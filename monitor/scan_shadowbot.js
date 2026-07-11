#!/usr/bin/env node
/**
 * 扫描本机影刀 apps，校验 robotUuid → xbot_robot 自动解析
 *
 * 用法:
 *   node monitor/scan_shadowbot.js
 *   node monitor/scan_shadowbot.js --write-map   # 生成 data/app-map.auto.json（不覆盖 app-map.json）
 *   node monitor/scan_shadowbot.js --robot <uuid>
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./lib/config');
const {
  scanLocalApps,
  resolveXbotDir,
  getShadowBotUsersRoot,
} = require('./lib/rpa');

function parseArgs(argv) {
  const opts = { writeMap: false, robot: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--write-map') opts.writeMap = true;
    else if (a === '--robot') opts.robot = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`用法: node monitor/scan_shadowbot.js [--write-map] [--robot <uuid>]

在 %LOCALAPPDATA%\\ShadowBot\\users\\*\\apps\\<robotUuid>\\xbot_robot 下自动发现流程目录。
手工覆盖仍可写 data/app-map.json。`);
    process.exit(0);
  }

  const cfg = loadConfig();
  const usersRoot = getShadowBotUsersRoot(cfg);
  console.log(`ShadowBot users 根: ${usersRoot}`);
  console.log(`存在: ${fs.existsSync(usersRoot)}`);

  if (opts.robot) {
    const r = resolveXbotDir(opts.robot, { cfg });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.mapped && r.xbotDir ? 0 : 1);
  }

  const scan = scanLocalApps(cfg);
  console.log(`账号数: ${scan.userCount}  应用(有 xbot_robot): ${scan.apps.length}`);
  scan.apps.slice(0, 30).forEach((a) => {
    console.log(`- ${a.robotUuid}  ${a.name || '(no name)'}  user=${a.userId}`);
    console.log(`  ${a.xbotDir}`);
  });
  if (scan.apps.length > 30) console.log(`… 另有 ${scan.apps.length - 30} 个`);

  // 抽样 resolve
  if (scan.apps[0]) {
    const sample = resolveXbotDir(scan.apps[0].robotUuid, { cfg });
    console.log('\n抽样 resolve_app:');
    console.log(JSON.stringify(sample, null, 2));
  }

  if (opts.writeMap) {
    const map = {};
    for (const a of scan.apps) {
      map[a.robotUuid] = { name: a.name || a.robotUuid, xbotDir: a.xbotDir, userId: a.userId };
    }
    const out = path.join(cfg.dataDir, 'app-map.auto.json');
    fs.mkdirSync(cfg.dataDir, { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    console.log(`\n✅ 已写入 ${out}（自动扫描结果；运行时不必依赖此文件，resolve 已内置自动发现）`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
