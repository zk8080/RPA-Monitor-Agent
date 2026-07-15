/**
 * soft-audit：成功状态 / 尾部错误判定 / 已审计集合 / 配额选择（不打影刀）
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const soft = require('./lib/soft-audit');
const memory = require('./lib/memory');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-soft-'));

// --- status ---
assert.strictEqual(soft.isSuccessStatus('finish'), true);
assert.strictEqual(soft.isSuccessStatus('success'), true);
assert.strictEqual(soft.isSuccessStatus('error'), false);
assert.strictEqual(soft.isSuccessStatus('running'), false);
assert.strictEqual(soft.isSuccessStatus('stopped'), false);

// --- evaluate tail ---
const clean = soft.evaluateTailLogs([
  { level: '信息', text: 'start' },
  { level: '信息', text: 'done' },
]);
assert.strictEqual(clean.matched, false);

const hit = soft.evaluateTailLogs([
  { level: '信息', text: 'ok' },
  { level: '错误', text: 'list index out of range', flowName: '主流程', lineNumber: 9 },
]);
assert.strictEqual(hit.matched, true);
assert.ok(hit.sampleText.includes('index'));

// --- store audited ---
const store = soft.loadStore(dir);
assert.strictEqual(soft.isAudited(store, 'j1'), false);
soft.markAudited(store, 'j1', { result: 'clean' });
soft.markAudited(store, 'j2', { result: 'soft', fingerprint: 'soft_x' });
assert.strictEqual(soft.isAudited(store, 'j1'), true);
assert.strictEqual(soft.isAudited(store, 'j2'), true);
// fetch_error 不算已审计
soft.markAudited(store, 'j3', { result: 'fetch_error' });
assert.strictEqual(soft.isAudited(store, 'j3'), false);
soft.saveStore(dir, store);
const store2 = soft.loadStore(dir);
assert.strictEqual(soft.isAudited(store2, 'j1'), true);

// --- selectCandidates 配额 ---
const cfg = soft.getSoftConfig({ softFail: { enabled: true, maxPerPoll: 2, maxPerAppPerPoll: 1 } });
const cands = [
  { jobUuid: 'a1', robotUuid: 'r1', status: 'finish' },
  { jobUuid: 'a2', robotUuid: 'r1', status: 'finish' }, // same app cap
  { jobUuid: 'b1', robotUuid: 'r2', status: 'finish' },
  { jobUuid: 'b2', robotUuid: 'r2', status: 'finish' },
  { jobUuid: 'j1', robotUuid: 'r3', status: 'finish' }, // already audited
];
const emptyStore = soft.loadStore(path.join(dir, 'empty'));
// pre-mark j1 in selection store
const selStore = soft.loadStore(dir);
const pick = soft.selectCandidates(cands, selStore, cfg);
assert.ok(pick.selected.length <= 2);
assert.ok(!pick.selected.find((j) => j.jobUuid === 'j1'));
// per app max 1 → a1 and b1 typically
const apps = new Set(pick.selected.map((j) => j.robotUuid));
assert.ok(apps.size >= 1);

// --- toSoftFingerprint ---
const fp = soft.toSoftFingerprint({
  fingerprint: '主流程_abc',
  errorSignature: '主流程|err|-',
  rawRemark: 'x',
});
assert.ok(fp.fingerprint.startsWith('soft_'));
assert.ok(fp.errorSignature.startsWith('soft|'));
assert.strictEqual(fp.failureKind, 'soft');

// --- memory soft fields ---
const dataDir = path.join(dir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const item = memory.upsertQueueItem(
  dataDir,
  {
    fingerprint: 'soft_test_fp',
    robotUuid: 'r',
    robotName: 'App',
    errorType: 'IndexError',
    rawRemark: '[假成功] boom',
    failureKind: 'soft',
    jobStatus: 'finish',
  },
  { jobUuid: 'job-soft-1', failureAt: new Date().toISOString() },
);
assert.strictEqual(item.failureKind, 'soft');
assert.strictEqual(item.jobStatus, 'finish');

// --- getSoftConfig env ---
const off = soft.getSoftConfig({}, { softFail: false });
assert.strictEqual(off.enabled, false);

// --- Web 设置：成功抽检白名单落盘 ---
const settingsSc = require('./lib/settings-success-check');
const scDir = path.join(dir, 'sc-settings');
fs.mkdirSync(scDir, { recursive: true });
const saved = settingsSc.saveSettings(scDir, {
  enabled: true,
  maxPerPoll: 10,
  robotUuidAllowlist: ['app-a', 'app-b'],
});
assert.strictEqual(saved.ok, true);
const overlay = settingsSc.getFileOverlay(scDir);
assert.strictEqual(overlay.hasFile, true);
assert.deepStrictEqual(overlay.robotUuidAllowlist, ['app-a', 'app-b']);
const merged = soft.getSoftConfig({ dataDir: scDir, softFail: { maxPerPoll: 99 } });
assert.strictEqual(merged.maxPerPoll, 10);
assert.deepStrictEqual(merged.robotUuidAllowlist, ['app-a', 'app-b']);
assert.strictEqual(settingsSc.PRODUCT_NAME, '成功抽检');

console.log('test_soft_audit: ok');
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  // ignore
}
