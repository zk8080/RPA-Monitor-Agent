#!/usr/bin/env node
/**
 * 指纹稳定性夹具（离线，不调 OpenAPI）
 * 用法: node monitor/test_fingerprint.js
 */

const assert = require('assert');
const { buildFingerprint, parseRemark, isUrgentRemark } = require('./lib/fingerprint');

const REMARK =
  '在【获取发票税金号】中第35行：匹配到多个元素, 无法唯一定位 元素名: 发票方案号';

const REAL_REMARK =
  '【968c477b-9ac7-4724-a449-d7bb4a4cc0a6】任务失败，在【获取发票税金号】中第29行：出错：未找到元素, 元素名: 输入框_FilterField_ProjectInvoiceProposalJour_ProposalId_ProposalId_Input_0';

const parsed = parseRemark(REMARK);
assert.strictEqual(parsed.flowName, '获取发票税金号');
assert.strictEqual(parsed.lineNumber, '35');
assert.ok(parsed.errorType.includes('匹配到多个元素'));
assert.strictEqual(parsed.elementName, '发票方案号');

const real = parseRemark(REAL_REMARK);
assert.strictEqual(real.flowName, '获取发票税金号', '不应把 jobUuid 当成 flowName');
assert.strictEqual(real.lineNumber, '29');
assert.ok(real.errorType.includes('未找到元素') || real.errorType.includes('元素'));
assert.ok(real.elementName.startsWith('输入框_'));

const a = buildFingerprint({
  robotUuid: 'bd3b43b3-9fb2-4b94-896c-ab10d320b065',
  robotName: 'API-发票附件下载回传',
  remark: REMARK,
});
const b = buildFingerprint({
  robotUuid: 'bd3b43b3-9fb2-4b94-896c-ab10d320b065',
  robotName: 'API-发票附件下载回传',
  remark: REMARK,
});
assert.strictEqual(a.fingerprint, b.fingerprint, '同输入指纹应稳定');
assert.ok(a.fingerprint.length > 8);
assert.strictEqual(a.flowName, '获取发票税金号');
assert.strictEqual(a.lineNumber, '35');

const differentRobot = buildFingerprint({
  robotUuid: 'other-robot-uuid',
  remark: REMARK,
});
assert.notStrictEqual(a.fingerprint, differentRobot.fingerprint, '不同 app 指纹应不同');
assert.strictEqual(a.errorSignature, differentRobot.errorSignature, '跨 app errorSignature 可相同');

assert.ok(isUrgentRemark('机器人断连，请检查客户端'));
assert.ok(!isUrgentRemark(REMARK));

// 日志补全
const fromLogs = buildFingerprint({
  robotUuid: 'r1',
  logs: [
    {
      level: '错误',
      flowName: '登录流程',
      lineNumber: 12,
      text: '元素未找到 元素名: 提交按钮',
    },
  ],
});
assert.strictEqual(fromLogs.flowName, '登录流程');
assert.strictEqual(fromLogs.lineNumber, '12');
assert.ok(fromLogs.errorType.includes('元素未找到') || fromLogs.elementName === '提交按钮');

console.log('✅ fingerprint fixtures passed');
console.log('   sample fp:', a.fingerprint);
console.log('   errorSignature:', a.errorSignature);
console.log('   real remark flow:', real.flowName, 'L' + real.lineNumber);
