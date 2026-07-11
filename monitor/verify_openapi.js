#!/usr/bin/env node
/**
 * 影刀 OpenAPI 链路验证脚本
 *
 * 目的：验证 SPEC 7.3 两个卡点：
 *   1. jobUuid 衔接 — list → log/search
 *   2. 日志定位 — flowName + lineNumber + level
 *
 * S1 起：HTTP 逻辑全部走 lib/yingdao.js（禁止平行客户端）。
 *
 * 用法：
 *   node monitor/verify_openapi.js
 *
 * 环境变量覆盖（优先级 env > config.local.js）：
 *   YD_ACCESS_KEY_ID / YD_ACCESS_KEY_SECRET
 *   YD_ROBOT_CLIENT_UUID / YD_JOB_SIZE
 */

const { loadConfig, requireYingdaoCredentials } = require('./lib/config');
const { getToken, listJobs, searchLogs } = require('./lib/yingdao');

const hr = (t) => console.log(`\n${'='.repeat(64)}\n${t}\n${'='.repeat(64)}`);

function analyzeTextDensity(texts) {
  if (!texts.length) return null;
  const lenStats = {
    avg: Math.round(texts.reduce((s, t) => s + t.length, 0) / texts.length),
    max: Math.max(...texts.map((t) => t.length)),
    min: Math.min(...texts.map((t) => t.length)),
  };
  const kw = [
    '点击', '输入', '读取', '写入', '打开', '等待', '循环', '条件', '步骤', '指令', '元素',
    'excel', 'web', 'click', 'input', 'read', 'write', 'wait', 'loop', 'if', 'error',
    '异常', '失败', '超时', '不存在', '找不到',
  ];
  const hit = texts.filter((t) => kw.some((k) => t.toLowerCase().includes(k.toLowerCase())));
  return { lenStats, total: texts.length, withKeyword: hit.length, sample: hit.slice(0, 5) };
}

(async () => {
  let cfg;
  try {
    cfg = requireYingdaoCredentials(loadConfig());
  } catch (e) {
    console.error(`❌ ${e.message}`);
    console.error('   方式1（推荐）：编辑 monitor/config.local.js 填入密钥（文件已 gitignore，勿提交）');
    console.error('   方式2：设置环境变量 YD_ACCESS_KEY_ID / YD_ACCESS_KEY_SECRET');
    process.exit(1);
  }

  const robotClientUuid = cfg.robotClientUuid || undefined;
  const size = cfg.size;

  hr('Step 1: 鉴权获取 accessToken（lib/yingdao.getToken）');
  const token = await getToken({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
  });
  console.log(`✅ 鉴权成功，accessToken: ${token.slice(0, 8)}...（已脱敏）`);

  hr('Step 2: 查询应用运行列表 (lib/yingdao.listJobs)');
  const listRes = await listJobs(token, {
    robotClientUuid,
    size,
    cursorDirection: 'next',
  });
  console.log(`HTTP ${listRes.status}  请求体: ${JSON.stringify(listRes.payload)}`);
  console.log('原始响应:');
  console.log(JSON.stringify(listRes.body, null, 2));

  hr('验证点 1: jobUuid 衔接');
  const dataList = listRes.dataList || [];
  const hasJobUuid = dataList.length > 0 && dataList.every((r) => r.jobUuid);
  console.log(`记录条数: ${dataList.length}`);
  console.log(
    `每条都带 jobUuid: ${
      hasJobUuid
        ? '✅ 是 -- 可直接喂给 job/log/search，无需 runRecordId 转换'
        : '❌ 否 -- 需另找衔接字段'
    }`,
  );
  if (dataList.length) {
    console.log(
      `示例: id=${dataList[0].id}  jobUuid=${dataList[0].jobUuid}  status=${dataList[0].status}  robot=${dataList[0].robotName}`,
    );
  }
  if (!dataList.length) {
    console.log('⚠️ 未拉到任何记录。可能机器人近期无运行，或需要传 robotClientUuid 缩小范围。');
    return;
  }

  const failed = dataList.filter(
    (r) => r.status === 'error' || r.status === 'stopped' || r.status === 'fail',
  );
  hr(`Step 3: 筛选失败记录 (status=error/stopped/fail，共 ${failed.length} 条)`);
  if (failed.length) {
    failed.slice(0, 5).forEach((r) =>
      console.log(
        `- [${r.status}] ${r.robotName || ''} / ${r.taskName || ''} | jobUuid=${r.jobUuid} | remark=${r.remark || ''}`,
      ),
    );
  } else {
    console.log('⚠️ 近期无失败记录，无法验证日志接口。可手动触发一个会失败的应用运行后再跑本脚本。');
    console.log('   （jobUuid 衔接点已由 Step 2 证明，log text 密度仍需一条失败记录来验证）');
    return;
  }

  hr('Step 4: 查询步骤级日志 (lib/yingdao.searchLogs)');
  const target = failed[0];
  console.log(`目标记录: ${target.robotName} | jobUuid=${target.jobUuid}`);
  const logRes = await searchLogs(token, target.jobUuid, { page: 1, size: 100 });
  console.log(`HTTP ${logRes.status}  请求体: ${JSON.stringify(logRes.payload)}`);
  console.log('原始响应:');
  console.log(JSON.stringify(logRes.body, null, 2));

  hr('验证点 2: 步骤日志的定位能力');
  const logList = logRes.logs || [];
  console.log(`日志条数: ${logList.length}`);
  if (!logList.length) {
    console.log('❌ 未取到日志条目 -- 检查上方原始响应结构');
    return;
  }

  const fields = Object.keys(logList[0] || {});
  const withFlow = logList.filter((l) => l && l.flowName);
  const withLine = logList.filter((l) => l && l.lineNumber);
  console.log(`日志字段: ${fields.join(', ')}`);
  console.log(`带 flowName: ${withFlow.length}/${logList.length}   带 lineNumber: ${withLine.length}/${logList.length}`);

  const errLogs = logList.filter((l) => l && /错误|error|err/i.test(l.level || ''));
  console.log(`\n错误级日志 (level=错误): ${errLogs.length} 条`);
  errLogs.slice(0, 10).forEach((l) =>
    console.log(
      `  - [${l.level}] flowName=${l.flowName || ''} line=${l.lineNumber || ''} | text=${l.text || ''}`,
    ),
  );

  const texts = logList.map((l) => (l || {}).text).filter(Boolean);
  const analysis = analyzeTextDensity(texts);

  console.log('\n结论:');
  const hasLocation = errLogs.length > 0 && errLogs.every((l) => l.flowName && l.lineNumber);
  if (hasLocation) {
    console.log('✅ 错误日志带 flowName + lineNumber + level -- 可直接定位到出错的子流程和行号');
    console.log('   无需 text 语义匹配，诊断层用 flowName+lineNumber 对齐 understand 解析的流程结构即可');
    console.log('   SPEC 7.3 卡点 2 通过（且比预期更好：有专用定位字段，不只靠 text 密度）');
  } else if (errLogs.length === 0) {
    console.log('⚠️ 该运行无错误级日志 -- 换一条 error 记录验证，或检查 level 字段取值');
  } else {
    console.log(
      `⚠️ text 密度: avg=${analysis.lenStats.avg}字, 含关键词 ${analysis.withKeyword}/${analysis.total}`,
    );
    console.log('   错误日志缺少 flowName/lineNumber，需靠 text 语义匹配定位指令块');
  }
})().catch((e) => {
  console.error('\n❌ 出错:', e.message);
  process.exit(1);
});
