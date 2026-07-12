/**
 * 空路径 / 空字符串路径 — 在 open/join 前插入 if not path 守卫
 */

const fs = require('fs');

const ID = 'python_empty_path';

function match(ctx) {
  const t = ctx.text || '';
  // 空路径特征：文件不存在且路径为空引号，或 Errno 2 空路径
  if (/No such file.*['"]\s*['"]|文件不存在:\s*$|Errno 2.*['"]\s*['"]/i.test(t)) return 0.92;
  if (/文件不存在|No such file|FileNotFoundError/i.test(t) && /['"]\s*['"]/.test(t)) return 0.85;
  if (/空路径|path is empty|empty path/i.test(t)) return 0.8;
  return 0;
}

function plan(ctx) {
  const original =
    ctx.fileContent != null ? ctx.fileContent : fs.readFileSync(ctx.absolutePath, 'utf8');
  const lines = original.split(/\r?\n/);
  const lineHint = ctx.lineHint;
  let targetIdx = lineHint != null && lineHint > 0 ? lineHint - 1 : -1;

  // 优先：open(...) / os.path.join / Path(...)
  const pathy = (l) =>
    /\bopen\s*\(|os\.path\.(join|exists|isfile|isdir)\s*\(|Path\s*\(|shutil\.|makedirs\s*\(/.test(
      l,
    ) && !/^\s*#/.test(l);

  if (targetIdx < 0 || targetIdx >= lines.length || !pathy(lines[targetIdx])) {
    targetIdx = lines.findIndex(pathy);
  }
  if (targetIdx < 0) {
    // 退而：含路径变量赋值后的使用
    targetIdx = lines.findIndex(
      (l) => /[A-Za-z_]\w*\s*=\s*['"]\s*['"]/.test(l) === false && /path|file|dir|文件夹|路径/i.test(l) && pathy(l),
    );
  }
  if (targetIdx < 0) {
    return { ok: false, error: 'no_path_line', title: '未能定位路径读写行' };
  }

  const line = lines[targetIdx];
  const indent = (line.match(/^(\s*)/) || ['', ''])[1];

  // 推断主路径变量：open(x) / join(a,b) 取第一个标识符参数
  let varName = null;
  const openM = line.match(/\bopen\s*\(\s*([A-Za-z_]\w*)/);
  const joinM = line.match(/os\.path\.\w+\s*\(\s*([A-Za-z_]\w*)/);
  const pathM = line.match(/Path\s*\(\s*([A-Za-z_]\w*)/);
  const assignUse = line.match(/([A-Za-z_]\w*)\s*\)/);
  varName = (openM && openM[1]) || (joinM && joinM[1]) || (pathM && pathM[1]) || null;
  if (!varName) {
    // 行内第一个看起来像路径的变量
    const ids = line.match(/\b([A-Za-z_][\w]*)\b/g) || [];
    varName =
      ids.find((id) => /path|file|dir|folder|目录|路径|fname|filepath/i.test(id)) || ids[0] || null;
  }
  if (!varName || ['self', 'cls', 'os', 'Path', 'open', 'join'].includes(varName)) {
    return { ok: false, error: 'no_safe_var', title: '无法安全推断路径变量' };
  }

  const prev = lines[targetIdx - 1] || '';
  if (
    new RegExp(`if\\s+not\\s+${varName}\\b`).test(prev) ||
    new RegExp(`if\\s+${varName}\\s*(is\\s+None|==\\s*['"]\\s*['"])`).test(prev)
  ) {
    return { ok: false, error: 'guard_exists', title: '疑似已有空路径守卫' };
  }

  const guard = [
    `${indent}if not ${varName}:`,
    `${indent}    raise ValueError("empty path: ${varName}")  # auto-fix: empty path guard`,
  ];
  const proposed = [...lines.slice(0, targetIdx), ...guard, ...lines.slice(targetIdx)].join('\n');

  return {
    ok: true,
    fixerId: ID,
    fixClass: 'config',
    title: `为空路径变量 ${varName} 增加守卫（约第 ${targetIdx + 1} 行）`,
    risk: 'low',
    rationale: `检测到空路径/文件不存在且路径为空的特征，在使用 \`${varName}\` 前增加空值校验。请确认业务上应 raise 还是跳过。`,
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
  fixClass: 'config',
  match,
  plan,
};
