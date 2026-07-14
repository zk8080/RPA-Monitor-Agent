/**
 * 业务流程 / 实现流程 → Markdown 导出（纯函数，无 IO）
 * 供 workbench API 与测试使用；前端通过 API 下载。
 */

const DISCLAIMER_BIZ =
  '业务解读为模型推测，非正式业务定稿；请以业务方确认为准。';

/**
 * @param {string} name
 * @param {string} [ext] 含点，如 .md
 */
function safeFilename(name, ext = '.md') {
  const base = String(name || 'export')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'export';
  const e = ext.startsWith('.') ? ext : `.${ext}`;
  return base.endsWith(e) ? base : `${base}${e}`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地日历日 YYYY-MM-DD */
function localDateStamp(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatLocalTime(iso) {
  if (!iso) return '';
  const raw = String(iso).trim();
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    return raw.replace('T', ' ').replace(/\.\d{3}Z?$/, '').replace(/Z$/, '').slice(0, 19);
  }
  const d = new Date(t);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

function asList(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((x) => {
      if (x == null) return '';
      if (typeof x === 'string') return x.trim();
      if (typeof x === 'object') {
        return String(x.name || x.rule || x.text || x.label || '').trim() || JSON.stringify(x);
      }
      return String(x).trim();
    })
    .filter(Boolean);
}

function bulletBlock(items) {
  const list = asList(items);
  if (!list.length) return '_（无）_\n';
  return `${list.map((x) => `- ${x}`).join('\n')}\n`;
}

function numberedBlock(items) {
  const list = asList(items);
  if (!list.length) return '_（无）_\n';
  return `${list.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n`;
}

function mermaidFence(src) {
  const body = String(src || '').trim();
  if (!body) return '';
  // 去掉已有围栏
  const m = body.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  const inner = (m ? m[1] : body).trim();
  if (!inner) return '';
  return `\`\`\`mermaid\n${inner}\n\`\`\`\n`;
}

function extractMermaidFromGraph(mg) {
  if (!mg) return '';
  if (mg.body && String(mg.body).trim()) return String(mg.body).trim();
  let src = String(mg.mermaid || '').trim();
  if (!src) return '';
  const m = src.match(/```(?:mermaid)?\s*([\s\S]*?)```/i);
  return m ? m[1].trim() : src;
}

function formatFlowRoleLine(x) {
  if (typeof x === 'string') return x;
  if (!x || typeof x !== 'object') return String(x || '');
  const name = x.flow || x.name || x.filename || '流程';
  const role = x.role || x.kind || '';
  const blocks = x.blockCount != null ? `${x.blockCount} 块` : '';
  return [name, role, blocks].filter(Boolean).join(' · ');
}

function formatStageBlock(stages) {
  if (!Array.isArray(stages) || !stages.length) return '_（无）_\n';
  const lines = [];
  for (const s of stages) {
    if (typeof s === 'string') {
      lines.push(`- ${s}`);
      continue;
    }
    if (s && Array.isArray(s.stages)) {
      const flow = s.flow || s.name || '流程';
      const items = s.stages
        .map((x) => (typeof x === 'string' ? x : (x && (x.name || x.title)) || JSON.stringify(x)))
        .filter(Boolean);
      lines.push(`- **${flow}**：${items.join(' → ')}`);
      continue;
    }
    if (s && typeof s === 'object') {
      const title = s.name || s.title || s.flow || '阶段';
      const desc = s.description || s.summary || '';
      lines.push(desc ? `- **${title}**：${desc}` : `- ${title}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '_（无）_\n';
}

/**
 * 业务流程（LLM brief）→ Markdown
 * @param {object} opts
 * @param {object} opts.brief
 * @param {string} [opts.appName]
 * @param {string} [opts.robotUuid]
 * @param {string} [opts.model]
 * @param {string} [opts.generatedAt]
 * @param {boolean} [opts.stale]
 * @param {string} [opts.disclaimer]
 * @param {object} [opts.flowDiagram]  { mermaid, mode, hasBranch }
 */
function businessBriefToMarkdown(opts = {}) {
  const brief = opts.brief || {};
  const title = brief.title || opts.appName || '业务解读';
  const disclaimer = opts.disclaimer || DISCLAIMER_BIZ;
  const fd = brief.flowDiagram || opts.flowDiagram || null;
  const mermaid = fd && fd.mermaid ? String(fd.mermaid).trim() : '';
  const conf =
    brief.confidence != null && Number.isFinite(Number(brief.confidence))
      ? `${Math.round(Number(brief.confidence) * 100)}%`
      : '';

  const meta = [];
  if (opts.appName) meta.push(`- 应用：${opts.appName}`);
  if (opts.robotUuid) meta.push(`- robotUuid：\`${opts.robotUuid}\``);
  if (opts.model) meta.push(`- 模型：${opts.model}`);
  if (opts.generatedAt) meta.push(`- 生成时间：${formatLocalTime(opts.generatedAt)}`);
  if (conf) meta.push(`- 置信度：${conf}`);
  if (opts.stale) meta.push('- 状态：结构已更新，解读可能过期');
  if (fd && fd.hasBranch) meta.push('- 业务图：主路径 + 推断分支（分支为推测）');
  else if (fd && fd.mode === 'chain') meta.push('- 业务图：主路径');

  const parts = [
    `# 业务解读：${title}`,
    '',
    `> ⚠️ ${disclaimer}`,
    '',
  ];
  if (meta.length) {
    parts.push('## 元信息', '', ...meta, '');
  }
  if (brief.purpose) {
    parts.push('## 业务目的', '', String(brief.purpose).trim(), '');
  }
  if (mermaid) {
    parts.push('## 业务流程图', '', mermaidFence(mermaid));
  }
  const steps = asList(brief.businessFlow);
  if (steps.length) {
    parts.push('## 业务步骤', '', numberedBlock(steps));
  }
  const systems = asList(brief.systems);
  if (systems.length) {
    parts.push('## 涉及系统', '', bulletBlock(systems));
  }
  const objects = asList(brief.dataObjects);
  if (objects.length) {
    parts.push('## 业务对象', '', bulletBlock(objects));
  }
  const risks = asList(brief.risks);
  if (risks.length) {
    parts.push('## 风险', '', bulletBlock(risks));
  }
  const questions = asList(brief.openQuestions);
  if (questions.length) {
    parts.push('## 待业务确认', '', bulletBlock(questions));
  }
  const tech = asList(brief.techHighlights);
  if (tech.length) {
    parts.push('## 实现要点', '', bulletBlock(tech));
  }
  parts.push('---', '', `*导出自 RPA Monitor Workbench · ${localDateStamp()}*`, '');
  return parts.join('\n');
}

/**
 * 实现流程（understand result）→ Markdown
 * @param {object} opts
 * @param {object} opts.result  understand 结果（r.ok 已为 true 的内容）
 * @param {string} [opts.appName]
 * @param {string} [opts.robotUuid]
 * @param {boolean} [opts.cached]
 * @param {string} [opts.xbotDir]
 */
function implFlowToMarkdown(opts = {}) {
  const r = opts.result || {};
  const projectName = r.projectName || opts.appName || '实现流程';
  const mermaid = extractMermaidFromGraph(r.mermaidGraph);
  const edges = (r.callGraph && Array.isArray(r.callGraph.edges) && r.callGraph.edges) || [];

  const meta = [];
  if (opts.appName) meta.push(`- 应用：${opts.appName}`);
  if (projectName && projectName !== opts.appName) meta.push(`- 项目名：${projectName}`);
  if (opts.robotUuid) meta.push(`- robotUuid：\`${opts.robotUuid}\``);
  if (opts.xbotDir) meta.push(`- 路径：\`${opts.xbotDir}\``);
  meta.push(`- 来源：rpa-skill understand${opts.cached ? '（缓存）' : ''}`);
  if (r.mermaidGraph) {
    const mg = r.mermaidGraph;
    const bits = [];
    if (mg.nodeCount != null) bits.push(`${mg.nodeCount} 节点`);
    if (mg.edgeCount != null) bits.push(`${mg.edgeCount} 边`);
    if (mg.truncated) bits.push(`已截断${mg.omitted != null ? ` ${mg.omitted}` : ''}`);
    if (bits.length) meta.push(`- 调用图：${bits.join(' · ')}`);
  }

  const parts = [`# 实现流程：${projectName}`, ''];
  if (meta.length) {
    parts.push('## 元信息', '', ...meta, '');
  }
  if (r.summary) {
    parts.push('## 摘要', '', String(r.summary).trim(), '');
  }
  if (mermaid) {
    parts.push('## 调用图', '', mermaidFence(mermaid));
  }
  if (Array.isArray(r.stages) && r.stages.length) {
    parts.push('## 阶段', '', formatStageBlock(r.stages));
  }
  const roles = Array.isArray(r.flowRoles) ? r.flowRoles : [];
  if (roles.length) {
    parts.push(
      '## 流程',
      '',
      ...roles.map((it) => `- ${formatFlowRoleLine(it)}`),
      '',
    );
  }
  const bizObjs = asList(r.businessObjects);
  if (bizObjs.length) {
    parts.push('## 业务对象', '', bulletBlock(bizObjs));
  }
  if (edges.length) {
    const limit = 80;
    const rows = edges.slice(0, limit).map((e) => {
      const type = String((e && e.type) || '').replace(/\|/g, '\\|');
      const from = String((e && e.from) || '').replace(/\|/g, '\\|');
      let to = String((e && e.to) || '').replace(/\|/g, '\\|');
      if (e && e.toKind) to += ` (${e.toKind})`;
      return `| ${type} | ${from} | ${to} |`;
    });
    parts.push(
      '## 调用关系',
      '',
      '| 类型 | 从 | 到 |',
      '| --- | --- | --- |',
      ...rows,
      '',
    );
    if (edges.length > limit) {
      parts.push(`_…其余 ${edges.length - limit} 条已省略_`, '');
    }
  }
  const rules = asList(r.rules);
  if (rules.length) {
    parts.push('## 规则 / 推断', '', bulletBlock(rules));
  }
  parts.push('---', '', `*导出自 RPA Monitor Workbench · ${localDateStamp()}*`, '');
  return parts.join('\n');
}

/**
 * @param {object} opts  businessBriefToMarkdown 参数 + appName
 */
function businessExportFilename(opts = {}) {
  const title = (opts.brief && opts.brief.title) || opts.appName || '业务解读';
  return safeFilename(`业务解读-${title}-${localDateStamp()}`, '.md');
}

/**
 * @param {object} opts  implFlowToMarkdown 参数
 */
function implExportFilename(opts = {}) {
  const r = opts.result || {};
  const name = r.projectName || opts.appName || '实现流程';
  return safeFilename(`实现流程-${name}-${localDateStamp()}`, '.md');
}

module.exports = {
  DISCLAIMER_BIZ,
  safeFilename,
  localDateStamp,
  formatLocalTime,
  businessBriefToMarkdown,
  implFlowToMarkdown,
  businessExportFilename,
  implExportFilename,
  extractMermaidFromGraph,
  formatFlowRoleLine,
  formatStageBlock,
};
