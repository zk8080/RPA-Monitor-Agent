/**
 * 业务解读：digest 压缩、normalize、可配置提示词（不调真实 LLM）
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

// 提示词模板
const def = getDefaultPromptSettings();
assert.ok(def.systemPrompt.includes('影刀 RPA'));
assert.ok(def.userPromptTemplate.includes('{{digest}}'));
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
