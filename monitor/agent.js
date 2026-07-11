#!/usr/bin/env node
/**
 * Agent CLI 入口（薄）：skill 路由 → agent-runner
 *
 * 用法：
 *   node monitor/agent.js diagnose --queue --limit 5
 *   node monitor/agent.js diagnose --fingerprint <fp>
 *   node monitor/agent.js diagnose --job <jobUuid>
 *   node monitor/agent.js develop ...
 */

const { loadConfig } = require('./lib/config');
const { runSkill } = require('./lib/agent-runner');

function parseArgs(argv) {
  const skill = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);
  const opts = {
    skill,
    jobUuid: null,
    fingerprint: null,
    queue: false,
    limit: null,
    fetchLogs: false,
    dryRun: false,
    useLlm: true,
    help: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--job') opts.jobUuid = rest[++i];
    else if (a === '--fingerprint') opts.fingerprint = rest[++i];
    else if (a === '--queue') opts.queue = true;
    else if (a === '--limit') opts.limit = parseInt(rest[++i], 10);
    else if (a === '--fetch-logs') opts.fetchLogs = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--no-llm') opts.useLlm = false;
  }
  return opts;
}

function printHelp() {
  console.log(`RPA Monitor & Diagnosis Agent

用法:
  node monitor/agent.js <skill> [选项]

Skills:
  diagnose    诊断失败运行（M1-min playbook → 结构化结果 → KB）
  develop     预留（skill_not_implemented）
  maintain    预留（skill_not_implemented）

diagnose 选项:
  --job <jobUuid>           指定运行 UUID
  --fingerprint <fp>        指定 queue 指纹
  --queue                   消费未诊断队列（建议加 --limit）
  --limit N                 批量诊断条数（与 --queue 联用，默认 5）
  --fetch-logs              强制拉步骤日志补全
  --dry-run                 只诊断不写 KB / 不改 queue
  --no-llm                  禁用 LLM 增强（纯规则）
  -h, --help                帮助

示例:
  node monitor/agent.js diagnose --queue --limit 3 --no-llm
  node monitor/agent.js diagnose --fingerprint 获取发票税金号_e987ed40f9d6eccb --no-llm
`);
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.skill || opts.help) {
    printHelp();
    process.exit(0);
  }

  const cfg = loadConfig();
  const result = await runSkill(
    opts.skill,
    {
      jobUuid: opts.jobUuid,
      fingerprint: opts.fingerprint,
      queue: opts.queue,
      limit: opts.limit,
      drain: opts.queue && opts.limit == null,
      fetchLogs: opts.fetchLogs,
      dryRun: opts.dryRun,
      useLlm: opts.useLlm,
    },
    { cfg, dryRun: opts.dryRun },
  );

  if (!result.ok) {
    console.error(`❌ [${result.code}] ${result.message}`);
    process.exit(result.code === 'unknown_skill' ? 2 : 1);
  }

  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error(`\n❌ agent 失败: ${e.message}`);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
