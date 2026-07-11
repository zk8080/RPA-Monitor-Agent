#!/usr/bin/env node
/**
 * Agent CLI：skill 路由 → agent-runner
 *
 *   node monitor/agent.js diagnose --fingerprint <fp>
 *   node monitor/agent.js diagnose --queue --limit 5
 *   node monitor/agent.js maintain inspect --robot <uuid>
 *   node monitor/agent.js maintain inspect --all-local
 *   node monitor/agent.js maintain fix --fingerprint <fp>
 *   node monitor/agent.js maintain fix --fingerprint <fp> --apply
 *   node monitor/agent.js maintain rollback --patch <id>
 */

const { loadConfig } = require('./lib/config');
const { runSkill } = require('./lib/agent-runner');

function parseArgs(argv) {
  const skill = (argv[0] || '').toLowerCase();
  const rest = argv.slice(1);
  const opts = {
    skill,
    action: null,
    jobUuid: null,
    fingerprint: null,
    robotUuid: null,
    patchId: null,
    queue: false,
    allLocal: false,
    limit: null,
    fetchLogs: false,
    dryRun: false,
    apply: false,
    force: false,
    forceApply: false,
    useLlm: true,
    withFailures: true,
    absolutePath: null,
    help: false,
  };

  // maintain: second token may be action
  if (skill === 'maintain' && rest[0] && !rest[0].startsWith('-')) {
    opts.action = rest.shift().toLowerCase();
  }

  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--job') opts.jobUuid = rest[++i];
    else if (a === '--fingerprint') opts.fingerprint = rest[++i];
    else if (a === '--robot') opts.robotUuid = rest[++i];
    else if (a === '--patch') opts.patchId = rest[++i];
    else if (a === '--queue') opts.queue = true;
    else if (a === '--all-local') opts.allLocal = true;
    else if (a === '--limit') opts.limit = parseInt(rest[++i], 10);
    else if (a === '--fetch-logs') opts.fetchLogs = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--apply') opts.apply = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--force-apply') opts.forceApply = true;
    else if (a === '--no-llm') opts.useLlm = false;
    else if (a === '--no-failures') opts.withFailures = false;
    else if (a === '--file') opts.absolutePath = rest[++i];
  }

  if (skill === 'maintain' && !opts.action) opts.action = 'inspect';
  return opts;
}

function printHelp() {
  console.log(`RPA Monitor & Diagnosis Agent

用法:
  node monitor/agent.js <skill> [动作] [选项]

Skills:
  diagnose    诊断失败（规则 ± LLM ± rpa-skill）
  maintain    维护：inspect | fix | rollback
  develop     预留

diagnose:
  --job <jobUuid>  --fingerprint <fp>  --queue [--limit N]
  --fetch-logs  --dry-run  --no-llm

maintain inspect:
  --robot <robotUuid>   单应用巡检
  --all-local           扫描本机 ShadowBot apps
  --no-failures         不附带 queue 失败热点
  --limit N             --all-local 时最多 N 个应用

maintain fix:
  --fingerprint <fp>    从 queue 取失败并 plan/apply
  --file <abs.py>       直接指定 py（测试）
  --apply               写盘（需 maintain.autoFix.enabled 或 --force-apply）
  --force               允许对 manual 类做 dry-run 预览
  --force-apply         忽略 autoFix 开关（慎用）

maintain rollback:
  --patch <patchId>

示例:
  node monitor/agent.js diagnose --fingerprint 获取发票税金号_e987ed40f9d6eccb --no-llm
  node monitor/agent.js maintain inspect --robot bd3b43b3-9fb2-4b94-896c-ab10d320b065
  node monitor/agent.js maintain fix --fingerprint <fp>
  node monitor/agent.js maintain rollback --patch patch-...
`);
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.skill || opts.help) {
    printHelp();
    process.exit(0);
  }

  const cfg = loadConfig();
  const input = {
    action: opts.action,
    jobUuid: opts.jobUuid,
    fingerprint: opts.fingerprint,
    robotUuid: opts.robotUuid,
    patchId: opts.patchId,
    queue: opts.queue,
    allLocal: opts.allLocal,
    limit: opts.limit,
    fetchLogs: opts.fetchLogs,
    dryRun: opts.dryRun,
    apply: opts.apply,
    force: opts.force,
    forceApply: opts.forceApply,
    useLlm: opts.useLlm,
    withFailures: opts.withFailures,
    absolutePath: opts.absolutePath,
    drain: opts.queue && opts.limit == null,
  };

  const result = await runSkill(opts.skill, input, { cfg, dryRun: opts.dryRun });

  if (!result.ok) {
    console.error(`❌ [${result.code}] ${result.message || ''}`);
    if (result.fixClass) console.error(JSON.stringify({ fixClass: result.fixClass, fixability: result.fixability, fixTargets: result.fixTargets }, null, 2));
    process.exit(result.code === 'unknown_skill' ? 2 : 1);
  }

  console.log(JSON.stringify(result, null, 2));
})().catch((e) => {
  console.error(`\n❌ agent 失败: ${e.message}`);
  if (e.stack) console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
