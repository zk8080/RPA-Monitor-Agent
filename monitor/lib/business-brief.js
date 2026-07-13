/**
 * 业务解读：在 rpa-skill understand 结构摘要之上调用 LLM，生成业务向说明（推测）。
 * 不替代 understand；结果须标注「模型推测」。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chatJson, isLlmConfigured, resolveLlmConfig } = require('./llm');

const CACHE_DIR = 'cache/business-brief';

function cacheDir(dataDir) {
  return path.join(dataDir, CACHE_DIR);
}

function cacheKey(robotUuid, understandFingerprint, model) {
  const material = `${robotUuid}|${understandFingerprint}|${model || ''}`;
  return crypto.createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 24);
}

/** 按应用保留「最近一次解读」，刷新页面可直接回显 */
function robotIndexPath(dataDir, robotUuid) {
  const safe = String(robotUuid || 'unknown')
    .replace(/[^\w.\u4e00-\u9fff-]+/g, '_')
    .slice(0, 80);
  return path.join(cacheDir(dataDir), 'by-app', `${safe}.json`);
}

function readRobotIndex(dataDir, robotUuid) {
  try {
    return JSON.parse(fs.readFileSync(robotIndexPath(dataDir, robotUuid), 'utf8'));
  } catch {
    return null;
  }
}

function writeRobotIndex(dataDir, robotUuid, payload) {
  try {
    const file = robotIndexPath(dataDir, robotUuid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  } catch {
    // ignore
  }
}

/**
 * 从 understand 结果压成 LLM 输入（控 token）
 * @param {object} understandResult rpa.understandFlow 成功结果
 * @param {{ appName?: string, robotUuid?: string }} meta
 */
function buildUnderstandDigest(understandResult, meta = {}) {
  const r = understandResult || {};
  const edges = (r.callGraph && r.callGraph.edges) || [];
  const codeMods = (r.callGraph && r.callGraph.codeModules) || [];
  return {
    appName: meta.appName || r.projectName || '',
    robotUuid: meta.robotUuid || '',
    projectName: r.projectName || '',
    summary: r.summary || '',
    businessObjects: (r.businessObjects || []).slice(0, 20),
    inputs: (r.inputs || []).slice(0, 15),
    outputs: (r.outputs || []).slice(0, 15),
    stages: (r.stages || []).slice(0, 12).map((s) => ({
      flow: s.flow || s.name || '',
      stages: (s.stages || []).slice(0, 8),
    })),
    flowRoles: (r.flowRoles || []).slice(0, 25).map((it) => {
      if (typeof it === 'string') return it;
      return {
        flow: it.flow || it.name || it.filename || '',
        role: it.role || it.description || '',
      };
    }),
    rules: (r.rules || []).slice(0, 10),
    callEdges: edges.slice(0, 40).map((e) => ({
      type: e.type,
      from: e.from,
      to: e.to,
      toKind: e.toKind,
    })),
    codeModules: codeMods.slice(0, 15).map((m) => ({
      name: m.name || m.filename,
      pyExists: m.pyExists,
      summary: (m.summary || '').slice(0, 200),
    })),
    callStats: r.callStats || (r.callGraph && r.callGraph.stats) || null,
  };
}

function digestFingerprint(digest) {
  return crypto.createHash('sha1').update(JSON.stringify(digest), 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {object} cfg
 * @param {object} digest
 * @returns {Promise<object>}
 */
async function runBusinessBriefLlm(cfg, digest) {
  const system = [
    '你是影刀 RPA 业务分析助手。用户会提供 rpa-skill understand 的结构化摘要（调用图、阶段、流程角色等）。',
    '请据此推断该机器人在业务上「做什么、怎么串、涉及哪些系统与数据」。',
    '规则：',
    '1. 只能基于给定材料推断；材料没有的信息放进 openQuestions，不要编造具体字段值、审批规则或接口路径。',
    '2. 技术结构（web/excel/子流程）要翻译成业务语言，但保留不确定处。',
    '3. 全文视为「模型推测」，不是已确认的业务文档。',
    '4. 必须只输出一个 JSON 对象，不要 Markdown 围栏。',
  ].join('\n');

  const user = [
    '请输出 JSON，字段：',
    '{',
    '  "title": "一句话标题",',
    '  "purpose": "业务目的 2～4 句",',
    '  "businessFlow": ["业务步骤1", "步骤2", "..."],',
    '  "systems": ["涉及系统/通道"],',
    '  "dataObjects": ["业务对象/单据"],',
    '  "techHighlights": ["与实现相关的要点，可选"],',
    '  "risks": ["业务或运维风险"],',
    '  "openQuestions": ["需业务方确认的问题"],',
    '  "confidence": 0.0-1.0',
    '}',
    '',
    '材料：',
    JSON.stringify(digest, null, 2),
  ].join('\n');

  const parsed = await chatJson(cfg, {
    system,
    user,
    temperature: 0.3,
    maxTokens: 1800,
    jsonMode: true,
  });

  return normalizeBrief(parsed);
}

function normalizeBrief(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      title: '业务解读',
      purpose: String(raw || ''),
      businessFlow: [],
      systems: [],
      dataObjects: [],
      techHighlights: [],
      risks: [],
      openQuestions: [],
      confidence: null,
    };
  }
  const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);
  let confidence = raw.confidence;
  if (confidence != null) {
    const n = Number(confidence);
    confidence = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  } else {
    confidence = null;
  }
  return {
    title: String(raw.title || '业务解读').slice(0, 120),
    purpose: String(raw.purpose || '').slice(0, 2000),
    businessFlow: arr(raw.businessFlow).slice(0, 20),
    systems: arr(raw.systems).slice(0, 20),
    dataObjects: arr(raw.dataObjects).slice(0, 20),
    techHighlights: arr(raw.techHighlights).slice(0, 15),
    risks: arr(raw.risks).slice(0, 15),
    openQuestions: arr(raw.openQuestions).slice(0, 15),
    confidence,
  };
}

function readCache(dataDir, key) {
  try {
    const p = path.join(cacheDir(dataDir), `${key}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(dataDir, key, payload) {
  try {
    const dir = cacheDir(dataDir);
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, `${key}.json`);
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, p);
  } catch {
    // ignore
  }
}

function toPublicResult(hit, { cached = true, fp = null, stale = false } = {}) {
  if (!hit || !hit.brief) return null;
  return {
    ok: true,
    cached,
    stale: !!stale,
    model: hit.model || null,
    generatedAt: hit.generatedAt || null,
    understandFingerprint: fp || hit.understandFingerprint || null,
    brief: hit.brief,
    disclaimer: '模型推测，非正式业务文档；请以业务方确认为准。',
  };
}

/**
 * 只读缓存（不调 LLM）。精确命中 → 按应用最近一次。
 * @param {object} cfg
 * @param {{ robotUuid: string, appName?: string, understandResult?: object }} opts
 */
function loadCachedBusinessBrief(cfg, opts = {}) {
  const robotUuid = opts.robotUuid || 'unknown';
  const llm = resolveLlmConfig(cfg);
  let fp = null;
  if (opts.understandResult && opts.understandResult.ok !== false) {
    const digest = buildUnderstandDigest(opts.understandResult, {
      appName: opts.appName,
      robotUuid,
    });
    fp = digestFingerprint(digest);
    const key = cacheKey(robotUuid, fp, llm.model);
    const hit = readCache(cfg.dataDir, key);
    const pub = toPublicResult(hit, { cached: true, fp, stale: false });
    if (pub) return pub;
  }

  // 回退：该应用最近一次解读（结构变更时仍可回显，标 stale）
  const latest = readRobotIndex(cfg.dataDir, robotUuid);
  const pubLatest = toPublicResult(latest, {
    cached: true,
    fp: latest && latest.understandFingerprint,
    stale: Boolean(fp && latest && latest.understandFingerprint && latest.understandFingerprint !== fp),
  });
  if (pubLatest) return pubLatest;

  return {
    ok: true,
    cached: false,
    brief: null,
    message: '尚无已保存的业务解读',
  };
}

/**
 * @param {object} cfg
 * @param {{
 *   robotUuid: string,
 *   appName?: string,
 *   understandResult: object,
 *   force?: boolean,
 * }} opts
 */
async function generateBusinessBrief(cfg, opts = {}) {
  if (!isLlmConfigured(cfg)) {
    return {
      ok: false,
      code: 'llm_not_configured',
      message: '未配置 LLM。请在工作台「设置」中配置 API Key，或设置 LLM_API_KEY。',
    };
  }
  if (!opts.understandResult || opts.understandResult.ok === false) {
    return {
      ok: false,
      code: 'understand_required',
      message: '需要先成功完成 understand 结构解析',
    };
  }

  const digest = buildUnderstandDigest(opts.understandResult, {
    appName: opts.appName,
    robotUuid: opts.robotUuid,
  });
  const fp = digestFingerprint(digest);
  const llm = resolveLlmConfig(cfg);
  const robotUuid = opts.robotUuid || 'unknown';
  const key = cacheKey(robotUuid, fp, llm.model);

  if (!opts.force) {
    const hit = readCache(cfg.dataDir, key);
    if (hit && hit.brief) {
      // 同步 by-app 索引，保证刷新可回显
      writeRobotIndex(cfg.dataDir, robotUuid, {
        ...hit,
        cacheKey: key,
      });
      return toPublicResult(hit, { cached: true, fp, stale: false });
    }
  }

  const t0 = Date.now();
  let brief;
  try {
    brief = await runBusinessBriefLlm(cfg, digest);
  } catch (e) {
    return {
      ok: false,
      code: 'llm_error',
      message: e && e.message ? e.message : String(e),
      latencyMs: Date.now() - t0,
    };
  }

  const generatedAt = new Date().toISOString();
  const store = {
    robotUuid,
    appName: opts.appName || '',
    model: llm.model,
    generatedAt,
    understandFingerprint: fp,
    brief,
    cacheKey: key,
  };
  writeCache(cfg.dataDir, key, store);
  writeRobotIndex(cfg.dataDir, robotUuid, store);

  return {
    ok: true,
    cached: false,
    stale: false,
    model: llm.model,
    generatedAt,
    latencyMs: Date.now() - t0,
    understandFingerprint: fp,
    brief,
    disclaimer: '模型推测，非正式业务文档；请以业务方确认为准。',
  };
}

module.exports = {
  buildUnderstandDigest,
  generateBusinessBrief,
  loadCachedBusinessBrief,
  normalizeBrief,
  digestFingerprint,
};
