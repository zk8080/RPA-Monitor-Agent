/**
 * S27a handoff 瘦身提示词单测
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const handoff = require('./lib/handoff');
const workbench = require('./lib/workbench');
const memory = require('./lib/memory');

function testTemplates() {
  const fixSlim = handoff.buildFixPrompt({
    name: 'DemoApp',
    robotUuid: 'ru-1',
    xbotDir: 'D:\\xbot\\Demo',
    fingerprint: 'fp-demo',
    flowName: 'main',
    lineNumber: 12,
    errorType: 'IndexError',
    rawRemark: 'list index out of range',
    fixClass: 'code_boundary',
    fixability: 'auto',
    rootCause: '数组越界',
    suggestion: '加长度判断',
    includeDiagnose: false,
  });
  assert.ok(fixSlim.includes('# 修这个 RPA 失败'));
  assert.ok(fixSlim.includes('DemoApp'));
  assert.ok(fixSlim.includes('IndexError'));
  assert.ok(fixSlim.includes('list index out of range'));
  assert.ok(!fixSlim.includes('数组越界'), '默认不含诊断根因');
  assert.ok(!fixSlim.includes('加长度判断'), '默认不含诊断建议');
  assert.ok(fixSlim.length < 1200, `slim fix too long: ${fixSlim.length}`);

  const fixFull = handoff.buildFixPrompt({
    name: 'DemoApp',
    xbotDir: 'D:\\xbot\\Demo',
    fingerprint: 'fp-demo',
    errorType: 'IndexError',
    rawRemark: 'boom',
    rootCause: '数组越界',
    suggestion: '加长度判断',
    includeDiagnose: true,
  });
  assert.ok(fixFull.includes('Monitor 判断'));
  assert.ok(fixFull.includes('数组越界'));
  assert.ok(fixFull.includes('加长度判断'));

  const longRemark = 'x'.repeat(500);
  const clipped = handoff.buildFixPrompt({
    name: 'A',
    rawRemark: longRemark,
    errorType: 'E',
  });
  assert.ok(clipped.includes('…'));
  assert.ok(!clipped.includes('x'.repeat(400)));

  const dev = handoff.buildDevelopPrompt({
    name: 'DemoApp',
    robotUuid: 'ru-1',
    xbotDir: 'D:\\xbot\\Demo',
  });
  assert.ok(dev.includes('开发 / 维护'));
  assert.ok(dev.includes('DemoApp'));
  assert.ok(!dev.includes('失败现场'));
  assert.ok(dev.length < 900);

  const viaAgent = handoff.buildAgentPrompt({
    mode: 'fix',
    fingerprint: 'fp',
    name: 'X',
    errorType: 'Timeout',
  });
  assert.ok(viaAgent.includes('修这个 RPA 失败'));

  const viaDev = handoff.buildAgentPrompt({ mode: 'develop', name: 'Y' });
  assert.ok(viaDev.includes('开发 / 维护'));

  console.log('ok templates');
}

function testWorkbenchHandoff() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-handoff-'));
  const cfg = {
    dataDir: tmp,
    workbench: { enabled: true, handoffIncludeDiagnose: false },
  };
  fs.mkdirSync(path.join(tmp, 'queue'), { recursive: true });

  const fp = 'test-fp-handoff-1';
  const item = {
    fingerprint: fp,
    robotUuid: 'robot-uuid-handoff',
    robotName: 'HandoffBot',
    flowName: 'flowA',
    lineNumber: 3,
    errorType: '超时',
    rawRemark: '等待元素超时',
  };
  memory.upsertQueueItem(cfg.dataDir, item, { jobUuid: 'job-h1' });
  memory.markQueueDiagnosed(cfg.dataDir, fp, {
    diagnosis: {
      rootCause: '页面慢',
      suggestion: '加长等待',
      location: 'flowA',
    },
  });

  const slim = workbench.getFindingHandoff(fp, cfg, { includeDiagnose: false });
  assert.strictEqual(slim.ok, true);
  assert.strictEqual(slim.mode, 'fix');
  assert.ok(slim.markdown.includes('等待元素超时'));
  assert.ok(!slim.markdown.includes('页面慢'));
  assert.strictEqual(slim.includeDiagnose, false);

  const full = workbench.getFindingHandoff(fp, cfg, { includeDiagnose: true });
  assert.strictEqual(full.ok, true);
  assert.ok(full.markdown.includes('页面慢'));
  assert.ok(full.includeDiagnose);

  const cfgDefaultOn = {
    ...cfg,
    workbench: { enabled: true, handoffIncludeDiagnose: true },
  };
  const defaultOn = workbench.getFindingHandoff(fp, cfgDefaultOn, {});
  assert.ok(defaultOn.markdown.includes('页面慢'));

  const miss = workbench.getFindingHandoff('no-such', cfg);
  assert.strictEqual(miss.ok, false);

  // app develop：无 ShadowBot 时仍应返回提示（路径可空）
  const app = workbench.getAppHandoff('robot-uuid-handoff', cfg);
  assert.strictEqual(app.ok, true);
  assert.strictEqual(app.mode, 'develop');
  assert.ok(app.markdown.includes('开发 / 维护'));

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.log('ok workbench handoff');
}

function main() {
  testTemplates();
  testWorkbenchHandoff();
  console.log('test_handoff: all passed');
}

main();
