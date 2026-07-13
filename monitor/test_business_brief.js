/**
 * 业务解读：digest 压缩、normalize、可配置提示词、业务图（不调真实 LLM）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  buildUnderstandDigest,
  normalizeBrief,
  digestFingerprint,
  renderUserPrompt,
  loadPromptSettings,
  savePromptSettings,
  resetPromptSettings,
  getDefaultPromptSettings,
  chainGraphFromSteps,
  normalizeFlowGraph,
  resolveBusinessFlowGraph,
  flowGraphToMermaid,
  enrichBriefForClient,
} = require('./lib/business-brief');

const digest = buildUnderstandDigest(
  {
    ok: true,
    projectName: 'Demo发票',
    summary: '围绕发票自动化',
    businessObjects: ['发票'],
    inputs: ['Excel'],
    outputs: ['网页业务系统'],
    stages: [{ flow: '主流程', stages: ['登录或建立系统会话', '操作业务系统页面'] }],
    flowRoles: [{ flow: '主流程', role: '总调度入口' }],
    rules: ['推测：循环处理'],
    callGraph: {
      edges: [{ type: 'run', from: 'main', to: '登录', toKind: 'flow' }],
      codeModules: [{ name: 'helper', pyExists: true, summary: 'def parse()' }],
      stats: { edgeCount: 1 },
    },
  },
  { appName: 'Demo', robotUuid: 'r1' },
);

assert.strictEqual(digest.appName, 'Demo');
assert.strictEqual(digest.projectName, 'Demo发票');
assert.ok(digest.stages.length === 1);
assert.ok(digest.callEdges.length === 1);
assert.ok(digestFingerprint(digest).length >= 8);

const brief = normalizeBrief({
  title: '补全发票信息',
  purpose: '从表格取数并在 ERP 补全',
  businessFlow: ['登录', '筛选未结'],
  systems: ['ERP'],
  dataObjects: ['发票方案'],
  risks: ['页面改版'],
  openQuestions: ['状态字段含义？'],
  confidence: 0.7,
});
assert.strictEqual(brief.title, '补全发票信息');
assert.strictEqual(brief.businessFlow.length, 2);
assert.strictEqual(brief.confidence, 0.7);
// 无 flowGraph 时降级为主路径链
assert.ok(brief.flowDiagram);
assert.strictEqual(brief.flowDiagram.mode, 'chain');
assert.ok(brief.flowDiagram.mermaid.includes('flowchart TD'));
assert.ok(brief.flowDiagram.mermaid.includes('登录'));
assert.strictEqual(brief.flowDiagram.hasBranch, false);

// 合法 flowGraph：主路径 + 失败分支
const withBranch = normalizeBrief({
  title: '录入',
  purpose: '录报告',
  businessFlow: ['取数', '录入', '回写成功', '记失败'],
  flowGraph: {
    nodes: [
      { id: 'n1', label: '取数' },
      { id: 'n2', label: '录入' },
      { id: 'n3', label: '回写成功' },
      { id: 'n4', label: '记失败' },
    ],
    edges: [
      { from: 'n1', to: 'n2' },
      { from: 'n2', to: 'n3', when: '成功' },
      { from: 'n2', to: 'n4', when: '失败' },
    ],
  },
});
assert.strictEqual(withBranch.flowDiagram.hasBranch, true);
assert.ok(withBranch.flowDiagram.mermaid.includes('-.->'));
assert.ok(withBranch.flowDiagram.branchEdgeCount >= 2);

// 非法边（指向不存在节点）→ 降级或重建，不得抛错
const badGraph = normalizeFlowGraph(
  {
    nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    edges: [{ from: 'a', to: 'ghost' }, { from: 'a', to: 'b' }],
  },
  ['A', 'B'],
);
assert.ok(badGraph);
assert.ok(badGraph.edges.some((e) => e.from === 'a' && e.to === 'b'));

const chain = chainGraphFromSteps(['一步', '二步', '三步']);
assert.strictEqual(chain.nodes.length, 3);
assert.strictEqual(chain.edges.length, 2);
assert.strictEqual(chain.mode, 'chain');
const mmd = flowGraphToMermaid(chain);
assert.ok(mmd.includes('s1'));
assert.ok(mmd.includes('-->'));

// 旧 brief 无 flowDiagram 时 enrich 可补
const enriched = enrichBriefForClient({
  title: 'x',
  businessFlow: ['甲', '乙'],
});
assert.ok(enriched.flowDiagram.mermaid.includes('甲'));

const resolved = resolveBusinessFlowGraph({
  businessFlow: ['x', 'y'],
  flowGraph: { nodes: [], edges: [] },
});
assert.strictEqual(resolved.mode, 'chain');

// 提示词模板：业务流而非实现链路 + flowGraph
const def = getDefaultPromptSettings();
assert.ok(def.systemPrompt.includes('影刀 RPA'));
assert.ok(def.systemPrompt.includes('业务流程'));
assert.ok(def.systemPrompt.includes('禁止'));
assert.ok(def.systemPrompt.includes('flowGraph'));
assert.ok(def.userPromptTemplate.includes('{{digest}}'));
assert.ok(def.userPromptTemplate.includes('flowGraph'));
assert.ok(def.userPromptTemplate.includes('好例子'));
assert.ok(def.userPromptTemplate.includes('坏例子'));
const rendered = renderUserPrompt('前言\n{{digest}}\n后记', { a: 1 });
assert.ok(rendered.includes('"a": 1'));
assert.ok(rendered.includes('前言'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-brief-prompt-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir);
const saved = savePromptSettings(dataDir, {
  systemPrompt: '自定义 system',
  userPromptTemplate: '材料：{{material}}',
  temperature: 0.5,
  maxTokens: 1000,
});
assert.strictEqual(saved.ok, true);
const loaded = loadPromptSettings(dataDir);
assert.strictEqual(loaded.systemPrompt, '自定义 system');
assert.strictEqual(loaded.customized, true);
assert.strictEqual(loaded.temperature, 0.5);
const reset = resetPromptSettings(dataDir);
assert.strictEqual(reset.ok, true);
assert.strictEqual(loadPromptSettings(dataDir).customized, false);

console.log('✅ test_business_brief passed');
