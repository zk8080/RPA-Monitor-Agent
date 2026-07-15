#!/usr/bin/env node
/**
 * 感知入口（薄）：确定性 poll → queue / alerts
 *
 * 用法：
 *   node monitor/poll.js
 *   node monitor/poll.js --once
 *   node monitor/poll.js --hours 24
 *   node monitor/poll.js --max-pages 20
 */

const { loadConfig, requireYingdaoCredentials } = require('./lib/config');
const { pollOnce } = require('./lib/poll');

function parseArgs(argv) {
  const opts = { once: true, maxPages: null, lookbackHours: null, enrichLogs: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') opts.once = true;
    else if (a === '--max-pages') opts.maxPages = parseInt(argv[++i], 10) || null;
    else if (a === '--hours' || a === '--lookback-hours') opts.lookbackHours = parseInt(argv[++i], 10);
    else if (a === '--no-enrich') opts.enrichLogs = false;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node monitor/poll.js [选项]

确定性感知：按时间窗拉影刀运行记录 → 失败指纹去重 → data/queue/

默认：最近 24 小时（config.pollLookbackHours），时间窗内翻页拉全（上限 pollMaxPages）。

选项:
  --once                跑一轮后退出（默认）
  --hours N             最近 N 小时（默认读配置 24；0=不按时间）
  --max-pages N         最多翻页（默认时间窗 50 / 无时间窗 3）
  --no-enrich           remark 不足时也不拉步骤日志
  -h, --help            帮助

配置: monitor/config.local.js 或环境变量 YD_* / POLL_LOOKBACK_HOURS`);
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  let cfg;
  try {
    cfg = requireYingdaoCredentials(loadConfig());
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  const pollOpts = {
    enrichLogs: opts.enrichLogs,
    trigger: 'cli',
  };
  if (opts.maxPages != null) pollOpts.maxPages = opts.maxPages;
  if (opts.lookbackHours != null) pollOpts.lookbackHours = opts.lookbackHours;

  console.log(
    `▶ poll 开始  dataDir=${cfg.dataDir}  size=${cfg.size}  lookbackHours=${
      pollOpts.lookbackHours != null ? pollOpts.lookbackHours : cfg.pollLookbackHours
    }`,
  );
  const result = await pollOnce(cfg, pollOpts);

  const { stats, samples, cursor, pollRun } = result;
  console.log('\n── 结果 ──');
  if (stats.triggerTimeBegin) {
    console.log(`时间窗: ${stats.triggerTimeBegin}  →  ${stats.triggerTimeEnd}  (${stats.lookbackHours}h)`);
  } else {
    console.log('时间窗: （未启用，按条数分页）');
  }
  console.log(
    `pages=${stats.pages} scanned=${stats.scanned} failed=${stats.failed} ` +
      `new=${stats.enqueued} updated=${stats.updated} urgent=${stats.urgent} enriched=${stats.enriched}` +
      (stats.truncated ? '  ⚠️ truncated=maxPages' : ''),
  );
  console.log(`lastPollAt=${cursor.lastPollAt}`);
  if (pollRun) {
    console.log(
      `poll-run: id=${pollRun.id} jobs=${pollRun.jobCount} withLogs=${pollRun.logJobCount}`,
    );
  }

  if (samples.length) {
    console.log('\nqueue 样例:');
    samples.forEach((s) => {
      console.log(
        `  - [${s.occurrenceCount}x] ${s.robotName || ''} | ${s.flowName || '?'} L${s.lineNumber || '?'} | ${s.errorType || ''} | fp=${s.fingerprint}`,
      );
    });
  } else if (stats.failed === 0) {
    console.log('\n（本轮无失败记录入队。可稍后重跑，或放宽 robotClientUuid / 时间窗。）');
  }

  console.log('\n✅ poll 完成');
})().catch((e) => {
  console.error(`\n❌ poll 失败: ${e.message}`);
  process.exit(1);
});
