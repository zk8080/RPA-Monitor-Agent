#!/usr/bin/env node
/**
 * 日报入口（薄）：聚合 queue/kb/alerts → data/reports/YYYY-MM-DD.md
 *
 * 用法：
 *   node monitor/report.js
 *   node monitor/report.js --date 2026-07-11
 *   node monitor/report.js --scope poll_window|calendar_day|all
 *   node monitor/report.js --stdout-only
 */

const { loadConfig } = require('./lib/config');
const { buildDailyReport } = require('./lib/report');

function parseArgs(argv) {
  const opts = { date: null, stdoutOnly: false, scope: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--date') opts.date = argv[++i];
    else if (a === '--scope') opts.scope = argv[++i];
    else if (a === '--stdout-only') opts.stdoutOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`用法: node monitor/report.js [选项]

从 data/queue · kb · alerts 渲染日报（不重跑诊断）。

选项:
  --date YYYY-MM-DD              指定日期（默认今天）
  --scope poll_window|calendar_day|all
                                 默认 poll_window=最近一次 poll 时间窗
  --stdout-only                  只打印，不写文件
  -h, --help
`);
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }
  const cfg = loadConfig();
  const result = buildDailyReport(cfg, {
    date: opts.date || undefined,
    write: !opts.stdoutOnly,
    scope: opts.scope || undefined,
  });
  console.log(result.markdown);
  if (result.filePath) {
    console.error(`\n✅ 已写入 ${result.filePath}`);
  }
  console.error(
    `scope=${result.scope} | in-report=${result.stats.rootCauseCount} queueTotal=${result.stats.queueTotal} ` +
      `diagnosed=${result.stats.diagnosed} pending=${result.stats.pending}`,
  );
})().catch((e) => {
  console.error(`❌ report 失败: ${e.message}`);
  process.exit(1);
});
