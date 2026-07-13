/**
 * queue 失败时间：真实 job 时间 vs poll 写入时间
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const memory = require('./lib/memory');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-qtime-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });

// 影刀本地时间 → ISO
const iso = memory.normalizeTime('2026-07-13 10:30:00');
assert.ok(iso);
assert.ok(iso.startsWith('2026-07-13'));

const fromJob = memory.pickJobFailureAt({
  triggerTime: '2026-07-13 09:00:00',
  startTime: '2026-07-13 09:01:00',
  endTime: '2026-07-13 09:05:30',
});
assert.strictEqual(fromJob, memory.normalizeTime('2026-07-13 09:05:30'));

const fp = {
  fingerprint: 'test-fp-time',
  errorSignature: 'flow|err|-',
  robotUuid: 'r1',
  robotName: 'App',
  flowName: '主流程',
  lineNumber: '1',
  errorType: '元素未找到',
  elementName: 'x',
  rawRemark: 'err',
};

// 首次入队：用 job 失败时间，不是 poll now
const pollNow = '2026-07-13T12:00:00.000Z';
const failAt = memory.normalizeTime('2026-07-13 09:05:30');
const a = memory.upsertQueueItem(dataDir, fp, {
  jobUuid: 'job-1',
  failureAt: failAt,
  now: pollNow,
});
assert.strictEqual(a.occurrenceCount, 1);
assert.strictEqual(a.lastSeen, failAt);
assert.strictEqual(a.lastFailureAt, failAt);
assert.strictEqual(a.firstSeen, failAt);
assert.strictEqual(a.lastPolledAt, pollNow);

// 同一 job 再次 poll：次数不涨，失败时间不变，只刷新 lastPolledAt
const pollNow2 = '2026-07-13T14:00:00.000Z';
const b = memory.upsertQueueItem(dataDir, fp, {
  jobUuid: 'job-1',
  failureAt: failAt,
  now: pollNow2,
});
assert.strictEqual(b.occurrenceCount, 1);
assert.strictEqual(b.lastSeen, failAt);
assert.strictEqual(b.lastPolledAt, pollNow2);
assert.deepStrictEqual(b.sampleJobUuids, ['job-1']);

// 新 job、更晚失败：次数 +1，lastSeen 推进
const failAt2 = memory.normalizeTime('2026-07-13 11:00:00');
const c = memory.upsertQueueItem(dataDir, fp, {
  jobUuid: 'job-2',
  failureAt: failAt2,
  now: '2026-07-13T15:00:00.000Z',
});
assert.strictEqual(c.occurrenceCount, 2);
assert.strictEqual(c.lastSeen, failAt2);
assert.strictEqual(c.firstSeen, failAt);
assert.strictEqual(c.sampleJobUuids.length, 2);

// 纠偏：旧数据 lastSeen 是 poll 时间，带真实 failureAt 应改回真实时间
const fp2 = { ...fp, fingerprint: 'test-fp-correct' };
const bad = memory.upsertQueueItem(dataDir, fp2, {
  jobUuid: 'job-x',
  // 无 failureAt → 会写成 now（旧行为兼容）
  now: '2026-07-13T16:00:00.000Z',
});
assert.strictEqual(bad.lastSeen, '2026-07-13T16:00:00.000Z');
const fixed = memory.upsertQueueItem(dataDir, fp2, {
  jobUuid: 'job-x',
  failureAt: failAt,
  now: '2026-07-13T17:00:00.000Z',
});
assert.strictEqual(fixed.occurrenceCount, 1);
assert.strictEqual(fixed.lastFailureAt, failAt);
assert.strictEqual(fixed.lastSeen, failAt);

console.log('✅ test_queue_time passed');
