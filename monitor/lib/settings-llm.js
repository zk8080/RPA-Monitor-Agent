/**
 * LLM 本机设置（Web 可写）：data/settings.llm.json
 * 优先级由 loadConfig 合并：env > 本文件 > config.local.js
 */

const fs = require('fs');
const path = require('path');
const { chatText, resolveLlmConfig } = require('./llm');

const SETTINGS_FILE = 'settings.llm.json';
const CLEAR_KEY = '__CLEAR__';

/** @type {{ at: number, mtimeMs: number, data: object|null, dataDir: string }|null} */
let cache = null;
const CACHE_MS = 1500;

function settingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILE);
}

function emptySettings() {
  return {
    version: 1,
    updatedAt: null,
    baseUrl: '',
    apiKey: '',
    model: '',
    apiStyle: '',
    timeoutMs: null,
    diagnoseUseLlm: true,
  };
}

/**
 * @param {string} dataDir
 * @param {{ force?: boolean }} [opts]
 * @returns {object}
 */
function readSettingsFile(dataDir, opts = {}) {
  if (!dataDir) return emptySettings();
  const file = settingsPath(dataDir);
  const now = Date.now();
  try {
    const st = fs.statSync(file);
    if (
      !opts.force &&
      cache &&
      cache.dataDir === dataDir &&
      cache.mtimeMs === st.mtimeMs &&
      now - cache.at < CACHE_MS
    ) {
      return { ...emptySettings(), ...cache.data };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = normalizeStored(raw);
    cache = { at: now, mtimeMs: st.mtimeMs, data, dataDir };
    return { ...emptySettings(), ...data };
  } catch {
    cache = { at: now, mtimeMs: 0, data: emptySettings(), dataDir };
    return emptySettings();
  }
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return emptySettings();
  const timeoutRaw = raw.timeoutMs;
  let timeoutMs = null;
  if (timeoutRaw != null && String(timeoutRaw).trim() !== '') {
    const n = parseInt(String(timeoutRaw), 10);
    if (Number.isFinite(n) && n > 0) timeoutMs = n;
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt || null,
    baseUrl: raw.baseUrl != null ? String(raw.baseUrl).trim() : '',
    apiKey: raw.apiKey != null ? String(raw.apiKey) : '',
    model: raw.model != null ? String(raw.model).trim() : '',
    apiStyle: raw.apiStyle != null ? String(raw.apiStyle).trim().toLowerCase() : '',
    timeoutMs,
    diagnoseUseLlm: raw.diagnoseUseLlm !== false,
  };
}

function invalidateCache() {
  cache = null;
}

/**
 * @param {string} dataDir
 * @param {object} next
 */
function writeSettingsFile(dataDir, next) {
  if (!dataDir) throw new Error('dataDir required');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = settingsPath(dataDir);
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    baseUrl: next.baseUrl || '',
    apiKey: next.apiKey || '',
    model: next.model || '',
    apiStyle: next.apiStyle || '',
    timeoutMs: next.timeoutMs != null ? next.timeoutMs : null,
    diagnoseUseLlm: next.diagnoseUseLlm !== false,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  invalidateCache();
  return payload;
}

function maskApiKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 3)}…${s.slice(-4)}`;
}

function envLocks() {
  return {
    apiKey: Boolean(
      process.env.LLM_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.ANTHROPIC_API_KEY,
    ),
    baseUrl: Boolean(
      process.env.LLM_BASE_URL ||
        process.env.OPENAI_BASE_URL ||
        process.env.ANTHROPIC_BASE_URL,
    ),
    model: Boolean(
      process.env.LLM_MODEL || process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL,
    ),
    apiStyle: Boolean(process.env.LLM_API_STYLE),
    timeoutMs: Boolean(process.env.LLM_TIMEOUT_MS),
  };
}

/**
 * 判定当前生效配置的主要来源（展示用）
 * @param {object} cfg loadConfig()
 */
function detectSource(cfg) {
  const locks = envLocks();
  if (locks.apiKey || locks.baseUrl || locks.model) return 'env';
  const file = readSettingsFile(cfg.dataDir || '');
  if (file.apiKey || file.baseUrl || file.model) return 'settings_file';
  if (cfg.llmApiKey || cfg.llmBaseUrl || cfg.llmModel) return 'config_local';
  if (cfg.anthropicApiKey) return 'config_local';
  return 'none';
}

/**
 * 脱敏视图
 * @param {object} cfg loadConfig()
 */
function getPublicLlmSettings(cfg) {
  const llm = resolveLlmConfig(cfg);
  const file = readSettingsFile(cfg.dataDir || '');
  const locks = envLocks();
  const diagnoseUseLlm = cfg.diagnoseUseLlm !== false;
  return {
    ok: true,
    configured: llm.enabled,
    source: detectSource(cfg),
    baseUrl: llm.baseUrl || '',
    model: llm.model || '',
    apiStyle: llm.apiStyle || 'openai',
    timeoutMs: llm.timeoutMs || 600000,
    diagnoseUseLlm,
    apiKeyConfigured: Boolean(llm.apiKey),
    apiKeyMasked: maskApiKey(llm.apiKey),
    updatedAt: file.updatedAt || null,
    envLocked: locks,
    settingsEnabled: true,
  };
}

/**
 * 合并 PUT body 写入文件
 * @param {string} dataDir
 * @param {object} body
 * @param {{ settingsEnabled?: boolean }} [opts]
 */
function saveLlmSettings(dataDir, body = {}, opts = {}) {
  if (opts.settingsEnabled === false) {
    return {
      ok: false,
      code: 'settings_disabled',
      message: 'workbench.settingsEnabled=false',
    };
  }
  const locks = envLocks();
  const prev = readSettingsFile(dataDir, { force: true });
  const next = { ...prev };

  if (body.baseUrl !== undefined && !locks.baseUrl) {
    next.baseUrl = String(body.baseUrl || '').trim();
  }
  if (body.model !== undefined && !locks.model) {
    next.model = String(body.model || '').trim();
  }
  if (body.apiStyle !== undefined && !locks.apiStyle) {
    const s = String(body.apiStyle || '').trim().toLowerCase();
    next.apiStyle = s === 'anthropic' ? 'anthropic' : s === 'openai' ? 'openai' : s;
  }
  if (body.timeoutMs !== undefined && !locks.timeoutMs) {
    const n = parseInt(String(body.timeoutMs), 10);
    next.timeoutMs = Number.isFinite(n) && n > 0 ? n : null;
  }
  if (body.diagnoseUseLlm !== undefined) {
    next.diagnoseUseLlm = body.diagnoseUseLlm !== false && body.diagnoseUseLlm !== 'false';
  }

  // apiKey：省略或空串 = 保留；__CLEAR__ = 清空
  if (body.apiKey !== undefined && !locks.apiKey) {
    const k = body.apiKey == null ? '' : String(body.apiKey);
    if (k === CLEAR_KEY || body.clearApiKey === true) {
      next.apiKey = '';
    } else if (k.trim() !== '') {
      next.apiKey = k.trim();
    }
    // empty → keep prev
  }

  const written = writeSettingsFile(dataDir, next);
  return {
    ok: true,
    saved: true,
    updatedAt: written.updatedAt,
    // 调用方应 loadConfig 后 getPublic
  };
}

/**
 * 用临时 cfg 或当前 cfg 测连通
 * @param {object} cfg
 * @param {object} [overrideBody] 可选：测试未保存的表单
 */
async function testLlmConnection(cfg, overrideBody = null) {
  let testCfg = cfg;
  if (overrideBody && typeof overrideBody === 'object') {
    const llm = resolveLlmConfig(cfg);
    const locks = envLocks();
    let apiKey = llm.apiKey;
    if (overrideBody.apiKey != null && String(overrideBody.apiKey).trim() !== '' && !locks.apiKey) {
      const k = String(overrideBody.apiKey).trim();
      if (k !== CLEAR_KEY) apiKey = k;
    }
    const baseUrl =
      overrideBody.baseUrl != null && String(overrideBody.baseUrl).trim() !== '' && !locks.baseUrl
        ? String(overrideBody.baseUrl).trim()
        : llm.baseUrl;
    const model =
      overrideBody.model != null && String(overrideBody.model).trim() !== '' && !locks.model
        ? String(overrideBody.model).trim()
        : llm.model;
    const apiStyle =
      overrideBody.apiStyle != null && String(overrideBody.apiStyle).trim() !== '' && !locks.apiStyle
        ? String(overrideBody.apiStyle).trim()
        : llm.apiStyle;
    let timeoutMs = llm.timeoutMs;
    if (overrideBody.timeoutMs != null && !locks.timeoutMs) {
      const n = parseInt(String(overrideBody.timeoutMs), 10);
      if (Number.isFinite(n) && n > 0) timeoutMs = Math.min(n, 30000);
    } else {
      timeoutMs = Math.min(timeoutMs || 600000, 30000);
    }
    testCfg = {
      ...cfg,
      llmApiKey: apiKey,
      llmBaseUrl: baseUrl,
      llmModel: model,
      llmApiStyle: apiStyle,
      llmTimeoutMs: timeoutMs,
      llm: { baseUrl, apiKey, model, apiStyle, timeoutMs },
    };
  } else {
    // 限制测试超时，避免挂死 UI
    const llm = resolveLlmConfig(cfg);
    testCfg = {
      ...cfg,
      llmTimeoutMs: Math.min(llm.timeoutMs || 600000, 30000),
      llm: { ...llm, timeoutMs: Math.min(llm.timeoutMs || 600000, 30000) },
    };
  }

  const llm = resolveLlmConfig(testCfg);
  if (!llm.enabled) {
    return {
      ok: false,
      code: 'not_configured',
      message: '未配置 API Key（请填写或确认环境变量 / data/settings.llm.json）',
    };
  }

  const t0 = Date.now();
  try {
    const text = await chatText(testCfg, {
      system: 'You are a connectivity probe. Reply with exactly: ok',
      user: 'ping',
      temperature: 0,
      maxTokens: 16,
    });
    return {
      ok: true,
      latencyMs: Date.now() - t0,
      model: llm.model,
      message: String(text || '').slice(0, 80),
    };
  } catch (e) {
    return {
      ok: false,
      code: 'test_failed',
      latencyMs: Date.now() - t0,
      model: llm.model,
      message: e && e.message ? e.message : String(e),
    };
  }
}

/**
 * 从文件取出非空字段，供 loadConfig 合并（不含 env）
 * @param {string} dataDir
 */
function getFileOverlay(dataDir) {
  const f = readSettingsFile(dataDir);
  const o = {};
  if (f.baseUrl) o.baseUrl = f.baseUrl;
  if (f.apiKey) o.apiKey = f.apiKey;
  if (f.model) o.model = f.model;
  if (f.apiStyle) o.apiStyle = f.apiStyle;
  if (f.timeoutMs != null) o.timeoutMs = f.timeoutMs;
  o.diagnoseUseLlm = f.diagnoseUseLlm !== false;
  // 有写过文件（updatedAt）才算 file 层参与 diagnoseUseLlm
  o.hasFile = Boolean(f.updatedAt);
  return o;
}

module.exports = {
  SETTINGS_FILE,
  CLEAR_KEY,
  settingsPath,
  readSettingsFile,
  writeSettingsFile,
  invalidateCache,
  maskApiKey,
  envLocks,
  getPublicLlmSettings,
  saveLlmSettings,
  testLlmConnection,
  getFileOverlay,
  detectSource,
};
