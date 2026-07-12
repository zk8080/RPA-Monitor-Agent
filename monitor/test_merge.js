/**
 * S10b 跨应用归并自检
 */
const assert = require('assert');
const { mergeByErrorSignature } = require('./lib/merge');
const { makeErrorSignature, buildFingerprint } = require('./lib/fingerprint');

const sig = makeErrorSignature({
  flowName: '获取发票税金号',
  errorType: '匹配到多个元素',
  elementName: '发票方案号',
});

const items = [
  {
    fingerprint: 'fp-a',
    errorSignature: sig,
    robotUuid: 'app-1',
    robotName: '应用甲',
    flowName: '获取发票税金号',
    errorType: '匹配到多个元素',
    elementName: '发票方案号',
    lastSeen: '2026-07-12T10:00:00.000Z',
    lastDiagnosis: { rootCause: '元素定位不唯一' },
  },
  {
    fingerprint: 'fp-b',
    errorSignature: sig,
    robotUuid: 'app-2',
    robotName: '应用乙',
    flowName: '获取发票税金号',
    errorType: '匹配到多个元素',
    elementName: '发票方案号',
    lastSeen: '2026-07-12T11:00:00.000Z',
  },
  {
    fingerprint: 'fp-c',
    errorSignature: 'other|timeout|-',
    robotUuid: 'app-3',
    robotName: '应用丙',
    flowName: 'other',
    errorType: 'timeout',
  },
];

// 单 app 不归并
const single = mergeByErrorSignature([items[0]], { minApps: 2 });
assert.strictEqual(single.length, 0);

const groups = mergeByErrorSignature(items, { minApps: 2 });
assert.strictEqual(groups.length, 1);
assert.strictEqual(groups[0].appCount, 2);
assert.strictEqual(groups[0].affectedApps.length, 2);
assert.ok(groups[0].affectedApps.some((a) => a.robotName === '应用甲'));
assert.ok(groups[0].affectedApps.some((a) => a.robotName === '应用乙'));
assert.strictEqual(groups[0].rootCauseHint, '元素定位不唯一');
assert.strictEqual(groups[0].fingerprints.length, 2);

// fingerprint 不同 robot 可共享 signature
const a = buildFingerprint({
  robotUuid: 'r1',
  robotName: 'A',
  remark: '在【获取发票税金号】中第35行：出错：匹配到多个元素 元素名: 发票方案号',
});
const b = buildFingerprint({
  robotUuid: 'r2',
  robotName: 'B',
  remark: '在【获取发票税金号】中第35行：出错：匹配到多个元素 元素名: 发票方案号',
});
assert.notStrictEqual(a.fingerprint, b.fingerprint);
assert.strictEqual(a.errorSignature, b.errorSignature);

console.log('test_merge: ok');
console.log('   signature:', groups[0].errorSignature);
console.log('   apps:', groups[0].appCount);
