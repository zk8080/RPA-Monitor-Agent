/**
 * S10a KB-first + S20 report maintain 节自检
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { tryKbFirst, isKbFirstEnabled } = require('./lib/skills/diagnose');
const { buildDailyReport } = require('./lib/report');
const memory = require('./lib/memory');
const patch = require('./lib/patch');
const kb = require('./lib/kb');

assert.strictEqual(isKbFirstEnabled({}), false);
assert.strictEqual(isKbFirstEnabled({ diagnose: { kbFirst: true } }), true);

const miss = tryKbFirst(
  [{ status: 'pending_review', fingerprint: 'fp1', rootCause: 'x', confidence: 0.9 }],
  { fingerprint: 'fp1' },
  { diagnose: { kbFirst: true } },
);
assert.strictEqual(miss, null);

const hit = tryKbFirst(
  [
    {
      id: 'KB-0001',
      status: 'confirmed',
      fingerprint: 'fp1',
      rootCause: '已知根因',
      solution: '已知方案',
      confidence: 0.9,
      errorCategory: 'element',
    },
  ],
  { fingerprint: 'fp1', robotName: 'App', errorType: '未找到元素', rawRemark: 'x' },
  { diagnose: { kbFirst: true, kbFirstMinConfidence: 0.8 } },
);
assert.ok(hit);
assert.strictEqual(hit.diagnosis.source, 'kb-first');
assert.strictEqual(hit.diagnosis.reusedKbId, 'KB-0001');
assert.ok(hit.diagnosis.notes.includes('KB-first'));

// pending 永不短路
const pend = tryKbFirst(
  [{ id: 'KB-9', status: 'pending_review', fingerprint: 'fp1', rootCause: 'x', confidence: 0.99 }],
  { fingerprint: 'fp1' },
  { diagnose: { kbFirst: true } },
);
assert.strictEqual(pend, null);

// S20 report section
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-report-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'kb'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'patches'), { recursive: true });
memory.upsertQueueItem(dataDir, {
  fingerprint: 'fp-report',
  robotUuid: 'r1',
  robotName: 'Demo',
  errorType: 'IndexError',
  rawRemark: 'list index out of range',
  flowName: 'main',
  lineNumber: '1',
});
const py = path.join(tmp, 'w.py');
fs.writeFileSync(py, 'rows=[]\nx=rows[0]\n', 'utf8');
patch.createPatch(
  dataDir,
  { fixerId: 'python_index_error', fixClass: 'code_boundary', fingerprint: 'fp-report', dryRun: true },
  [{ relativePath: 'w.py', absolutePath: py, original: 'rows=[]\nx=rows[0]\n', proposed: 'rows=[]\nif not rows:\n    return\nx=rows[0]\n' }],
);

const cfg = { dataDir, reportScope: 'all' };
const report = buildDailyReport(cfg, { write: false, scope: 'all' });
assert.ok(report.ok);
assert.ok(report.markdown.includes('维护与补丁'));
assert.ok(report.stats.plannedPatches >= 1);

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // ignore
}

console.log('test_p1_s20_s10a: ok');
