/**
 * 本地知识库（Agent Memory 长期层）
 * data/kb/KB-XXXX.json
 */

const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWriteJson, readJson, paths } = require('./memory');

function listKbFiles(dataDir) {
  const dir = paths(dataDir).kbDir;
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^KB-\d+\.json$/i.test(f))
    .sort();
}

function nextKbId(dataDir) {
  const files = listKbFiles(dataDir);
  let max = 0;
  for (const f of files) {
    const m = f.match(/KB-(\d+)/i);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `KB-${String(max + 1).padStart(4, '0')}`;
}

function kbPath(dataDir, id) {
  return path.join(paths(dataDir).kbDir, `${id}.json`);
}

function loadKb(dataDir, id) {
  if (!id) return null;
  return readJson(kbPath(dataDir, id), null);
}

function loadAllKb(dataDir) {
  return listKbFiles(dataDir)
    .map((f) => readJson(path.join(paths(dataDir).kbDir, f), null))
    .filter(Boolean);
}

/**
 * @param {string} dataDir
 * @param {{ fingerprint?: string, errorSignature?: string, errorType?: string, elementName?: string, limit?: number }} query
 */
function searchKb(dataDir, query = {}) {
  const limit = query.limit ?? 5;
  const all = loadAllKb(dataDir);
  const hits = [];

  for (const item of all) {
    let score = 0;
    if (query.fingerprint && item.fingerprint === query.fingerprint) score += 100;
    if (query.errorSignature && item.errorSignature === query.errorSignature) score += 50;
    if (query.errorType && item.errorType && String(item.errorType).includes(query.errorType)) score += 20;
    if (query.errorType && item.errorSignature && String(item.errorSignature).includes(query.errorType)) score += 10;
    if (query.elementName && item.elementName && String(item.elementName).includes(query.elementName)) score += 15;
    if (query.elementName && item.errorSignature && String(item.errorSignature).includes(query.elementName)) score += 10;
    if (score > 0) hits.push({ score, item });
  }

  hits.sort((a, b) => b.score - a.score || String(b.item.lastSeen).localeCompare(String(a.item.lastSeen)));
  return {
    count: hits.length,
    hits: hits.slice(0, limit).map((h) => ({ score: h.score, ...h.item })),
  };
}

/**
 * @param {string} dataDir
 * @param {object} entry
 * @param {{ id?: string, updateIfFingerprint?: boolean }} [opts]
 */
function writeKb(dataDir, entry, opts = {}) {
  ensureDir(paths(dataDir).kbDir);
  const now = new Date().toISOString().slice(0, 10);
  let id = opts.id || entry.id;

  if (!id && opts.updateIfFingerprint !== false && entry.fingerprint) {
    const existing = loadAllKb(dataDir).find((k) => k.fingerprint === entry.fingerprint);
    if (existing) id = existing.id;
  }
  if (!id) id = nextKbId(dataDir);

  const prev = loadKb(dataDir, id) || {};
  const next = {
    id,
    fingerprint: entry.fingerprint || prev.fingerprint || '',
    errorSignature: entry.errorSignature || prev.errorSignature || '',
    errorType: entry.errorType || prev.errorType || '',
    elementName: entry.elementName || prev.elementName || '',
    robotUuid: entry.robotUuid || prev.robotUuid || '',
    robotName: entry.robotName || prev.robotName || '',
    rootCause: entry.rootCause || prev.rootCause || '',
    solution: entry.solution || entry.suggestion || prev.solution || '',
    location: entry.location || prev.location || '',
    errorCategory: entry.errorCategory || prev.errorCategory || 'other',
    affectedBlocks: entry.affectedBlocks || prev.affectedBlocks || [],
    affectedApps: entry.affectedApps || prev.affectedApps || [],
    confidence: entry.confidence != null ? entry.confidence : prev.confidence != null ? prev.confidence : 0.5,
    occurrenceCount: entry.occurrenceCount != null
      ? entry.occurrenceCount
      : (prev.occurrenceCount || 0) + (entry.bumpOccurrence ? 1 : 0) || 1,
    firstSeen: prev.firstSeen || entry.firstSeen || now,
    lastSeen: entry.lastSeen || now,
    status: entry.status || prev.status || 'pending_review',
    sourceJobUuids: uniqueIds([...(prev.sourceJobUuids || []), ...(entry.sourceJobUuids || [])]).slice(-20),
    notes: entry.notes != null ? entry.notes : prev.notes || '',
    kbAction: entry.kbAction || (prev.id ? 'update' : 'create'),
  };

  atomicWriteJson(kbPath(dataDir, id), next);
  return next;
}

function uniqueIds(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

module.exports = {
  listKbFiles,
  nextKbId,
  loadKb,
  loadAllKb,
  searchKb,
  writeKb,
  kbPath,
};
