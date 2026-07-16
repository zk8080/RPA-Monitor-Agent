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

  // resolved + 新 job → 回 open（复发）
  const rs = workStatus.mergeWorkStatusOnUpsert(
    {
      workStatus: 'resolved',
      resolutionRootCause: '元素找不到',
      resolutionSolution: '已改选择器',
      resolvedAt: '2026-07-13T00:00:00.000Z',
    },
    { isNewJob: true, now },
  );
  assert.strictEqual(rs.workStatus, 'open');
  assert.strictEqual(rs.reopenedBy, 'new_job');
  assert.strictEqual(rs.resolutionRootCause, '元素找不到');
  assert.strictEqual(rs.resolutionSolution, '已改选择器');

  // resolved + 非新 job → 保持 resolved
  const rsKeep = workStatus.mergeWorkStatusOnUpsert(
    { workStatus: 'resolved', resolutionRootCause: 'x' },
    { isNewJob: false, now },
  );
  assert.strictEqual(rsKeep.workStatus, 'resolved');

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

  // resolved 读路径：不进优先
  const resEff = workStatus.resolveEffectiveWorkStatus(
    { workStatus: 'resolved', resolutionRootCause: 'a' },
    now,
  );
  assert.strictEqual(resEff.workStatus, 'resolved');
  assert.strictEqual(resEff.effectiveOpen, false);
  assert.strictEqual(resEff.workStatusLabel, '处理完成');
  assert.strictEqual(resEff.resolutionRootCause, 'a');

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

  // resolved：可空说明；新 job 拉回
  const done = memory.setQueueWorkStatus(dir, fp, 'resolved', {
    rootCause: '上游缺列',
    solution: '业务补数据后重跑',
  });
  assert.strictEqual(done.workStatus, 'resolved');
  assert.strictEqual(done.resolutionRootCause, '上游缺列');
  assert.strictEqual(done.resolutionSolution, '业务补数据后重跑');
  assert.ok(done.resolvedAt);
  assert.strictEqual(
    workStatus.isPriorityEligible(done, {
      now: new Date('2026-07-14T15:00:00.000Z'),
      recentDays: 1,
    }),
    false,
  );
  const doneWoke = memory.upsertQueueItem(dir, base, {
    jobUuid: 'j4',
    failureAt: '2026-07-14T13:00:00',
  });
  assert.strictEqual(doneWoke.workStatus, 'open');
  assert.strictEqual(doneWoke.reopenedBy, 'new_job');
  // 历史说明保留
  assert.strictEqual(doneWoke.resolutionRootCause, '上游缺列');

  // 空说明也可 resolved
  const emptyNote = memory.setQueueWorkStatus(dir, fp, 'resolved', {
    rootCause: '',
    solution: '',
  });
  assert.strictEqual(emptyNote.workStatus, 'resolved');
  assert.strictEqual(emptyNote.resolutionRootCause, '');

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

  const r2 = workbench.setFindingWorkStatus(fp, cfg, {
    status: 'resolved',
    rootCause: '超时',
    solution: '调大 wait',
  });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.workStatus, 'resolved');
  assert.strictEqual(r2.rootCause, '超时');
  assert.strictEqual(r2.solution, '调大 wait');

  const detail2 = workbench.getFindingDetail(fp, cfg);
  assert.strictEqual(detail2.ok, true);
  assert.strictEqual(detail2.work.status, 'resolved');
  assert.strictEqual(detail2.work.label, '处理完成');
  assert.strictEqual(detail2.work.rootCause, '超时');
  assert.strictEqual(detail2.work.solution, '调大 wait');

  // 可空说明
  const r3 = workbench.setFindingWorkStatus(fp, cfg, { status: 'resolved' });
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.workStatus, 'resolved');
  assert.strictEqual(r3.rootCause, '');
  assert.strictEqual(r3.solution, '');

  // 终态：不可改为 snoozed / ignored
  const blockSn = workbench.setFindingWorkStatus(fp, cfg, { status: 'snoozed' });
  assert.strictEqual(blockSn.ok, false);
  assert.strictEqual(blockSn.code, 'terminal_resolved');
  const blockIg = workbench.setFindingWorkStatus(fp, cfg, { status: 'ignored' });
  assert.strictEqual(blockIg.ok, false);
  assert.strictEqual(blockIg.code, 'terminal_resolved');

  // 终态：可补说明、可恢复待处理
  const edit = workbench.setFindingWorkStatus(fp, cfg, {
    status: 'resolved',
    rootCause: '补一句',
    solution: 'ok',
  });
  assert.strictEqual(edit.ok, true);
  assert.strictEqual(edit.rootCause, '补一句');
  const reopen = workbench.setFindingWorkStatus(fp, cfg, { status: 'open' });
  assert.strictEqual(reopen.ok, true);
  assert.strictEqual(reopen.workStatus, 'open');
  assert.strictEqual(reopen.reopenedBy, 'manual');

  // assertManualTransition 单元
  assert.strictEqual(
    workStatus.assertManualTransition('resolved', 'ignored').ok,
    false,
  );
  assert.strictEqual(workStatus.assertManualTransition('resolved', 'open').ok, true);
  assert.strictEqual(workStatus.assertManualTransition('resolved', 'resolved').ok, true);
  assert.strictEqual(workStatus.assertManualTransition('open', 'ignored').ok, true);

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
