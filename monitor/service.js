#!/usr/bin/env node
/**
 * Agent 常驻 Runtime（薄调度壳）
 * 只调度已有 poll / runner / report，不复制业务逻辑。
 *
 * 用法：
 *   node monitor/service.js              # 常驻
 *   node monitor/service.js --once       # 单轮：poll → diagnose → report 后退出
 *   node monitor/service.js --no-diagnose
 *   node monitor/service.js --diagnose-limit 10
 */

const http = require('http');
const { loadConfig, requireYingdaoCredentials } = require('./lib/config');
const { pollOnce } = require('./lib/poll');
const { runSkill } = require('./lib/agent-runner');
const { buildDailyReport } = require('./lib/report');
const { acquireLock, releaseLock } = require('./lib/lock');
const { cronMatchesNow, slotKey } = require('./lib/cron');
const memory = require('./lib/memory');

function parseArgs(argv) {
  const opts = {
    once: false,
    diagnose: true,
    report: true,
    diagnoseLimit: 10,
    help: false,
    noLlm: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') opts.once = true;
    else if (a === '--no-diagnose') opts.diagnose = false;
    else if (a === '--no-report') opts.report = false;
    else if (a === '--diagnose-limit') opts.diagnoseLimit = parseInt(argv[++i], 10) || 10;
    else if (a === '--llm') opts.noLlm = false;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function printHelp() {
  console.log(`RPA Monitor & Diagnosis Agent — Runtime

用法:
  node monitor/service.js [选项]

选项:
  --once               执行一轮 poll→diagnose→report 后退出（适合任务计划）
  --no-diagnose        不跑诊断
  --no-report          不生成日报
  --diagnose-limit N   每轮最多诊断条数（默认 10）
  --llm                诊断启用 LLM 增强（默认纯规则）
  -h, --help           帮助

常驻时：
  - 每 pollIntervalMinutes 执行 poll
  - 每轮 poll 后 drain 未诊断队列（limit）
  - diagnoseCron / reportCron（分 时 * * *）触发额外诊断/日报
  - healthPort>0 时提供 GET /health
  - data/service.pid 单实例锁
`);
}

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function runPipeline(cfg, opts, label = 'cycle') {
  log(`▶ ${label}: poll`);
  const pollResult = await pollOnce(cfg, { maxPages: 3, enrichLogs: true });
  log(
    `  poll done scanned=${pollResult.stats.scanned} failed=${pollResult.stats.failed} ` +
      `new=${pollResult.stats.enqueued} updated=${pollResult.stats.updated}`,
  );

  let diagnoseResult = null;
  if (opts.diagnose) {
    log(`▶ ${label}: diagnose --queue --limit ${opts.diagnoseLimit}`);
    diagnoseResult = await runSkill(
      'diagnose',
      {
        queue: true,
        limit: opts.diagnoseLimit,
        useLlm: !opts.noLlm,
      },
      { cfg },
    );
    if (diagnoseResult.ok) {
      log(
        `  diagnose processed=${diagnoseResult.processed ?? 1} remaining=${diagnoseResult.remaining ?? '?'}`,
      );
    } else {
      log(`  diagnose skip/fail: ${diagnoseResult.message || diagnoseResult.code}`);
    }
  }

  let reportResult = null;
  if (opts.report) {
    log(`▶ ${label}: report`);
    reportResult = buildDailyReport(cfg, { write: true });
    log(`  report → ${reportResult.filePath} roots=${reportResult.stats.rootCauseCount}`);
  }

  return { pollResult, diagnoseResult, reportResult };
}

function startHealthServer(cfg, state) {
  const port = parseInt(String(cfg.healthPort || 0), 10) || 0;
  if (!port) {
    log('health disabled (healthPort=0)');
    return null;
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      const queue = memory.listQueueItems(cfg.dataDir);
      const body = {
        ok: true,
        service: 'rpa-monitor-agent',
        uptimeSec: Math.floor((Date.now() - state.startedAt) / 1000),
        lastPollAt: state.lastPollAt,
        lastDiagnoseAt: state.lastDiagnoseAt,
        lastReportAt: state.lastReportAt,
        queueDepth: queue.length,
        undiagnosed: queue.filter((q) => !q.diagnosed).length,
        pid: process.pid,
        dataDir: cfg.dataDir,
      };
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify(body, null, 2)}\n`);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  server.listen(port, '127.0.0.1', () => log(`health listening on http://127.0.0.1:${port}/health`));
  return server;
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

  const lock = acquireLock(cfg.dataDir);
  if (!lock.ok) {
    console.error(`❌ 已有实例在运行 (pid=${lock.pid})。若进程已死，删除 data/service.pid 后重试。`);
    process.exit(1);
  }

  const state = {
    startedAt: Date.now(),
    lastPollAt: null,
    lastDiagnoseAt: null,
    lastReportAt: null,
    firedDiagnoseSlot: null,
    firedReportSlot: null,
  };

  let stopping = false;
  let timer = null;
  let server = null;

  const cleanup = () => {
    if (stopping) return;
    stopping = true;
    log('shutting down…');
    if (timer) clearInterval(timer);
    if (server) server.close();
    releaseLock(cfg.dataDir);
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    if (opts.once) {
      const result = await runPipeline(cfg, opts, 'once');
      state.lastPollAt = new Date().toISOString();
      if (opts.diagnose) state.lastDiagnoseAt = state.lastPollAt;
      if (opts.report) state.lastReportAt = state.lastPollAt;
      log('✅ --once 完成');
      releaseLock(cfg.dataDir);
      // 非 0 仅当 poll 抛错；诊断失败仍 0
      process.exit(result.pollResult ? 0 : 1);
    }

    server = startHealthServer(cfg, state);
    log(
      `service started pid=${process.pid} pollEvery=${cfg.pollIntervalMinutes}m ` +
        `diagnoseCron=${cfg.diagnoseCron} reportCron=${cfg.reportCron}`,
    );

    // 启动先跑一轮
    await runPipeline(cfg, opts, 'boot');
    state.lastPollAt = new Date().toISOString();
    if (opts.diagnose) state.lastDiagnoseAt = state.lastPollAt;
    if (opts.report) state.lastReportAt = state.lastPollAt;

    const intervalMs = Math.max(1, cfg.pollIntervalMinutes || 15) * 60 * 1000;
    timer = setInterval(async () => {
      if (stopping) return;
      try {
        await runPipeline(cfg, { ...opts, report: false }, 'poll-interval');
        state.lastPollAt = new Date().toISOString();
        if (opts.diagnose) state.lastDiagnoseAt = state.lastPollAt;

        const now = new Date();
        if (opts.diagnose && cronMatchesNow(cfg.diagnoseCron, now)) {
          const sk = slotKey(cfg.diagnoseCron, now);
          if (sk && sk !== state.firedDiagnoseSlot) {
            state.firedDiagnoseSlot = sk;
            log('▶ cron diagnose');
            await runSkill(
              'diagnose',
              { queue: true, limit: opts.diagnoseLimit, useLlm: !opts.noLlm },
              { cfg },
            );
            state.lastDiagnoseAt = new Date().toISOString();
          }
        }
        if (opts.report && cronMatchesNow(cfg.reportCron, now)) {
          const sk = slotKey(cfg.reportCron, now);
          if (sk && sk !== state.firedReportSlot) {
            state.firedReportSlot = sk;
            log('▶ cron report');
            const r = buildDailyReport(cfg, { write: true });
            state.lastReportAt = new Date().toISOString();
            log(`  report → ${r.filePath}`);
          }
        }
      } catch (e) {
        log(`cycle error: ${e.message}`);
      }
    }, intervalMs);

    log(`interval armed every ${cfg.pollIntervalMinutes} minutes (Ctrl+C 退出)`);
  } catch (e) {
    console.error(`❌ service 失败: ${e.message}`);
    releaseLock(cfg.dataDir);
    process.exit(1);
  }
})();
