/**
 * IndexError / 列表越界 — 在可疑下标访问前插入空列表守卫
 * 规则优先；复杂情况由 maintain 层可选 LLM 再 plan
 */

const fs = require('fs');

const ID = 'python_index_error';

function match(ctx) {
  const t = `${ctx.text || ''} ${ctx.fileContent || ''}`;
  if (/IndexError|list index out of range|索引越界|下标越界/i.test(ctx.text || '')) return 0.95;
  if (/IndexError/i.test(t) && ctx.fileContent) return 0.6;
  return 0;
}

/**
 * 在首个 `var[0]` / `var[i]` 形式访问前插入 if not var
 * 保守：只处理「单独一行」的简单下标访问
 */
function plan(ctx) {
  const original = ctx.fileContent != null
    ? ctx.fileContent
    : fs.readFileSync(ctx.absolutePath, 'utf8');
  const lines = original.split(/\r?\n/);
  const lineHint = ctx.lineHint || guessLine(lines, ctx.text);
  let targetIdx = lineHint != null && lineHint > 0 ? lineHint - 1 : -1;

  if (targetIdx < 0 || targetIdx >= lines.length) {
    targetIdx = lines.findIndex((l) => /\w+\s*\[\s*\d+\s*\]/.test(l) && !/^\s*#/.test(l));
  }
  if (targetIdx < 0) {
    return {
      ok: false,
      error: 'no_index_access_line',
      title: '未能定位下标访问行',
    };
  }

  const line = lines[targetIdx];
  const indent = (line.match(/^(\s*)/) || ['', ''])[1];
  const m = line.match(/([A-Za-z_]\w*)\s*\[\s*\d+\s*\]/);
  const varName = m ? m[1] : null;
  if (!varName) {
    return { ok: false, error: 'no_var_name', title: '无法解析下标变量名' };
  }

  // 已有守卫则跳过
  const prev = lines[targetIdx - 1] || '';
  if (new RegExp(`if\\s+not\\s+${varName}\\s*:`).test(prev) || new RegExp(`if\\s+len\\s*\\(\\s*${varName}`).test(prev)) {
    return { ok: false, error: 'guard_exists', title: '疑似已有空列表守卫' };
  }

  const guard = [
    `${indent}if not ${varName}:`,
    `${indent}    return None  # auto-fix: empty ${varName} boundary`,
  ];
  const proposedLines = [
    ...lines.slice(0, targetIdx),
    ...guard,
    ...lines.slice(targetIdx),
  ];
  const proposed = proposedLines.join('\n');

  return {
    ok: true,
    fixerId: ID,
    fixClass: 'code_boundary',
    title: `为 ${varName} 增加空列表边界守卫（约第 ${targetIdx + 1} 行）`,
    risk: 'low',
    rationale: `检测到 IndexError/下标访问风险，在 \`${varName}[n]\` 前增加 \`if not ${varName}: return None\`。请确认业务上「空则返回」是否合适。`,
    files: [
      {
        relativePath: ctx.relativePath,
        absolutePath: ctx.absolutePath,
        original,
        proposed,
      },
    ],
  };
}

function guessLine(lines, text) {
  const m = String(text || '').match(/line (\d+)/i);
  if (m) return parseInt(m[1], 10);
  return null;
}

module.exports = {
  id: ID,
  fixClass: 'code_boundary',
  match,
  plan,
};
