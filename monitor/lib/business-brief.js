/**
 * 业务解读：在 rpa-skill understand 结构摘要之上调用 LLM，生成业务向说明（推测）。
 * 不替代 understand；结果须标注「模型推测」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chatJson, isLlmConfigured, resolveLlmConfig } = require('./llm');

const CACHE_DIR = 'cache/business-brief';
const PROMPT_FILE = 'settings.business-brief.json';

/**
 * 内置默认提示词（可被 data/settings.business-brief.json 覆盖）
 * 目标：业务一页纸（谁、为了什么、单据怎么流转），不是 RPA 执行链路复述。
 */
const DEFAULT_SYSTEM_PROMPT = [
  '你是影刀 RPA 的「业务翻译」助手。输入是 understand 结构摘要（调用图、阶段、流程角色等）。',
  '读者是业务接手人或开发者，要快速看懂：这个机器人在业务上完成什么事，单据怎么走。',
  '',
  '核心目标：写「业务流程」，不是「自动化怎么实现」。',
  '',
  '硬规则：',
  '1. 只能依据材料推断；材料没有的写进 openQuestions，禁止编造字段名、审批规则、接口路径、菜单路径。',
  '2. businessFlow 只写业务状态变化（处理什么对象 → 到什么结果），4～8 步，每步一句人话，尽量 ≤30 字。',
  '3. businessFlow / systems / dataObjects / purpose 中禁止出现实现词，例如：',
  '   配置文件、配置字典、变量、运行目录、初始化、浏览器会话、子流程、process.run、',
  '   Python 模块名、函数名、Excel 单元格格式、等待/重试/清理窗口、日志、异常处理、归档路径。',
  '4. 上述实现细节如有必要，只放进 techHighlights（可短）。',
  '5. systems 只列业务触点（网页业务系统、钉钉/企微、源表格/单据系统等）；',
  '   不要写「本地文件系统」「配置表」这类纯运行环境，除非它本身就是业务交付物。',
  '6. dataObjects 只写业务单据/主数据（如心电报告、发票、待办清单），不要写配置、变量、临时文件。',
  '7. purpose 2～3 句口语：谁/什么场景、输入从哪来、输出到哪去、解决什么重复劳动；',
  '   不要写「全文为模型推测」等免责声明（系统会另标）。',
  '8. risks 写业务后果（录错、漏回写、状态误判、通知不到位），少写纯运维措辞。',
  '9. openQuestions 优先问业务方能回答的问题（系统名、字段、成功标准、通知对象），少问代码细节。',
  '10. flowGraph（可选）：用 nodes + edges 描述业务图。主路径边不要 when；仅当材料明确支持时才加带 when 的分支边（如成功/失败）。',
  '    无依据不要编造菱形分支。节点 label 同样禁止实现词。id 用 n1、n2… 简短稳定。',
  '11. 全文是模型推测；不确定用「可能/推测」一笔带过，不要反复道歉。',
  '12. 只输出一个 JSON 对象，不要 Markdown 围栏，不要解释文字。',
].join('\n');

const DEFAULT_USER_PROMPT_TEMPLATE = [
  '根据下列材料，输出业务向 JSON（字段名必须一致）：',
  '{',
  '  "title": "业务标题，一句话，像给人介绍「这机器人干什么」",',
  '  "purpose": "2～3 句：场景 + 输入 + 输出 + 价值（口语）",',
  '  "businessFlow": [',
  '    "业务步骤1：用业务语言描述状态变化",',
  '    "业务步骤2",',
  '    "…共 4～8 步，不要实现步骤"',
  '  ],',
  '  "flowGraph": {',
  '    "nodes": [{ "id": "n1", "label": "与 businessFlow 一致的业务短句" }],',
  '    "edges": [',
  '      { "from": "n1", "to": "n2" },',
  '      { "from": "n3", "to": "n4", "when": "失败（仅材料支持时）" }',
  '    ]',
  '  },',
  '  "systems": ["业务触达的系统/通道，3～6 个为宜"],',
  '  "dataObjects": ["核心业务对象/单据，3～6 个为宜"],',
  '  "techHighlights": ["可选，实现侧备注，给开发看；可空数组"],',
  '  "risks": ["业务风险，2～5 条"],',
  '  "openQuestions": ["需业务确认的问题，3～6 条"],',
  '  "confidence": 0.0',
  '}',
  '',
  'flowGraph 规则：',
  '- nodes 4～10 个；label 业务话，≤30 字。',
  '- 主路径：按业务顺序用无 when 的边串起来（可与 businessFlow 对齐）。',
  '- 分支：仅材料能支持时写 when（成功/失败/跳过等）；无依据则只输出主路径边。',
  '- 不要为「好看」给每一步都加失败口。',
  '- 若拿不准图结构，可省略 flowGraph 或只给主路径；系统会用 businessFlow 画直线。',
  '',
  '自检（输出前默念）：',
  '- 若某步删掉后业务同事仍能听懂整条链路，那它多半是实现细节，移出 businessFlow。',
  '- 步骤主语应是业务对象或业务动作，而不是「机器人初始化」。',
  '',
  '好例子（业务步骤）：',
  '["从表格读取待处理心电报告", "登录 eImage 并进入录入页面", "按条查询并录入报告", "把成功/失败写回表格", "汇总结果并通知相关人"]',
  '',
  '坏例子（禁止，属于实现链路）：',
  '["读取配置文件初始化变量", "创建运行目录", "建立浏览器会话", "解析 Excel 单元格格式", "调用 writeback_result"]',
  '',
  '材料：',
  '{{digest}}',
].join('\n');

const DEFAULT_PROMPT_SETTINGS = {
  version: 1,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE,
  temperature: 0.3,
  maxTokens: 2200,
};

function cacheDir(dataDir) {
  return path.join(dataDir, CACHE_DIR);
}

function promptSettingsPath(dataDir) {
  return path.join(dataDir, PROMPT_FILE);
}

function getDefaultPromptSettings() {
  return {
    ...DEFAULT_PROMPT_SETTINGS,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPromptTemplate: DEFAULT_USER_PROMPT_TEMPLATE,
  };
}

/**
 * 读取可配置提示词（无文件则默认）
 * @param {string} dataDir
 */
function loadPromptSettings(dataDir) {
  const defaults = getDefaultPromptSettings();
  if (!dataDir) return { ...defaults, source: 'default', customized: false, updatedAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(promptSettingsPath(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object') {
      return { ...defaults, source: 'default', customized: false, updatedAt: null };
    }
    const temperature = Number(raw.temperature);
    const maxTokens = parseInt(String(raw.maxTokens), 10);
    return {
      version: 1,
      systemPrompt:
        raw.systemPrompt != null && String(raw.systemPrompt).trim()
          ? String(raw.systemPrompt)
          : defaults.systemPrompt,
      userPromptTemplate:
        raw.userPromptTemplate != null && String(raw.userPromptTemplate).trim()
          ? String(raw.userPromptTemplate)
          : defaults.userPromptTemplate,
      temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : defaults.temperature,
      maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.min(8000, maxTokens) : defaults.maxTokens,
      source: 'file',
      customized: true,
      updatedAt: raw.updatedAt || null,
    };
  } catch {
    return { ...defaults, source: 'default', customized: false, updatedAt: null };
  }
}

/**
 * @param {string} dataDir
 * @param {object} body
 * @param {{ settingsEnabled?: boolean }} [opts]
 */
function savePromptSettings(dataDir, body = {}, opts = {}) {
  if (opts.settingsEnabled === false) {
    return { ok: false, code: 'settings_disabled', message: 'workbench.settingsEnabled=false' };
  }
  if (!dataDir) return { ok: false, code: 'no_data_dir', message: '缺少 dataDir' };

  const prev = loadPromptSettings(dataDir);
  const next = {
    version: 1,
    updatedAt: new Date().toISOString(),
    systemPrompt:
      body.systemPrompt != null ? String(body.systemPrompt) : prev.systemPrompt,
    userPromptTemplate:
      body.userPromptTemplate != null ? String(body.userPromptTemplate) : prev.userPromptTemplate,
    temperature:
      body.temperature != null ? Number(body.temperature) : prev.temperature,
    maxTokens: body.maxTokens != null ? parseInt(String(body.maxTokens), 10) : prev.maxTokens,
  };

  if (!String(next.systemPrompt).trim()) {
    return { ok: false, code: 'invalid', message: 'systemPrompt 不能为空' };
  }
  if (!String(next.userPromptTemplate).trim()) {
    return { ok: false, code: 'invalid', message: 'userPromptTemplate 不能为空' };
  }
  if (!Number.isFinite(next.temperature) || next.temperature < 0 || next.temperature > 2) {
    return { ok: false, code: 'invalid', message: 'temperature 须在 0～2' };
  }
  if (!Number.isFinite(next.maxTokens) || next.maxTokens < 256) {
    return { ok: false, code: 'invalid', message: 'maxTokens 无效' };
  }
  next.maxTokens = Math.min(8000, next.maxTokens);

  fs.mkdirSync(dataDir, { recursive: true });
  const file = promptSettingsPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);

  return {
    ok: true,
    saved: true,
    ...loadPromptSettings(dataDir),
    defaults: getDefaultPromptSettings(),
    placeholders: ['{{digest}}', '{{material}}'],
  };
}

function resetPromptSettings(dataDir, opts = {}) {
  if (opts.settingsEnabled === false) {
    return { ok: false, code: 'settings_disabled', message: 'workbench.settingsEnabled=false' };
  }
  if (!dataDir) return { ok: false, code: 'no_data_dir', message: '缺少 dataDir' };
  try {
    const file = promptSettingsPath(dataDir);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // ignore
  }
  return {
    ok: true,
    reset: true,
    ...loadPromptSettings(dataDir),
    defaults: getDefaultPromptSettings(),
    placeholders: ['{{digest}}', '{{material}}'],
  };
}

function getPublicPromptSettings(dataDir) {
  const s = loadPromptSettings(dataDir);
  return {
    ok: true,
    ...s,
    defaults: getDefaultPromptSettings(),
    placeholders: ['{{digest}}', '{{material}}'],
    hint: 'user 模板中请保留 {{digest}}（或 {{material}}），运行时会替换为 understand 结构 JSON。',
  };
}

function promptFingerprint(promptSettings) {
  const s = promptSettings || {};
  return crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        systemPrompt: s.systemPrompt || '',
        userPromptTemplate: s.userPromptTemplate || '',
        temperature: s.temperature,
        maxTokens: s.maxTokens,
      }),
      'utf8',
    )
    .digest('hex')
    .slice(0, 10);
}

/**
 * 渲染 user 模板：{{digest}} / {{material}} → digest JSON
 */
function renderUserPrompt(template, digest) {
  const json = JSON.stringify(digest, null, 2);
  const tpl = String(template || '');
  if (/\{\{\s*digest\s*\}\}/i.test(tpl) || /\{\{\s*material\s*\}\}/i.test(tpl)) {
    return tpl
      .replace(/\{\{\s*digest\s*\}\}/gi, json)
      .replace(/\{\{\s*material\s*\}\}/gi, json);
  }
  // 模板未写占位符时自动附上材料，避免空跑
  return `${tpl}\n\n材料：\n${json}`;
}

function cacheKey(robotUuid, understandFingerprint, model, promptFp) {
  const material = `${robotUuid}|${understandFingerprint}|${model || ''}|${promptFp || ''}`;
  return crypto.createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 24);
}

/** 按应用保留「最近一次解读」，刷新页面可直接回显 */
function robotIndexPath(dataDir, robotUuid) {
  const safe = String(robotUuid || 'unknown')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .slice(0, 80);
  return path.join(cacheDir(dataDir), 'by-app', `${safe}.json`);
}

function readRobotIndex(dataDir, robotUuid) {
  try {
    return JSON.parse(fs.readFileSync(robotIndexPath(dataDir, robotUuid), 'utf8'));
  } catch {
    return null;
  }
}

function writeRobotIndex(dataDir, robotUuid, payload) {
  try {
    const file = robotIndexPath(dataDir, robotUuid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

/**
 * 从 understand 结果压成 LLM 输入（控 token）
 * @param {object} understandResult rpa.understandFlow 成功结果
 * @param {{ appName?: string, robotUuid?: string }} meta
 */
function buildUnderstandDigest(understandResult, meta = {}) {
  const r = understandResult || {};
  const edges = (r.callGraph && r.callGraph.edges) || [];
  const codeMods = (r.callGraph && r.callGraph.codeModules) || [];
  return {
    appName: meta.appName || r.projectName || '',
    robotUuid: meta.robotUuid || '',
    projectName: r.projectName || '',
    summary: r.summary || '',
    businessObjects: (r.businessObjects || []).slice(0, 20),
    inputs: (r.inputs || []).slice(0, 15),
    outputs: (r.outputs || []).slice(0, 15),
    stages: (r.stages || []).slice(0, 12).map((s) => ({
      flow: s.flow || s.name || '',
      stages: (s.stages || []).slice(0, 8),
    })),
    flowRoles: (r.flowRoles || []).slice(0, 25).map((it) => {
      if (typeof it === 'string') return it;
      return {
        flow: it.flow || it.name || it.filename || '',
        role: it.role || it.description || '',
      };
    }),
    rules: (r.rules || []).slice(0, 10),
    callEdges: edges.slice(0, 40).map((e) => ({
      type: e.type,
      from: e.from,
      to: e.to,
      toKind: e.toKind,
    })),
    codeModules: codeMods.slice(0, 15).map((m) => ({
      name: m.name || m.filename,
      pyExists: m.pyExists,
      summary: (m.summary || '').slice(0, 200),
    })),
    callStats: r.callStats || (r.callGraph && r.callGraph.stats) || null,
  };
}

function digestFingerprint(digest) {
  return crypto.createHash('sha1').update(JSON.stringify(digest), 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {object} cfg
 * @param {object} digest
 * @param {object} [promptSettings] loadPromptSettings 结果
 * @returns {Promise<object>}
 */
async function runBusinessBriefLlm(cfg, digest, promptSettings) {
  const ps = promptSettings || loadPromptSettings(cfg.dataDir);
  const system = ps.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  const user = renderUserPrompt(ps.userPromptTemplate || DEFAULT_USER_PROMPT_TEMPLATE, digest);

  const parsed = await chatJson(cfg, {
    system,
    user,
    temperature: ps.temperature != null ? ps.temperature : 0.3,
    maxTokens: ps.maxTokens != null ? ps.maxTokens : 1800,
    jsonMode: true,
  });

  return normalizeBrief(parsed);
}

/**
 * 清洗节点 id：仅保留安全字符，保证 Mermaid 可用
 * @param {string} id
 * @param {number} fallbackIndex
 */
function sanitizeNodeId(id, fallbackIndex) {
  const raw = String(id || '')
    .trim()
    .replace(/[^a-zA-Z0-9_\u4e00-\u9fff]/g, '_')
    .replace(/^(\d)/, 'n$1')
    .slice(0, 24);
  return raw || `n${fallbackIndex + 1}`;
}

/**
 * 从 businessFlow 步骤列表生成确定性主路径图（无分支）
 * @param {string[]} steps
 * @returns {{ nodes: object[], edges: object[], mode: 'chain' }}
 */
function chainGraphFromSteps(steps) {
  const labels = (Array.isArray(steps) ? steps : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 10);
  const nodes = labels.map((label, i) => ({
    id: `s${i + 1}`,
    label: label.slice(0, 40),
    kind: 'main',
  }));
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    edges.push({
      from: nodes[i].id,
      to: nodes[i + 1].id,
      when: '',
      kind: 'main',
    });
  }
  return { nodes, edges, mode: 'chain' };
}

/**
 * 校验并归一化 LLM 返回的 flowGraph；不合法则返回 null（由上层降级为 chain）
 * @param {object|null|undefined} rawGraph
 * @param {string[]} [businessFlow]
 * @returns {{ nodes: object[], edges: object[], mode: string, hasBranch: boolean, warnings: string[] } | null}
 */
function normalizeFlowGraph(rawGraph, businessFlow = []) {
  if (!rawGraph || typeof rawGraph !== 'object') return null;
  const warnings = [];
  const rawNodes = Array.isArray(rawGraph.nodes) ? rawGraph.nodes : [];
  const rawEdges = Array.isArray(rawGraph.edges) ? rawGraph.edges : [];
  if (!rawNodes.length) return null;

  const used = new Set();
  const nodes = [];
  for (let i = 0; i < rawNodes.length && nodes.length < 12; i++) {
    const n = rawNodes[i];
    if (n == null) continue;
    let id;
    let label;
    if (typeof n === 'string') {
      id = sanitizeNodeId(`s${i + 1}`, i);
      label = n.trim();
    } else if (typeof n === 'object') {
      id = sanitizeNodeId(n.id != null ? n.id : `n${i + 1}`, i);
      label = String(n.label || n.name || n.title || '').trim();
    } else {
      continue;
    }
    if (!label) {
      warnings.push(`drop_node_empty_label:${id}`);
      continue;
    }
    // 防 id 冲突
    let finalId = id;
    let k = 2;
    while (used.has(finalId)) {
      finalId = `${id}_${k++}`.slice(0, 28);
    }
    used.add(finalId);
    nodes.push({ id: finalId, label: label.slice(0, 40), kind: 'step' });
  }
  if (nodes.length < 2) {
    // 单节点图无意义，交给 businessFlow chain
    return null;
  }

  const idSet = new Set(nodes.map((n) => n.id));
  // 兼容 LLM 用旧 id：建 label→id 与 原始序号 弱映射
  const labelToId = new Map();
  for (const n of nodes) {
    if (!labelToId.has(n.label)) labelToId.set(n.label, n.id);
  }

  const edgeKey = new Set();
  const edges = [];
  for (const e of rawEdges) {
    if (!e || typeof e !== 'object') continue;
    let from = sanitizeNodeId(e.from != null ? e.from : e.source, 0);
    let to = sanitizeNodeId(e.to != null ? e.to : e.target, 1);
    // 若 sanitize 后对不上，尝试按原文字面在 idSet
    if (!idSet.has(from) && e.from != null && idSet.has(String(e.from))) from = String(e.from);
    if (!idSet.has(to) && e.to != null && idSet.has(String(e.to))) to = String(e.to);
    if (!idSet.has(from) || !idSet.has(to) || from === to) {
      warnings.push(`drop_edge:${from}->${to}`);
      continue;
    }
    const when = e.when != null ? String(e.when).trim().slice(0, 24) : '';
    const key = `${from}|${to}|${when}`;
    if (edgeKey.has(key)) continue;
    edgeKey.add(key);
    edges.push({
      from,
      to,
      when,
      kind: when ? 'branch' : 'main',
    });
    if (edges.length >= 20) break;
  }

  // 有节点但边全废：用节点顺序串主路径
  if (!edges.length) {
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        from: nodes[i].id,
        to: nodes[i + 1].id,
        when: '',
        kind: 'main',
      });
    }
    warnings.push('edges_rebuilt_from_node_order');
  }

  // 若 LLM 图与 businessFlow 完全无关且步数差极大，仍保留图，但记 warning
  const steps = (Array.isArray(businessFlow) ? businessFlow : []).filter(Boolean);
  if (steps.length >= 2 && Math.abs(nodes.length - steps.length) > 4) {
    warnings.push('node_count_diverges_from_businessFlow');
  }

  const hasBranch = edges.some((e) => e.kind === 'branch' || e.when);
  return {
    nodes,
    edges,
    mode: hasBranch ? 'graph' : 'graph-linear',
    hasBranch,
    warnings,
  };
}

/**
 * 解析最终用于展示的业务图：优先合法 flowGraph，否则 businessFlow 主路径链
 * @param {object} brief normalizeBrief 结果
 */
function resolveBusinessFlowGraph(brief) {
  const b = brief || {};
  const steps = Array.isArray(b.businessFlow) ? b.businessFlow : [];
  const validated = normalizeFlowGraph(b.flowGraph, steps);
  if (validated && validated.nodes.length >= 2) {
    return {
      graph: {
        nodes: validated.nodes,
        edges: validated.edges,
      },
      mode: validated.mode,
      hasBranch: validated.hasBranch,
      warnings: validated.warnings || [],
    };
  }
  const chain = chainGraphFromSteps(steps);
  return {
    graph: { nodes: chain.nodes, edges: chain.edges },
    mode: chain.nodes.length ? 'chain' : 'empty',
    hasBranch: false,
    warnings: validated === null && (b.flowGraph != null) ? ['flowGraph_invalid_fallback_chain'] : [],
  };
}

/**
 * Mermaid 节点文案转义
 * @param {string} s
 */
function mermaidLabel(s) {
  return String(s || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/"/g, "'")
    .replace(/[<>]/g, '')
    .slice(0, 40);
}

/**
 * 业务图 → Mermaid flowchart
 * 主路径实线；带 when 的分支边虚线 + 标签（推断层）
 * 始终纵向 TD；紧凑靠节点间距 / 文案长度 / CSS 限高，不改方向
 * @param {{ nodes?: object[], edges?: object[] }} graph
 * @param {{ hasBranch?: boolean }} [opts]
 * @returns {string}
 */
function flowGraphToMermaid(graph, opts = {}) {
  const nodes = (graph && graph.nodes) || [];
  const edges = (graph && graph.edges) || [];
  if (!nodes.length) return '';

  const lines = ['flowchart TD'];
  for (const n of nodes) {
    const id = sanitizeNodeId(n.id, 0);
    // 节点文案压短，避免超宽框
    lines.push(`  ${id}["${mermaidLabel(n.label).slice(0, 22)}"]`);
  }
  for (const e of edges) {
    const from = sanitizeNodeId(e.from, 0);
    const to = sanitizeNodeId(e.to, 1);
    const when = e.when ? mermaidLabel(e.when).slice(0, 12) : '';
    if (when) {
      // 推断分支：虚线，避免与主路径同等视觉权重
      lines.push(`  ${from} -.->|${when}| ${to}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }
  return lines.join('\n');
}

/**
 * 给 brief 挂上可渲染的 flowDiagram（读缓存 / 新生成共用）
 * @param {object} brief
 */
function enrichBriefForClient(brief) {
  if (!brief || typeof brief !== 'object') return brief;
  const resolved = resolveBusinessFlowGraph(brief);
  const mermaid = flowGraphToMermaid(resolved.graph, { hasBranch: resolved.hasBranch });
  const branchEdges = (resolved.graph.edges || []).filter((e) => e.when || e.kind === 'branch');
  return {
    ...brief,
    // 归一化后的图（旧缓存无 flowGraph 时用 chain 回填）
    flowGraph: resolved.graph.nodes.length
      ? { nodes: resolved.graph.nodes, edges: resolved.graph.edges }
      : brief.flowGraph || null,
    flowDiagram: {
      mermaid,
      mode: resolved.mode,
      hasBranch: !!resolved.hasBranch,
      direction: 'TD',
      nodeCount: resolved.graph.nodes.length,
      edgeCount: resolved.graph.edges.length,
      branchEdgeCount: branchEdges.length,
      warnings: resolved.warnings || [],
    },
  };
}

function normalizeBrief(raw) {
  if (!raw || typeof raw !== 'object') {
    return enrichBriefForClient({
      title: '业务解读',
      purpose: String(raw || ''),
      businessFlow: [],
      flowGraph: null,
      systems: [],
      dataObjects: [],
      techHighlights: [],
      risks: [],
      openQuestions: [],
      confidence: null,
    });
  }
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  let confidence = raw.confidence;
  if (confidence != null) {
    const n = Number(confidence);
    confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  } else {
    confidence = null;
  }
  const businessFlow = arr(raw.businessFlow).slice(0, 10);
  // 先挂原始 flowGraph，enrich 时再校验；非法则降级 chain
  const base = {
    title: String(raw.title || '业务解读').slice(0, 80),
    purpose: String(raw.purpose || '').slice(0, 800),
    businessFlow,
    flowGraph: raw.flowGraph && typeof raw.flowGraph === 'object' ? raw.flowGraph : null,
    systems: arr(raw.systems).slice(0, 10),
    dataObjects: arr(raw.dataObjects).slice(0, 10),
    techHighlights: arr(raw.techHighlights).slice(0, 8),
    risks: arr(raw.risks).slice(0, 8),
    openQuestions: arr(raw.openQuestions).slice(0, 8),
    confidence,
  };
  return enrichBriefForClient(base);
}

function readCache(dataDir, key) {
  try {
    const p = path.join(cacheDir(dataDir), `${key}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(dataDir, key, payload) {
  try {
    const dir = cacheDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${key}.json`);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
  } catch {
    // ignore
  }
}

function toPublicResult(hit, { cached = true, fp = null, stale = false } = {}) {
  if (!hit || !hit.brief) return null;
  const brief = enrichBriefForClient(hit.brief);
  return {
    ok: true,
    cached,
    stale: !!stale,
    model: hit.model || null,
    generatedAt: hit.generatedAt || null,
    understandFingerprint: fp || hit.understandFingerprint || null,
    brief,
    flowDiagram: brief.flowDiagram || null,
    disclaimer: '模型推测，非正式业务文档；请以业务方确认为准。',
  };
}

/**
 * 只读缓存（不调 LLM）。精确命中 → 按应用最近一次。
 * @param {object} cfg
 * @param {{ robotUuid: string, appName?: string, understandResult?: object }} opts
 */
function loadCachedBusinessBrief(cfg, opts = {}) {
  const robotUuid = opts.robotUuid || 'unknown';
  const llm = resolveLlmConfig(cfg);
  const promptFp = promptFingerprint(loadPromptSettings(cfg.dataDir));
  let fp = null;
  if (opts.understandResult && opts.understandResult.ok !== false) {
    const digest = buildUnderstandDigest(opts.understandResult, {
      appName: opts.appName,
      robotUuid,
    });
    fp = digestFingerprint(digest);
    const key = cacheKey(robotUuid, fp, llm.model, promptFp);
    const hit = readCache(cfg.dataDir, key);
    const pub = toPublicResult(hit, { cached: true, fp, stale: false });
    if (pub) return pub;
  }

  // 回退：该应用最近一次解读（结构变更时仍可回显，标 stale）
  const latest = readRobotIndex(cfg.dataDir, robotUuid);
  const pubLatest = toPublicResult(latest, {
    cached: true,
    fp: latest && latest.understandFingerprint,
    stale: Boolean(fp && latest && latest.understandFingerprint && latest.understandFingerprint !== fp),
  });
  if (pubLatest) return pubLatest;

  return {
    ok: true,
    cached: false,
    brief: null,
    message: '尚无已保存的业务解读',
  };
}

/**
 * @param {object} cfg
 * @param {{
 *   robotUuid: string,
 *   appName?: string,
 *   understandResult: object,
 *   force?: boolean,
 * }} opts
 */
async function generateBusinessBrief(cfg, opts = {}) {
  if (!isLlmConfigured(cfg)) {
    return {
      ok: false,
      code: 'llm_not_configured',
      message: '未配置 LLM。请在工作台「设置」中配置 API Key，或设置 LLM_API_KEY。',
    };
  }
  if (!opts.understandResult || opts.understandResult.ok === false) {
    return {
      ok: false,
      code: 'understand_required',
      message: '需要先成功完成 understand 结构解析',
    };
  }

  const digest = buildUnderstandDigest(opts.understandResult, {
    appName: opts.appName,
    robotUuid: opts.robotUuid,
  });
  const fp = digestFingerprint(digest);
  const llm = resolveLlmConfig(cfg);
  const robotUuid = opts.robotUuid || 'unknown';
  const promptSettings = loadPromptSettings(cfg.dataDir);
  const promptFp = promptFingerprint(promptSettings);
  const key = cacheKey(robotUuid, fp, llm.model, promptFp);

  if (!opts.force) {
    const hit = readCache(cfg.dataDir, key);
    if (hit && hit.brief) {
      // 同步 by-app 索引，保证刷新可回显
      writeRobotIndex(cfg.dataDir, robotUuid, {
        ...hit,
        cacheKey: key,
        promptFingerprint: promptFp,
      });
      return toPublicResult(hit, { cached: true, fp, stale: false });
    }
  }

  const t0 = Date.now();
  let brief;
  try {
    brief = await runBusinessBriefLlm(cfg, digest, promptSettings);
  } catch (e) {
    return {
      ok: false,
      code: 'llm_error',
      message: e && e.message ? e.message : String(e),
      latencyMs: Date.now() - t0,
    };
  }

  const generatedAt = new Date().toISOString();
  const store = {
    robotUuid,
    appName: opts.appName || '',
    model: llm.model,
    generatedAt,
    understandFingerprint: fp,
    promptFingerprint: promptFp,
    brief,
    cacheKey: key,
  };
  writeCache(cfg.dataDir, key, store);
  writeRobotIndex(cfg.dataDir, robotUuid, store);

  const briefOut = enrichBriefForClient(brief);
  return {
    ok: true,
    cached: false,
    stale: false,
    model: llm.model,
    generatedAt,
    latencyMs: Date.now() - t0,
    understandFingerprint: fp,
    promptFingerprint: promptFp,
    brief: briefOut,
    flowDiagram: briefOut.flowDiagram || null,
    disclaimer: '模型推测，非正式业务文档；请以业务方确认为准。',
  };
}

module.exports = {
  buildUnderstandDigest,
  generateBusinessBrief,
  loadCachedBusinessBrief,
  loadPromptSettings,
  savePromptSettings,
  resetPromptSettings,
  getPublicPromptSettings,
  getDefaultPromptSettings,
  renderUserPrompt,
  normalizeBrief,
  normalizeFlowGraph,
  chainGraphFromSteps,
  resolveBusinessFlowGraph,
  flowGraphToMermaid,
  enrichBriefForClient,
  digestFingerprint,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_PROMPT_TEMPLATE,
  PROMPT_FILE,
};
