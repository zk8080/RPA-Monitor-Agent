/**
 * S18 验证闭环自检（临时目录，不碰生产 data）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const patch = require('./lib/patch');
const verify = require('./lib/verify');
const memory = require('./lib/memory');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-verify-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'kb'), { recursive: true });

const target = path.join(tmp, 'app.py');
fs.writeFileSync(target, 'x=1\n', 'utf8');
const fp = 'test-flow_fp_verify_s18';

const meta = patch.createPatch(
  dataDir,
  { fixerId: 't', fixClass: 'code_boundary', fingerprint: fp, dryRun: false },
  [
    {
      relativePath: 'app.py',
      absolutePath: target,
      original: 'x=1\n',
      proposed: 'x=2\n',
    },
  ],
);

const applied = patch.applyPatch(dataDir, meta.patchId);
assert.ok(applied.ok, applied.error);

const pending = verify.markPatchPendingVerify(dataDir, meta.patchId, {
  fingerprint: fp,
  quietDaysRequired: 3,
});
assert.ok(pending.ok, pending.error);
assert.strictEqual(pending.meta.status, 'fixed_pending_verify');

// 写入 queue 模拟历史
memory.upsertQueueItem(dataDir, {
  fingerprint: fp,
  robotUuid: 'r1',
  flowName: 'test',
  errorType: 'IndexError',
  rawRemark: 'x',
});

// 重扫旧 job 不算复发
const noReg = verify.afterQueueUpsert(dataDir, fp, { jobUuid: 'job-old', isNewJob: false });
assert.strictEqual(noReg, null);

// 新 job → regressed
const reg = verify.afterQueueUpsert(dataDir, fp, { jobUuid: 'job-new', isNewJob: true });
assert.ok(reg && reg.ok);
assert.strictEqual(reg.regressed[0].patchId, meta.patchId);

const loaded = patch.loadPatch(dataDir, meta.patchId);
assert.strictEqual(loaded.meta.status, 'regressed');

// 再造一个 pending 测 verified
const t2 = path.join(tmp, 'b.py');
fs.writeFileSync(t2, 'a=1\n', 'utf8');
const m2 = patch.createPatch(
  dataDir,
  { fixerId: 't', fixClass: 'code_boundary', fingerprint: 'fp2', dryRun: false },
  [{ relativePath: 'b.py', absolutePath: t2, original: 'a=1\n', proposed: 'a=2\n' }],
);
patch.applyPatch(dataDir, m2.patchId);
verify.markPatchPendingVerify(dataDir, m2.patchId, { fingerprint: 'fp2', quietDaysRequired: 3 });
// 回拨 startedAt
const L = patch.loadPatch(dataDir, m2.patchId);
L.meta.appliedAt = new Date(Date.now() - 5 * 86400000).toISOString();
L.meta.verify.startedAt = L.meta.appliedAt;
memory.atomicWriteJson(path.join(L.root, 'meta.json'), L.meta);

const tick = verify.tickVerification(dataDir, { quietDays: 3 });
assert.ok(tick.verified.some((v) => v.patchId === m2.patchId));
const L2 = patch.loadPatch(dataDir, m2.patchId);
assert.strictEqual(L2.meta.status, 'verified');

// cleanup
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  // ignore
}

console.log('test_verify: ok');
