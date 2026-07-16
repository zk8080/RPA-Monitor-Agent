/**
 * cron 极简解析 / 命中 / 当日 due 补跑
 */
const assert = require('assert');
const { parseSimpleCron, cronMatchesNow, cronDueToday, slotKey } = require('./lib/cron');

const p = parseSimpleCron('5 9 * * *');
assert.deepStrictEqual(p, { minute: 5, hour: 9 });
assert.strictEqual(parseSimpleCron('bad'), null);

const at905 = new Date(2026, 6, 16, 9, 5, 10); // local Jul 16 09:05
const at904 = new Date(2026, 6, 16, 9, 4, 59);
const at906 = new Date(2026, 6, 16, 9, 6, 0);
const at1000 = new Date(2026, 6, 16, 10, 0, 0);
const at800 = new Date(2026, 6, 16, 8, 0, 0);

assert.strictEqual(cronMatchesNow('5 9 * * *', at905), true);
assert.strictEqual(cronMatchesNow('5 9 * * *', at904), false);
assert.strictEqual(cronMatchesNow('5 9 * * *', at906), false);

assert.strictEqual(cronDueToday('5 9 * * *', at800), false);
assert.strictEqual(cronDueToday('5 9 * * *', at904), false);
assert.strictEqual(cronDueToday('5 9 * * *', at905), true);
assert.strictEqual(cronDueToday('5 9 * * *', at906), true);
assert.strictEqual(cronDueToday('5 9 * * *', at1000), true);

assert.strictEqual(slotKey('5 9 * * *', at1000), '2026-07-16T09:05');
assert.strictEqual(slotKey('5 9 * * *', at800), '2026-07-16T09:05');

console.log('ok cron');
