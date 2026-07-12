/**
 * 快速自检：triage + fixers + patch dry path
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { classifyFix } = require('./lib/triage');
const indexFixer = require('./lib/fixers/python_index_error');
const emptyPathFixer = require('./lib/fixers/python_empty_path');
const patch = require('./lib/patch');

const t = classifyFix(
  { errorType: 'IndexError', rawRemark: 'list index out of range in worker' },
  { logs: [{ text: 'File "worker.py", line 12, in main' }], appInfo: null },
);
assert.strictEqual(t.fixClass, 'code_boundary');
assert.ok(t.fixability === 'auto' || t.fixability === 'assisted');

const sample = 'def main():\n    rows = []\n    x = rows[0]\n    return x\n';
const plan = indexFixer.plan({
  fileContent: sample,
  absolutePath: 't.py',
  relativePath: 't.py',
  text: 'IndexError: list index out of range',
  lineHint: 3,
});
assert.ok(plan.ok, plan.error);
assert.ok(plan.files[0].proposed.includes('if not rows:'));

// S19 empty path fixer
const emptySample = 'def load(p):\n    with open(p) as f:\n        return f.read()\n';
const ep = emptyPathFixer.plan({
  fileContent: emptySample,
  absolutePath: 'p.py',
  relativePath: 'p.py',
  text: "FileNotFoundError: No such file or directory: ''",
  lineHint: 2,
});
assert.ok(ep.ok, ep.error);
assert.ok(ep.files[0].proposed.includes('if not p:'));
assert.ok(emptyPathFixer.match({ text: "No such file: ''" }) > 0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-patch-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
const target = path.join(tmp, 'app.py');
fs.writeFileSync(target, sample, 'utf8');
const meta = patch.createPatch(
  dataDir,
  { fixerId: 'python_index_error', fixClass: 'code_boundary', dryRun: true },
  [
    {
      relativePath: 'app.py',
      absolutePath: target,
      original: sample,
      proposed: plan.files[0].proposed,
    },
  ],
);
assert.ok(meta.patchId);
const applied = patch.applyPatch(dataDir, meta.patchId);
assert.ok(applied.ok, applied.error);
assert.ok(fs.readFileSync(target, 'utf8').includes('if not rows:'));

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // ignore
}

console.log('✅ maintain unit checks passed');
console.log('   patchId', meta.patchId);
