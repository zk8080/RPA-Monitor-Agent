/**
 * NoneType 属性访问 — 在 `x.attr` 前插入 if x is None
 */

const fs = require('fs');

const ID = 'python_none_guard';

function match(ctx) {
  if (/NoneType|AttributeError.*None|空引用/i.test(ctx.text || '')) return 0.9;
  return 0;
}

function plan(ctx) {
  const original = ctx.fileContent != null
    ? ctx.fileContent
    : fs.readFileSync(ctx.absolutePath, 'utf8');
  const lines = original.split(/\r?\n/);
  const lineHint = ctx.lineHint;
  let targetIdx = lineHint != null && lineHint > 0 ? lineHint - 1 : -1;

  if (targetIdx < 0 || targetIdx >= lines.length) {
    targetIdx = lines.findIndex(
      (l) => /[A-Za-z_]\w*\s*\.\s*[A-Za-z_]\w*/.test(l) && !/^\s*#/.test(l) && !/^\s*import\b/.test(l),
    );
  }
  if (targetIdx < 0) {
    return { ok: false, error: 'no_attr_line', title: '未能定位属性访问行' };
  }

  const line = lines[targetIdx];
  const indent = (line.match(/^(\s*)/) || ['', ''])[1];
  const m = line.match(/([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*/);
  const varName = m ? m[1] : null;
  if (!varName || ['self', 'cls'].includes(varName)) {
    return { ok: false, error: 'no_safe_var', title: '无法安全推断空值变量' };
  }

  const prev = lines[targetIdx - 1] || '';
  if (new RegExp(`if\\s+${varName}\\s+is\\s+None`).test(prev) || new RegExp(`if\\s+not\\s+${varName}\\s*:`).test(prev)) {
    return { ok: false, error: 'guard_exists', title: '疑似已有 None 守卫' };
  }

  const guard = [
    `${indent}if ${varName} is None:`,
    `${indent}    return None  # auto-fix: None guard for ${varName}`,
  ];
  const proposed = [...lines.slice(0, targetIdx), ...guard, ...lines.slice(targetIdx)].join('\n');

  return {
    ok: true,
    fixerId: ID,
    fixClass: 'null_guard',
    title: `为 ${varName} 增加 None 守卫（约第 ${targetIdx + 1} 行）`,
    risk: 'low',
    rationale: `检测到 NoneType 相关错误，在 \`${varName}.\` 访问前增加空值返回。请确认业务语义。`,
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

module.exports = {
  id: ID,
  fixClass: 'null_guard',
  match,
  plan,
};
