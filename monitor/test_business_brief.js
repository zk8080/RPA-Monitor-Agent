/**
 * 业务解读：digest 压缩与 normalize（不调真实 LLM）
 */
const assert = require('assert');
const { buildUnderstandDigest, normalizeBrief, digestFingerprint } = require('./lib/business-brief');

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

console.log('✅ test_business_brief passed');
