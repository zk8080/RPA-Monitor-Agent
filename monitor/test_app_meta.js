/**
 * 应用业务标签 + 优先池标签配置
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const appMeta = require('./lib/app-meta');
const workbench = require('./lib/workbench');
const memory = require('./lib/memory');

function testNormalize() {
  assert.strictEqual(appMeta.normalizePriorityScope('tags', ['PV']), 'tags');
  assert.strictEqual(appMeta.normalizePriorityScope('all', []), 'all');
  assert.deepStrictEqual(appMeta.normalizeTags([' PV ', 'PV', '财务', '']), ['PV', '财务']);
  assert.ok(appMeta.appMatchesPriorityTags(['PV', '招募'], ['财务', 'PV']));
  assert.ok(!appMeta.appMatchesPriorityTags(['运营'], ['PV', '财务']));
  assert.ok(appMeta.appMatchesPriorityTags(['任意'], []), '空优先标签 = 不限制');
  console.log('ok normalize');
}

function testStoreAndPriority() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-appmeta-'));
  const dataDir = path.join(tmp, 'data');
  fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });

  const cfg = {
    dataDir,
    workbench: { enabled: true },
    shadowbotUsersRoot: path.join(tmp, 'empty-sb'),
  };
  fs.mkdirSync(cfg.shadowbotUsersRoot, { recursive: true });

  const now = new Date().toISOString();
  memory.upsertQueueItem(
    dataDir,
    {
      fingerprint: 'fp-pv',
      robotUuid: 'robot-pv',
      robotName: 'PVApp',
      errorType: '未找到元素',
      lastFailureAt: now,
      diagnosed: true,
      occurrenceCount: 1,
    },
    { jobUuid: 'j1' },
  );
  memory.upsertQueueItem(
    dataDir,
    {
      fingerprint: 'fp-fin',
      robotUuid: 'robot-fin',
      robotName: 'FinApp',
      errorType: '超时',
      lastFailureAt: now,
      diagnosed: true,
      occurrenceCount: 1,
    },
    { jobUuid: 'j2' },
  );
  memory.upsertQueueItem(
    dataDir,
    {
      fingerprint: 'fp-other',
      robotUuid: 'robot-other',
      robotName: 'OtherApp',
      errorType: '超时',
      lastFailureAt: now,
      diagnosed: true,
      occurrenceCount: 1,
    },
    { jobUuid: 'j3' },
  );

  assert.strictEqual(
    workbench.setAppMeta('robot-pv', cfg, { tags: ['PV', '核心'] }).ok,
    true,
  );
  assert.strictEqual(workbench.setAppMeta('robot-fin', cfg, { tags: ['财务'] }).ok, true);
  // other 无标签

  // 默认全部
  let ov = workbench.buildOverview(cfg, { startedAt: Date.now() });
  assert.strictEqual(ov.queue.priorityScope, 'all');
  assert.ok(ov.priorityQueue.some((p) => p.fingerprint === 'fp-pv'));
  assert.ok(ov.priorityQueue.some((p) => p.fingerprint === 'fp-other'));

  // 优先池只要 PV
  const sc = workbench.setPriorityTags(cfg, ['PV']);
  assert.strictEqual(sc.priorityScope, 'tags');
  assert.deepStrictEqual(sc.priorityTags, ['PV']);

  ov = workbench.buildOverview(cfg, { startedAt: Date.now() });
  assert.strictEqual(ov.queue.priorityScope, 'tags');
  assert.ok(ov.priorityQueue.some((p) => p.fingerprint === 'fp-pv'));
  assert.ok(!ov.priorityQueue.some((p) => p.fingerprint === 'fp-fin'));
  assert.ok(!ov.priorityQueue.some((p) => p.fingerprint === 'fp-other'));

  // PV + 财务
  workbench.setPriorityTags(cfg, ['PV', '财务']);
  ov = workbench.buildOverview(cfg, { startedAt: Date.now() });
  assert.ok(ov.priorityQueue.some((p) => p.fingerprint === 'fp-pv'));
  assert.ok(ov.priorityQueue.some((p) => p.fingerprint === 'fp-fin'));
  assert.ok(!ov.priorityQueue.some((p) => p.fingerprint === 'fp-other'));

  // 清空 = 全部
  workbench.setPriorityTags(cfg, []);
  ov = workbench.buildOverview(cfg, { startedAt: Date.now() });
  assert.strictEqual(ov.queue.priorityScope, 'all');
  assert.ok(ov.priorityQueue.some((p) => p.fingerprint === 'fp-other'));

  const apps = workbench.listAppsWithStats(cfg);
  const pv = apps.apps.find((a) => a.robotUuid === 'robot-pv');
  assert.ok(pv.tags.includes('PV'));

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
  console.log('ok store and priority tag pool');
}

function main() {
  testNormalize();
  testStoreAndPriority();
  console.log('test_app_meta: all passed');
}

main();
