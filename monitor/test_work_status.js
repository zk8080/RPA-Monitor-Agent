/**
 * S27d workStatus + 新 job 唤醒规则
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const memory = require('./lib/memory');
const workStatus = require('./lib/work-status');
const workbench = require('./lib/workbench');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-ws-'));
}

function testMergeRules() {
  const now = '2026-07-14T12:00:00.000Z';

  // 新条目
  const fresh = workStatus.mergeWorkStatusOnUpsert(null, { isNewJob: true, now });
  assert.strictEqual(fresh.workStatus, 'open');

  // snoozed + 新 job → open
  const sn = workStatus.mergeWorkStatusOnUpsert(
    {
      workStatus: 'snoozed',
      snoozedUntil: '2026-07-20T00:00:00.000Z',
    },
    { isNewJob: true, now },
  );
  assert.strictEqual(sn.workStatus, 'open');
  assert.strictEqual(sn.reopenedBy, 'new_job');

  // snoozed + 非新 job → 保持 snoozed
  const snKeep = workStatus.mergeWorkStatusOnUpsert(
    {
      workStatus: 'snoozed',
      snoozedUntil: '2026-07-20T00:00:00.000Z',
    },
    { isNewJob: false, now },
  );
  assert.strictEqual(snKeep.workStatus, 'snoozed');

  // ignored + 新 job → 仍 ignored + still failing
  const ig = workStatus.mergeWorkStatusOnUpsert(
    { workStatus: 'ignored', ignoredStillFailing: false },
    { isNewJob: true, now },
  );
  assert.strictEqual(ig.workStatus, 'ignored');
  assert.strictEqual(ig.ignoredStillFailing, true);

  // forceOpen（regressed）
  const fo = workStatus.mergeWorkStatusOnUpsert(
    { workStatus: 'ignored' },
    { isNewJob: true, forceOpen: true, now },
  );
  assert.strictEqual(fo.workStatus, 'open');
  assert.strictEqual(fo.reopenedBy, 'regressed');

  // snooze 过期 → 读路径 open
  const expired = workStatus.resolveEffectiveWorkStatus(
    {
      workStatus: 'snoozed',
      snoozedUntil: '2020-01-01T00:00:00.000Z',
    },
    now,
  );
  assert.strictEqual(expired.workStatus, 'open');
  assert.strictEqual(expired.snoozeExpired, true);
  assert.strictEqual(expired.effectiveOpen, true);

  console.log('ok merge rules');
}

function testUpsertAndManual() {
  const dir = tmpDir();
  const fp = 'fp-ws-1';
  const base = {
    fingerprint: fp,
    robotUuid: 'r1',
    robotName: 'App',
    flowName: 'main',
    errorType: 'IndexError',
    rawRemark: 'list index',
  };

  const a = memory.upsertQueueItem(dir, base, { jobUuid: 'j1', failureAt: '2026-07-14T10:00:00' });
  assert.strictEqual(a.workStatus, 'open');

  const snoozed = memory.setQueueWorkStatus(dir, fp, 'snoozed', { snoozeDays: 3 });
  assert.strictEqual(snoozed.workStatus, 'snoozed');
  assert.ok(snoozed.snoozedUntil);

  // 同 job 再 upsert → 不唤醒
  const same = memory.upsertQueueItem(dir, base, { jobUuid: 'j1', failureAt: '2026-07-14T10:00:00' });
  assert.strictEqual(same.workStatus, 'snoozed');

  // 新 job → 回 open
  const woke = memory.upsertQueueItem(dir, base, {
    jobUuid: 'j2',
    failureAt: '2026-07-14T11:00:00',
  });
  assert.strictEqual(woke.workStatus, 'open');
  assert.strictEqual(woke.reopenedBy, 'new_job');

  memory.setQueueWorkStatus(dir, fp, 'ignored');
  const still = memory.upsertQueueItem(dir, base, {
    jobUuid: 'j3',
    failureAt: '2026-07-14T12:00:00',
  });
  assert.strictEqual(still.workStatus, 'ignored');
  assert.strictEqual(still.ignoredStillFailing, true);

  // priority：ignored 不进
  assert.strictEqual(
    workStatus.isPriorityEligible(still, { recentDays: 1 }),
    false,
  );

  memory.setQueueWorkStatus(dir, fp, 'open');
  const openItem = memory.loadQueueItem(dir, fp);
  // 默认窗口 = 滚动 24h
  assert.strictEqual(
    workStatus.isPriorityEligible(openItem, {
      now: new Date('2026-07-14T15:00:00.000Z'),
      recentDays: 1,
    }),
    true,
  );

  // 超过 24h 不进优先
  openItem.lastFailureAt = '2026-07-13T14:00:00.000Z'; // 25h 前
  openItem.lastSeen = openItem.lastFailureAt;
  assert.strictEqual(
    workStatus.isPriorityEligible(openItem, {
      now: new Date('2026-07-14T15:00:00.000Z'),
      recentDays: 1,
    }),
    false,
  );

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok upsert and manual');
}

function testWorkbenchApi() {
  const dir = tmpDir();
  const cfg = { dataDir: dir, workbench: { enabled: true, priorityRecentDays: 1 } };
  const fp = 'fp-ws-api';
  memory.upsertQueueItem(
    dir,
    {
      fingerprint: fp,
      robotUuid: 'r2',
      errorType: 'IndexError',
      rawRemark: 'x',
    },
    { jobUuid: 'ja', failureAt: new Date().toISOString() },
  );

  const r1 = workbench.setFindingWorkStatus(fp, cfg, { status: 'snoozed', snoozeDays: 2 });
  assert.strictEqual(r1.ok, true);
  assert.strictEqual(r1.workStatus, 'snoozed');

  const bad = workbench.setFindingWorkStatus(fp, cfg, { status: 'nope' });
  assert.strictEqual(bad.ok, false);

  const detail = workbench.getFindingDetail(fp, cfg);
  assert.strictEqual(detail.ok, true);
  assert.strictEqual(detail.work.status, 'snoozed');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ok workbench api');
}

function main() {
  testMergeRules();
  testUpsertAndManual();
  testWorkbenchApi();
  console.log('test_work_status: all passed');
}

main();
