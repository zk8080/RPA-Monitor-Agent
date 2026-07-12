/**
 * 本地 Memory 读写：cursor / queue / alerts
 * 单文件原子写，无 DB。
 */

const fs = require('fs');
const path = require('path');

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
  };
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
 * 写入或合并 queue 条目（同指纹累加 occurrence）
 * @param {string} dataDir
 * @param {object} item
 * @param {{ jobUuid?: string, now?: string }} [meta]
 */
function upsertQueueItem(dataDir, item, meta = {}) {
  const now = meta.now || new Date().toISOString();
  const existing = loadQueueItem(dataDir, item.fingerprint);
  const sampleJobUuids = existing?.sampleJobUuids ? [...existing.sampleJobUuids] : [];
  if (meta.jobUuid && !sampleJobUuids.includes(meta.jobUuid)) {
    sampleJobUuids.push(meta.jobUuid);
    if (sampleJobUuids.length > 10) sampleJobUuids.shift();
  }

  const next = {
    fingerprint: item.fingerprint,
    errorSignature: item.errorSignature || existing?.errorSignature || null,
    robotUuid: item.robotUuid || existing?.robotUuid || '',
    robotName: item.robotName || existing?.robotName || '',
    flowName: item.flowName || existing?.flowName || '',
    lineNumber: item.lineNumber || existing?.lineNumber || '',
    errorType: item.errorType || existing?.errorType || '',
    elementName: item.elementName || existing?.elementName || '',
    occurrenceCount: (existing?.occurrenceCount || 0) + 1,
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
    sampleJobUuids,
    rawRemark: item.rawRemark || existing?.rawRemark || '',
    diagnosed: existing?.diagnosed === true,
    kbId: existing?.kbId ?? null,
  };

  atomicWriteJson(queuePath(dataDir, item.fingerprint), next);
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
  listQueueItems,
  markQueueDiagnosed,
  writeAlert,
};

