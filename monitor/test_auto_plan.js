/**
 * S17：诊后 dry-run 闸门 + autoPlan 字段自检（不依赖影刀密钥）
 */
const assert = require('assert');
const { isAutoPlanOnDiagnose, maybeAutoPlanPatch } = require('./lib/skills/diagnose');

assert.strictEqual(isAutoPlanOnDiagnose({}), false);
assert.strictEqual(isAutoPlanOnDiagnose({ maintain: { autoPlanOnDiagnose: false } }), false);
assert.strictEqual(isAutoPlanOnDiagnose({ maintain: { autoPlanOnDiagnose: true } }), true);

(async () => {
  // 未开启配置 → null
  const off = await maybeAutoPlanPatch(
    { fingerprint: 'fp-x' },
    { fixability: 'auto', fixTargets: [{ type: 'python' }] },
    { maintain: { autoPlanOnDiagnose: false }, dataDir: 'data' },
  );
  assert.strictEqual(off, null);

  // fixability 非 auto → skipped
  const skip = await maybeAutoPlanPatch(
    { fingerprint: 'fp-x' },
    { fixability: 'manual', fixTargets: [{ type: 'python' }] },
    { maintain: { autoPlanOnDiagnose: true }, dataDir: 'data' },
  );
  assert.strictEqual(skip.skipped, true);
  assert.strictEqual(skip.reason, 'fixability_not_auto');

  // 无 python 目标
  const noPy = await maybeAutoPlanPatch(
    { fingerprint: 'fp-x' },
    { fixability: 'auto', fixTargets: [{ type: 'element' }] },
    { maintain: { autoPlanOnDiagnose: true }, dataDir: 'data' },
  );
  assert.strictEqual(noPy.reason, 'no_python_target');

  console.log('test_auto_plan: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
