/**
 * M1-min diagnose playbook：固定 tool 序 + 规则/可选 LLM → 结构化诊断 → KB
 * 经 agent-runner 调用；禁止平行 diagnose.js。
 */

const { invokeTool } = require('../tools');
const memory = require('../memory');
const kb = require('../kb');
const llm = require('../llm');
const { classifyFix } = require('../triage');
const maintainSkill = require('./maintain');

/**
 * S17：诊后是否自动 dry-run 生成 patch 预览（绝不 apply）
 * @param {object} cfg
 */
function isAutoPlanOnDiagnose(cfg) {
  const m = (cfg && cfg.maintain) || {};
  if (m.autoPlanOnDiagnose === true) return true;
  if (process.env.MAINTAIN_AUTO_PLAN === '1') return true;
  return false;
}

/**
 * S10a：是否启用 KB-first（默认关）
 */
function isKbFirstEnabled(cfg, input = {}) {
  if (input.kbFirst === false || input.noKbFirst === true) return false;
  if (input.kbFirst === true) return true;
  const d = (cfg && cfg.diagnose) || {};
  if (d.kbFirst === true) return true;
  if (process.env.DIAGNOSE_KB_FIRST === '1') return true;
  return false;
}

function kbFirstMinConfidence(cfg) {
  const d = (cfg && cfg.diagnose) || {};
  const n = parseFloat(String(d.kbFirstMinConfidence != null ? d.kbFirstMinConfidence : 0.8));
  return Number.isFinite(n) ? n : 0.8;
}

/**
 * 仅 confirmed + 同 fingerprint + 高置信 可短路完整 diagnose
 * @returns {{ diagnosis: object, kbEntry: object } | null}
 */
function tryKbFirst(history, working, cfg, input = {}) {
  if (!isKbFirstEnabled(cfg, input)) return null;
  if (!working || !working.fingerprint) return null;
  const minConf = kbFirstMinConfidence(cfg);
  const hit = (history || []).find(
    (h) =>
      h.status === 'confirmed' &&
      h.fingerprint === working.fingerprint &&
      (h.confidence == null || Number(h.confidence) >= minConf) &&
      h.rootCause,
  );
  if (!hit) return null;

  // 分诊仍用当前失败文本（便于 maintain 预览）
  const triage = classifyFix(working, { logs: [], appInfo: null });
  const diagnosis = {
    rootCause: hit.rootCause,
    location: hit.location || [working.robotName, working.flowName].filter(Boolean).join(' · '),
    suggestion: hit.solution || hit.suggestion || '',
    confidence: Number(hit.confidence != null ? hit.confidence : minConf),
    errorCategory: hit.errorCategory || 'other',
    relatedFingerprintHints: [],
    kbAction: 'reuse',
    reusedKbId: hit.id,
    affectedBlocks: hit.affectedBlocks || [],
    notes: `KB-first：复用已确认 ${hit.id}（confidence≥${minConf}），跳过完整 diagnose`,
    source: 'kb-first',
    fixClass: triage.fixClass,
    fixability: triage.fixability,
    fixTargets: triage.fixTargets,
  };
  return { diagnosis, kbEntry: hit };
}

/**
 * fixability=auto 且含 python 目标时，调用 maintain fix（默认 dry-run）存 patch
 * @returns {Promise<object|null>}
 */
async function maybeAutoPlanPatch(working, diagnosis, cfg, options = {}) {
  if (options.dryRun) return null;
  if (!isAutoPlanOnDiagnose(cfg)) return null;
  if (!diagnosis || diagnosis.fixability !== 'auto') {
    return {
      ok: false,
      skipped: true,
      reason: 'fixability_not_auto',
      fixability: diagnosis && diagnosis.fixability,
    };
  }
  const targets = diagnosis.fixTargets || [];
  if (!targets.some((t) => t.type === 'python')) {
    return { ok: false, skipped: true, reason: 'no_python_target' };
  }
  if (!working || !working.fingerprint) {
    return { ok: false, skipped: true, reason: 'missing_fingerprint' };
  }

  try {
    // 显式 dry-run：不传 apply / forceApply
    const r = await maintainSkill.runMaintain(
      {
        action: 'fix',
        fingerprint: working.fingerprint,
        diagnosis,
      },
      cfg,
    );
    const patchId = (r.patch && (r.patch.patchId || r.patch.id)) || null;
    if (r.ok && patchId) {
      return {
        ok: true,
        dryRun: true,
        applied: false,
        patchId,
        fixerId: r.fixerId || null,
        fixClass: r.fixClass || diagnosis.fixClass,
        message: `已生成补丁预览 ${patchId}（未写 xbot）`,
        patch: r.patch
          ? {
              patchId,
              dryRun: r.dryRun !== false,
              fixerId: r.fixerId,
              fixClass: r.fixClass,
            }
          : null,
      };
    }
    return {
      ok: false,
      dryRun: true,
      applied: false,
      code: r.code || 'auto_plan_failed',
      message: r.message || '诊后 dry-run patch 未生成',
      patch: r.patch || null,
    };
  } catch (e) {
    return {
      ok: false,
      dryRun: true,
      applied: false,
      code: 'auto_plan_error',
      message: e.message || String(e),
    };
  }
}

/**
 * @param {object} input
 * @param {object} cfg
 * @param {{ dryRun?: boolean }} [options]
 */
async function runDiagnosePlaybook(input, cfg, options = {}) {
  const ctx = { cfg, skill: 'diagnose' };
  const toolTrace = [];

  async function step(name, args) {
    const started = Date.now();
    try {
      const result = await invokeTool(name, args, ctx);
      toolTrace.push({ tool: name, ok: true, ms: Date.now() - started });
      return result;
    } catch (e) {
      toolTrace.push({ tool: name, ok: false, ms: Date.now() - started, error: e.message });
      return { __error: e.message };
    }
  }

  // 1) 解析诊断目标（queue / fingerprint / jobUuid）
  let queueItem = null;
  if (input.fingerprint) {
    queueItem = await step('queue_get', { fingerprint: input.fingerprint });
    if (queueItem && queueItem.__error) queueItem = null;
  }
  if (!queueItem && (input.queue || input.fromQueue)) {
    const listed = await step('queue_get', { undiagnosedOnly: !input.includeDiagnosed });
    const items = (listed && listed.items) || [];
    queueItem = items[0] || null;
  }

  // 从 job 构建临时条目
  let jobUuid = input.jobUuid || (queueItem && queueItem.sampleJobUuids && queueItem.sampleJobUuids[0]) || null;
  let working = queueItem
    ? { ...queueItem }
    : {
        fingerprint: null,
        robotUuid: input.robotUuid || '',
        robotName: input.robotName || '',
        flowName: '',
        lineNumber: '',
        errorType: '',
        elementName: '',
        rawRemark: input.remark || '',
        occurrenceCount: 1,
        sampleJobUuids: jobUuid ? [jobUuid] : [],
        diagnosed: false,
        kbId: null,
      };

  // 2) 需要时拉日志补全
  let logs = null;
  const needLogs =
    Boolean(jobUuid) &&
    (input.fetchLogs || !working.flowName || !working.errorType || !working.fingerprint);

  if (needLogs && jobUuid) {
    const logRes = await step('search_logs', { jobUuid, page: 1, size: 100 });
    if (!logRes.__error) {
      logs = logRes.logs || [];
      const fp = await step('build_fingerprint', {
        robotUuid: working.robotUuid,
        robotName: working.robotName,
        remark: working.rawRemark,
        jobUuid,
        logs,
      });
      if (!fp.__error) {
        working = {
          ...working,
          fingerprint: working.fingerprint || fp.fingerprint,
          errorSignature: fp.errorSignature || working.errorSignature,
          flowName: working.flowName || fp.flowName,
          lineNumber: working.lineNumber || fp.lineNumber,
          errorType: working.errorType || fp.errorType,
          elementName: working.elementName || fp.elementName,
          rawRemark: working.rawRemark || fp.rawRemark,
          robotUuid: working.robotUuid || fp.robotUuid,
          robotName: working.robotName || fp.robotName,
        };
      }
    }
  }

  if (!working.fingerprint && (working.rawRemark || working.errorType)) {
    const fp = await step('build_fingerprint', {
      robotUuid: working.robotUuid,
      robotName: working.robotName,
      remark: working.rawRemark,
      jobUuid,
    });
    if (!fp.__error) {
      working = { ...working, ...fp, sampleJobUuids: working.sampleJobUuids };
    }
  }

  if (!working.fingerprint && !jobUuid && !working.rawRemark) {
    return {
      ok: false,
      code: 'missing_target',
      skill: 'diagnose',
      message: '请提供 --fingerprint / --job / --queue 之一',
      toolTrace,
    };
  }

  // 3) KB 检索（附带历史；S10a 仅 confirmed 可短路）
  const kbHits = await step('kb_search', {
    fingerprint: working.fingerprint,
    errorSignature: working.errorSignature,
    errorType: working.errorType,
    elementName: working.elementName,
    limit: 3,
  });
  const history = (kbHits && !kbHits.__error && kbHits.hits) || [];

  // S10a：KB-first（仅 confirmed + 同 fingerprint + 高置信）
  const kbFirstHit = tryKbFirst(history, working, cfg, input);
  if (kbFirstHit) {
    const diagnosis = kbFirstHit.diagnosis;
    let kbEntry = kbFirstHit.kbEntry;
    if (!options.dryRun) {
      // 更新 lastSeen / occurrence，保持 confirmed，不降级为 pending_review
      kbEntry = await step('kb_write', {
        fingerprint: working.fingerprint,
        errorSignature: working.errorSignature || kbEntry.errorSignature,
        errorType: working.errorType || kbEntry.errorType,
        elementName: working.elementName || kbEntry.elementName,
        robotUuid: working.robotUuid || kbEntry.robotUuid,
        robotName: working.robotName || kbEntry.robotName,
        rootCause: diagnosis.rootCause,
        solution: diagnosis.suggestion,
        location: diagnosis.location,
        errorCategory: diagnosis.errorCategory,
        affectedBlocks: diagnosis.affectedBlocks || kbEntry.affectedBlocks || [],
        confidence: diagnosis.confidence,
        occurrenceCount: working.occurrenceCount || kbEntry.occurrenceCount || 1,
        status: 'confirmed',
        sourceJobUuids: working.sampleJobUuids || (jobUuid ? [jobUuid] : []),
        notes: diagnosis.notes || kbEntry.notes || '',
        kbAction: 'update',
      });
      if (working.fingerprint && kbEntry && !kbEntry.__error) {
        memory.markQueueDiagnosed(cfg.dataDir, working.fingerprint, {
          kbId: kbEntry.id,
          diagnosis,
        });
      }
    }
    const autoPlan = await maybeAutoPlanPatch(working, diagnosis, cfg, options);
    if (autoPlan && autoPlan.ok && autoPlan.message) {
      toolTrace.push({
        tool: 'auto_plan_on_diagnose',
        ok: true,
        patchId: autoPlan.patchId,
        message: autoPlan.message,
      });
    }
    return {
      ok: true,
      skill: 'diagnose',
      stage: 'M1-min',
      kbFirst: true,
      diagnosis,
      target: {
        fingerprint: working.fingerprint,
        robotUuid: working.robotUuid,
        robotName: working.robotName,
        flowName: working.flowName,
        lineNumber: working.lineNumber,
        errorType: working.errorType,
        elementName: working.elementName,
        occurrenceCount: working.occurrenceCount,
        sampleJobUuids: working.sampleJobUuids,
        rawRemark: working.rawRemark,
      },
      historyAttached: history.map((h) => ({
        id: h.id,
        score: h.score,
        rootCause: h.rootCause,
        solution: h.solution,
        status: h.status,
        confidence: h.confidence,
      })),
      appMapped: false,
      appInfo: null,
      flowContext: null,
      blocksContext: null,
      kb: kbEntry && !kbEntry.__error ? { id: kbEntry.id, status: kbEntry.status, path: `data/kb/${kbEntry.id}.json` } : kbEntry,
      autoPlan: autoPlan || null,
      toolTrace,
      dryRun: Boolean(options.dryRun),
    };
  }

  // 4) resolve app + 可选 understand / load_blocks（rpa-skill）
  let appInfo = null;
  let flowContext = null;
  let blocksContext = null;
  if (working.robotUuid) {
    appInfo = await step('resolve_app', { robotUuid: working.robotUuid });
    // 有有效 xbotDir 即读流程；reason 可能是提示（如多账号择一），不阻断
    if (appInfo && !appInfo.__error && appInfo.xbotDir) {
      flowContext = await step('understand_flow', {
        xbotDir: appInfo.xbotDir,
        flowName: working.flowName || undefined,
      });
      if (working.flowName || working.lineNumber) {
        blocksContext = await step('load_blocks', {
          xbotDir: appInfo.xbotDir,
          flowName: working.flowName,
          lineNumber: working.lineNumber,
        });
      }
    }
  }


  // 5) 结构化诊断（规则引擎；配置了任意 LLM apiKey 时可增强，失败则回落）
  const diagnosis = buildRuleDiagnosis(working, {
    history,
    appInfo,
    flowContext,
    blocksContext,
    logs,
  });


  const llmClient = llm;
  if (llmClient.isLlmConfigured(cfg) && input.useLlm !== false) {
    try {
      const enhanced = await enhanceWithLlm(diagnosis, working, {
        history,
        appInfo,
        flowContext,
        blocksContext,
        cfg,
      });
      if (enhanced) Object.assign(diagnosis, enhanced, { source: 'llm+rules' });
    } catch (e) {
      diagnosis.notes = [diagnosis.notes, `LLM 增强失败，已用规则诊断: ${e.message}`].filter(Boolean).join(' | ');
    }
  }



  // 6) 写 KB + 更新 queue
  let kbEntry = null;
  if (!options.dryRun) {
    // S10b：同 errorSignature 的其它应用写入 affectedApps
    let affectedApps = [];
    if (working.errorSignature) {
      try {
        const peers = memory
          .listQueueItems(cfg.dataDir)
          .filter((q) => q.errorSignature === working.errorSignature && q.robotUuid);
        const uuids = [
          ...new Set(
            [working.robotUuid, ...peers.map((p) => p.robotUuid)].filter(Boolean),
          ),
        ];
        if (uuids.length > 1) affectedApps = uuids;
      } catch {
        affectedApps = [];
      }
    }

    kbEntry = await step('kb_write', {
      fingerprint: working.fingerprint,
      errorSignature: working.errorSignature,
      errorType: working.errorType,
      elementName: working.elementName,
      robotUuid: working.robotUuid,
      robotName: working.robotName,
      rootCause: diagnosis.rootCause,
      solution: diagnosis.suggestion,
      location: diagnosis.location,
      errorCategory: diagnosis.errorCategory,
      affectedBlocks: diagnosis.affectedBlocks || [],
      affectedApps,
      confidence: diagnosis.confidence,
      occurrenceCount: working.occurrenceCount || 1,
      status: 'pending_review',
      sourceJobUuids: working.sampleJobUuids || (jobUuid ? [jobUuid] : []),
      notes: [
        diagnosis.notes || '',
        affectedApps.length > 1
          ? `跨应用特征 errorSignature 命中 ${affectedApps.length} 个 app`
          : '',
      ]
        .filter(Boolean)
        .join(' | '),
      kbAction: history.some((h) => h.fingerprint === working.fingerprint) ? 'update' : 'create',
    });

    if (working.fingerprint && kbEntry && !kbEntry.__error) {
      memory.markQueueDiagnosed(cfg.dataDir, working.fingerprint, {
        kbId: kbEntry.id,
        diagnosis,
      });
    }
  }

  // 7) S17：可选诊后 dry-run 存 patch（绝不 apply）
  const autoPlan = await maybeAutoPlanPatch(working, diagnosis, cfg, options);
  if (autoPlan && autoPlan.ok && autoPlan.message) {
    // 便于 service 日志直接看到
    toolTrace.push({
      tool: 'auto_plan_on_diagnose',
      ok: true,
      patchId: autoPlan.patchId,
      message: autoPlan.message,
    });
  } else if (autoPlan && !autoPlan.skipped && !autoPlan.ok) {
    toolTrace.push({
      tool: 'auto_plan_on_diagnose',
      ok: false,
      code: autoPlan.code,
      message: autoPlan.message,
    });
  }

  return {
    ok: true,
    skill: 'diagnose',
    stage: 'M1-min',
    diagnosis,
    target: {
      fingerprint: working.fingerprint,
      robotUuid: working.robotUuid,
      robotName: working.robotName,
      flowName: working.flowName,
      lineNumber: working.lineNumber,
      errorType: working.errorType,
      elementName: working.elementName,
      occurrenceCount: working.occurrenceCount,
      sampleJobUuids: working.sampleJobUuids,
      rawRemark: working.rawRemark,
    },
    historyAttached: history.map((h) => ({
      id: h.id,
      score: h.score,
      rootCause: h.rootCause,
      solution: h.solution,
      status: h.status,
      confidence: h.confidence,
    })),
    appMapped: Boolean(appInfo && appInfo.xbotDir),
    appInfo: appInfo && !appInfo.__error ? appInfo : null,
    flowContext: flowContext && flowContext.ok ? { summary: flowContext.summary, projectName: flowContext.projectName } : flowContext,
    blocksContext: blocksContext && blocksContext.ok
      ? { flowName: blocksContext.flowName, focusIndex: blocksContext.focusIndex, blocks: blocksContext.blocks }
      : blocksContext,

    kb: kbEntry && !kbEntry.__error ? { id: kbEntry.id, status: kbEntry.status, path: `data/kb/${kbEntry.id}.json` } : kbEntry,
    autoPlan: autoPlan || null,
    toolTrace,
    dryRun: Boolean(options.dryRun),
  };
}

/**
 * 批量消费未诊断队列
 */
async function drainQueue(cfg, { limit = 5, dryRun = false } = {}) {
  const items = memory.listQueueItems(cfg.dataDir).filter((i) => !i.diagnosed);
  const slice = items.slice(0, limit);
  const results = [];
  for (const item of slice) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runDiagnosePlaybook({ fingerprint: item.fingerprint }, cfg, { dryRun });
    results.push({
      fingerprint: item.fingerprint,
      ok: r.ok,
      kbId: r.kb && r.kb.id,
      rootCause: r.diagnosis && r.diagnosis.rootCause,
      confidence: r.diagnosis && r.diagnosis.confidence,
      fixability: r.diagnosis && r.diagnosis.fixability,
      autoPlan: r.autoPlan
        ? {
            ok: r.autoPlan.ok,
            skipped: r.autoPlan.skipped,
            patchId: r.autoPlan.patchId || null,
            message: r.autoPlan.message || r.autoPlan.reason || null,
          }
        : null,
    });
  }
  return {
    ok: true,
    skill: 'diagnose',
    mode: 'queue_drain',
    requested: limit,
    processed: results.length,
    remaining: Math.max(0, items.length - results.length),
    results,
  };
}

function buildRuleDiagnosis(working, ctx) {
  const { history, appInfo, flowContext, blocksContext } = ctx;
  const errorType = working.errorType || '';
  const elementName = working.elementName || '';
  const flowName = working.flowName || '未知子流程';
  const lineNumber = working.lineNumber || '?';
  const focusBlock = blocksContext && blocksContext.ok
    ? (blocksContext.blocks || []).find((b) => b.isFocus) || null
    : null;

  let errorCategory = 'other';
  let rootCause = '';
  let suggestion = '';
  let confidence = 0.55;

  if (/匹配到多个元素/.test(errorType) || /多个元素/.test(working.rawRemark || '')) {
    errorCategory = 'element';
    rootCause = `元素定位不唯一${elementName ? `（${elementName}）` : ''}，页面存在多个匹配节点`;
    suggestion = '收紧选择器（增加父级/属性约束）或改用更稳定的定位方式，并在操作前加唯一性校验/等待';
    confidence = 0.75;
  } else if (/未找到元素|找不到元素|元素未找到/.test(errorType) || /未找到元素/.test(working.rawRemark || '')) {
    errorCategory = 'element';
    rootCause = `目标元素未出现或定位失效${elementName ? `：${elementName}` : ''}`;
    suggestion = '检查页面是否改版、等待条件是否足够；重新抓取元素并增加显式等待/存在性判断';
    confidence = 0.72;
  } else if (/文件不存在|No such file|找不到文件/.test(errorType) || /文件不存在/.test(working.rawRemark || '')) {
    errorCategory = 'file';
    rootCause = '目标文件路径不存在或文件名拼接错误（常见重复扩展名、日期目录未生成）';
    suggestion = '运行前校验路径；检查导出/下载步骤是否成功；修正路径拼接与扩展名';
    confidence = 0.7;
  } else if (/超时|timeout/i.test(errorType) || /超时/.test(working.rawRemark || '')) {
    errorCategory = 'network';
    rootCause = '等待目标状态超时（页面/对话框/下载未在预期时间内出现）';
    suggestion = '增大超时、优化等待条件，或排查上游系统响应与客户端性能';
    confidence = 0.65;
  } else if (/登录|鉴权|认证/.test(errorType) || /登录|鉴权/.test(working.rawRemark || '')) {
    errorCategory = 'login';
    rootCause = '登录或鉴权失败';
    suggestion = '检查账号凭证、验证码/二次认证与登录页元素是否变更';
    confidence = 0.68;
  } else if (!errorType && /用户停止/.test(working.rawRemark || '')) {
    errorCategory = 'other';
    rootCause = '运行被用户手动停止，非应用逻辑故障';
    suggestion = '可忽略或从监听层过滤 stopped+用户停止；若误触需规范操作流程';
    confidence = 0.85;
  } else {
    rootCause = errorType
      ? `运行失败：${errorType}`
      : '运行失败，信息不足，仅基于 remark/日志做弱诊断';
    suggestion = '打开影刀日志确认失败步骤；补充 app-map 后可结合流程指令块深入分析';
    confidence = errorType ? 0.5 : 0.35;
  }

  if (focusBlock) {
    rootCause += `；邻近指令疑似 \`${focusBlock.name}\`${focusBlock.comment ? `（${focusBlock.comment}）` : ''}`;
    confidence = Math.min(0.9, confidence + 0.08);
    // 规则层：有真实指令类型时，建议里点名该块
    if (focusBlock.name && !suggestion.includes(focusBlock.name)) {
      suggestion += `；请在 Studio 中打开子流程「${flowName}」第 ${lineNumber} 行附近指令 \`${focusBlock.name}\` 核对选择器/参数`;
    }
  } else if (!appInfo || !appInfo.xbotDir) {
    confidence = Math.max(0.25, confidence - 0.12);
  }

  if (flowContext && flowContext.ok && flowContext.summary) {
    confidence = Math.min(0.92, confidence + 0.03);
  }

  // 历史仅附带提示，不自动覆盖（除非 confirmed 且指纹全等——仍只降 notes 提示）
  const confirmed = history.find((h) => h.status === 'confirmed' && h.fingerprint === working.fingerprint);
  let notes = '';
  if (!appInfo || !appInfo.xbotDir) {
    notes = '未解析到本地 xbot_robot，仅基于日志/remark 诊断';
  } else if (appInfo.source === 'shadowbot-auto') {
    notes = `已自动定位流程目录（${appInfo.source}）`;
    if (appInfo.reason) notes += `；${appInfo.reason}`;
    if (flowContext && flowContext.ok) notes += '；已调用 rpa-skill understand';
    if (blocksContext && blocksContext.ok) notes += '；已 load_blocks 邻近指令';
    if (focusBlock) notes += `；焦点指令 ${focusBlock.name}`;
  } else if (appInfo.source === 'app-map') {
    notes = '使用 app-map 手工路径';
    if (flowContext && flowContext.ok) notes += '；已调用 rpa-skill understand';
    if (blocksContext && blocksContext.ok) notes += '；已 load_blocks';
  } else if (appInfo.reason) {
    notes = `应用路径未完全生效: ${appInfo.reason}`;
  }

  if (confirmed) {
    notes = [notes, `存在已确认 KB ${confirmed.id}，可参考: ${confirmed.rootCause}`].filter(Boolean).join(' | ');
    if (confirmed.confidence >= 0.8) {
      // 附带提高一点置信，但仍写 pending_review 新结论，由人确认
      confidence = Math.max(confidence, Math.min(0.88, confirmed.confidence - 0.05));
    }
  } else if (history.length) {
    notes = [notes, `附带 ${history.length} 条历史 KB 供参考（未自动复用为最终结论）`].filter(Boolean).join(' | ');
  }

  const location = [
    working.robotName || working.robotUuid || '',
    `${flowName}/第${lineNumber}行`,
    focusBlock ? `指令:${focusBlock.name}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    rootCause,
    location,
    suggestion,
    confidence: Number(confidence.toFixed(2)),
    errorCategory,
    relatedFingerprintHints: history.filter((h) => h.fingerprint !== working.fingerprint).map((h) => h.fingerprint).slice(0, 5),
    kbAction: history.some((h) => h.fingerprint === working.fingerprint) ? 'update' : 'create',
    reusedKbId: null,
    affectedBlocks: focusBlock ? [focusBlock.name] : [],
    notes,
    source: 'rules',
    ...classifyFix(working, { logs: ctx.logs, blocksContext, appInfo }),
  };
}


async function enhanceWithLlm(base, working, ctx) {
  const { cfg, history, flowContext, blocksContext } = ctx;
  const resolved = llm.resolveLlmConfig(cfg);

  const system = `你是影刀 RPA 诊断助手。根据给定上下文输出【仅一个 JSON 对象】，字段：
rootCause, location, suggestion, confidence(0-1), errorCategory(element|file|login|network|data|other), notes
不要输出 markdown。若信息不足降低 confidence 并在 notes 说明。`;

  const user = JSON.stringify(
    {
      error: working,
      ruleDraft: base,
      history: history.slice(0, 2),
      flowSummary: flowContext && flowContext.ok ? flowContext.summary : null,
      blocks: blocksContext && blocksContext.ok ? blocksContext.blocks : null,
    },
    null,
    2,
  );

  let parsed;
  try {
    parsed = await llm.chatJson(cfg, {
      system,
      user,
      temperature: 0.2,
      maxTokens: 1024,
      jsonMode: resolved.apiStyle === 'openai',
    });
  } catch (e) {
    if (String(e.message).includes('response_format') || String(e.message).includes('json_object')) {
      parsed = await llm.chatJson(cfg, {
        system,
        user,
        temperature: 0.2,
        maxTokens: 1024,
        jsonMode: false,
      });
    } else {
      throw e;
    }
  }

  return {
    rootCause: parsed.rootCause || base.rootCause,
    location: parsed.location || base.location,
    suggestion: parsed.suggestion || base.suggestion,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : base.confidence,
    errorCategory: parsed.errorCategory || base.errorCategory,
    notes: parsed.notes || base.notes,
    // 保留规则分诊字段（LLM 不覆盖）
    fixClass: base.fixClass,
    fixability: base.fixability,
    fixTargets: base.fixTargets,
    relatedFingerprintHints: base.relatedFingerprintHints,
    kbAction: base.kbAction,
    reusedKbId: base.reusedKbId,
    affectedBlocks: base.affectedBlocks,
    llmProvider: `${resolved.apiStyle}@${resolved.baseUrl}`,
    llmModel: resolved.model,
  };
}




module.exports = {
  runDiagnosePlaybook,
  drainQueue,
  buildRuleDiagnosis,
  isAutoPlanOnDiagnose,
  maybeAutoPlanPatch,
  isKbFirstEnabled,
  tryKbFirst,
};
