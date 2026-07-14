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

/**
 * @param {object} cfg
 * @param {{ startedAt?: number, lastPollAt?: string|null, lastDiagnoseAt?: string|null, lastReportAt?: string|null }} state
 */
function buildOverview(cfg, state = {}) {
  const bundle = getAppsBundle(cfg);
  const { scan, queueItems, queueStats } = bundle;
  const undiagnosed = queueItems.filter((q) => !q.diagnosed).length;

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
  const crossAppGroups = mergeByErrorSignature(queueItems, { minApps: 2 }).slice(0, 12);

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
    },
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
    /** 影刀 job.robotClientName：运行客户端 / 机器人 */
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
    fixClass: triage.fixClass,
    fixability: triage.fixability,
    canPreviewFix: canPreviewFix(triage),
    guidance,
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
    // 附加字段：失败详情「复制路径 / Agent 提示」；旧客户端可忽略
    xbotDir,
    appName: appName || null,
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
  listPatchesForWorkbench,
  getPatchDetail,
  runWorkbenchAction,
  listReports,
  getReport,
  generateReport,
  getLlmSettings,
  saveLlmSettingsFromWeb,
  testLlmSettingsFromWeb,
  getBusinessBriefPromptSettings,
  saveBusinessBriefPromptSettings,
  resetBusinessBriefPromptSettings,
};
