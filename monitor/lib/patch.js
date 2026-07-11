/**
 * 补丁审计：备份 / 预览 / apply / rollback
 * 路径：data/patches/<patchId>/
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDir, atomicWriteJson, readJson } = require('./memory');

function patchesRoot(dataDir) {
  return path.join(dataDir, 'patches');
}

function newPatchId() {
  const ts = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rnd = crypto.randomBytes(3).toString('hex');
  return `patch-${ts}-${rnd}`;
}

/**
 * @param {string} dataDir
 * @param {object} meta
 * @param {Array<{ relativePath: string, absolutePath: string, original: string, proposed: string, diff?: string }>} files
 */
function createPatch(dataDir, meta, files) {
  const patchId = meta.patchId || newPatchId();
  const root = path.join(patchesRoot(dataDir), patchId);
  const beforeDir = path.join(root, 'before');
  const proposedDir = path.join(root, 'proposed');
  ensureDir(beforeDir);
  ensureDir(proposedDir);

  const fileMetas = [];
  const diffParts = [];

  for (const f of files) {
    const rel = f.relativePath.replace(/\\/g, '/');
    const beforePath = path.join(beforeDir, rel);
    const proposedPath = path.join(proposedDir, rel);
    ensureDir(path.dirname(beforePath));
    ensureDir(path.dirname(proposedPath));
    fs.writeFileSync(beforePath, f.original ?? '', 'utf8');
    fs.writeFileSync(proposedPath, f.proposed ?? '', 'utf8');
    const diff = f.diff || makeUnifiedDiff(rel, f.original || '', f.proposed || '');
    diffParts.push(diff);
    fileMetas.push({
      relativePath: rel,
      absolutePath: f.absolutePath,
      bytesBefore: Buffer.byteLength(f.original || '', 'utf8'),
      bytesAfter: Buffer.byteLength(f.proposed || '', 'utf8'),
    });
  }

  fs.writeFileSync(path.join(root, 'patch.diff'), `${diffParts.join('\n')}\n`, 'utf8');

  const record = {
    patchId,
    status: 'planned',
    createdAt: new Date().toISOString(),
    appliedAt: null,
    rolledBackAt: null,
    fixerId: meta.fixerId || null,
    fixClass: meta.fixClass || null,
    fingerprint: meta.fingerprint || null,
    robotUuid: meta.robotUuid || null,
    robotName: meta.robotName || null,
    rationale: meta.rationale || '',
    risk: meta.risk || 'low',
    dryRun: meta.dryRun !== false,
    files: fileMetas,
    error: null,
  };
  atomicWriteJson(path.join(root, 'meta.json'), record);
  return record;
}

function loadPatch(dataDir, patchId) {
  const root = path.join(patchesRoot(dataDir), patchId);
  const meta = readJson(path.join(root, 'meta.json'), null);
  if (!meta) return null;
  return { root, meta };
}

/**
 * 将 proposed 写入 absolutePath（before 已在 create 时备份）
 */
function applyPatch(dataDir, patchId, options = {}) {
  const loaded = loadPatch(dataDir, patchId);
  if (!loaded) return { ok: false, error: 'patch_not_found' };
  const { root, meta } = loaded;
  if (meta.status === 'applied') return { ok: false, error: 'already_applied' };

  try {
    for (const f of meta.files) {
      const proposedPath = path.join(root, 'proposed', f.relativePath);
      const content = fs.readFileSync(proposedPath, 'utf8');
      if (options.maxPatchBytes && Buffer.byteLength(content, 'utf8') > options.maxPatchBytes) {
        throw new Error(`file_too_large:${f.relativePath}`);
      }
      ensureDir(path.dirname(f.absolutePath));
      fs.writeFileSync(f.absolutePath, content, 'utf8');
    }
    meta.status = 'applied';
    meta.appliedAt = new Date().toISOString();
    meta.dryRun = false;
    meta.error = null;
    atomicWriteJson(path.join(root, 'meta.json'), meta);
    return { ok: true, meta };
  } catch (e) {
    // 尽力回滚已写文件
    try {
      rollbackPatch(dataDir, patchId);
    } catch {
      // ignore
    }
    meta.status = 'failed';
    meta.error = e.message;
    atomicWriteJson(path.join(root, 'meta.json'), meta);
    return { ok: false, error: e.message, meta };
  }
}

function rollbackPatch(dataDir, patchId) {
  const loaded = loadPatch(dataDir, patchId);
  if (!loaded) return { ok: false, error: 'patch_not_found' };
  const { root, meta } = loaded;

  try {
    for (const f of meta.files) {
      const beforePath = path.join(root, 'before', f.relativePath);
      if (!fs.existsSync(beforePath)) {
        throw new Error(`backup_missing:${f.relativePath}`);
      }
      const content = fs.readFileSync(beforePath, 'utf8');
      ensureDir(path.dirname(f.absolutePath));
      fs.writeFileSync(f.absolutePath, content, 'utf8');
    }
    meta.status = 'rolled_back';
    meta.rolledBackAt = new Date().toISOString();
    meta.error = null;
    atomicWriteJson(path.join(root, 'meta.json'), meta);
    return { ok: true, meta };
  } catch (e) {
    return { ok: false, error: e.message, meta };
  }
}

function makeUnifiedDiff(filename, before, after) {
  // 简易行 diff（非完整 Myers，足够审计预览）
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const lines = [`--- a/${filename}`, `+++ b/${filename}`];
  const max = Math.max(a.length, b.length);
  let hunk = [];
  const flush = () => {
    if (hunk.length) {
      lines.push('@@');
      lines.push(...hunk);
      hunk = [];
    }
  };
  for (let i = 0; i < max; i += 1) {
    const la = a[i];
    const lb = b[i];
    if (la === lb) {
      if (hunk.length && hunk.length < 200) hunk.push(` ${la ?? ''}`);
      continue;
    }
    if (la !== undefined) hunk.push(`-${la}`);
    if (lb !== undefined) hunk.push(`+${lb}`);
  }
  flush();
  if (lines.length === 2) {
    lines.push('@@');
    lines.push(' (no line-level diff; files differ by encoding or are identical)');
  }
  return lines.join('\n');
}

function listPatches(dataDir) {
  const root = patchesRoot(dataDir);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((d) => d.startsWith('patch-'))
    .map((id) => readJson(path.join(root, id, 'meta.json'), null))
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

module.exports = {
  patchesRoot,
  newPatchId,
  createPatch,
  loadPatch,
  applyPatch,
  rollbackPatch,
  makeUnifiedDiff,
  listPatches,
};
