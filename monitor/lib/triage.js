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
    (/No such file|文件不存在|FileNotFoundError/.test(text) && /['"]\s*['"]/.test(text)) ||
    /空路径|path is empty|empty path/i.test(text)
  ) {
    fixClass = 'config';
    // 有 py 目标时可 auto 走 empty_path fixer；否则 assisted
    fixability = 'auto';
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

  // 没有 py 目标时，code/config 类不能 auto
  if (
    (fixClass === 'code_boundary' || fixClass === 'null_guard' || fixClass === 'config') &&
    !fixTargets.some((t) => t.type === 'python')
  ) {
    if (fixability === 'auto') fixability = 'assisted';
  }

  return { fixClass, fixability, fixTargets };
}

/**
 * 是否适合 Web「预览修复」（dry-run py patch）
 * auto 且有 python 目标；assisted 有 python 时也允许预览（需 force）
 */
function canPreviewFix(triage) {
  if (!triage) return false;
  const hasPy = (triage.fixTargets || []).some(
    (t) => t.type === 'python' && (t.absolutePath || t.relativePath),
  );
  if (!hasPy) return false;
  return triage.fixability === 'auto' || triage.fixability === 'assisted';
}

/**
 * 给人看的修复指引（不能 auto 时尤其重要）
 * @param {{ fixClass?: string, fixability?: string, fixTargets?: any[] }} triage
 * @param {{ errorType?: string, rawRemark?: string, suggestion?: string }} [extra]
 */
function describeFixGuidance(triage = {}, extra = {}) {
  const fixClass = triage.fixClass || 'unknown';
  const fixability = triage.fixability || 'manual';
  const hasPy = (triage.fixTargets || []).some((t) => t.type === 'python');

  const byClass = {
    element: {
      title: '元素定位问题',
      summary: '页面元素找不到或不唯一，属于选择器/等待问题，不是 Python 补丁能自动修的。',
      steps: [
        '在影刀 Studio 打开失败子流程对应行',
        '重新抓取元素或收紧选择器（父级/属性）',
        '为页面加载增加显式等待/存在性判断',
        '用「诊断」查看根因与流程位置，再用 Coding Agent 改流程',
      ],
    },
    env: {
      title: '环境 / 超时问题',
      summary: '超时、断连或机器人占用等，通常需调超时、网络或调度，而非改 py 逻辑。',
      steps: [
        '检查目标系统是否缓慢或不可用',
        '适当增大等待超时，优化等待条件',
        '确认机器人未被占用、客户端正常',
        '若反复出现，在诊断结论中记录环境依赖',
      ],
    },
    config: {
      title: '路径 / 配置问题',
      summary: '文件路径为空或不存在，可能是配置或上游下载失败。',
      steps: [
        '核对配置表/路径拼接是否为空',
        '确认上游下载/导出步骤是否成功',
        '运行前增加路径存在性校验',
      ],
    },
    code_boundary: {
      title: '代码边界问题',
      summary: hasPy
        ? '可能可用 Python 补丁预览（如 IndexError 边界检查）。'
        : '疑似代码问题，但未解析到可写的 .py 文件，暂无法自动生成补丁。',
      steps: hasPy
        ? ['可点「预览修复」生成 dry-run patch', '确认 diff 后再用 CLI --apply', 'apply 后由 poll 验证是否复发']
        : ['先「诊断」并拉取含 Traceback 的日志', '确认 invoke_module / .py 路径', '定位到 py 后再预览修复'],
    },
    null_guard: {
      title: '空值防护问题',
      summary: hasPy ? '可能对 None 访问加守卫并生成预览补丁。' : '疑似空引用，但未定位到 .py 文件。',
      steps: hasPy
        ? ['可点「预览修复」', '检查 diff 后 CLI apply']
        : ['诊断并补充日志中的 File "*.py" 路径', '再尝试预览修复'],
    },
    unknown: {
      title: '需人工判断',
      summary: '当前规则无法自动归类为可修代码问题。',
      steps: [
        '先点「诊断」生成结构化根因与建议',
        '打开流程图定位业务步骤',
        '复制路径后用 Coding Agent 深入排查',
      ],
    },
  };

  const base = byClass[fixClass] || byClass.unknown;
  const canPreview = canPreviewFix(triage);
  let cta = '查看详情与诊断建议';
  if (canPreview) cta = '可尝试「预览修复」（仅 dry-run，不写盘）';
  else if (fixability === 'manual') cta = '请按下方步骤人工处理，不显示自动预览';

  return {
    fixClass,
    fixability,
    canPreviewFix: canPreview,
    title: base.title,
    summary: base.summary,
    steps: base.steps,
    cta,
    suggestion: extra.suggestion || null,
    errorType: extra.errorType || null,
  };
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
  canPreviewFix,
  describeFixGuidance,
};
