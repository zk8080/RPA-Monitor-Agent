/**
 * 诊断分诊：fixClass / fixability / fixTargets
 * 供 diagnose 输出与 maintain fix 匹配。
 */

const path = require('path');
const fs = require('fs');

/**
 * @param {object} working
 * @param {{ logs?: any[], blocksContext?: any, appInfo?: any }} ctx
 */
function classifyFix(working, ctx = {}) {
  const text = [
    working.errorType,
    working.rawRemark,
    working.elementName,
    ...(ctx.logs || []).map((l) => l && l.text).filter(Boolean),
  ]
    .join('\n')
    .slice(0, 4000);

  let fixClass = 'unknown';
  let fixability = 'manual';

  if (/IndexError|list index out of range|索引越界|下标越界/i.test(text)) {
    fixClass = 'code_boundary';
    fixability = 'auto';
  } else if (/NoneType|AttributeError.*None|空引用/i.test(text)) {
    fixClass = 'null_guard';
    fixability = 'auto';
  } else if (
    /No such file.*['"]\s*['"]|文件不存在:\s*$|Errno 2.*['"]\s*['"]/i.test(text) ||
    (/No such file|文件不存在/.test(text) && /['"]\s*['"]/.test(text))
  ) {
    fixClass = 'config';
    fixability = 'assisted';
  } else if (/匹配到多个元素|未找到元素|找不到元素|元素未找到|元素定位/.test(text)) {
    fixClass = 'element';
    fixability = 'manual';
  } else if (/超时|timeout|断连|未连接|机器人.*占用/i.test(text)) {
    fixClass = 'env';
    fixability = 'manual';
  } else if (/SyntaxError|IndentationError|TabError/i.test(text)) {
    fixClass = 'code_boundary';
    fixability = 'assisted';
  } else if (/\.py\b|Traceback|File ".*\.py"/i.test(text)) {
    fixClass = 'code_boundary';
    fixability = 'assisted';
  }

  const fixTargets = resolveFixTargets(working, ctx, text, fixClass);

  // 没有 py 目标时，code 类不能 auto
  if (
    (fixClass === 'code_boundary' || fixClass === 'null_guard') &&
    !fixTargets.some((t) => t.type === 'python')
  ) {
    if (fixability === 'auto') fixability = 'assisted';
  }

  return { fixClass, fixability, fixTargets };
}

function resolveFixTargets(working, ctx, text, fixClass) {
  const targets = [];
  const xbotDir = ctx.appInfo && ctx.appInfo.xbotDir;

  // 1) traceback: File "path", line N
  const tbRe = /File "([^"]+\.py)"(?:, line (\d+))?/gi;
  let m;
  while ((m = tbRe.exec(text)) !== null) {
    const absOrRel = m[1];
    const lineHint = m[2] ? parseInt(m[2], 10) : null;
    const absolutePath = resolvePyPath(xbotDir, absOrRel);
    if (absolutePath) {
      targets.push({
        type: 'python',
        relativePath: xbotDir ? path.relative(xbotDir, absolutePath).replace(/\\/g, '/') : path.basename(absolutePath),
        absolutePath,
        symbol: null,
        lineHint,
        errorSignal: (working.errorType || working.rawRemark || '').slice(0, 200),
      });
    }
  }

  // 2) invoke_module / code 块
  const blocks = (ctx.blocksContext && ctx.blocksContext.blocks) || [];
  const focus = blocks.find((b) => b.isFocus) || null;
  const candidates = focus ? [focus, ...blocks] : blocks;
  for (const b of candidates) {
    if (!b || !b.name) continue;
    if (b.name === 'process.invoke_module' || b.name.includes('invoke_module')) {
      const mod =
        (b.inputsSummary && (b.inputsSummary.module || b.inputsSummary.Module)) ||
        extractModuleFromSummary(b.inputsSummary);
      if (mod && xbotDir) {
        const absolutePath = resolvePyPath(xbotDir, mod.endsWith('.py') ? mod : `${mod}.py`);
        if (absolutePath && !targets.some((t) => t.absolutePath === absolutePath)) {
          targets.push({
            type: 'python',
            relativePath: path.relative(xbotDir, absolutePath).replace(/\\/g, '/'),
            absolutePath,
            symbol: null,
            lineHint: working.lineNumber ? parseInt(String(working.lineNumber), 10) : null,
            errorSignal: (working.errorType || '').slice(0, 200),
          });
        }
      }
    }
    // code 流程：filename.py
    if (b.name && /code|python/i.test(b.name) && xbotDir) {
      // skip generic
    }
  }

  // 3) 日志里裸 xxx.py
  const bare = text.match(/\b([\w.-]+\.py)\b/g) || [];
  for (const name of bare) {
    if (!xbotDir) break;
    const absolutePath = resolvePyPath(xbotDir, name);
    if (absolutePath && !targets.some((t) => t.absolutePath === absolutePath)) {
      targets.push({
        type: 'python',
        relativePath: path.relative(xbotDir, absolutePath).replace(/\\/g, '/'),
        absolutePath,
        symbol: null,
        lineHint: null,
        errorSignal: (working.errorType || '').slice(0, 200),
      });
    }
  }

  // element 类：目标记为 block
  if (fixClass === 'element' && focus) {
    targets.push({
      type: 'flow_block',
      flowName: working.flowName || '',
      lineNumber: working.lineNumber || '',
      blockName: focus.name,
      elementName: working.elementName || '',
      errorSignal: (working.errorType || '').slice(0, 200),
    });
  }

  return targets;
}

function extractModuleFromSummary(inputsSummary) {
  if (!inputsSummary || typeof inputsSummary !== 'object') return null;
  for (const [k, v] of Object.entries(inputsSummary)) {
    if (/module/i.test(k) && v) {
      return String(v).replace(/^10:/, '').replace(/\.py$/i, '');
    }
  }
  return null;
}

function resolvePyPath(xbotDir, fileHint) {
  if (!fileHint) return null;
  let p = String(fileHint).replace(/^file:\/\//, '');
  if (path.isAbsolute(p) && fs.existsSync(p)) return p;
  if (xbotDir) {
    const joined = path.join(xbotDir, p);
    if (fs.existsSync(joined)) return joined;
    const base = path.join(xbotDir, path.basename(p));
    if (fs.existsSync(base)) return base;
    if (!p.endsWith('.py')) {
      const withPy = path.join(xbotDir, `${p}.py`);
      if (fs.existsSync(withPy)) return withPy;
    }
  }
  return null;
}

module.exports = {
  classifyFix,
  resolveFixTargets,
  resolvePyPath,
};
