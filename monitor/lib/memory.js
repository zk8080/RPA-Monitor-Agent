/**
 * 本地 Memory 读写：cursor / queue / alerts
 * 单文件原子写，无 DB。
 */

const fs = require('fs');
const path = require('path');
const workStatusLib = require('./work-status');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @param {string} dataDir
 */
function paths(dataDir) {
  return {
    dataDir,
    cursor: path.join(dataDir, 'cursor.json'),
    queueDir: path.join(dataDir, 'queue'),
    alertsDir: path.join(dataDir, 'alerts'),
    kbDir: path.join(dataDir, 'kb'),
    reportsDir: path.join(dataDir, 'reports'),
    appMap: path.join(dataDir, 'app-map.json'),
    /** robotUuid → 调度任务名索引（含成功 job，不依赖失败入队） */
    taskIndex: path.join(dataDir, 'task-index.json'),
  };
}

/**
 * 加载任务名索引
 * @param {string} dataDir
 * @returns {{ version: number, updatedAt: string|null, byRobot: Object<string, object> }}
 */
function loadTaskIndex(dataDir) {
  const raw = readJson(paths(dataDir).taskIndex, null);
  if (!raw || typeof raw !== 'object') {
    return { version: 1, updatedAt: null, byRobot: {} };
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt || null,
    byRobot: raw.byRobot && typeof raw.byRobot === 'object' ? raw.byRobot : {},
  };
}

/**
 * 从 job 列表增量更新任务名 / 运行客户端索引（成功/失败都记）
 * @param {string} dataDir
 * @param {Array<{
 *   robotUuid?: string,
 *   robotName?: string,
 *   taskName?: string,
 *   robotClientName?: string,
 *   robotClientUuid?: string,
 *   status?: string,
 *   triggerTime?: string,
 * }>} jobs
 * @returns {{ touched: number, robots: number }}
 */
function upsertTaskNamesFromJobs(dataDir, jobs) {
  if (!Array.isArray(jobs) || !jobs.length) {
    return { touched: 0, robots: 0 };
  }
  const idx = loadTaskIndex(dataDir);
  let touched = 0;
  const now = new Date().toISOString();

  for (const job of jobs) {
    const robotUuid = job && job.robotUuid ? String(job.robotUuid).trim() : '';
    const taskName = job && job.taskName != null ? String(job.taskName).trim() : '';
    const robotClientName =
      job && job.robotClientName != null ? String(job.robotClientName).trim() : '';
    const robotClientUuid =
      job && job.robotClientUuid != null ? String(job.robotClientUuid).trim() : '';
    // 至少要有任务名或客户端名之一才值得写入
    if (!robotUuid || (!taskName && !robotClientName)) continue;

    let row = idx.byRobot[robotUuid];
    if (!row || typeof row !== 'object') {
      row = {
        robotUuid,
        robotName: '',
        taskName: '',
        taskNames: [],
        robotClientName: '',
        robotClientUuid: '',
        lastStatus: '',
        lastSeenAt: null,
        updatedAt: now,
      };
      idx.byRobot[robotUuid] = row;
    }

    if (job.robotName) row.robotName = String(job.robotName);
    if (!Array.isArray(row.taskNames)) row.taskNames = [];
    if (taskName) {
      row.taskNames = [taskName, ...row.taskNames.filter((t) => t !== taskName)].slice(0, 12);
    }
    if (job.status != null) row.lastStatus = String(job.status);
    // 用 job 时间作「最近见到」；无则用 poll 时刻
    const seen =
      normalizeTime(job.triggerTime) ||
      normalizeTime(job.updateTime) ||
      normalizeTime(job.endTime) ||
      now;
    if (!row.lastSeenAt || String(seen) >= String(row.lastSeenAt)) {
      row.lastSeenAt = seen;
      if (taskName) row.taskName = taskName;
      if (robotClientName) row.robotClientName = robotClientName;
      if (robotClientUuid) row.robotClientUuid = robotClientUuid;
    } else {
      // 非最新 job 仍可补空字段
      if (taskName && !row.taskName) row.taskName = taskName;
      if (robotClientName && !row.robotClientName) row.robotClientName = robotClientName;
      if (robotClientUuid && !row.robotClientUuid) row.robotClientUuid = robotClientUuid;
    }
    row.updatedAt = now;
    touched += 1;
  }

  if (touched > 0) {
    idx.updatedAt = now;
    atomicWriteJson(paths(dataDir).taskIndex, idx);
  }
  return { touched, robots: Object.keys(idx.byRobot).length };
}

/**
 * @param {string} dataDir
 * @param {string} robotUuid
 * @returns {object|null}
 */
function getTaskIndexEntry(dataDir, robotUuid) {
  if (!robotUuid) return null;
  const idx = loadTaskIndex(dataDir);
  return idx.byRobot[robotUuid] || null;
}

function loadCursor(dataDir) {
  const p = paths(dataDir);
  return readJson(p.cursor, { lastNextId: null, lastPollAt: null });
}

function saveCursor(dataDir, cursor) {
  atomicWriteJson(paths(dataDir).cursor, cursor);
}

function queuePath(dataDir, fingerprint) {
  const safe = String(fingerprint).replace(/[^\w.\u4e00-\u9fff-]+/g, '_');
  return path.join(paths(dataDir).queueDir, `${safe}.json`);
}

function loadQueueItem(dataDir, fingerprint) {
  return readJson(queuePath(dataDir, fingerprint), null);
}

/**
 * 将影刀时间 / ISO / Date 规范为 ISO 字符串（本地 yyyy-MM-dd HH:mm:ss 按本机时区解析）
 * @param {string|number|Date|null|undefined} value
 * @returns {string|null}
 */
function normalizeTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return null;
  // 影刀：yyyy-MM-dd HH:mm:ss（无时区，按本地）
  const yd = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (yd) {
    const d = new Date(
      Number(yd[1]),
      Number(yd[2]) - 1,
      Number(yd[3]),
      Number(yd[4]),
      Number(yd[5]),
      Number(yd[6]),
    );
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return String(a) >= String(b) ? a : b;
}

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return String(a) <= String(b) ? a : b;
}

/**
 * 从影刀 job 取「失败发生时间」：优先结束时间，其次开始/触发时间
 * @param {object} job
 * @returns {string|null} ISO
 */
function pickJobFailureAt(job = {}) {
  return (
    normalizeTime(job.endTime) ||
    normalizeTime(job.finishTime) ||
    normalizeTime(job.startTime) ||
    normalizeTime(job.triggerTime) ||
    null
  );
}

/**
 * 写入或合并 queue 条目（同指纹累加 occurrence）
 *
 * 时间语义：
 * - firstSeen / lastSeen / lastFailureAt：任务真实失败时间（来自影刀 job）
 * - lastPolledAt：本机 poll 写入时间（发现/刷新时刻）
 *
 * @param {string} dataDir
 * @param {object} item
 * @param {{ jobUuid?: string, failureAt?: string|Date|number, now?: string }} [meta]
 */
function upsertQueueItem(dataDir, item, meta = {}) {
  const now = normalizeTime(meta.now) || new Date().toISOString();
  const failureAt = normalizeTime(meta.failureAt);
  const existing = loadQueueItem(dataDir, item.fingerprint);
  const sampleJobUuids = existing?.sampleJobUuids ? [...existing.sampleJobUuids] : [];
  const alreadyHadJob = Boolean(meta.jobUuid && sampleJobUuids.includes(meta.jobUuid));
  if (meta.jobUuid && !alreadyHadJob) {
    sampleJobUuids.push(meta.jobUuid);
    if (sampleJobUuids.length > 10) sampleJobUuids.shift();
  }

  // 有 jobUuid 时：仅新 job 计一次；无 uuid 时每次观察 +1（兼容旧调用）
  const isNewOccurrence = meta.jobUuid ? !alreadyHadJob : true;
  /** 与 isNewOccurrence 在有 jobUuid 时一致；无 uuid 时不算「新 job 唤醒」 */
  const isNewJob = Boolean(meta.jobUuid && !alreadyHadJob);
  const occurrenceCount = isNewOccurrence
    ? (existing?.occurrenceCount || 0) + 1
    : existing?.occurrenceCount || 1;

  // failureAtTrusted：标记 last/firstFailureAt 是否来自影刀 job（可纠偏 poll 时刻污染）
  let lastFailureAt = existing?.lastFailureAt || null;
  let firstFailureAt = existing?.firstFailureAt || existing?.firstSeen || null;
  let failureAtTrusted = existing?.failureAtTrusted === true;

  if (failureAt) {
    if (failureAtTrusted) {
      lastFailureAt = maxIso(lastFailureAt, failureAt);
      firstFailureAt = firstFailureAt ? minIso(firstFailureAt, failureAt) : failureAt;
    } else {
      // 丢弃未信任的 poll 回退时间，改用真实 job 时间
      lastFailureAt = failureAt;
      firstFailureAt = failureAt;
    }
    failureAtTrusted = true;
  } else if (isNewOccurrence) {
    if (!failureAtTrusted) {
      lastFailureAt = maxIso(lastFailureAt, now);
      if (!firstFailureAt) firstFailureAt = lastFailureAt || now;
    }
    // 已有可信失败时间时，无 job 时间不把 lastSeen 推到 poll 时刻
  } else {
    lastFailureAt = lastFailureAt || existing?.lastSeen || now;
    firstFailureAt = firstFailureAt || lastFailureAt;
  }

  // 展示字段与 lastFailureAt 对齐，兼容 Web / report / merge
  const lastSeen = lastFailureAt || existing?.lastSeen || now;
  const firstSeen = firstFailureAt || existing?.firstSeen || lastSeen;

  // 调度任务名：保留最近出现过的 taskName（同一应用可挂多个任务）
  const taskName = (item.taskName || existing?.taskName || '').trim();
  let recentTaskNames = Array.isArray(existing?.recentTaskNames)
    ? existing.recentTaskNames.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  if (taskName) {
    recentTaskNames = [taskName, ...recentTaskNames.filter((t) => t !== taskName)].slice(0, 8);
  }

  const robotClientName = String(
    item.robotClientName || existing?.robotClientName || '',
  ).trim();
  const robotClientUuid = String(
    item.robotClientUuid || existing?.robotClientUuid || '',
  ).trim();

  const next = {
    fingerprint: item.fingerprint,
    errorSignature: item.errorSignature || existing?.errorSignature || null,
    robotUuid: item.robotUuid || existing?.robotUuid || '',
    robotName: item.robotName || existing?.robotName || '',
    taskName: taskName || existing?.taskName || '',
    recentTaskNames,
    robotClientName,
    robotClientUuid,
    flowName: item.flowName || existing?.flowName || '',
    lineNumber: item.lineNumber || existing?.lineNumber || '',
    errorType: item.errorType || existing?.errorType || '',
    elementName: item.elementName || existing?.elementName || '',
    occurrenceCount,
    firstSeen,
    lastSeen,
    firstFailureAt: firstFailureAt || firstSeen,
    lastFailureAt: lastFailureAt || lastSeen,
    failureAtTrusted,
    lastPolledAt: now,
    sampleJobUuids,
    rawRemark: item.rawRemark || existing?.rawRemark || '',
    diagnosed: existing?.diagnosed === true,
    kbId: existing?.kbId ?? null,
    // hard=影刀 status 失败；soft=任务成功但日志尾部异常（假成功）
    failureKind:
      item.failureKind === 'soft' || item.failureKind === 'hard'
        ? item.failureKind
        : existing?.failureKind === 'soft' || existing?.failureKind === 'hard'
          ? existing.failureKind
          : 'hard',
    jobStatus:
      item.jobStatus != null && String(item.jobStatus).trim() !== ''
        ? String(item.jobStatus)
        : existing?.jobStatus || null,
  };

  // workStatus：新 job 唤醒规则；无新 job 保留人工处置
  const ws = workStatusLib.mergeWorkStatusOnUpsert(existing, {
    isNewJob,
    forceOpen: meta.forceOpenWorkStatus === true,
    now,
  });
  next.workStatus = ws.workStatus;
  next.snoozedUntil = ws.snoozedUntil;
  next.workStatusUpdatedAt = ws.workStatusUpdatedAt;
  next.workStatusReason = ws.workStatusReason;
  next.reopenedBy = ws.reopenedBy;
  next.ignoredStillFailing = ws.ignoredStillFailing;

  // 保留诊断等扩展字段（同指纹再扫时不丢）
  if (existing) {
    if (existing.diagnosedAt) next.diagnosedAt = existing.diagnosedAt;
    if (existing.lastDiagnosis) next.lastDiagnosis = existing.lastDiagnosis;
    if (existing.fixStatus) next.fixStatus = existing.fixStatus;
    if (existing.lastPatchId) next.lastPatchId = existing.lastPatchId;
  }

  atomicWriteJson(queuePath(dataDir, item.fingerprint), next);
  return next;
}

/**
 * 人工设置 queue workStatus（open / snoozed / ignored）
 * @param {string} dataDir
 * @param {string} fingerprint
 * @param {'open'|'snoozed'|'ignored'} status
 * @param {{ snoozeDays?: number, snoozedUntil?: string, reason?: string }} [opts]
 */
function setQueueWorkStatus(dataDir, fingerprint, status, opts = {}) {
  const existing = loadQueueItem(dataDir, fingerprint);
  if (!existing) return null;
  const next = workStatusLib.applyManualWorkStatus(existing, status, opts);
  atomicWriteJson(queuePath(dataDir, fingerprint), next);
  return next;
}

function listQueueItems(dataDir) {
  const dir = paths(dataDir).queueDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean);
}

/**
 * 标记 queue 条目已诊断
 * @param {string} dataDir
 * @param {string} fingerprint
 * @param {{ kbId?: string, diagnosis?: object }} extra
 */
function markQueueDiagnosed(dataDir, fingerprint, extra = {}) {
  const existing = loadQueueItem(dataDir, fingerprint);
  if (!existing) return null;
  const next = {
    ...existing,
    diagnosed: true,
    diagnosedAt: new Date().toISOString(),
    kbId: extra.kbId || existing.kbId || null,
  };
  if (extra.diagnosis) {
    next.lastDiagnosis = {
      rootCause: extra.diagnosis.rootCause,
      suggestion: extra.diagnosis.suggestion,
      confidence: extra.diagnosis.confidence,
      errorCategory: extra.diagnosis.errorCategory,
      location: extra.diagnosis.location,
      fixClass: extra.diagnosis.fixClass,
      fixability: extra.diagnosis.fixability,
      source: extra.diagnosis.source,
    };
  }
  atomicWriteJson(queuePath(dataDir, fingerprint), next);
  return next;
}

/**
 * @param {string} dataDir
 * @param {object} alert
 */
function writeAlert(dataDir, alert) {
  const dir = paths(dataDir).alertsDir;
  ensureDir(dir);
  const ts = new Date();
  const stamp = [
    ts.getFullYear(),
    String(ts.getMonth() + 1).padStart(2, '0'),
    String(ts.getDate()).padStart(2, '0'),
    '-',
    String(ts.getHours()).padStart(2, '0'),
    String(ts.getMinutes()).padStart(2, '0'),
    String(ts.getSeconds()).padStart(2, '0'),
  ].join('');
  const file = path.join(dir, `${stamp}.json`);
  const payload = { ...alert, writtenAt: ts.toISOString() };
  atomicWriteJson(file, payload);
  return file;
}

module.exports = {
  ensureDir,
  atomicWriteJson,
  readJson,
  paths,
  loadCursor,
  saveCursor,
  queuePath,
  loadQueueItem,
  upsertQueueItem,
  setQueueWorkStatus,
  listQueueItems,
  markQueueDiagnosed,
  writeAlert,
  normalizeTime,
  pickJobFailureAt,
  maxIso,
  minIso,
  loadTaskIndex,
  upsertTaskNamesFromJobs,
  getTaskIndexEntry,
};

