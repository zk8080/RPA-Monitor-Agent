/**
 * Coding Agent 交接提示词（瘦身版）
 *
 * 给外部 Cursor / Claude Code 等，不是 Monitor 内 LLM 的 system/user prompt。
 * 默认短：路径 + 现象 + 最短约束；诊断结论 opt-in，避免噪音。
 *
 * 不可配置全文模板（首期）；仅 includeDiagnose 等开关。
 */

const REMARK_MAX = 280;
const DIAG_FIELD_MAX = 320;
const TASK_NOTE_MAX = 600;

function clip(s, max) {
  const t = String(s == null ? '' : s).trim();
  if (!t) return '';
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function truthyFlag(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

/**
 * @param {object} ctx
 * @param {string} [ctx.name]
 * @param {string} [ctx.robotUuid]
 * @param {string} [ctx.xbotDir]
 * @param {string} [ctx.taskNote]
 * @returns {string}
 */
function buildDevelopPrompt(ctx = {}) {
  const lines = [
    '# 任务 · 影刀 RPA 开发 / 维护',
    '当前工作区应已是该应用的 xbot_robot 目录。先理解结构，再按需求最小改动；写盘前说明影响面。',
    '',
    '## 工程',
  ];
  if (ctx.name) lines.push(`- 应用：${ctx.name}`);
  if (ctx.robotUuid) lines.push(`- robotUuid：${ctx.robotUuid}`);
  if (ctx.xbotDir) lines.push(`- 路径：${ctx.xbotDir}`);
  if (ctx.taskNote) {
    lines.push('', '## 本次需求', clip(ctx.taskNote, TASK_NOTE_MAX));
  }
  lines.push(
    '',
    '## 怎么做',
    '1. `/rpa understand` 或读 package.json / .dev 下流程与 py',
    '2. 最小改动；改 .flow.json 遵守 rpa skill 确认门槛',
    '3. 不要整库重写，不要假设其他未打开的应用目录',
  );
  return lines.join('\n');
}

/**
 * @param {object} ctx
 * @param {string} [ctx.name]
 * @param {string} [ctx.robotUuid]
 * @param {string} [ctx.xbotDir]
 * @param {string} [ctx.fingerprint]
 * @param {string} [ctx.flowName]
 * @param {string|number} [ctx.lineNumber]
 * @param {string} [ctx.errorType]
 * @param {string} [ctx.rawRemark]
 * @param {string} [ctx.guidanceTitle]
 * @param {string} [ctx.fixClass]
 * @param {string} [ctx.fixability]
 * @param {string} [ctx.rootCause]
 * @param {string} [ctx.suggestion]
 * @param {boolean} [ctx.includeDiagnose] 默认 false
 * @returns {string}
 */
function buildFixPrompt(ctx = {}) {
  const lines = [
    '# 修这个 RPA 失败',
    '当前工作区应已是该应用的 xbot_robot 目录。按失败现场定位并最小修复；先读后改。',
    '',
    '## 要改什么',
  ];
  if (ctx.name) lines.push(`- 应用：${ctx.name}`);
  if (ctx.xbotDir) lines.push(`- 路径：${ctx.xbotDir}`);
  else lines.push('- 路径：（未解析到 xbot_robot，请先在工作台确认本机应用）');
  if (ctx.robotUuid) lines.push(`- robotUuid：${ctx.robotUuid}`);

  if (ctx.flowName) {
    const loc =
      ctx.lineNumber != null && ctx.lineNumber !== ''
        ? `${ctx.flowName}  L${ctx.lineNumber}`
        : ctx.flowName;
    lines.push(`- 流程位置：${loc}`);
  }

  lines.push('', '## 现象');
  if (ctx.errorType) lines.push(`- 错误：${ctx.errorType}`);
  const remark = clip(ctx.rawRemark, REMARK_MAX);
  if (remark) lines.push(`- 备注：${remark}`);
  if (ctx.fingerprint) lines.push(`- 指纹：${ctx.fingerprint}`);

  const triageBits = [ctx.guidanceTitle, ctx.fixClass, ctx.fixability].filter(Boolean);
  if (triageBits.length) {
    lines.push(`- 分诊：${triageBits.join(' / ')}`);
  }
  if (ctx.bucketLabel || ctx.bucket) {
    lines.push(`- 分流：${ctx.bucketLabel || ctx.bucket}`);
  }
  // 环境/调度类：明确劝阻硬改业务代码
  if (ctx.actionable === 'ops' || ctx.bucket === 'env_robot' || ctx.bucket === 'schedule') {
    lines.push(
      '',
      '> ⚠ 分流为环境/调度类：优先查机器人在线、客户端、任务排队；**不要先改业务 py/flow**。',
    );
  } else if (ctx.bucket === 'element') {
    lines.push(
      '',
      '> 分流为元素类：优先查选择器/等待/页面结构；**不要当成 py 逻辑 bug 先改脚本**。',
    );
  }

  if (truthyFlag(ctx.includeDiagnose) && (ctx.rootCause || ctx.suggestion)) {
    lines.push('', '## Monitor 判断（参考，需核实）');
    if (ctx.rootCause) lines.push(`- 根因：${clip(ctx.rootCause, DIAG_FIELD_MAX)}`);
    if (ctx.suggestion) lines.push(`- 建议：${clip(ctx.suggestion, DIAG_FIELD_MAX)}`);
  }

  lines.push(
    '',
    '## 怎么做',
    '1. `/rpa understand` 或打开相关 .flow.json / py，对照流程名与行号（行号可能是块序号）',
    '2. 最小改动；写盘前说明影响面',
    '3. 改完说明如何验证（重跑任务 / 同指纹是否再出现）',
    '4. 不要整库重写；不要让用户再贴整份流程 JSON',
  );
  return lines.join('\n');
}

/**
 * @param {object} ctx
 * @param {'fix'|'develop'} [ctx.mode]
 * @returns {string}
 */
function buildAgentPrompt(ctx = {}) {
  const effective =
    ctx.mode === 'develop'
      ? 'develop'
      : ctx.mode === 'fix' || ctx.fingerprint
        ? 'fix'
        : 'develop';
  if (effective === 'develop') return buildDevelopPrompt(ctx);
  return buildFixPrompt(ctx);
}

/**
 * @param {string} markdown
 * @returns {{ lineCount: number, charCount: number }}
 */
function measurePrompt(markdown) {
  const s = String(markdown || '');
  return {
    lineCount: s ? s.split(/\r?\n/).length : 0,
    charCount: s.length,
  };
}

module.exports = {
  REMARK_MAX,
  DIAG_FIELD_MAX,
  buildDevelopPrompt,
  buildFixPrompt,
  buildAgentPrompt,
  measurePrompt,
  truthyFlag,
  clip,
};
