/**
 * Coding Agent 交接提示词（瘦身版）
 *
 * 给外部 Cursor / Claude Code 等，不是 Monitor 内 LLM 的 system/user prompt。
 * 默认短：路径 + 现象 + 最短约束；诊断结论 opt-in，避免噪音。
 * 应用 develop 可附带「聚焦节点」（来自 understand flowRoles），引导节点级深读。
 *
 * 不可配置全文模板（首期）；仅 includeDiagnose / focusNodes 等开关。
 */

const REMARK_MAX = 280;
const DIAG_FIELD_MAX = 320;
const TASK_NOTE_MAX = 600;
const ROLE_MAX = 160;
const MAX_FOCUS_NODES = 8;

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
 * 规范化用户勾选的聚焦节点（字符串或对象均可）
 * @param {Array<string|object>} raw
 * @returns {Array<{ name: string, filename?: string, kind?: string, role?: string, blockCount?: number|null, pyFile?: string }>}
 */
function normalizeFocusNodes(raw) {
  if (!Array.isArray(raw) || !raw.length) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= MAX_FOCUS_NODES) break;
    let name = '';
    let filename = '';
    let kind = '';
    let role = '';
    let blockCount = null;
    let pyFile = '';
    if (typeof item === 'string') {
      name = item.trim();
    } else if (item && typeof item === 'object') {
      name = String(item.name || item.label || item.filename || '').trim();
      filename = String(item.filename || item.file || '').trim();
      kind = String(item.kind || item.type || '').trim();
      role = String(item.role || item.summary || '').trim();
      if (item.blockCount != null && Number.isFinite(Number(item.blockCount))) {
        blockCount = Number(item.blockCount);
      }
      pyFile = String(item.pyFile || item.py || '').trim();
    }
    if (!name && filename) name = filename;
    if (!name) continue;
    const key = `${name}|${filename || ''}|${kind || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      filename: filename || undefined,
      kind: kind || undefined,
      role: role ? clip(role, ROLE_MAX) : undefined,
      blockCount: blockCount != null ? blockCount : undefined,
      pyFile: pyFile || undefined,
    });
  }
  return out;
}

/**
 * 从 understand 结果提取可选节点列表（优先 flowRoles，其次 callGraph 边端点）
 * @param {object} understandResult rpa.understandFlow 返回体
 * @returns {Array<object>}
 */
function listFocusCandidates(understandResult) {
  const r = understandResult || {};
  const out = [];
  const seen = new Set();

  const push = (node) => {
    const list = normalizeFocusNodes([node]);
    if (!list.length) return;
    const n = list[0];
    const key = `${n.name}|${n.filename || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(n);
  };

  const roles = Array.isArray(r.flowRoles) ? r.flowRoles : [];
  for (const fr of roles) {
    if (typeof fr === 'string') push({ name: fr, kind: 'flow' });
    else if (fr && typeof fr === 'object') {
      push({
        name: fr.name || fr.filename,
        filename: fr.filename,
        kind: fr.kind || (fr.pyFile ? 'code' : 'visual'),
        role: fr.role,
        blockCount: fr.blockCount,
        pyFile: fr.pyFile,
      });
    }
  }

  // flowRoles 为空时从 callGraph 补
  if (!out.length && r.callGraph) {
    const modules = Array.isArray(r.callGraph.codeModules) ? r.callGraph.codeModules : [];
    for (const m of modules) {
      push({
        name: m.name || m.filename,
        filename: m.filename,
        kind: 'code',
        role: m.summary || m.pySummary,
        pyFile: m.filename,
      });
    }
    const edges = Array.isArray(r.callGraph.edges) ? r.callGraph.edges : [];
    for (const e of edges) {
      if (e && e.from) push({ name: String(e.from), kind: 'flow' });
      if (e && e.to) push({ name: String(e.to), kind: e.toKind || 'flow' });
    }
  }

  return out.slice(0, 80);
}

/**
 * @param {object} ctx
 * @param {string} [ctx.name]
 * @param {string} [ctx.robotUuid]
 * @param {string} [ctx.xbotDir]
 * @param {string} [ctx.taskNote]
 * @param {Array} [ctx.focusNodes]
 * @returns {string}
 */
function buildDevelopPrompt(ctx = {}) {
  const focusNodes = normalizeFocusNodes(ctx.focusNodes);
  const hasFocus = focusNodes.length > 0;

  const lines = [
    hasFocus ? '# 任务 · 影刀 RPA 节点深读 / 维护' : '# 任务 · 影刀 RPA 开发 / 维护',
    hasFocus
      ? '当前工作区应已是该应用的 xbot_robot 目录。**只围绕下方聚焦节点**分析逻辑并按需最小改动；不要先输出整应用/全库概览。'
      : '当前工作区应已是该应用的 xbot_robot 目录。先理解结构，再按需求最小改动；写盘前说明影响面。',
    '',
    '## 工程',
  ];
  if (ctx.name) lines.push(`- 应用：${ctx.name}`);
  if (ctx.robotUuid) lines.push(`- robotUuid：${ctx.robotUuid}`);
  if (ctx.xbotDir) lines.push(`- 路径：${ctx.xbotDir}`);

  if (hasFocus) {
    lines.push('', '## 聚焦节点（优先，按勾选顺序）');
    focusNodes.forEach((n, i) => {
      const bits = [];
      if (n.filename && n.filename !== n.name) bits.push(`文件 ${n.filename}`);
      if (n.kind) bits.push(n.kind);
      if (n.blockCount != null) bits.push(`${n.blockCount} 块`);
      if (n.pyFile) bits.push(`py ${n.pyFile}`);
      const meta = bits.length ? `（${bits.join(' · ')}）` : '';
      lines.push(`${i + 1}. **${n.name}**${meta}`);
      if (n.role) lines.push(`   - 角色/摘要：${n.role}`);
    });
    lines.push(
      '',
      '## 分析要求',
      '1. 对每个聚焦节点说明：职责、主要输入/输出、关键分支与失败处理、调用的子流程/py',
      '2. 打开对应 .flow.json / .py，结合块指令与变量；需要时只读上下游 1 跳',
      '3. **禁止**先 `/rpa understand` 整库摘要或复述全流程阶段图；未要求时不要铺开未勾选节点',
      '4. 若要改代码：最小改动；写盘前说明影响面与如何验证',
    );
  } else {
    lines.push(
      '',
      '## 怎么做',
      '1. `/rpa understand` 或读 package.json / .dev 下流程与 py',
      '2. 最小改动；改 .flow.json 遵守 rpa skill 确认门槛',
      '3. 不要整库重写，不要假设其他未打开的应用目录',
    );
  }

  if (ctx.taskNote) {
    lines.push('', '## 本次需求', clip(ctx.taskNote, TASK_NOTE_MAX));
  }

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

  // 有明确失败位置时，收紧「先整库 understand」的引导
  if (ctx.flowName) {
    lines.push(
      '',
      '## 怎么做',
      `1. **先定位**流程「${ctx.flowName}」${
        ctx.lineNumber != null && ctx.lineNumber !== '' ? ` 附近 L${ctx.lineNumber}` : ''
      } 对应的 .flow.json / py；行号可能是块序号`,
      '2. 围绕失败点分析输入/等待/分支，不要先输出整应用概览',
      '3. 最小改动；写盘前说明影响面',
      '4. 改完说明如何验证（重跑任务 / 同指纹是否再出现）',
      '5. 不要整库重写；不要让用户再贴整份流程 JSON',
    );
  } else {
    lines.push(
      '',
      '## 怎么做',
      '1. `/rpa understand` 或打开相关 .flow.json / py，对照流程名与行号（行号可能是块序号）',
      '2. 最小改动；写盘前说明影响面',
      '3. 改完说明如何验证（重跑任务 / 同指纹是否再出现）',
      '4. 不要整库重写；不要让用户再贴整份流程 JSON',
    );
  }
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
  MAX_FOCUS_NODES,
  buildDevelopPrompt,
  buildFixPrompt,
  buildAgentPrompt,
  measurePrompt,
  truthyFlag,
  clip,
  normalizeFocusNodes,
  listFocusCandidates,
};
