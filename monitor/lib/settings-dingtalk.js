/**
 * 钉钉机器人本机设置：data/settings.dingtalk.json
 * Web 可写；密钥仅存 data/（gitignore），GET 脱敏。
 *
 * 字段：
 * - enabled: 是否启用每日晨报推送
 * - webhookUrl: 自定义机器人 Webhook
 * - secret: 加签密钥（可选）
 * - recentDays: 摘要时间窗（天，默认 1=24h）
 * - topN: 优先/失败条目最多展示条数
 * - atMobiles: 要 @ 的手机号列表（钉钉账号绑定手机）
 * - atAll: 是否 @所有人
 * - atAlways: 无异常时是否也 @（默认 true，防止漏看）
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'settings.dingtalk.json';
const CLEAR_SECRET = '__CLEAR__';

/** @type {{ at: number, mtimeMs: number, data: object|null, dataDir: string }|null} */
let cache = null;
const CACHE_MS = 1500;

function settingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILE);
}

/**
 * @param {string|string[]|null|undefined} raw
 * @returns {string[]}
 */
function normalizeMobiles(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x || '').trim())
      .filter((x) => /^\d{6,20}$/.test(x));
  }
  const s = String(raw || '').trim();
  if (!s) return [];
  return s
    .split(/[,，;\s]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d{6,20}$/.test(x));
}

function emptySettings() {
  return {
    version: 1,
    updatedAt: null,
    enabled: false,
    webhookUrl: '',
    secret: '',
    recentDays: 1,
    topN: 8,
    atMobiles: [],
    atAll: false,
    atAlways: true,
    lastSendAt: null,
    lastSendOk: null,
    lastSendError: null,
  };
}

/**
 * @param {string} dataDir
 * @param {{ force?: boolean }} [opts]
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
  let recentDays = 1;
  if (raw.recentDays != null && String(raw.recentDays).trim() !== '') {
    const n = Number(raw.recentDays);
    if (Number.isFinite(n) && n >= 0) recentDays = n;
  }
  let topN = 8;
  if (raw.topN != null && String(raw.topN).trim() !== '') {
    const n = parseInt(String(raw.topN), 10);
    if (Number.isFinite(n) && n > 0) topN = Math.min(n, 30);
  }
  return {
    version: 1,
    updatedAt: raw.updatedAt || null,
    enabled: raw.enabled === true || raw.enabled === 'true',
    webhookUrl: raw.webhookUrl != null ? String(raw.webhookUrl).trim() : '',
    secret: raw.secret != null ? String(raw.secret) : '',
    recentDays,
    topN,
    atMobiles: normalizeMobiles(raw.atMobiles),
    atAll: raw.atAll === true || raw.atAll === 'true',
    // 默认 true：无异常也 @，避免漏看
    atAlways: raw.atAlways !== false && raw.atAlways !== 'false',
    lastSendAt: raw.lastSendAt || null,
    lastSendOk: raw.lastSendOk == null ? null : raw.lastSendOk === true,
    lastSendError: raw.lastSendError != null ? String(raw.lastSendError).slice(0, 500) : null,
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
    enabled: next.enabled === true,
    webhookUrl: next.webhookUrl || '',
    secret: next.secret || '',
    recentDays: next.recentDays != null ? Number(next.recentDays) : 1,
    topN: next.topN != null ? Number(next.topN) : 8,
    atMobiles: normalizeMobiles(next.atMobiles),
    atAll: next.atAll === true,
    atAlways: next.atAlways !== false,
    lastSendAt: next.lastSendAt || null,
    lastSendOk: next.lastSendOk == null ? null : next.lastSendOk === true,
    lastSendError: next.lastSendError != null ? String(next.lastSendError).slice(0, 500) : null,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  invalidateCache();
  return payload;
}

function maskSecret(s) {
  const t = String(s || '');
  if (!t) return '';
  if (t.length <= 6) return '••••';
  return `${t.slice(0, 2)}…${t.slice(-3)}`;
}

function maskWebhook(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  try {
    const parsed = new URL(u);
    const path = parsed.pathname || '';
    const tail = path.length > 12 ? path.slice(-10) : path;
    return `${parsed.origin}/…${tail}`;
  } catch {
    if (u.length <= 16) return '••••';
    return `${u.slice(0, 12)}…${u.slice(-6)}`;
  }
}

/**
 * 脱敏视图
 * @param {object} cfg loadConfig()
 */
function getPublicDingtalkSettings(cfg) {
  const file = readSettingsFile(cfg.dataDir || '');
  const reportCron = cfg.reportCron || '5 9 * * *';
  return {
    ok: true,
    enabled: file.enabled === true,
    configured: Boolean(file.webhookUrl),
    webhookConfigured: Boolean(file.webhookUrl),
    webhookMasked: maskWebhook(file.webhookUrl),
    secretConfigured: Boolean(file.secret),
    secretMasked: maskSecret(file.secret),
    recentDays: file.recentDays != null ? file.recentDays : 1,
    topN: file.topN != null ? file.topN : 8,
    atMobiles: Array.isArray(file.atMobiles) ? file.atMobiles : [],
    atMobilesText: (Array.isArray(file.atMobiles) ? file.atMobiles : []).join(', '),
    atAll: file.atAll === true,
    atAlways: file.atAlways !== false,
    /** 晨报：独立 1min cron tick 检查 reportCron；boot/poll 不发；成功后本机日历日去重 */
    scheduleHint: `独立分钟级调度检查 reportCron（${reportCron}，默认约 9:05）；到点或晚点补跑一次；启动与定时 poll 不发；每天最多一条（测试发送可强制）`,
    reportCron,
    updatedAt: file.updatedAt || null,
    lastSendAt: file.lastSendAt || null,
    lastSendOk: file.lastSendOk,
    lastSendError: file.lastSendError || null,
    settingsEnabled: true,
  };
}

/**
 * @param {string} dataDir
 * @param {object} body
 * @param {{ settingsEnabled?: boolean }} [opts]
 */
function saveDingtalkSettings(dataDir, body = {}, opts = {}) {
  if (opts.settingsEnabled === false) {
    return {
      ok: false,
      code: 'settings_disabled',
      message: 'workbench.settingsEnabled=false',
    };
  }
  const prev = readSettingsFile(dataDir, { force: true });
  const next = { ...prev };

  if (body.enabled !== undefined) {
    next.enabled = body.enabled === true || body.enabled === 'true';
  }
  // 显式 clear 优先；空串保留原值（与 LLM apiKey 一致）
  if (body.clearWebhook === true) {
    next.webhookUrl = '';
  } else if (body.webhookUrl !== undefined) {
    const w = body.webhookUrl == null ? '' : String(body.webhookUrl).trim();
    if (w === CLEAR_SECRET) next.webhookUrl = '';
    else if (w !== '') next.webhookUrl = w;
  }
  if (body.clearSecret === true) {
    next.secret = '';
  } else if (body.secret !== undefined) {
    const s = body.secret == null ? '' : String(body.secret);
    if (s === CLEAR_SECRET) next.secret = '';
    else if (s.trim() !== '') next.secret = s.trim();
  }
  if (body.recentDays !== undefined) {
    const n = Number(body.recentDays);
    if (Number.isFinite(n) && n >= 0) next.recentDays = n;
  }
  if (body.topN !== undefined) {
    const n = parseInt(String(body.topN), 10);
    if (Number.isFinite(n) && n > 0) next.topN = Math.min(n, 30);
  }
  if (body.atMobiles !== undefined || body.atMobilesText !== undefined) {
    next.atMobiles = normalizeMobiles(
      body.atMobiles !== undefined ? body.atMobiles : body.atMobilesText,
    );
  }
  if (body.atAll !== undefined) {
    next.atAll = body.atAll === true || body.atAll === 'true';
  }
  if (body.atAlways !== undefined) {
    next.atAlways = body.atAlways !== false && body.atAlways !== 'false';
  }

  const written = writeSettingsFile(dataDir, next);
  return {
    ok: true,
    saved: true,
    updatedAt: written.updatedAt,
  };
}

/**
 * 记录最近一次发送结果（不改 enabled/webhook）
 * @param {string} dataDir
 * @param {{ ok: boolean, error?: string }} result
 */
function recordSendResult(dataDir, result) {
  const prev = readSettingsFile(dataDir, { force: true });
  writeSettingsFile(dataDir, {
    ...prev,
    lastSendAt: new Date().toISOString(),
    lastSendOk: result && result.ok === true,
    lastSendError: result && result.ok ? null : (result && result.error) || 'send failed',
  });
}

/**
 * 供发送层读取完整密钥（仅服务端）
 * @param {string} dataDir
 */
function getRuntimeConfig(dataDir) {
  const f = readSettingsFile(dataDir);
  return {
    enabled: f.enabled === true,
    webhookUrl: f.webhookUrl || '',
    secret: f.secret || '',
    recentDays: f.recentDays != null ? f.recentDays : 1,
    topN: f.topN != null ? f.topN : 8,
    atMobiles: Array.isArray(f.atMobiles) ? f.atMobiles : [],
    atAll: f.atAll === true,
    atAlways: f.atAlways !== false,
  };
}

module.exports = {
  SETTINGS_FILE,
  CLEAR_SECRET,
  settingsPath,
  readSettingsFile,
  writeSettingsFile,
  invalidateCache,
  maskSecret,
  maskWebhook,
  normalizeMobiles,
  getPublicDingtalkSettings,
  saveDingtalkSettings,
  recordSendResult,
  getRuntimeConfig,
  emptySettings,
};
