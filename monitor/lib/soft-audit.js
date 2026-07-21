/**
 * 成功抽检：成功 job 日志尾部 → soft finding（抽检命中）
 *
 * - 只扫尚未审计的 jobUuid（data/soft-audit.json）
 * - 每轮配额 + 每应用上限 + 可选白名单
 * - 倒序 size=K 看末尾是否有错误级日志
 * - 命中则入 queue（failureKind=soft），与 hard 指纹隔离
 */

const fs = require('fs');
const path = require('path');
const { buildFingerprint, isFailedStatus } = require('./fingerprint');
const memory = require('./memory');
const yingdao = require('./yingdao');
const pollRuns = require('./poll-runs');

const STORE_FILE = 'soft-audit.json';
const STORE_VERSION = 1;

/** 影刀常见「成功结束」状态 */
const SUCCESS_STATUSES = new Set([
  'finish',
  'finished',
  'success',
  'succeed',
  'succeeded',
  'completed',
  'complete',
  'ok',
  'normal',
  '成功',
  '完成',
  '正常',
]);

/** 仍在跑 / 未结束，不做 soft 审计 */
const ACTIVE_STATUSES = new Set([
  'running',
  'waiting',
  'pending',
  'queue',
  'queued',
  'start',
  'starting',
  'dispatch',
  'dispatched',
  '运行中',
  '等待',
]);

const DEFAULT_ERROR_LEVEL_RE = /错误|error|err|exception|fatal/i;
const DEFAULT_ERROR_TEXT_RE =
  /IndexError|list index out of range|NoneType|AttributeError|Traceback|超时|timeout|元素未找到|找不到元素|匹配到多个元素|No such file|失败|异常/i;

function storePath(dataDir) {
  return path.join(dataDir, STORE_FILE);
}

function emptyStore() {
  return { version: STORE_VERSION, updatedAt: null, byJob: {} };
}

/**
 * @param {string} dataDir
 */
function loadStore(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyStore();
    return {
      version: STORE_VERSION,
      updatedAt: raw.updatedAt || null,
      byJob: raw.byJob && typeof raw.byJob === 'object' ? raw.byJob : {},
    };
  } catch {
    return emptyStore();
  }
}

/**
 * @param {string} dataDir
 * @param {object} store
 */
function saveStore(dataDir, store) {
  memory.ensureDir(dataDir);
  const file = storePath(dataDir);
  const payload = {
    version: STORE_VERSION,
    updatedAt: new Date().toISOString(),
    byJob: store.byJob || {},
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * @param {object} store
 * @param {string} jobUuid
 */
function isAudited(store, jobUuid) {
  if (!jobUuid || !store || !store.byJob) return false;
  const row = store.byJob[jobUuid];
  if (!row) return false;
  // fetch_error 未标 audited 成功时允许重试：仅 clean/soft 算已审计
  return row.result === 'clean' || row.result === 'soft';
}

/**
 * @param {object} store
 * @param {string} jobUuid
 * @param {{ result: string, fingerprint?: string, reason?: string, at?: string }} meta
 */
function markAudited(store, jobUuid, meta) {
  if (!jobUuid) return;
  if (!store.byJob) store.byJob = {};
  store.byJob[jobUuid] = {
    at: meta.at || new Date().toISOString(),
    result: meta.result || 'clean',
    fingerprint: meta.fingerprint || null,
    reason: meta.reason ? String(meta.reason).slice(0, 200) : null,
  };
}

/**
 * 淘汰过期 job 记录
 * @param {object} store
 * @param {number} retainDays
 */
function pruneStore(store, retainDays = 14) {
  const days = Number(retainDays);
  if (!(days > 0) || !store.byJob) return { removed: 0 };
  const cutoff = Date.now() - days * 86400 * 1000;
  let removed = 0;
  for (const [id, row] of Object.entries(store.byJob)) {
    const t = row && row.at ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(t) || t < cutoff) {
      delete store.byJob[id];
      removed += 1;
    }
  }
  return { removed };
}

/**
 * @param {any} status
 */
function isSuccessStatus(status) {
  const t = String(status || '')
    .trim()
    .toLowerCase();
  if (!t) return false;
  if (isFailedStatus(status)) return false;
  if (ACTIVE_STATUSES.has(t)) return false;
  if (SUCCESS_STATUSES.has(t)) return true;
  // 兼容数字枚举等：仅明确成功词
  return /finish|success|complete|成功|完成/.test(t);
}

/**
 * 合并优先级：env > data/settings.success-check.json > config.local softFail > 默认
 * @param {object} cfg
 * @param {object} [options] poll options 覆盖
 */
function getSoftConfig(cfg = {}, options = {}) {
  const local = (cfg.softFail && typeof cfg.softFail === 'object' ? cfg.softFail : {}) || {};
  let file = { hasFile: false };
  try {
    // eslint-disable-next-line global-require
    file = require('./settings-success-check').getFileOverlay(cfg.dataDir || '') || { hasFile: false };
  } catch {
    file = { hasFile: false };
  }

  // 文件层覆盖 local（有文件时）
  const s = file.hasFile
    ? {
        ...local,
        enabled: file.enabled,
        maxPerPoll: file.maxPerPoll,
        maxPerAppPerPoll: file.maxPerAppPerPoll,
        tailSize: file.tailSize,
        sort: file.sort,
        minIntervalMs: file.minIntervalMs,
        retainDays: file.retainDays,
        robotUuidAllowlist: file.robotUuidAllowlist,
        robotUuidPriority: file.robotUuidPriority,
      }
    : { ...local };

  const envOn = process.env.SOFT_FAIL;
  let enabled = s.enabled !== false;
  if (envOn != null && String(envOn).trim() !== '') {
    enabled = !/^(0|false|no|off)$/i.test(String(envOn).trim());
  }
  if (options.softFail === false) enabled = false;
  if (options.softFail === true) enabled = true;

  const allow = Array.isArray(s.robotUuidAllowlist)
    ? s.robotUuidAllowlist.map(String).filter(Boolean)
    : [];
  const priority = Array.isArray(s.robotUuidPriority)
    ? s.robotUuidPriority.map(String).filter(Boolean)
    : Array.isArray(s.robotUuids)
      ? s.robotUuids.map(String).filter(Boolean)
      : [];

  return {
    enabled,
    maxPerPoll: clampInt(
      options.maxSoftPerPoll ?? process.env.SOFT_FAIL_MAX_PER_POLL ?? s.maxPerPoll,
      25,
      0,
      200,
    ),
    maxPerAppPerPoll: clampInt(s.maxPerAppPerPoll, 5, 0, 50),
    tailSize: clampInt(s.tailSize ?? process.env.SOFT_FAIL_TAIL_SIZE, 10, 1, 50),
    /** 影刀 queryFilter.sort：倒序取最新一页；若环境实测不同可在 config 覆盖 */
    sort: s.sort != null ? String(s.sort) : 'desc',
    minIntervalMs: clampInt(
      s.minIntervalMs ?? process.env.YD_LOG_SEARCH_MIN_INTERVAL_MS,
      220,
      0,
      5000,
    ),
    retainDays: clampInt(s.retainDays, 14, 1, 90),
    robotUuidAllowlist: allow,
    robotUuidPriority: priority,
    errorLevelRe: s.errorLevelRe || null,
    errorTextRe: s.errorTextRe || null,
    source: file.hasFile ? 'settings.success-check.json' : 'config',
  };
}

function clampInt(v, def, min, max) {
  const n = v != null && String(v).trim() !== '' ? parseInt(String(v), 10) : def;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * 判断单行是否像错误
 * @param {any} line
 * @param {{ errorLevelRe?: RegExp|null, errorTextRe?: RegExp|null }} [cfg]
 */
function isErrorLogLine(line, cfg = {}) {
  if (!line || typeof line !== 'object') return false;
  const level = String(line.level || line.logLevel || '');
  const text = String(line.text || line.message || line.content || line.log || '');
  const levelRe = cfg.errorLevelRe instanceof RegExp ? cfg.errorLevelRe : DEFAULT_ERROR_LEVEL_RE;
  if (level && levelRe.test(level)) return true;
  // level 空时：正文强错误词也算（末 10 条内）
  const textRe = cfg.errorTextRe instanceof RegExp ? cfg.errorTextRe : DEFAULT_ERROR_TEXT_RE;
  if (!level && text && textRe.test(text)) return true;
  if (level && /info|信息|debug|调试|warn|警告/i.test(level) && !levelRe.test(level)) {
    return false;
  }
  if (levelRe.test(level)) return true;
  return false;
}

/**
 * 审计尾部日志（已是倒序第一页或正序截尾后的数组）
 * @param {any[]} logs
 * @param {object} [softCfg]
 * @returns {{ matched: boolean, reason: string, errorLines: any[], sampleText: string }}
 */
function evaluateTailLogs(logs, softCfg = {}) {
  const list = Array.isArray(logs) ? logs : [];
  const errorLines = list.filter((l) => isErrorLogLine(l, softCfg));
  if (!errorLines.length) {
    return { matched: false, reason: 'tail_clean', errorLines: [], sampleText: '' };
  }
  const first = errorLines[0];
  const sampleText = String(first.text || first.message || first.content || '').slice(0, 500);
  const level = String(first.level || first.logLevel || '');
  return {
    matched: true,
    reason: `tail_error_level:${level || 'text'}`,
    errorLines,
    sampleText,
  };
}

/**
 * soft 与 hard 指纹隔离：前缀 soft_
 * @param {object} fp buildFingerprint 结果
 */
function toSoftFingerprint(fp) {
  const base = fp && fp.fingerprint ? String(fp.fingerprint) : 'unknown';
  const sig = fp && fp.errorSignature ? String(fp.errorSignature) : '';
  return {
    ...fp,
    fingerprint: base.startsWith('soft_') ? base : `soft_${base}`,
    errorSignature: sig ? (sig.startsWith('soft|') ? sig : `soft|${sig}`) : sig,
    failureKind: 'soft',
    jobStatus: 'success',
  };
}

/**
 * 选择本轮要审计的成功 job（配额 / 白名单 / 优先 / 每应用上限 / 已审计跳过）
 * @param {object[]} candidates
 * @param {object} store
 * @param {ReturnType<typeof getSoftConfig>} softCfg
 */
function selectCandidates(candidates, store, softCfg) {
  const allow = new Set(softCfg.robotUuidAllowlist || []);
  const priority = new Set(softCfg.robotUuidPriority || []);
  const maxPerApp = softCfg.maxPerAppPerPoll;
  const maxTotal = softCfg.maxPerPoll;

  let list = (candidates || []).filter((j) => j && j.jobUuid && isSuccessStatus(j.status));
  // 去重 jobUuid（保留先出现的）
  const seen = new Set();
  list = list.filter((j) => {
    if (seen.has(j.jobUuid)) return false;
    seen.add(j.jobUuid);
    return true;
  });

  list = list.filter((j) => !isAudited(store, j.jobUuid));

  if (allow.size) {
    list = list.filter((j) => allow.has(String(j.robotUuid || '')));
  }

  // 优先白名单应用在前
  list.sort((a, b) => {
    const ap = priority.has(String(a.robotUuid || '')) ? 0 : 1;
    const bp = priority.has(String(b.robotUuid || '')) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return 0;
  });

  const perApp = new Map();
  const selected = [];
  let skippedQuota = 0;
  let skippedAppCap = 0;

  for (const j of list) {
    if (selected.length >= maxTotal) {
      skippedQuota += 1;
      continue;
    }
    const app = String(j.robotUuid || 'unknown');
    const n = perApp.get(app) || 0;
    if (maxPerApp > 0 && n >= maxPerApp) {
      skippedAppCap += 1;
      continue;
    }
    perApp.set(app, n + 1);
    selected.push(j);
  }

  return {
    selected,
    skippedQuota,
    skippedAppCap,
    pendingUnaudited: list.length,
  };
}

/**
 * 执行 soft 审计并入队
 *
 * @param {string} token
 * @param {string} dataDir
 * @param {object[]} successJobs
 * @param {object} cfg
 * @param {{ softFail?: boolean, maxSoftPerPoll?: number }} [options]
 * @returns {Promise<object>}
 */
async function auditSuccessJobs(token, dataDir, successJobs, cfg, options = {}) {
  const softCfg = getSoftConfig(cfg, options);
  const stats = {
    enabled: softCfg.enabled,
    candidates: 0,
    pendingUnaudited: 0,
    selected: 0,
    audited: 0,
    clean: 0,
    softHit: 0,
    softEnqueued: 0,
    softUpdated: 0,
    fetchError: 0,
    skippedQuota: 0,
    skippedAppCap: 0,
    skippedAudited: 0,
  };

  if (!softCfg.enabled) {
    return { stats, archivedJobs: [], softCfg };
  }

  yingdao.configureLogSearchRate({ minIntervalMs: softCfg.minIntervalMs });

  const store = loadStore(dataDir);
  pruneStore(store, softCfg.retainDays);

  const allSuccess = (successJobs || []).filter((j) => j && j.jobUuid && isSuccessStatus(j.status));
  stats.candidates = allSuccess.length;
  stats.skippedAudited = allSuccess.filter((j) => isAudited(store, j.jobUuid)).length;

  const pick = selectCandidates(allSuccess, store, softCfg);
  stats.pendingUnaudited = pick.pendingUnaudited;
  stats.selected = pick.selected.length;
  stats.skippedQuota = pick.skippedQuota;
  stats.skippedAppCap = pick.skippedAppCap;

  /** @type {object[]} */
  const archivedJobs = [];

  for (const job of pick.selected) {
    let logs = [];
    try {
      const logRes = await yingdao.searchLogs(token, job.jobUuid, {
        page: 1,
        size: softCfg.tailSize,
        sort: softCfg.sort,
      });
      logs = logRes.logs || [];
    } catch (e) {
      stats.fetchError += 1;
      stats.audited += 1;
      // 拉失败不记 clean/soft，下轮可重试（不 markAudited 成功态）
      archivedJobs.push({
        jobUuid: job.jobUuid,
        robotUuid: job.robotUuid || '',
        robotName: job.robotName || '',
        taskName: job.taskName || '',
        robotClientName: job.robotClientName || '',
        robotClientUuid: job.robotClientUuid || '',
        status: job.status || '',
        fingerprint: '',
        failureAt: memory.pickJobFailureAt(job) || null,
        remark: job.remark || '',
        flowName: '',
        lineNumber: '',
        errorType: '',
        logs: [],
        logFetchError: e.message || String(e),
        logSkipped: false,
        failureKind: 'soft_scan',
      });
      continue;
    }

    stats.audited += 1;
    const verdict = evaluateTailLogs(logs, softCfg);

    if (!verdict.matched) {
      stats.clean += 1;
      markAudited(store, job.jobUuid, { result: 'clean', reason: verdict.reason });
      // clean 不落 poll-runs（只记已审计集合，控磁盘）
      continue;
    }

    // 命中：构建 soft fingerprint 并入队
    stats.softHit += 1;
    const errLogs = verdict.errorLines.length ? verdict.errorLines : logs;
    let fp = buildFingerprint({
      robotUuid: job.robotUuid,
      robotName: job.robotName,
      taskName: job.taskName,
      robotClientName: job.robotClientName,
      robotClientUuid: job.robotClientUuid,
      remark: job.remark || '',
      jobUuid: job.jobUuid,
      logs: errLogs,
    });
    const softRemark = `[成功抽检] 任务状态成功，但末尾日志含错误：${verdict.sampleText || fp.rawRemark || ''}`.slice(
      0,
      2000,
    );
    fp = toSoftFingerprint({
      ...fp,
      rawRemark: softRemark,
    });

    const existed = memory.loadQueueItem(dataDir, fp.fingerprint);
    const failureAt =
      memory.pickJobFailureAt(job) || job.endTime || job.updateTime || job.triggerTime || null;
    const item = memory.upsertQueueItem(
      dataDir,
      {
        ...fp,
        failureKind: 'soft',
        jobStatus: String(job.status || 'success'),
        rawRemark: softRemark,
      },
      {
        jobUuid: job.jobUuid,
        failureAt: failureAt || undefined,
      },
    );
    if (existed) stats.softUpdated += 1;
    else stats.softEnqueued += 1;

    markAudited(store, job.jobUuid, {
      result: 'soft',
      fingerprint: fp.fingerprint,
      reason: verdict.reason,
    });

    archivedJobs.push({
      jobUuid: job.jobUuid,
      robotUuid: job.robotUuid || item.robotUuid || '',
      robotName: job.robotName || item.robotName || '',
      taskName: job.taskName || item.taskName || '',
      robotClientName: job.robotClientName || item.robotClientName || '',
      robotClientUuid: job.robotClientUuid || item.robotClientUuid || '',
      status: job.status || '',
      fingerprint: fp.fingerprint,
      failureAt: failureAt || null,
      remark: softRemark,
      flowName: fp.flowName || '',
      lineNumber: fp.lineNumber || '',
      errorType: fp.errorType || '',
      logs: pollRuns.compactLogs(logs, softCfg.tailSize),
      logFetchError: null,
      logSkipped: false,
      failureKind: 'soft',
      softResult: 'soft',
    });
  }

  saveStore(dataDir, store);
  return { stats, archivedJobs, softCfg };
}

module.exports = {
  STORE_FILE,
  SUCCESS_STATUSES,
  getSoftConfig,
  loadStore,
  saveStore,
  isAudited,
  markAudited,
  pruneStore,
  isSuccessStatus,
  isErrorLogLine,
  evaluateTailLogs,
  toSoftFingerprint,
  selectCandidates,
  auditSuccessJobs,
  storePath,
};
