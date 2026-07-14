/**
 * 业务流程 / 实现流程 Markdown 导出（不调 LLM / OpenAPI）
 */
const assert = require('assert');
const {
  businessBriefToMarkdown,
  implFlowToMarkdown,
  businessExportFilename,
  implExportFilename,
  safeFilename,
  DISCLAIMER_BIZ,
} = require('./lib/export-flow-doc');

const brief = {
  title: '补全发票信息',
  purpose: '从表格取数并在 ERP 补全方案字段',
  businessFlow: ['读取待办清单', '登录 ERP', '补全发票方案', '回写结果'],
  systems: ['ERP', '钉钉'],
  dataObjects: ['发票方案'],
  risks: ['页面改版导致漏录'],
  openQuestions: ['成功状态字段名？'],
  techHighlights: ['子流程 writeback'],
  confidence: 0.72,
  flowDiagram: {
    mode: 'chain',
    hasBranch: false,
    mermaid: 'flowchart TD\n  n1["读取待办清单"] --> n2["登录 ERP"]',
  },
};

const bizMd = businessBriefToMarkdown({
  brief,
  appName: 'Demo发票',
  robotUuid: 'robot-1',
  model: 'test-model',
  generatedAt: '2026-07-14T08:00:00.000Z',
  disclaimer: DISCLAIMER_BIZ,
});

assert.ok(bizMd.includes('# 业务解读：补全发票信息'));
assert.ok(bizMd.includes('模型推测') || bizMd.includes(DISCLAIMER_BIZ.slice(0, 8)));
assert.ok(bizMd.includes('## 业务步骤'));
assert.ok(bizMd.includes('1. 读取待办清单'));
assert.ok(bizMd.includes('## 业务流程图'));
assert.ok(bizMd.includes('```mermaid'));
assert.ok(bizMd.includes('flowchart TD'));
assert.ok(bizMd.includes('ERP'));
assert.ok(bizMd.includes('待业务确认'));
assert.ok(bizMd.includes('实现要点'));
assert.ok(bizMd.includes('Demo发票'));
assert.ok(bizMd.includes('robot-1'));

const bizName = businessExportFilename({ brief, appName: 'Demo发票' });
assert.ok(bizName.startsWith('业务解读-'));
assert.ok(bizName.endsWith('.md'));
assert.ok(!/[<>:"/\\|?*]/.test(bizName.replace(/\.md$/, '')));

const result = {
  ok: true,
  projectName: 'Demo发票RPA',
  summary: '调用主流程完成补全',
  stages: [{ flow: '主流程', stages: ['登录', '录入'] }],
  flowRoles: [{ flow: '主流程', role: '入口', blockCount: 12 }],
  businessObjects: ['发票'],
  mermaidGraph: {
    mermaid: '```mermaid\nflowchart LR\n  A-->B\n```',
    nodeCount: 2,
    edgeCount: 1,
  },
  callGraph: {
    edges: [
      { type: 'run', from: 'main', to: '登录', toKind: 'flow' },
      { type: 'code', from: '登录', to: 'helper.py' },
    ],
  },
  rules: ['推测：循环处理多行'],
};

const implMd = implFlowToMarkdown({
  result,
  appName: 'Demo发票',
  robotUuid: 'robot-1',
  cached: true,
  xbotDir: 'D:\\\\bots\\\\demo',
});

assert.ok(implMd.includes('# 实现流程：Demo发票RPA'));
assert.ok(implMd.includes('## 调用图'));
assert.ok(implMd.includes('```mermaid'));
assert.ok(implMd.includes('flowchart LR'));
assert.ok(implMd.includes('## 阶段'));
assert.ok(implMd.includes('主流程'));
assert.ok(implMd.includes('## 调用关系'));
assert.ok(implMd.includes('| run |'));
assert.ok(implMd.includes('## 规则 / 推断'));
assert.ok(implMd.includes('缓存'));

const implName = implExportFilename({ result, appName: 'Demo发票' });
assert.ok(implName.startsWith('实现流程-'));
assert.ok(implName.endsWith('.md'));

assert.strictEqual(safeFilename('a/b:c*.md', '.md'), 'a_b_c_.md');
assert.ok(safeFilename('正常名', '.md').endsWith('.md'));

// 分支图标记
const branchMd = businessBriefToMarkdown({
  brief: {
    title: '分支示例',
    purpose: '测分支',
    businessFlow: ['A', 'B'],
    flowDiagram: {
      mode: 'graph',
      hasBranch: true,
      mermaid: 'flowchart TD\n  n1-->n2',
    },
  },
});
assert.ok(branchMd.includes('推断分支') || branchMd.includes('分支'));

console.log('test_export_flow_doc: ok');
