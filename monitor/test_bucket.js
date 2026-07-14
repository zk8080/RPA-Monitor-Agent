/**
 * S27b 技术分流 bucket 单测
 */
const assert = require('assert');
const bucket = require('./lib/bucket');
const handoff = require('./lib/handoff');
const { classifyFix } = require('./lib/triage');

function testClassify() {
  const robot = bucket.classifyBucket({
    errorType: '机器人未连接',
    rawRemark: '任务等待运行超时。原因：机器人未连接',
    errorSignature: '调度层|机器人未连接|机器人未连接',
  });
  assert.strictEqual(robot.bucket, 'env_robot');
  assert.strictEqual(robot.actionable, 'ops');

  const schedule = bucket.classifyBucket({
    errorType: '任务等待运行超时',
    rawRemark: '任务等待运行超时。原因：未分配空闲机器人',
    errorSignature: '调度层|任务等待运行超时|未分配空闲机器人',
    flowName: '',
  });
  assert.strictEqual(schedule.bucket, 'schedule');
  assert.strictEqual(schedule.actionable, 'ops');

  const code = bucket.classifyBucket({
    errorType: 'IndexError',
    rawRemark: 'list index out of range',
    flowName: 'main',
  });
  assert.strictEqual(code.bucket, 'code');
  assert.strictEqual(code.actionable, 'dev');
  assert.strictEqual(code.label, '代码');

  // 元素：不得打「代码」
  const element = bucket.classifyBucket({
    errorType: '匹配到多个元素',
    rawRemark: '匹配到多个元素 元素名: 发票',
    flowName: '录入',
  });
  assert.strictEqual(element.bucket, 'element');
  assert.strictEqual(element.label, '元素');
  assert.strictEqual(element.actionable, 'dev');

  const elementNotFound = bucket.classifyBucket({
    errorType: '未找到元素',
    rawRemark: '出错：找不到元素',
  });
  assert.strictEqual(elementNotFound.bucket, 'element');

  const config = bucket.classifyBucket(
    { errorType: '文件不存在', rawRemark: '空路径' },
    { fixClass: 'config' },
  );
  assert.strictEqual(config.bucket, 'data_config');
  assert.strictEqual(config.actionable, 'dev');

  const viaTriageCode = bucket.classifyBucket(
    { errorType: 'x', rawRemark: 'y' },
    { fixClass: 'null_guard' },
  );
  assert.strictEqual(viaTriageCode.bucket, 'code');

  const viaTriageEl = bucket.classifyBucket(
    { errorType: 'x', rawRemark: 'y' },
    { fixClass: 'element' },
  );
  assert.strictEqual(viaTriageEl.bucket, 'element');

  // fixClass=code_boundary 但文案是元素时：分诊 class 在元素文案规则之前；
  // 若 class 已是 element 会走 element。code_boundary 仍 code。
  const boundary = bucket.classifyBucket(
    { errorType: 'IndexError', rawRemark: 'out of range' },
    { fixClass: 'code_boundary' },
  );
  assert.strictEqual(boundary.bucket, 'code');

  console.log('ok classify');
}

function testAggregateFilter() {
  const items = [
    { bucket: 'env_robot' },
    { bucket: 'schedule' },
    { bucket: 'code' },
    { bucket: 'element' },
    { bucket: 'element' },
    { bucket: 'data_config' },
    { bucket: 'unknown' },
  ];
  const agg = bucket.aggregateBuckets(items);
  assert.strictEqual(agg.total, 7);
  assert.strictEqual(agg.byBucket.code, 1);
  assert.strictEqual(agg.byBucket.element, 2);
  assert.strictEqual(bucket.countDevActionable(agg.byBucket), 4); // code+element+config
  assert.strictEqual(bucket.countOpsNoise(agg.byBucket), 2);

  const dev = bucket.filterByBucket(items, 'dev');
  assert.strictEqual(dev.length, 4);
  const ops = bucket.filterByBucket(items, 'ops');
  assert.strictEqual(ops.length, 2);
  console.log('ok aggregate/filter');
}

function testHandoffHints() {
  const el = handoff.buildFixPrompt({
    name: 'Bot',
    xbotDir: 'D:/x',
    errorType: '未找到元素',
    rawRemark: '元素',
    bucket: 'element',
    bucketLabel: '元素',
    actionable: 'dev',
  });
  assert.ok(el.includes('分流：元素'));
  assert.ok(el.includes('不要当成 py'));

  const ops = handoff.buildFixPrompt({
    name: 'Bot',
    xbotDir: 'D:/x',
    errorType: '机器人未连接',
    rawRemark: '断连',
    bucket: 'env_robot',
    bucketLabel: '机器人/环境',
    actionable: 'ops',
  });
  assert.ok(ops.includes('不要先改业务'));
  console.log('ok handoff hints');
}

function testTriageEnvStillBuckets() {
  const item = {
    errorType: '机器人未连接',
    rawRemark: '原因：机器人未连接',
  };
  const triage = classifyFix(item, { logs: [] });
  const b = bucket.classifyBucket(item, triage);
  assert.strictEqual(b.bucket, 'env_robot');

  const elItem = {
    errorType: '匹配到多个元素',
    rawRemark: '匹配到多个元素',
  };
  const elTriage = classifyFix(elItem, { logs: [] });
  assert.strictEqual(elTriage.fixClass, 'element');
  const elB = bucket.classifyBucket(elItem, elTriage);
  assert.strictEqual(elB.bucket, 'element');
  console.log('ok with triage');
}

function main() {
  testClassify();
  testAggregateFilter();
  testHandoffHints();
  testTriageEnvStillBuckets();
  console.log('test_bucket: all passed');
}

main();
