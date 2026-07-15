/**
 * 本机开发者工作台：聚合 overview / apps / understand（无 HTTP 细节）
 */

const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const rpa = require('./rpa');
const understandCache = require('./understand-cache');
const openPath = require('./http/open-path');
const patchLib = require('./patch');
const kb = require('./kb');
const { classifyFix, canPreviewFix, describeFixGuidance } = require('./triage');
const { runSkill } = require('./agent-runner');
const { buildDailyReport, toDateKey } = require('./report');
const { mergeByErrorSignature } = require('./merge');
const handoff = require('./handoff');
const bucketLib = require('./bucket');
const workStatusLib = require('./work-status');

/** @type {{ at: number, apps: object, queueStats: Map } | null} */
let memCache = null;
const MEM_TTL_MS = 45 * 1000;

/** 防止并发 diagnose/fix 打爆本机 */
let actionBusy = false;

function getWorkbenchConfig(cfg = {}) {
  const w = cfg.workbench && typeof cfg.workbench === 'object' ? cfg.workbench : {};
  return {
    enabled: w.enabled !== false,
    openFolderEnabled: w.openFolderEnabled !== false,
    understandCache: w.understandCache !== false,
    openCommand: w.openCommand || null,
    // 在 Cursor / Claude Code / Codex 等打开：array 全量，或 object 按 id 覆盖（false 禁用）
    agents: w.agents != null ? w.agents : null,
    // S25b：Web 触发 skill（仅 dry-run fix；apply 永不从 Web）
    actionsEnabled: w.actionsEnabled !== false,
    // S26：Web 配置 LLM
    settingsEnabled: w.settingsEnabled !== false,
    // S27a：交接包默认是否附带诊断（仍可被查询参数覆盖）
    handoffIncludeDiagnose: w.handoffIncludeDiagnose === true,
    // S27d：优先队列只看 open，且失败时间在 recentDays 内（1=滚动 24h；0=不限）
    priorityRecentDays:
      w.priorityRecentDays != null
        ? Number(w.priorityRecentDays)
        : process.env.WORKBENCH_PRIORITY_RECENT_DAYS != null
          ? Number(process.env.WORKBENCH_PRIORITY_RECENT_DAYS)
          : 1,
    defaultSnoozeDays:
      w.defaultSnoozeDays != null
        ? Number(w.defaultSnoozeDays)
        : workStatusLib.DEFAULT_SNOOZE_DAYS,
  };
}

/** 可供 UI 展示的 Agent 列表 */
function listOpenAgents(cfg) {
  const wb = getWorkbenchConfig(cfg);
  return {
    ok: true,
    agents: openPath.listAgents(wb.agents),
  };
}

/**
 * queue → 按 robotUuid 聚合
 * @param {object[]} items
 * @returns {Map<string, {
 *   robotUuid, robotName, taskName, taskNames,
 *   failureCount, undiagnosedCount, lastSeen, items
 * }>}
 */
/** 展示用失败时间：优先 lastFailureAt（真实失败），兼容旧 queue 仅 lastSeen */
function failureTimeOf(it) {
  if (!it) return null;
  return it.lastFailureAt || it.lastSeen || it.firstFailureAt || it.firstSeen || null;
}

function aggregateFailuresByRobot(items) {
  const map = new Map();
  for (const it of items || []) {
    const id = it.robotUuid || 'unknown';
    let row = map.get(id);
    if (!row) {
      row = {
        robotUuid: id,
        robotName: it.robotName || '',
        taskName: it.taskName || '',
        taskNames: [],
        robotClientName: it.robotClientName || '',
        robotClientUuid: it.robotClientUuid || '',
        failureCount: 0,
        undiagnosedCount: 0,
        lastSeen: null,
        items: [],
      };
      map.set(id, row);
    }
    row.failureCount += 1;
    if (!it.diagnosed) row.undiagnosedCount += 1;
    if (!row.robotName && it.robotName) row.robotName = it.robotName;
    if (!row.robotClientName && it.robotClientName) {
      row.robotClientName = String(it.robotClientName).trim();
    }
    if (!row.robotClientUuid && it.robotClientUuid) {
      row.robotClientUuid = String(it.robotClientUuid).trim();
    }

    // 合并调度任务名（taskName ≠ robotName / 应用名）
    const namesFromItem = [];
    if (it.taskName) namesFromItem.push(String(it.taskName).trim());
    if (Array.isArray(it.recentTaskNames)) {
      for (const t of it.recentTaskNames) {
        if (t) namesFromItem.push(String(t).trim());
      }
    }
    for (const t of namesFromItem) {
      if (!t) continue;
      if (!row.taskNames.includes(t)) row.taskNames.push(t);
      if (!row.taskName) row.taskName = t;
    }

    const ft = failureTimeOf(it);
    if (ft && (!row.lastSeen || String(ft) > String(row.lastSeen || ''))) {
      row.lastSeen = ft;
      // 最近失败条目上的 taskName / 客户端优先
      if (it.taskName) row.taskName = String(it.taskName).trim();
      if (it.robotClientName) row.robotClientName = String(it.robotClientName).trim();
      if (it.robotClientUuid) row.robotClientUuid = String(it.robotClientUuid).trim();
    }
    row.items.push(it);
  }
  return map;
}

function listQueueSorted(dataDir) {
  const items = memory.listQueueItems(dataDir);
  items.sort((a, b) => String(failureTimeOf(b) || '').localeCompare(String(failureTimeOf(a) || '')));
  return items;
}

function getAppsBundle(cfg, { force = false } = {}) {
  const now = Date.now();
  if (!force && memCache && now - memCache.at < MEM_TTL_MS) {
    return memCache;
  }
  const scan = rpa.scanLocalApps(cfg);
  const queueItems = listQueueSorted(cfg.dataDir);
  const queueStats = aggregateFailuresByRobot(queueItems);
  memCache = { at: now, scan, queueItems, queueStats };
  return memCache;
}

function invalidateAppsCache() {
  memCache = null;
}

/** 优先原因权重：未诊断 > 复发 > 跨应用 > 可预览修 > 高频 */
const PRIORITY_WEIGHTS = {
  undiagnosed: 1000,
  regressed: 800,
  cross_app: 600,
  can_preview: 400,
  high_occurrence: 200,
};

const PRIORITY_LABELS = {
  undiagnosed: '未诊断',
  regressed: '复发',
  cross_app: '跨应用',
  can_preview: '可预览修',
  high_occurrence: '高频',
};

/**
 * 从 patch 列表建 fingerprint 索引（regressed / planned dry-run）
 * @param {object[]} patches
 * @returns {Map<string, { regressed: boolean, planned: boolean, pendingVerify: boolean }>}
 */
function indexPatchesByFingerprint(patches) {
  const map = new Map();
  for (const p of patches || []) {
    const fp = p && p.fingerprint;
    if (!fp) continue;
    let row = map.get(fp);
    if (!row) {
      row = { regressed: false, planned: false, pendingVerify: false };
      map.set(fp, row);
    }
    const st = String(p.status || '');
    if (st === 'regressed') row.regressed = true;
    if (st === 'fixed_pending_verify') row.pendingVerify = true;
    if (st === 'planned' || (p.dryRun === true && st !== 'applied' && st !== 'rolled_back')) {
      row.planned = true;
    }
  }
  return map;
}

/**
 * 跨应用组 → fingerprint 集合
 * @param {Array<{ fingerprints?: string[] }>} groups
 */
function crossFingerprintSet(groups) {
  const set = new Set();
  for (const g of groups || []) {
    for (const fp of g.fingerprints || []) {
      if (fp) set.add(fp);
    }
  }
  return set;
}

/**
 * 今日优先队列：按失败指纹排序，告诉人「先处理谁」
 * 仅 workStatus 有效 open（snoozed 过期算 open；ignored 不进）
 * 可选 recentDays：lastFailureAt 在滚动窗口内（默认 1=24h；0=不限）
 * 排序：未诊断 > 复发 > 跨应用 > 可预览修 > 高频 occurrence；同分按失败时间新→旧
 *
 * @param {object[]} queueItems
 * @param {{
 *   limit?: number,
 *   crossFpSet?: Set<string>,
 *   patchIndex?: Map<string, { regressed?: boolean, planned?: boolean }>,
 *   minOccurrenceHigh?: number,
 *   recentDays?: number,
 *   now?: string|Date,
 *   nameResolver?: (item: object) => { robotName?: string, taskName?: string },
 * }} [opts]
 * @returns {object[]}
 */
function buildPriorityQueue(queueItems, opts = {}) {
  const limit = opts.limit > 0 ? opts.limit : 10;
  const minOcc = opts.minOccurrenceHigh > 0 ? opts.minOccurrenceHigh : 3;
  const crossSet = opts.crossFpSet || new Set();
  const patchIndex = opts.patchIndex || new Map();
  const recentDays =
    opts.recentDays != null && Number(opts.recentDays) >= 0
      ? Number(opts.recentDays)
      : 1;
  const now = opts.now || new Date();
  const nameResolver =
    typeof opts.nameResolver === 'function' ? opts.nameResolver : () => ({});

  const ranked = [];
  for (const it of queueItems || []) {
    if (!it || !it.fingerprint) continue;

    // S27d：非 open（含 snoozed 有效期 / ignored）不进优先
    if (
      !workStatusLib.isPriorityEligible(it, {
        now,
        recentDays: recentDays > 0 ? recentDays : undefined,
      })
    ) {
      continue;
    }

    const patchInfo = patchIndex.get(it.fingerprint) || {};
    const reasons = [];
    let score = 0;

    if (!it.diagnosed) {
      reasons.push('undiagnosed');
      score += PRIORITY_WEIGHTS.undiagnosed;
    }
    if (it.fixStatus === 'regressed' || patchInfo.regressed) {
      reasons.push('regressed');
      score += PRIORITY_WEIGHTS.regressed;
    }
    if (it.errorSignature && crossSet.has(it.fingerprint)) {
      reasons.push('cross_app');
      score += PRIORITY_WEIGHTS.cross_app;
    }

    // 可预览：分诊 canPreview 或已有 planned dry-run（不依赖本机 resolve，避免总览扫盘）
    let canPreview = false;
    let triage = null;
    try {
      triage = classifyFix(it, { logs: [] });
      // 无 appInfo 时 auto 常降为 assisted；有 python 目标才算 canPreviewFix
      canPreview = canPreviewFix(triage);
      if (!canPreview && triage.fixability === 'auto') canPreview = true;
    } catch {
      canPreview = false;
      triage = null;
    }
    if (patchInfo.planned) canPreview = true;
    if (canPreview) {
      reasons.push('can_preview');
      score += PRIORITY_WEIGHTS.can_preview;
    }

    const bucketInfo = bucketLib.classifyBucket(it, triage);
    // 可开发类略加权，环境噪声不额外抬分（仍可因未诊断等原因入列）
    if (bucketLib.isDevActionable(bucketInfo.bucket) && canPreview) {
      score += 8;
    }

    const occ = Number(it.occurrenceCount) || 0;
    if (occ >= minOcc) {
      reasons.push('high_occurrence');
      score += PRIORITY_WEIGHTS.high_occurrence + Math.min(occ, 20) * 5;
    }

    // 无任何优先信号则跳过（已诊断、单次、非跨应用、无预览）
    if (!reasons.length) continue;

    const names = nameResolver(it) || {};
    const failAt = failureTimeOf(it);
    const ws = workStatusLib.resolveEffectiveWorkStatus(it, now);
    ranked.push({
      fingerprint: it.fingerprint,
      robotUuid: it.robotUuid || null,
      robotName: names.robotName || it.robotName || it.robotUuid || '',
      taskName: names.taskName || it.taskName || '',
      // 影刀客户端/机器侧名称（与应用 robotName 不同）
      robotClientName:
        names.robotClientName ||
        it.robotClientName ||
        '',
      robotClientUuid: it.robotClientUuid || '',
      flowName: it.flowName || '',
      errorType: it.errorType || '',
      diagnosed: !!it.diagnosed,
      occurrenceCount: occ,
      lastSeen: failAt,
      fixStatus: it.fixStatus || null,
      canPreviewFix: canPreview,
      bucket: bucketInfo.bucket,
      bucketLabel: bucketInfo.label,
      actionable: bucketInfo.actionable,
      workStatus: ws.workStatus,
      workStatusLabel: ws.workStatusLabel,
      reopenedBy: ws.reopenedBy,
      reasons,
      reasonLabels: reasons.map((r) => PRIORITY_LABELS[r] || r),
      primaryReason: reasons[0],
      score,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''));
  });

  return ranked.slice(0, limit);
}

/**
 * @param {object} cfg
 * @param {{ startedAt?: number, lastPollAt?: string|null, lastDiagnoseAt?: string|null, lastReportAt?: string|null }} state
 */
function buildOverview(cfg, state = {}) {
  const bundle = getAppsBundle(cfg);
  const { scan, queueItems, queueStats } = bundle;
  const undiagnosed = queueItems.filter((q) => !q.diagnosed).length;
  // S27b：全 queue 技术分流计数（运行时，不写盘）
  const bucketAgg = bucketLib.aggregateBuckets(queueItems, {
    triageOf: (it) => {
      try {
        return classifyFix(it, { logs: [] });
      } catch {
        return null;
      }
    },
  });

  const localByUuid = new Map((scan.apps || []).map((a) => [a.robotUuid, a]));
  const taskIndex = memory.loadTaskIndex(cfg.dataDir);
  const byRobotTask = (taskIndex && taskIndex.byRobot) || {};

  const problemApps = [...queueStats.values()]
    .filter((r) => r.robotUuid && r.robotUuid !== 'unknown')
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .slice(0, 10)
    .map((r) => {
      const local = localByUuid.get(r.robotUuid);
      const taskEntry = byRobotTask[r.robotUuid];
      const appName =
        (local && local.name) || r.robotName || (taskEntry && taskEntry.robotName) || r.robotUuid;
      const merged = mergeTaskNames(r, taskEntry, null);
      return {
        robotUuid: r.robotUuid,
        /** 应用名（package / robotName） */
        robotName: appName,
        /** 调度任务名（优先列表主标题） */
        taskName: merged.taskName || '',
        taskNames: merged.taskNames || [],
        failureCount: r.failureCount,
        undiagnosedCount: r.undiagnosedCount,
        lastSeen: r.lastSeen,
        // 附加字段：总览「复制路径」；旧客户端可忽略
        xbotDir: (local && local.xbotDir) || null,
      };
    });

  // S10b：queue 全量按 errorSignature 归并（≥2 app）
  const crossAppGroupsRaw = mergeByErrorSignature(queueItems, { minApps: 2 });
  const crossAppGroups = crossAppGroupsRaw.slice(0, 12);

  // 今日优先：失败指纹级排序（未诊断 > 复发 > 跨应用 > 可预览 > 高频）
  let patchIndex = new Map();
  try {
    patchIndex = indexPatchesByFingerprint(patchLib.listPatches(cfg.dataDir));
  } catch {
    patchIndex = new Map();
  }
  const wbCfg = getWorkbenchConfig(cfg);
  const priorityQueue = buildPriorityQueue(queueItems, {
    limit: 10,
    crossFpSet: crossFingerprintSet(crossAppGroupsRaw),
    patchIndex,
    recentDays: wbCfg.priorityRecentDays,
    nameResolver: (it) => {
      const rid = it.robotUuid;
      const local = rid ? localByUuid.get(rid) : null;
      const st = rid ? queueStats.get(rid) : null;
      const te = rid ? byRobotTask[rid] : null;
      const merged = mergeTaskNames(st, te, it);
      const appName =
        (local && local.name) || it.robotName || (te && te.robotName) || rid || '';
      const clientName =
        it.robotClientName ||
        (st && st.robotClientName) ||
        (te && te.robotClientName) ||
        '';
      return {
        robotName: appName,
        taskName: merged.taskName || it.taskName || '',
        robotClientName: clientName,
      };
    },
  });

  // 处置态计数（全队列；不改变 depth 语义）
  let workOpen = 0;
  let workSnoozed = 0;
  let workIgnored = 0;
  let ignoredStillFailing = 0;
  const nowWs = new Date();
  for (const it of queueItems) {
    const eff = workStatusLib.resolveEffectiveWorkStatus(it, nowWs);
    if (eff.workStatus === 'snoozed') workSnoozed += 1;
    else if (eff.workStatus === 'ignored') {
      workIgnored += 1;
      if (eff.ignoredStillFailing) ignoredStillFailing += 1;
    } else workOpen += 1;
  }

  const startedAt = state.startedAt || Date.now();

  return {
    ok: true,
    runtime: {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      lastPollAt: state.lastPollAt || null,
      lastDiagnoseAt: state.lastDiagnoseAt || null,
      lastReportAt: state.lastReportAt || null,
      pid: process.pid,
      dataDir: cfg.dataDir,
    },
    localApps: {
      count: scan.apps.length,
      usersRoot: scan.usersRoot,
      userCount: scan.userCount,
    },
    queue: {
      depth: queueItems.length,
      undiagnosed,
      /** S27b 技术分流计数 */
      byBucket: bucketAgg.byBucket,
      bucketLabels: bucketAgg.labels,
      // 可开发 = 代码(py) + 元素 + 数据配置（不含机器人/调度）
      devActionable: bucketLib.countDevActionable(bucketAgg.byBucket),
      opsNoise: bucketLib.countOpsNoise(bucketAgg.byBucket),
      /** S27d 处置态（优先队列只吃 open） */
      workStatus: {
        open: workOpen,
        snoozed: workSnoozed,
        ignored: workIgnored,
        ignoredStillFailing,
      },
      priorityRecentDays: wbCfg.priorityRecentDays,
    },
    /** 优先处理的失败指纹（最多 10；仅 open + 近 N 天，默认 1=24h） */
    priorityQueue,
    problemApps,
    crossAppGroups: crossAppGroups.map((g) => ({
      errorSignature: g.errorSignature,
      flowName: g.flowName,
      errorType: g.errorType,
      elementName: g.elementName,
      rootCauseHint: g.rootCauseHint,
      appCount: g.appCount,
      totalCount: g.totalCount,
      lastSeen: g.lastSeen,
      sampleFingerprint: g.sampleFingerprint,
      affectedApps: g.affectedApps.map((a) => {
        const te = byRobotTask[a.robotUuid];
        const st = queueStats.get(a.robotUuid);
        const merged = mergeTaskNames(st, te, null);
        const appName = a.robotName || (te && te.robotName) || a.robotUuid;
        return {
          robotUuid: a.robotUuid,
          robotName: appName,
          taskName: merged.taskName || '',
          count: a.count,
          sampleFingerprint: a.fingerprints[0] || '',
        };
      }),
    })),
  };
}

/**
 * 从 queue 聚合行取最近失败条目 + 任务名列表
 * @param {object|null|undefined} st
 */
function lastFailureFromStats(st) {
  if (!st || !Array.isArray(st.items) || !st.items.length) return null;
  return st.items
    .slice()
    .sort((x, y) =>
      String(failureTimeOf(y) || '').localeCompare(String(failureTimeOf(x) || '')),
    )[0];
}

/**
 * 合并任务名：task-index（含成功 job）优先，queue 失败条目补充
 * @param {object|null|undefined} st
 * @param {object|null|undefined} taskEntry memory task-index 行
 * @param {object|null|undefined} lastItem
 */
function mergeTaskNames(st, taskEntry, lastItem) {
  const taskNames = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (s && !taskNames.includes(s)) taskNames.push(s);
  };
  // 1) 全量 job 索引（成功也有）
  if (taskEntry) {
    push(taskEntry.taskName);
    if (Array.isArray(taskEntry.taskNames)) taskEntry.taskNames.forEach(push);
  }
  // 2) 失败 queue 聚合
  if (st) {
    push(st.taskName);
    if (Array.isArray(st.taskNames)) st.taskNames.forEach(push);
  }
  if (lastItem) push(lastItem.taskName);

  const taskName =
    (taskEntry && taskEntry.taskName) ||
    (st && st.taskName) ||
    (lastItem && lastItem.taskName) ||
    taskNames[0] ||
    '';
  return { taskName, taskNames };
}

/**
 * @param {object} base 本地扫描或 queue/索引 补全的基础字段
 * @param {object|null|undefined} st queue 聚合
 * @param {object|null|undefined} taskEntry task-index 行
 */
function buildAppListRow(base, st, taskEntry) {
  const lastItem = lastFailureFromStats(st);
  const appName =
    (base && base.name) ||
    (st && st.robotName) ||
    (taskEntry && taskEntry.robotName) ||
    (base && base.robotUuid) ||
    (st && st.robotUuid) ||
    (taskEntry && taskEntry.robotUuid) ||
    '';
  const { taskName, taskNames } = mergeTaskNames(st, taskEntry, lastItem);
  const robotClientName =
    (taskEntry && taskEntry.robotClientName) ||
    (st && st.robotClientName) ||
    (lastItem && lastItem.robotClientName) ||
    '';
  const robotClientUuid =
    (taskEntry && taskEntry.robotClientUuid) ||
    (st && st.robotClientUuid) ||
    (lastItem && lastItem.robotClientUuid) ||
    '';

  return {
    robotUuid:
      (base && base.robotUuid) ||
      (st && st.robotUuid) ||
      (taskEntry && taskEntry.robotUuid) ||
      '',
    name: appName,
    /** 影刀 job.taskName：调度任务名（列表主展示；可来自成功 job） */
    taskName: taskName || '',
    taskNames,
    /** 影刀 job.robotClientName：运行端机器人（非应用名） */
    robotClientName: robotClientName || '',
    robotClientUuid: robotClientUuid || '',
    description: (base && base.description) || '',
    version: (base && base.version) || '',
    startup: (base && base.startup) || '',
    robotType: (base && base.robotType) || '',
    flowCount: base && base.flowCount != null ? base.flowCount : 0,
    packageMtime: (base && base.packageMtime) || null,
    userId: (base && base.userId) || null,
    xbotDir: (base && base.xbotDir) || null,
    /** 仅云端有（本机未安装） */
    remoteOnly: !(base && base.xbotDir),
    failureCount: st ? st.failureCount : 0,
    undiagnosedCount: st ? st.undiagnosedCount : 0,
    lastFailureAt: st ? st.lastSeen : null,
    lastErrorType: lastItem ? lastItem.errorType || '' : '',
    lastFlowName: lastItem ? lastItem.flowName || '' : '',
  };
}

function listAppsWithStats(cfg) {
  const bundle = getAppsBundle(cfg);
  const { scan, queueStats } = bundle;
  const taskIndex = memory.loadTaskIndex(cfg.dataDir);
  const byRobotTask = (taskIndex && taskIndex.byRobot) || {};
  const seen = new Set();
  const apps = [];

  // 1) 本机已安装应用（任务名来自 task-index + 失败 queue）
  for (const a of scan.apps || []) {
    seen.add(a.robotUuid);
    apps.push(buildAppListRow(a, queueStats.get(a.robotUuid), byRobotTask[a.robotUuid]));
  }

  // 2) queue 失败应用（本机未安装）
  for (const [robotUuid, st] of queueStats.entries()) {
    if (!robotUuid || seen.has(robotUuid)) continue;
    seen.add(robotUuid);
    apps.push(
      buildAppListRow(
        {
          robotUuid,
          name: st.robotName || robotUuid,
          description: '',
          version: '',
          startup: '',
          robotType: '',
          flowCount: 0,
          packageMtime: null,
          userId: null,
          xbotDir: null,
        },
        st,
        byRobotTask[robotUuid],
      ),
    );
  }

  // 3) 仅在 task-index 出现（近期有运行、未必失败、本机也可能未装）
  for (const [robotUuid, te] of Object.entries(byRobotTask)) {
    if (!robotUuid || seen.has(robotUuid)) continue;
    seen.add(robotUuid);
    apps.push(
      buildAppListRow(
        {
          robotUuid,
          name: (te && te.robotName) || robotUuid,
          description: '',
          version: '',
          startup: '',
          robotType: '',
          flowCount: 0,
          packageMtime: null,
          userId: null,
          xbotDir: null,
        },
        queueStats.get(robotUuid),
        te,
      ),
    );
  }

  apps.sort((a, b) => {
    if (b.failureCount !== a.failureCount) return b.failureCount - a.failureCount;
    const an = a.taskName || a.name || '';
    const bn = b.taskName || b.name || '';
    return String(an).localeCompare(String(bn), 'zh');
  });

  return {
    ok: true,
    usersRoot: scan.usersRoot,
    userCount: scan.userCount,
    count: apps.length,
    localCount: (scan.apps || []).length,
    apps,
  };
}

/**
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ failureLimit?: number }} [opts]
 */
function getAppDetail(robotUuid, cfg, opts = {}) {
  if (!robotUuid) {
    return { ok: false, code: 'missing_robotUuid', message: '缺少 robotUuid' };
  }

  const resolved = rpa.resolveXbotDir(robotUuid, { cfg });
  const bundle = getAppsBundle(cfg);
  const local = bundle.scan.apps.find((a) => a.robotUuid === robotUuid) || null;
  const st = bundle.queueStats.get(robotUuid);

  const limit = opts.failureLimit || 20;
  const failures = (st ? st.items : [])
    .slice()
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .slice(0, limit)
    .map((it) => enrichFailureItem(it, cfg));

  const patches = patchLib
    .listPatches(cfg.dataDir)
    .filter((p) => p.robotUuid === robotUuid)
    .slice(0, 20)
    .map((p) => ({
      patchId: p.patchId,
      status: p.status,
      fingerprint: p.fingerprint,
      fixerId: p.fixerId,
      fixClass: p.fixClass,
      dryRun: p.dryRun,
      createdAt: p.createdAt,
      appliedAt: p.appliedAt || null,
    }));

  const taskEntry = memory.getTaskIndexEntry(cfg.dataDir, robotUuid);
  const appName =
    (local && local.name) ||
    resolved.name ||
    (st && st.robotName) ||
    (taskEntry && taskEntry.robotName) ||
    robotUuid;
  const mergedTasks = mergeTaskNames(st, taskEntry, null);
  const taskNames = mergedTasks.taskNames;
  const taskName = mergedTasks.taskName;
  const robotClientName =
    (taskEntry && taskEntry.robotClientName) ||
    (st && st.robotClientName) ||
    '';
  const robotClientUuid =
    (taskEntry && taskEntry.robotClientUuid) ||
    (st && st.robotClientUuid) ||
    '';

  return {
    ok: true,
    robotUuid,
    name: appName,
    taskName,
    taskNames,
    robotClientName,
    robotClientUuid,
    userId: (local && local.userId) || null,
    xbotDir: resolved.xbotDir || (local && local.xbotDir) || null,
    resolve: {
      mapped: !!resolved.mapped,
      source: resolved.source || null,
      reason: resolved.reason || null,
    },
    failureCount: st ? st.failureCount : 0,
    undiagnosedCount: st ? st.undiagnosedCount : 0,
    lastFailureAt: st ? st.lastSeen : null,
    failures,
    patches,
    actionsEnabled: getWorkbenchConfig(cfg).actionsEnabled,
  };
}

/**
 * 为 queue 条目附加分诊 + 是否可预览修复 + 人工指引
 */
function enrichFailureItem(it, cfg) {
  let appInfo = null;
  try {
    if (it.robotUuid) appInfo = rpa.resolveXbotDir(it.robotUuid, { cfg, dataDir: cfg.dataDir });
  } catch {
    appInfo = null;
  }
  const triage = classifyFix(it, { logs: [], appInfo });
  const guidance = describeFixGuidance(triage, {
    errorType: it.errorType,
    rawRemark: it.rawRemark,
    suggestion: it.lastDiagnosis && it.lastDiagnosis.suggestion,
  });
  const failAt = failureTimeOf(it);
  const bucketInfo = bucketLib.classifyBucket(it, triage);
  const ws = workStatusLib.resolveEffectiveWorkStatus(it);
  return {
    fingerprint: it.fingerprint,
    flowName: it.flowName,
    errorType: it.errorType,
    elementName: it.elementName,
    rawRemark: it.rawRemark,
    diagnosed: !!it.diagnosed,
    occurrenceCount: it.occurrenceCount,
    // Web「最近/失败时间」用真实失败时间
    lastSeen: failAt,
    firstSeen: it.firstFailureAt || it.firstSeen || failAt,
    lastFailureAt: it.lastFailureAt || failAt,
    firstFailureAt: it.firstFailureAt || it.firstSeen || null,
    lastPolledAt: it.lastPolledAt || null,
    kbId: it.kbId || null,
    fixStatus: it.fixStatus || null,
    lastPatchId: it.lastPatchId || null,
    lastDiagnosis: it.lastDiagnosis || null,
    robotUuid: it.robotUuid || null,
    robotName: it.robotName || null,
    taskName: it.taskName || null,
    robotClientName: it.robotClientName || null,
    robotClientUuid: it.robotClientUuid || null,
    fixClass: triage.fixClass,
    fixability: triage.fixability,
    canPreviewFix: canPreviewFix(triage),
    guidance,
    // S27b
    bucket: bucketInfo.bucket,
    bucketLabel: bucketInfo.label,
    actionable: bucketInfo.actionable,
    bucketReason: bucketInfo.reason,
    // S27d
    workStatus: ws.workStatus,
    workStatusLabel: ws.workStatusLabel,
    snoozedUntil: ws.snoozedUntil,
    reopenedBy: ws.reopenedBy,
    ignoredStillFailing: ws.ignoredStillFailing,
  };
}

/**
 * 单条失败详情：queue + lastDiagnosis + KB + 相关 patches + 修复指引
 */
function getFindingDetail(fingerprint, cfg) {
  if (!fingerprint) {
    return { ok: false, code: 'missing_fingerprint', message: '缺少 fingerprint' };
  }
  const item = memory.loadQueueItem(cfg.dataDir, fingerprint);
  if (!item) {
    return { ok: false, code: 'not_found', message: 'queue 中无此 fingerprint' };
  }

  let kbEntry = null;
  if (item.kbId) kbEntry = kb.loadKb(cfg.dataDir, item.kbId);
  if (!kbEntry && fingerprint) {
    const hits = kb.searchKb(cfg.dataDir, { fingerprint, limit: 1 });
    kbEntry = (hits.hits && hits.hits[0]) || null;
  }

  const patches = patchLib
    .listPatches(cfg.dataDir)
    .filter((p) => p.fingerprint === fingerprint)
    .slice(0, 10);

  const enriched = enrichFailureItem(item, cfg);

  let xbotDir = null;
  let appName = item.robotName || '';
  try {
    if (item.robotUuid) {
      const resolved = rpa.resolveXbotDir(item.robotUuid, { cfg, dataDir: cfg.dataDir });
      xbotDir = resolved.xbotDir || null;
      if (!appName) appName = resolved.name || '';
    }
  } catch {
    xbotDir = null;
  }

  return {
    ok: true,
    finding: item,
    diagnosis: item.lastDiagnosis || null,
    triage: {
      fixClass: enriched.fixClass,
      fixability: enriched.fixability,
      canPreviewFix: enriched.canPreviewFix,
    },
    guidance: enriched.guidance,
    // S27b 技术分流
    bucket: {
      id: enriched.bucket,
      label: enriched.bucketLabel,
      actionable: enriched.actionable,
      reason: enriched.bucketReason,
    },
    // S27d 处置态
    work: {
      status: enriched.workStatus,
      label: enriched.workStatusLabel,
      snoozedUntil: enriched.snoozedUntil,
      reopenedBy: enriched.reopenedBy,
      ignoredStillFailing: enriched.ignoredStillFailing,
      defaultSnoozeDays: getWorkbenchConfig(cfg).defaultSnoozeDays,
    },
    // 附加字段：失败详情「复制路径 / Agent 提示」；旧客户端可忽略
    xbotDir,
    appName: appName || null,
    robotClientName: item.robotClientName || null,
    robotClientUuid: item.robotClientUuid || null,
    taskName: item.taskName || null,
    kb: kbEntry
      ? {
          id: kbEntry.id,
          rootCause: kbEntry.rootCause,
          solution: kbEntry.solution,
          location: kbEntry.location,
          confidence: kbEntry.confidence,
          status: kbEntry.status,
          notes: kbEntry.notes,
        }
      : null,
    patches: patches.map((p) => ({
      patchId: p.patchId,
      status: p.status,
      dryRun: p.dryRun,
      fixerId: p.fixerId,
      fixClass: p.fixClass,
      createdAt: p.createdAt,
      appliedAt: p.appliedAt,
      verify: p.verify || null,
    })),
    actionsEnabled: getWorkbenchConfig(cfg).actionsEnabled,
  };
}

/**
 * S27d：设置失败处置态（仅影响优先队列，不删 queue、不改 py）
 * @param {string} fingerprint
 * @param {object} cfg
 * @param {{ status: string, snoozeDays?: number, reason?: string }} body
 */
function setFindingWorkStatus(fingerprint, cfg, body = {}) {
  if (!fingerprint) {
    return { ok: false, code: 'missing_fingerprint', message: '缺少 fingerprint' };
  }
  const raw = String(body.status || '').trim().toLowerCase();
  if (!['open', 'snoozed', 'ignored'].includes(raw)) {
    return {
      ok: false,
      code: 'invalid_status',
      message: 'status 须为 open | snoozed | ignored',
    };
  }
  const status = workStatusLib.normalizeWorkStatus(raw);
  const wb = getWorkbenchConfig(cfg);
  const snoozeDays =
    body.snoozeDays > 0 ? Number(body.snoozeDays) : wb.defaultSnoozeDays || 3;
  const next = memory.setQueueWorkStatus(cfg.dataDir, fingerprint, status, {
    snoozeDays,
    reason: body.reason || `manual_${status}`,
  });
  if (!next) {
    return { ok: false, code: 'not_found', message: 'queue 中无此 fingerprint' };
  }
  invalidateAppsCache();
  const eff = workStatusLib.resolveEffectiveWorkStatus(next);
  return {
    ok: true,
    fingerprint,
    workStatus: next.workStatus,
    workStatusLabel: eff.workStatusLabel,
    snoozedUntil: next.snoozedUntil || null,
    reopenedBy: next.reopenedBy || null,
    ignoredStillFailing: next.ignoredStillFailing === true,
    item: next,
  };
}

/**
 * S27a：失败修复交接提示词（瘦身；诊断 opt-in）
 * @param {string} fingerprint
 * @param {object} cfg
 * @param {{ includeDiagnose?: boolean|string }} [opts]
 */
function getFindingHandoff(fingerprint, cfg, opts = {}) {
  const detail = getFindingDetail(fingerprint, cfg);
  if (!detail.ok) return detail;

  const wb = getWorkbenchConfig(cfg);
  const includeDiagnose =
    opts.includeDiagnose != null
      ? handoff.truthyFlag(opts.includeDiagnose)
      : wb.handoffIncludeDiagnose === true;

  const f = detail.finding || {};
  const d = detail.diagnosis || {};
  const k = detail.kb || {};
  const g = detail.guidance || {};
  const triage = detail.triage || {};

  const b = detail.bucket || {};
  const ctx = {
    mode: 'fix',
    name: detail.appName || f.robotName || '',
    robotUuid: f.robotUuid || '',
    xbotDir: detail.xbotDir || '',
    fingerprint,
    flowName: f.flowName,
    lineNumber: f.lineNumber,
    errorType: f.errorType,
    rawRemark: f.rawRemark,
    guidanceTitle: g.title,
    fixClass: triage.fixClass || g.fixClass,
    fixability: triage.fixability || g.fixability,
    rootCause: d.rootCause || k.rootCause,
    suggestion: d.suggestion || k.solution,
    includeDiagnose,
    bucket: b.id || '',
    bucketLabel: b.label || '',
    actionable: b.actionable || '',
  };

  const markdown = handoff.buildFixPrompt(ctx);
  const measure = handoff.measurePrompt(markdown);
  return {
    ok: true,
    mode: 'fix',
    markdown,
    summary: `修：${ctx.name || fingerprint} · ${ctx.errorType || '失败'}`,
    includeDiagnose,
    meta: {
      fingerprint,
      robotUuid: ctx.robotUuid || null,
      appName: ctx.name || null,
      xbotDir: ctx.xbotDir || null,
      flowName: ctx.flowName || null,
      lineNumber: ctx.lineNumber != null ? ctx.lineNumber : null,
      errorType: ctx.errorType || null,
      fixClass: ctx.fixClass || null,
      fixability: ctx.fixability || null,
    },
    ...measure,
  };
}

/**
 * S27a：应用开发/维护交接提示词
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ taskNote?: string }} [opts]
 */
function getAppHandoff(robotUuid, cfg, opts = {}) {
  if (!robotUuid) {
    return { ok: false, code: 'missing_robot', message: '缺少 robotUuid' };
  }
  const detail = getAppDetail(robotUuid, cfg);
  if (!detail.ok) return detail;

  const ctx = {
    mode: 'develop',
    name: detail.name || robotUuid,
    robotUuid,
    xbotDir: detail.xbotDir || '',
    taskNote: opts.taskNote || '',
  };
  const markdown = handoff.buildDevelopPrompt(ctx);
  const measure = handoff.measurePrompt(markdown);
  return {
    ok: true,
    mode: 'develop',
    markdown,
    summary: `开发：${ctx.name}`,
    includeDiagnose: false,
    meta: {
      robotUuid,
      appName: ctx.name || null,
      xbotDir: ctx.xbotDir || null,
    },
    ...measure,
  };
}

function listPatchesForWorkbench(cfg, opts = {}) {
  let list = patchLib.listPatches(cfg.dataDir);
  if (opts.fingerprint) list = list.filter((p) => p.fingerprint === opts.fingerprint);
  if (opts.robotUuid) list = list.filter((p) => p.robotUuid === opts.robotUuid);
  if (opts.status) list = list.filter((p) => p.status === opts.status);
  const limit = opts.limit || 50;
  return {
    ok: true,
    count: list.length,
    patches: list.slice(0, limit),
  };
}

function getPatchDetail(cfg, patchId) {
  const loaded = patchLib.loadPatch(cfg.dataDir, patchId);
  if (!loaded) return { ok: false, code: 'not_found', message: 'patch 不存在' };
  let diff = '';
  try {
    const diffPath = path.join(loaded.root, 'patch.diff');
    if (fs.existsSync(diffPath)) {
      diff = fs.readFileSync(diffPath, 'utf8').slice(0, 50000);
    }
  } catch {
    // ignore
  }
  return { ok: true, meta: loaded.meta, diff, root: loaded.root };
}

/**
 * S25b：经统一 runner 触发 skill（Web 薄封装）
 * @param {'diagnose'|'fix-dry-run'} action
 * @param {{ fingerprint: string, useLlm?: boolean, force?: boolean }} input
 * @param {object} cfg
 */
async function runWorkbenchAction(action, input, cfg) {
  const wb = getWorkbenchConfig(cfg);
  if (!wb.actionsEnabled) {
    return { ok: false, code: 'actions_disabled', message: 'workbench.actionsEnabled=false' };
  }
  if (!input || !input.fingerprint) {
    return { ok: false, code: 'missing_fingerprint', message: '需要 fingerprint' };
  }
  if (actionBusy) {
    return { ok: false, code: 'busy', message: '已有操作进行中，请稍后重试' };
  }

  actionBusy = true;
  try {
    if (action === 'diagnose') {
      // useLlm：请求体显式 true/false 优先；否则跟 cfg.diagnoseUseLlm
      let useLlm;
      if (input.useLlm === true) useLlm = true;
      else if (input.useLlm === false) useLlm = false;
      else useLlm = cfg.diagnoseUseLlm !== false;
      const result = await runSkill(
        'diagnose',
        {
          fingerprint: input.fingerprint,
          useLlm,
          fetchLogs: true,
        },
        { cfg },
      );
      invalidateAppsCache();
      return {
        ok: !!result.ok,
        action: 'diagnose',
        result: summarizeSkillResult(result),
      };
    }

    if (action === 'fix-dry-run' || action === 'fix') {
      // 先分诊：不可预览时直接返回人工建议，不调用 maintain
      const detail = getFindingDetail(input.fingerprint, cfg);
      if (!detail.ok) {
        return {
          ok: false,
          action: 'fix-dry-run',
          dryRun: true,
          applied: false,
          code: detail.code,
          message: detail.message,
          guidance: null,
        };
      }
      if (!detail.triage?.canPreviewFix && input.force !== true) {
        return {
          ok: false,
          action: 'fix-dry-run',
          dryRun: true,
          applied: false,
          code: 'not_previewable',
          message: detail.guidance?.summary || '当前失败不支持自动预览修复',
          guidance: detail.guidance,
          triage: detail.triage,
          result: {
            ok: false,
            code: 'not_previewable',
            message: detail.guidance?.summary || '当前失败不支持自动预览修复',
            fixClass: detail.triage?.fixClass,
            fixability: detail.triage?.fixability,
            guidance: detail.guidance,
          },
        };
      }

      // Web 永不 apply
      const result = await runSkill(
        'maintain',
        {
          action: 'fix',
          fingerprint: input.fingerprint,
          force: input.force === true || detail.triage?.fixability === 'assisted',
          apply: false,
          forceApply: false,
        },
        { cfg },
      );
      invalidateAppsCache();
      // 失败时附带 guidance，避免只剩 code
      if (!result.ok) {
        return {
          ok: false,
          action: 'fix-dry-run',
          dryRun: true,
          applied: false,
          code: result.code,
          message: result.message,
          guidance: detail.guidance,
          triage: detail.triage,
          result: {
            ...summarizeSkillResult(result),
            guidance: detail.guidance,
          },
        };
      }
      return {
        ok: true,
        action: 'fix-dry-run',
        dryRun: true,
        applied: false,
        guidance: detail.guidance,
        result: summarizeSkillResult(result),
      };
    }

    return { ok: false, code: 'unknown_action', message: `未知动作: ${action}` };
  } catch (e) {
    return { ok: false, code: 'action_error', message: e.message || String(e) };
  } finally {
    actionBusy = false;
  }
}

/**
 * 工作台手动触发 poll（与 CLI `poll.js --once` / service 同一 pollOnce）
 * 仅确定性拉失败入队，不自动 diagnose、不写盘。
 *
 * @param {object} cfg
 * @param {{ lookbackHours?: number, maxPages?: number, enrichLogs?: boolean }} [input]
 */
async function runManualPoll(cfg, input = {}) {
  if (actionBusy) {
    return { ok: false, code: 'busy', message: '已有操作进行中（诊断或拉取），请稍后重试' };
  }

  actionBusy = true;
  try {
    // eslint-disable-next-line global-require
    const { pollOnce } = require('./poll');
    // eslint-disable-next-line global-require
    const { requireYingdaoCredentials } = require('./config');

    let liveCfg;
    try {
      liveCfg = requireYingdaoCredentials(cfg);
    } catch (e) {
      return {
        ok: false,
        code: e.code || 'no_credentials',
        message: e.message || '缺少影刀 OpenAPI 密钥',
      };
    }

    const pollOpts = {
      enrichLogs: input.enrichLogs !== false,
    };
    if (input.lookbackHours != null && Number.isFinite(Number(input.lookbackHours))) {
      pollOpts.lookbackHours = Number(input.lookbackHours);
    }
    if (input.maxPages != null && Number.isFinite(Number(input.maxPages))) {
      pollOpts.maxPages = Number(input.maxPages);
    }

    const result = await pollOnce(liveCfg, pollOpts);
    invalidateAppsCache();

    const stats = (result && result.stats) || {};
    return {
      ok: true,
      action: 'poll',
      polledAt: (result.cursor && result.cursor.lastPollAt) || new Date().toISOString(),
      stats: {
        scanned: stats.scanned || 0,
        failed: stats.failed || 0,
        enqueued: stats.enqueued || 0,
        updated: stats.updated || 0,
        urgent: stats.urgent || 0,
        enriched: stats.enriched || 0,
        pages: stats.pages || 0,
        lookbackHours: stats.lookbackHours || 0,
        truncated: !!stats.truncated,
        findings: stats.findings || 0,
        regressed: stats.regressed || 0,
        verified: stats.verified || 0,
      },
      cursor: result.cursor || null,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'poll_error',
      message: e.message || String(e),
    };
  } finally {
    actionBusy = false;
  }
}

function summarizeSkillResult(result) {
  if (!result) return null;
  // 截断 toolTrace / 大字段，避免 HTTP 过大
  const out = { ...result };
  if (Array.isArray(out.toolTrace) && out.toolTrace.length > 40) {
    out.toolTrace = out.toolTrace.slice(0, 40);
  }
  if (out.flowContext && out.flowContext.summary) {
    out.flowContext = {
      summary: String(out.flowContext.summary).slice(0, 2000),
      projectName: out.flowContext.projectName,
    };
  }
  if (out.blocksContext && out.blocksContext.blocks) {
    out.blocksContext = {
      flowName: out.blocksContext.flowName,
      focusIndex: out.blocksContext.focusIndex,
      blocks: (out.blocksContext.blocks || []).slice(0, 12),
    };
  }
  return out;
}

function isSafeReportDate(dateKey) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''));
}

/**
 * 列出 data/reports 下的日报
 */
function listReports(cfg, opts = {}) {
  const dir = memory.paths(cfg.dataDir).reportsDir;
  if (!fs.existsSync(dir)) {
    return { ok: true, count: 0, reports: [], reportsDir: dir };
  }
  const limit = opts.limit || 60;
  const reports = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map((f) => {
      const date = f.replace(/\.md$/, '');
      const full = path.join(dir, f);
      let size = 0;
      let mtime = null;
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch {
        // ignore
      }
      return { date, file: f, size, mtime };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, limit);

  return { ok: true, count: reports.length, reports, reportsDir: dir };
}

/**
 * 读取单日日报 Markdown
 */
function getReport(cfg, dateKey) {
  const date = dateKey || toDateKey();
  if (!isSafeReportDate(date)) {
    return { ok: false, code: 'bad_date', message: '日期格式须为 YYYY-MM-DD' };
  }
  const filePath = path.join(memory.paths(cfg.dataDir).reportsDir, `${date}.md`);
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      code: 'not_found',
      message: `无日报 ${date}.md，可先生成`,
      date,
    };
  }
  let markdown = '';
  try {
    markdown = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return { ok: false, code: 'read_failed', message: e.message, date };
  }
  return {
    ok: true,
    date,
    filePath,
    markdown,
    mtime: fs.statSync(filePath).mtime.toISOString(),
  };
}

/**
 * 生成日报（写盘），供 Web 按钮触发
 */
function generateReport(cfg, opts = {}) {
  const date = opts.date || toDateKey();
  if (!isSafeReportDate(date)) {
    return { ok: false, code: 'bad_date', message: '日期格式须为 YYYY-MM-DD' };
  }
  try {
    const result = buildDailyReport(cfg, {
      date,
      write: true,
      scope: opts.scope || cfg.reportScope || 'poll_window',
    });
    return {
      ok: true,
      date: result.date,
      filePath: result.filePath,
      stats: result.stats,
      markdown: result.markdown,
      scope: result.scope,
    };
  } catch (e) {
    return { ok: false, code: 'generate_failed', message: e.message || String(e) };
  }
}

/**
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ flowName?: string, skipCache?: boolean }} [opts]
 */
function getAppUnderstand(robotUuid, cfg, opts = {}) {
  const wb = getWorkbenchConfig(cfg);
  const detail = getAppDetail(robotUuid, cfg);
  if (!detail.ok) return detail;

  const xbotDir = detail.xbotDir;
  if (!xbotDir) {
    return {
      ok: false,
      code: 'xbotDir_missing',
      message: detail.resolve.reason || '本机未找到流程目录',
      robotUuid,
    };
  }

  const flowName = opts.flowName || '';

  if (wb.understandCache && !opts.skipCache) {
    const cached = understandCache.readCache(cfg.dataDir, xbotDir, flowName);
    if (cached.hit && cached.payload && cached.payload.result) {
      return {
        ok: true,
        robotUuid,
        xbotDir,
        cached: true,
        cacheKey: cached.key,
        result: cached.payload.result,
      };
    }
  }

  let result;
  try {
    result = rpa.understandFlow(xbotDir, flowName, { cfg });
  } catch (e) {
    const msg = e.message || String(e);
    const code = /rpa-skill|不存在/.test(msg) ? 'rpa_skill_missing' : 'understand_error';
    return { ok: false, code, message: msg, robotUuid, xbotDir };
  }

  let cacheKey = null;
  if (wb.understandCache && result && result.ok) {
    cacheKey = understandCache.makeCacheKey(xbotDir, flowName);
    try {
      understandCache.writeCache(cfg.dataDir, cacheKey, result);
    } catch {
      // 缓存失败不阻塞
    }
  }

  return {
    ok: true,
    robotUuid,
    xbotDir,
    cached: false,
    cacheKey,
    result,
  };
}

/**
 * S26b：业务解读（LLM）。先 understand，再基于结构摘要生成业务向说明。
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ force?: boolean, flowName?: string, cacheOnly?: boolean }} [opts]
 */
async function getAppBusinessBrief(robotUuid, cfg, opts = {}) {
  const wb = getWorkbenchConfig(cfg);
  if (!wb.actionsEnabled) {
    return { ok: false, code: 'actions_disabled', message: 'workbench.actionsEnabled=false' };
  }
  // eslint-disable-next-line global-require
  const businessBrief = require('./business-brief');
  // eslint-disable-next-line global-require
  const { isLlmConfigured } = require('./llm');

  const u = getAppUnderstand(robotUuid, cfg, {
    flowName: opts.flowName || '',
    skipCache: false,
  });
  const detail = getAppDetail(robotUuid, cfg);
  const appName =
    (detail.ok && detail.name) ||
    (u.ok && u.result && u.result.projectName) ||
    robotUuid;

  // 只读缓存：刷新页面回显；无缓存不调 LLM
  if (opts.cacheOnly) {
    const cached = businessBrief.loadCachedBusinessBrief(cfg, {
      robotUuid,
      appName,
      understandResult: u.ok ? u.result : null,
    });
    return {
      ...cached,
      robotUuid,
      appName,
      xbotDir: u.ok ? u.xbotDir : null,
      understandCached: !!(u.ok && u.cached),
    };
  }

  if (!isLlmConfigured(cfg)) {
    return {
      ok: false,
      code: 'llm_not_configured',
      message: '未配置 LLM。请打开「设置」配置 API Key。',
      robotUuid,
    };
  }

  if (!u.ok) return { ...u, step: 'understand' };
  if (!u.result || u.result.ok === false) {
    return {
      ok: false,
      code: 'understand_failed',
      message: (u.result && (u.result.reason || u.result.error)) || 'understand 未成功',
      robotUuid,
      understand: u,
    };
  }

  const gen = await businessBrief.generateBusinessBrief(cfg, {
    robotUuid,
    appName,
    understandResult: u.result,
    force: opts.force === true,
  });

  return {
    ...gen,
    robotUuid,
    appName,
    xbotDir: u.xbotDir,
    understandCached: !!u.cached,
  };
}

/**
 * @param {string} robotUuid
 * @param {object} cfg
 */
function openAppFolder(robotUuid, cfg) {
  const wb = getWorkbenchConfig(cfg);
  return openPath.openRobotFolder(robotUuid, {
    cfg,
    enabled: wb.openFolderEnabled,
    openCommand: wb.openCommand,
  });
}

/**
 * 在配置的 Coding Agent 中打开应用目录（不 apply、不写 py）
 * @param {string} robotUuid
 * @param {string} agentId
 * @param {object} cfg
 */
function openAppWithAgent(robotUuid, agentId, cfg) {
  const wb = getWorkbenchConfig(cfg);
  return openPath.openRobotWithAgent(robotUuid, agentId, {
    cfg,
    enabled: wb.openFolderEnabled,
    agents: wb.agents,
  });
}

/**
 * health JSON（兼容原 /health）
 */
function buildHealth(cfg, state = {}) {
  const queue = memory.listQueueItems(cfg.dataDir);
  const startedAt = state.startedAt || Date.now();
  return {
    ok: true,
    service: 'rpa-monitor-agent',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    lastPollAt: state.lastPollAt || null,
    lastDiagnoseAt: state.lastDiagnoseAt || null,
    lastReportAt: state.lastReportAt || null,
    queueDepth: queue.length,
    undiagnosed: queue.filter((q) => !q.diagnosed).length,
    pid: process.pid,
    dataDir: cfg.dataDir,
    workbench: getWorkbenchConfig(cfg).enabled,
  };
}

/**
 * S26：LLM 设置（脱敏 GET / 保存 / 测试）
 */
function getLlmSettings(cfg) {
  // eslint-disable-next-line global-require
  const settingsLlm = require('./settings-llm');
  const wb = getWorkbenchConfig(cfg);
  const pub = settingsLlm.getPublicLlmSettings(cfg);
  pub.settingsEnabled = wb.settingsEnabled;
  return pub;
}

/**
 * 钉钉机器人设置（脱敏 GET / 保存 / 测试发送）
 */
function getDingtalkSettings(cfg) {
  // eslint-disable-next-line global-require
  const settingsDt = require('./settings-dingtalk');
  const wb = getWorkbenchConfig(cfg);
  const pub = settingsDt.getPublicDingtalkSettings(cfg);
  pub.settingsEnabled = wb.settingsEnabled;
  return pub;
}

function saveDingtalkSettingsFromWeb(cfg, body) {
  // eslint-disable-next-line global-require
  const settingsDt = require('./settings-dingtalk');
  const wb = getWorkbenchConfig(cfg);
  const saved = settingsDt.saveDingtalkSettings(cfg.dataDir, body || {}, {
    settingsEnabled: wb.settingsEnabled,
  });
  if (!saved.ok) return saved;
  return { ...getDingtalkSettings(cfg), ok: true, saved: true };
}

/**
 * @param {object} cfg
 * @param {{ force?: boolean }} [opts] force=true 忽略 enabled（测试连接）
 */
async function sendDingtalkDigestFromWeb(cfg, opts = {}) {
  // eslint-disable-next-line global-require
  const morning = require('./morning-digest');
  const wb = getWorkbenchConfig(cfg);
  if (wb.settingsEnabled === false) {
    return { ok: false, code: 'settings_disabled', message: 'workbench.settingsEnabled=false' };
  }
  return morning.sendMorningDigest(cfg, {
    force: opts.force === true,
  });
}

function saveLlmSettingsFromWeb(cfg, body) {
  // eslint-disable-next-line global-require
  const settingsLlm = require('./settings-llm');
  const wb = getWorkbenchConfig(cfg);
  const saved = settingsLlm.saveLlmSettings(cfg.dataDir, body || {}, {
    settingsEnabled: wb.settingsEnabled,
  });
  if (!saved.ok) return saved;
  // 调用方应重新 loadConfig；此处用新鲜配置做脱敏回显
  // eslint-disable-next-line global-require
  const { loadConfig } = require('./config');
  const live = loadConfig();
  return { ...getLlmSettings(live), ok: true, saved: true };
}

/** 业务解读提示词（可配置） */
function getBusinessBriefPromptSettings(cfg) {
  // eslint-disable-next-line global-require
  const businessBrief = require('./business-brief');
  const wb = getWorkbenchConfig(cfg);
  const pub = businessBrief.getPublicPromptSettings(cfg.dataDir);
  pub.settingsEnabled = wb.settingsEnabled;
  return pub;
}

function saveBusinessBriefPromptSettings(cfg, body) {
  // eslint-disable-next-line global-require
  const businessBrief = require('./business-brief');
  const wb = getWorkbenchConfig(cfg);
  return businessBrief.savePromptSettings(cfg.dataDir, body || {}, {
    settingsEnabled: wb.settingsEnabled,
  });
}

function resetBusinessBriefPromptSettings(cfg) {
  // eslint-disable-next-line global-require
  const businessBrief = require('./business-brief');
  const wb = getWorkbenchConfig(cfg);
  return businessBrief.resetPromptSettings(cfg.dataDir, {
    settingsEnabled: wb.settingsEnabled,
  });
}

async function testLlmSettingsFromWeb(cfg, body) {
  // eslint-disable-next-line global-require
  const settingsLlm = require('./settings-llm');
  const wb = getWorkbenchConfig(cfg);
  if (!wb.settingsEnabled) {
    return { ok: false, code: 'settings_disabled', message: 'workbench.settingsEnabled=false' };
  }
  return settingsLlm.testLlmConnection(cfg, body && Object.keys(body).length ? body : null);
}

/**
 * 导出业务流程 Markdown（仅已缓存 brief，不调 LLM）
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ flowName?: string }} [opts]
 */
async function exportAppBusinessMarkdown(robotUuid, cfg, opts = {}) {
  // eslint-disable-next-line global-require
  const exportDoc = require('./export-flow-doc');
  const data = await getAppBusinessBrief(robotUuid, cfg, {
    cacheOnly: true,
    flowName: opts.flowName || '',
  });
  if (!data || data.ok === false) {
    return {
      ok: false,
      code: (data && data.code) || 'export_failed',
      message: (data && data.message) || '无法导出业务解读',
      robotUuid,
    };
  }
  if (!data.brief) {
    return {
      ok: false,
      code: 'no_brief',
      message: '尚未生成业务解读，请先在「业务流程」页生成',
      robotUuid,
    };
  }
  const pack = {
    brief: data.brief,
    appName: data.appName,
    robotUuid,
    model: data.model,
    generatedAt: data.generatedAt,
    stale: data.stale,
    disclaimer: data.disclaimer,
    flowDiagram: data.flowDiagram || data.brief.flowDiagram || null,
  };
  return {
    ok: true,
    kind: 'business',
    robotUuid,
    appName: data.appName,
    filename: exportDoc.businessExportFilename(pack),
    markdown: exportDoc.businessBriefToMarkdown(pack),
  };
}

/**
 * 导出实现流程 Markdown（understand 缓存或实时）
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ flowName?: string, skipCache?: boolean }} [opts]
 */
function exportAppImplMarkdown(robotUuid, cfg, opts = {}) {
  // eslint-disable-next-line global-require
  const exportDoc = require('./export-flow-doc');
  const u = getAppUnderstand(robotUuid, cfg, {
    flowName: opts.flowName || '',
    skipCache: opts.skipCache === true,
  });
  if (!u.ok) {
    return {
      ok: false,
      code: u.code || 'understand_failed',
      message: u.message || '无法解析实现流程',
      robotUuid,
    };
  }
  const r = u.result || {};
  if (r.ok === false) {
    return {
      ok: false,
      code: 'understand_failed',
      message: r.reason || r.error || 'understand 未成功',
      robotUuid,
    };
  }
  const detail = getAppDetail(robotUuid, cfg);
  const appName = (detail.ok && detail.name) || r.projectName || robotUuid;
  const pack = {
    result: r,
    appName,
    robotUuid,
    cached: !!u.cached,
    xbotDir: u.xbotDir,
  };
  return {
    ok: true,
    kind: 'impl',
    robotUuid,
    appName,
    filename: exportDoc.implExportFilename(pack),
    markdown: exportDoc.implFlowToMarkdown(pack),
  };
}

module.exports = {
  getWorkbenchConfig,
  aggregateFailuresByRobot,
  failureTimeOf,
  buildPriorityQueue,
  indexPatchesByFingerprint,
  crossFingerprintSet,
  PRIORITY_WEIGHTS,
  PRIORITY_LABELS,
  buildOverview,
  listAppsWithStats,
  getAppDetail,
  getAppUnderstand,
  getAppBusinessBrief,
  exportAppBusinessMarkdown,
  exportAppImplMarkdown,
  openAppFolder,
  openAppWithAgent,
  listOpenAgents,
  buildHealth,
  invalidateAppsCache,
  getAppsBundle,
  getFindingDetail,
  getFindingHandoff,
  getAppHandoff,
  setFindingWorkStatus,
  classifyBucket: bucketLib.classifyBucket,
  listPatchesForWorkbench,
  getPatchDetail,
  runWorkbenchAction,
  runManualPoll,
  listReports,
  getReport,
  generateReport,
  getLlmSettings,
  saveLlmSettingsFromWeb,
  testLlmSettingsFromWeb,
  getDingtalkSettings,
  saveDingtalkSettingsFromWeb,
  sendDingtalkDigestFromWeb,
  getBusinessBriefPromptSettings,
  saveBusinessBriefPromptSettings,
  resetBusinessBriefPromptSettings,
};
