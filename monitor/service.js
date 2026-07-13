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

const { loadConfig, requireYingdaoCredentials } = require('./lib/config');
const { pollOnce } = require('./lib/poll');
const { runSkill } = require('./lib/agent-runner');
const { buildDailyReport } = require('./lib/report');
const { acquireLock, releaseLock } = require('./lib/lock');
const { cronMatchesNow, slotKey } = require('./lib/cron');
const { startHttpServer } = require('./lib/http/server');

function parseArgs(argv) {
  const opts = {
    once: false,
    diagnose: true,
    report: true,
    diagnoseLimit: 10,
    help: false,
    // null = 跟随 config.diagnoseUseLlm；true/false = CLI 强制
    forceNoLlm: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--once') opts.once = true;
    else if (a === '--no-diagnose') opts.diagnose = false;
    else if (a === '--no-report') opts.report = false;
    else if (a === '--diagnose-limit') opts.diagnoseLimit = parseInt(argv[++i], 10) || 10;
    else if (a === '--llm') opts.forceNoLlm = false;
    else if (a === '--no-llm') opts.forceNoLlm = true;
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
  --llm                强制诊断启用 LLM
  --no-llm             强制纯规则（覆盖 settings diagnoseUseLlm）
  -h, --help           帮助

常驻时：
  - 每 pollIntervalMinutes 执行 poll
  - 每轮 poll 后 drain 未诊断队列（limit）
  - 默认是否 LLM：settings.llm.json 的 diagnoseUseLlm（可用 --llm / --no-llm 覆盖）
  - diagnoseCron / reportCron（分 时 * * *）触发额外诊断/日报
  - healthPort>0 时提供 GET /health + 本机工作台 http://127.0.0.1:<port>/
  - data/service.pid 单实例锁
`);
}

const fs = require('fs');
const path = require('path');

let logFilePath = null;

function initFileLog(dataDir) {
  try {
    const dir = path.join(dataDir || path.join(__dirname, '..', 'data'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    // local calendar day for filename (match deploy scripts)
    const local = new Date();
    const y = local.getFullYear();
    const m = String(local.getMonth() + 1).padStart(2, '0');
    const d = String(local.getDate()).padStart(2, '0');
    logFilePath = path.join(dir, `service-${y}${m}${d}.log`);
  } catch {
    logFilePath = null;
  }
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
    } catch {
      /* ignore disk errors */
    }
  }
}

function resolveUseLlm(cfg, opts) {
  if (opts.forceNoLlm === true) return false;
  if (opts.forceNoLlm === false) return true;
  return cfg.diagnoseUseLlm !== false;
}

async function runPipeline(cfg, opts, label = 'cycle') {
  // 每轮热读配置（Web 改 LLM 后无需重启）
  let liveCfg = cfg;
  try {
    // eslint-disable-next-line global-require
    liveCfg = require('./lib/config').loadConfig();
  } catch {
    liveCfg = cfg;
  }

  log(`▶ ${label}: poll`);
  // 翻页上限走配置 pollMaxPages（默认 50），不再写死 3 页≈150 条
  const pollResult = await pollOnce(liveCfg, { enrichLogs: true });
  log(
    `  poll done scanned=${pollResult.stats.scanned} failed=${pollResult.stats.failed} ` +
      `new=${pollResult.stats.enqueued} updated=${pollResult.stats.updated}` +
      (pollResult.stats.regressed ? ` regressed=${pollResult.stats.regressed}` : '') +
      (pollResult.stats.verified ? ` verified=${pollResult.stats.verified}` : ''),
  );

  let diagnoseResult = null;
  if (opts.diagnose) {
    const useLlm = resolveUseLlm(liveCfg, opts);
    const keyOn = Boolean(liveCfg.llmApiKey || (liveCfg.llm && liveCfg.llm.apiKey));
    log(
      `▶ ${label}: diagnose --queue --limit ${opts.diagnoseLimit} useLlm=${useLlm} llmConfigured=${keyOn}`,
    );
    diagnoseResult = await runSkill(
      'diagnose',
      {
        queue: true,
        limit: opts.diagnoseLimit,
        useLlm,
      },
      { cfg: liveCfg },
    );
    if (diagnoseResult.ok) {
      log(
        `  diagnose processed=${diagnoseResult.processed ?? 1} remaining=${diagnoseResult.remaining ?? '?'}`,
      );
      // S17：诊后 dry-run patch 摘要（若开启 autoPlanOnDiagnose）
      const rows = diagnoseResult.results || [];
      const planned = rows.filter((r) => r.autoPlan && r.autoPlan.ok && r.autoPlan.patchId);
      if (planned.length) {
        log(`  autoPlan patches=${planned.length}`);
        planned.slice(0, 5).forEach((r) => {
          log(`    patch ${r.autoPlan.patchId} fp=${r.fingerprint}`);
        });
      }
    } else {
      log(`  diagnose skip/fail: ${diagnoseResult.message || diagnoseResult.code}`);
    }
  }

  let reportResult = null;
  if (opts.report) {
    log(`▶ ${label}: report`);
    reportResult = buildDailyReport(liveCfg, { write: true });
    log(`  report → ${reportResult.filePath} roots=${reportResult.stats.rootCauseCount}`);
  }

  return { pollResult, diagnoseResult, reportResult };
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

  initFileLog(cfg.dataDir);

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

    server = startHttpServer(cfg, state, { log });
    log(
      `service started pid=${process.pid} pollEvery=${cfg.pollIntervalMinutes}m ` +
        `diagnoseCron=${cfg.diagnoseCron} reportCron=${cfg.reportCron}`,
    );

    // 启动先跑一轮（失败只记日志，不拖垮 HTTP / 常驻）
    try {
      await runPipeline(cfg, opts, 'boot');
      state.lastPollAt = new Date().toISOString();
      if (opts.diagnose) state.lastDiagnoseAt = state.lastPollAt;
      if (opts.report) state.lastReportAt = state.lastPollAt;
    } catch (e) {
      log(`boot error (service keeps running): ${e && e.message ? e.message : e}`);
    }

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
            let liveCfg = cfg;
            try {
              // eslint-disable-next-line global-require
              liveCfg = require('./lib/config').loadConfig();
            } catch {
              /* keep */
            }
            await runSkill(
              'diagnose',
              {
                queue: true,
                limit: opts.diagnoseLimit,
                useLlm: resolveUseLlm(liveCfg, opts),
              },
              { cfg: liveCfg },
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

    // 未捕获异常/拒绝：记日志，尽量保持常驻（避免工作台端口突然消失）
    process.on('uncaughtException', (err) => {
      log(`uncaughtException: ${err && err.stack ? err.stack : err}`);
    });
    process.on('unhandledRejection', (reason) => {
      const msg = reason && reason.stack ? reason.stack : String(reason);
      log(`unhandledRejection: ${msg}`);
    });
  } catch (e) {
    console.error(`❌ service 失败: ${e.message}`);
    releaseLock(cfg.dataDir);
    process.exit(1);
  }
})();
