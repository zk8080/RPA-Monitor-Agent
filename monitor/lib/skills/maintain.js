/**
 * maintain skill：巡检报告 + py 受控修复
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { invokeTool } = require('../tools');
const memory = require('../memory');
const { loadConfig } = require('../config');
const { matchFixers } = require('../fixers');
const patchLib = require('../patch');
const { classifyFix } = require('../triage');
const verify = require('../verify');

function getAutoFixConfig(cfg) {
  const m = cfg.maintain || {};
  const a = m.autoFix || {};
  return {
    enabled: a.enabled === true || process.env.MAINTAIN_AUTO_FIX === '1',
    classes: a.classes || ['code_boundary', 'null_guard', 'config'],
    requirePyCompile: a.requirePyCompile !== false,
    requireValidate: a.requireValidate === true,
    maxFilesPerPatch: a.maxFilesPerPatch || 1,
    maxPatchBytes: a.maxPatchBytes || 200000,
  };
}

/**
 * @param {object} input
 * @param {object} cfg
 */
async function runMaintain(input, cfg) {
  const action = String(input.action || input.subcommand || 'inspect').toLowerCase();
  if (action === 'inspect') return runInspect(input, cfg);
  if (action === 'fix') return runFix(input, cfg);
  if (action === 'rollback') return runRollback(input, cfg);
  if (action === 'report') return runInspect(input, cfg); // alias
  return {
    ok: false,
    code: 'unknown_action',
    message: `未知 maintain 动作: ${action}。可用: inspect | fix | rollback`,
  };
}

async function runInspect(input, cfg) {
  const ctx = { cfg, skill: 'maintain' };
  const toolTrace = [];
  async function step(name, args) {
    const t0 = Date.now();
    try {
      const r = await invokeTool(name, args, ctx);
      toolTrace.push({ tool: name, ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      toolTrace.push({ tool: name, ok: false, ms: Date.now() - t0, error: e.message });
      return { __error: e.message };
    }
  }

  const targets = [];
  if (input.allLocal) {
    const scan = await step('scan_local_apps', {});
    const apps = (scan && scan.apps) || [];
    for (const a of apps.slice(0, input.limit || 20)) {
      targets.push({ robotUuid: a.robotUuid, name: a.name, xbotDir: a.xbotDir });
    }
  } else if (input.robotUuid) {
    const app = await step('resolve_app', { robotUuid: input.robotUuid });
    if (app && app.xbotDir) {
      targets.push({
        robotUuid: input.robotUuid,
        name: app.name,
        xbotDir: app.xbotDir,
      });
    } else {
      return {
        ok: false,
        code: 'resolve_failed',
        message: app?.reason || '无法解析应用目录',
        app,
      };
    }
  } else {
    return {
      ok: false,
      code: 'missing_target',
      message: '请提供 --robot <uuid> 或 --all-local',
    };
  }

  const results = [];
  for (const t of targets) {
    const insp = await step('inspect_project', { xbotDir: t.xbotDir });
    let failures = [];
    if (input.withFailures !== false) {
      const listed = await step('list_app_failures', {
        robotUuid: t.robotUuid,
        limit: 10,
      });
      failures = (listed && listed.items) || [];
    }
    results.push({
      robotUuid: t.robotUuid,
      name: t.name,
      xbotDir: t.xbotDir,
      inspect: insp && !insp.__error ? insp : { ok: false, error: insp?.__error || insp },
      failures,
    });
  }

  const md = renderMaintainMarkdown(results);
  const dateKey = new Date().toISOString().slice(0, 10);
  const reportsDir = path.join(cfg.dataDir, 'reports');
  memory.ensureDir(reportsDir);
  const suffix = targets.length === 1 ? `-${(targets[0].name || targets[0].robotUuid).replace(/[^\w\u4e00-\u9fff-]+/g, '_')}` : '-multi';
  const filePath = path.join(reportsDir, `maintain-${dateKey}${suffix}.md`);
  fs.writeFileSync(filePath, `${md}\n`, 'utf8');

  return {
    ok: true,
    skill: 'maintain',
    action: 'inspect',
    count: results.length,
    filePath,
    results: results.map((r) => ({
      robotUuid: r.robotUuid,
      name: r.name,
      riskCount: (r.inspect.risks || []).length,
      missingPy: r.inspect.missingPy || [],
      failureCount: (r.failures || []).length,
    })),
    toolTrace,
  };
}

function renderMaintainMarkdown(results) {
  const lines = [];
  lines.push(`# 维护巡检报告 ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(`共巡检 **${results.length}** 个应用。`);
  lines.push('');

  for (const r of results) {
    lines.push(`## ${r.name || r.robotUuid}`);
    lines.push('');
    lines.push(`- robotUuid: \`${r.robotUuid}\``);
    lines.push(`- 路径: \`${r.xbotDir}\``);
    const insp = r.inspect || {};
    if (insp.ok) {
      lines.push(`- 流程数: ${insp.flowCount}/${insp.totalFlowCount}`);
      lines.push(`- 风险数: ${(insp.risks || []).length}`);
      if ((insp.missingPy || []).length) {
        lines.push(`- 缺失 py: ${(insp.missingPy || []).join(', ')}`);
      }
      lines.push('');
      lines.push('### 结构风险');
      if (!(insp.risks || []).length) lines.push('- （未发现明显风险）');
      else (insp.risks || []).slice(0, 30).forEach((x) => lines.push(`- ${x}`));
      if ((insp.unreferencedFlows || []).length) {
        lines.push('');
        lines.push('### 未引用流程（节选）');
        insp.unreferencedFlows.slice(0, 15).forEach((f) => {
          lines.push(`- \`${f.name}\` (${f.filename}, ${f.blockCount}块)`);
        });
      }
    } else {
      lines.push(`- 巡检失败: ${insp.error || insp.reason || JSON.stringify(insp)}`);
    }

    if ((r.failures || []).length) {
      lines.push('');
      lines.push('### 线上失败热点（queue）');
      r.failures.forEach((f) => {
        const d = f.lastDiagnosis || {};
        lines.push(
          `- \`${f.fingerprint}\` · ${f.errorType || ''} · ${d.rootCause || '未诊断'} · fix=${d.fixClass || '?'}`,
        );
      });
    }
    lines.push('');
  }

  lines.push('--');
  lines.push('_Generated by maintain skill · RPA Monitor Agent_');
  return lines.join('\n');
}

async function runFix(input, cfg) {
  const auto = getAutoFixConfig(cfg);
  const wantApply = input.apply === true;
  const ctx = { cfg, skill: 'maintain' };
  const toolTrace = [];
  async function step(name, args) {
    const t0 = Date.now();
    try {
      const r = await invokeTool(name, args, ctx);
      toolTrace.push({ tool: name, ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      toolTrace.push({ tool: name, ok: false, error: e.message });
      return { __error: e.message };
    }
  }

  let working = null;
  let diagnosis = input.diagnosis || null;

  if (input.fingerprint) {
    working = await step('queue_get', { fingerprint: input.fingerprint });
    if (!working || working.__error) {
      return { ok: false, code: 'queue_miss', message: 'queue 中无此 fingerprint' };
    }
    if (working.lastDiagnosis) {
      diagnosis = { ...working.lastDiagnosis, ...(diagnosis || {}) };
    }
  }

  if (!working && !input.absolutePath) {
    return {
      ok: false,
      code: 'missing_target',
      message: '请提供 --fingerprint 或测试用 absolutePath',
    };
  }

  const robotUuid = (working && working.robotUuid) || input.robotUuid || '';
  let appInfo = null;
  if (robotUuid) {
    appInfo = await step('resolve_app', { robotUuid });
  }

  // 补全分诊
  const triage = classifyFix(working || { rawRemark: input.remark || '', errorType: input.errorType || '' }, {
    logs: [],
    blocksContext: null,
    appInfo,
  });
  const fixClass = (diagnosis && diagnosis.fixClass) || triage.fixClass;
  const fixability = (diagnosis && diagnosis.fixability) || triage.fixability;
  let fixTargets = (diagnosis && diagnosis.fixTargets) || triage.fixTargets || [];

  if (input.absolutePath) {
    fixTargets = [
      {
        type: 'python',
        relativePath: path.basename(input.absolutePath),
        absolutePath: input.absolutePath,
        lineHint: input.lineHint || null,
        errorSignal: input.remark || input.errorType || 'IndexError',
      },
    ];
  }

  if (fixability === 'manual' && !input.force) {
    return {
      ok: false,
      code: 'not_auto_fixable',
      message: `fixability=manual（fixClass=${fixClass}），本阶段不自动修。可用 --force 仅生成 dry-run 预览。`,
      fixClass,
      fixability,
      fixTargets,
    };
  }

  const pyTarget = fixTargets.find((t) => t.type === 'python' && t.absolutePath);
  if (!pyTarget) {
    return {
      ok: false,
      code: 'no_python_target',
      message: '未解析到可修复的 .py 文件',
      fixClass,
      fixability,
      fixTargets,
    };
  }

  const fileRead = await step('read_project_file', {
    xbotDir: appInfo?.xbotDir || path.dirname(pyTarget.absolutePath),
    relativePath: pyTarget.relativePath || path.basename(pyTarget.absolutePath),
  });
  // 若 relative 失败，直接读绝对路径
  let fileContent;
  let absolutePath = pyTarget.absolutePath;
  let relativePath = pyTarget.relativePath;
  if (fileRead && fileRead.ok) {
    fileContent = fileRead.content;
    absolutePath = fileRead.absolutePath;
    relativePath = fileRead.relativePath;
  } else if (fs.existsSync(absolutePath)) {
    fileContent = fs.readFileSync(absolutePath, 'utf8');
    relativePath = relativePath || path.basename(absolutePath);
  } else {
    return { ok: false, code: 'file_not_found', message: absolutePath, fileRead };
  }

  const text = [working?.rawRemark, working?.errorType, diagnosis?.rootCause, input.remark, input.errorType]
    .filter(Boolean)
    .join('\n');

  const matchCtx = {
    text,
    fileContent,
    relativePath,
    absolutePath,
    working,
    diagnosis,
    lineHint: pyTarget.lineHint,
  };
  const ranked = matchFixers(matchCtx);
  if (!ranked.length) {
    return {
      ok: false,
      code: 'no_fixer',
      message: '无匹配的 fixer',
      fixClass,
      text: text.slice(0, 200),
    };
  }

  const best = ranked[0].fixer;
  const plan = best.plan(matchCtx);
  if (!plan || plan.ok === false) {
    return {
      ok: false,
      code: plan?.error || 'plan_failed',
      message: plan?.title || 'fixer plan 失败',
      fixerId: best.id,
    };
  }

  if (plan.files.length > auto.maxFilesPerPatch) {
    return {
      ok: false,
      code: 'too_many_files',
      message: `patch 含 ${plan.files.length} 文件，超过 maxFilesPerPatch=${auto.maxFilesPerPatch}`,
    };
  }

  const patchMeta = patchLib.createPatch(
    cfg.dataDir,
    {
      fixerId: plan.fixerId || best.id,
      fixClass: plan.fixClass || fixClass,
      fingerprint: working?.fingerprint,
      robotUuid,
      robotName: working?.robotName || appInfo?.name,
      rationale: plan.rationale,
      risk: plan.risk || 'low',
      dryRun: !wantApply,
    },
    plan.files,
  );

  let applyResult = null;
  if (wantApply) {
    if (!auto.enabled && !input.forceApply) {
      return {
        ok: true,
        skill: 'maintain',
        action: 'fix',
        dryRun: true,
        message: 'autoFix.enabled=false：已生成 patch 预览，未写盘。配置 maintain.autoFix.enabled=true 或 --force-apply',
        patch: patchMeta,
        plan: { title: plan.title, rationale: plan.rationale },
        toolTrace,
      };
    }
    if (!auto.classes.includes(plan.fixClass || fixClass) && !input.forceApply) {
      return {
        ok: false,
        code: 'class_not_allowed',
        message: `fixClass=${plan.fixClass || fixClass} 不在 autoFix.classes 中`,
        patch: patchMeta,
      };
    }

    applyResult = patchLib.applyPatch(cfg.dataDir, patchMeta.patchId, {
      maxPatchBytes: auto.maxPatchBytes,
    });
    if (!applyResult.ok) {
      return {
        ok: false,
        code: 'apply_failed',
        message: applyResult.error,
        patch: applyResult.meta || patchMeta,
        toolTrace,
      };
    }

    if (auto.requirePyCompile) {
      for (const f of plan.files) {
        try {
          execFileSync('python', ['-m', 'py_compile', f.absolutePath], {
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30000,
          });
        } catch (e) {
          patchLib.rollbackPatch(cfg.dataDir, patchMeta.patchId);
          return {
            ok: false,
            code: 'py_compile_failed',
            message: e.stderr?.toString() || e.message,
            rolledBack: true,
            patchId: patchMeta.patchId,
          };
        }
      }
    }

    // S18：apply 成功 → fixed_pending_verify
    const vcfg = verify.getVerifyConfig(cfg);
    const pending = verify.markPatchPendingVerify(cfg.dataDir, patchMeta.patchId, {
      fingerprint: working?.fingerprint || patchMeta.fingerprint,
      quietDaysRequired: vcfg.quietDays,
      kbId: working?.kbId || null,
    });
    if (pending.ok && pending.meta) {
      applyResult.meta = pending.meta;
    }
  }

  return {
    ok: true,
    skill: 'maintain',
    action: 'fix',
    dryRun: !wantApply,
    applied: Boolean(wantApply && applyResult?.ok),
    fixClass,
    fixability,
    fixerId: best.id,
    plan: {
      title: plan.title,
      rationale: plan.rationale,
      risk: plan.risk,
    },
    patch: wantApply && applyResult?.meta ? applyResult.meta : patchMeta,
    verify:
      wantApply && applyResult?.ok
        ? {
            status: 'fixed_pending_verify',
            quietDays: verify.getVerifyConfig(cfg).quietDays,
            message: '已进入验证期：后续 poll 若同指纹新 job 出现 → regressed；静默期满 → verified',
          }
        : null,
    diffPath: path.join(cfg.dataDir, 'patches', patchMeta.patchId, 'patch.diff'),
    toolTrace,
  };
}

async function runRollback(input, cfg) {
  if (!input.patchId) {
    return { ok: false, code: 'missing_patch_id', message: '需要 --patch <patchId>' };
  }
  const r = patchLib.rollbackPatch(cfg.dataDir, input.patchId);
  if (r.ok && r.meta && r.meta.fingerprint) {
    const q = memory.loadQueueItem(cfg.dataDir, r.meta.fingerprint);
    if (q) {
      memory.atomicWriteJson(memory.queuePath(cfg.dataDir, r.meta.fingerprint), {
        ...q,
        fixStatus: 'rolled_back',
        lastPatchId: input.patchId,
        rolledBackAt: r.meta.rolledBackAt || new Date().toISOString(),
      });
    }
    try {
      const kb = require('../kb');
      kb.writeKb(cfg.dataDir, {
        fingerprint: r.meta.fingerprint,
        status: 'rolled_back',
        notes: `patch ${input.patchId} rolled back`,
      });
    } catch {
      // ignore
    }
  }
  return {
    ok: r.ok,
    skill: 'maintain',
    action: 'rollback',
    ...r,
  };
}

module.exports = {
  runMaintain,
  getAutoFixConfig,
};
