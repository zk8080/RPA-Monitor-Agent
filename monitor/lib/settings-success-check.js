/**
 * 成功抽检本机设置：data/settings.success-check.json
 * Web 可写；gitignore 的 data/。
 *
 * 产品名「成功抽检」：对状态成功的任务抽查末尾日志，发现被吞掉的错误。
 * 内部仍映射 softFail 运行时配置。
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = 'settings.success-check.json';
const PRODUCT_NAME = '成功抽检';

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
    enabled: true,
    maxPerPoll: 25,
    maxPerAppPerPoll: 5,
    tailSize: 10,
    sort: 'desc',
    minIntervalMs: 220,
    retainDays: 14,
    robotUuidAllowlist: [],
    robotUuidPriority: [],
  };
}

function clampInt(v, def, min, max) {
  const n = v != null && String(v).trim() !== '' ? parseInt(String(v), 10) : def;
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function normalizeUuidList(raw) {
  if (Array.isArray(raw)) {
    return [...new Set(raw.map((x) => String(x || '').trim()).filter(Boolean))];
  }
  const s = String(raw || '').trim();
  if (!s) return [];
  return [
    ...new Set(
      s
        .split(/[,，;\s\n]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return emptySettings();
  const base = emptySettings();
  return {
    version: 1,
    updatedAt: raw.updatedAt || null,
    enabled: raw.enabled !== false && raw.enabled !== 'false',
    maxPerPoll: clampInt(raw.maxPerPoll, base.maxPerPoll, 0, 200),
    maxPerAppPerPoll: clampInt(raw.maxPerAppPerPoll, base.maxPerAppPerPoll, 0, 50),
    tailSize: clampInt(raw.tailSize, base.tailSize, 1, 50),
    sort: raw.sort != null && String(raw.sort).trim() !== '' ? String(raw.sort).trim() : 'desc',
    minIntervalMs: clampInt(raw.minIntervalMs, base.minIntervalMs, 0, 5000),
    retainDays: clampInt(raw.retainDays, base.retainDays, 1, 90),
    robotUuidAllowlist: normalizeUuidList(raw.robotUuidAllowlist),
    robotUuidPriority: normalizeUuidList(raw.robotUuidPriority),
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
  const payload = normalizeStored({
    ...next,
    updatedAt: new Date().toISOString(),
  });
  payload.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  invalidateCache();
  return payload;
}

/**
 * 是否存在用户文件（用于 UI 标注来源）
 * @param {string} dataDir
 */
function hasFile(dataDir) {
  try {
    return fs.existsSync(settingsPath(dataDir));
  } catch {
    return false;
  }
}

/**
 * 供 soft-audit 合并：仅返回文件层字段
 * @param {string} dataDir
 */
function getFileOverlay(dataDir) {
  if (!hasFile(dataDir)) {
    return { hasFile: false };
  }
  const f = readSettingsFile(dataDir);
  return {
    hasFile: true,
    enabled: f.enabled,
    maxPerPoll: f.maxPerPoll,
    maxPerAppPerPoll: f.maxPerAppPerPoll,
    tailSize: f.tailSize,
    sort: f.sort,
    minIntervalMs: f.minIntervalMs,
    retainDays: f.retainDays,
    robotUuidAllowlist: f.robotUuidAllowlist,
    robotUuidPriority: f.robotUuidPriority,
    updatedAt: f.updatedAt,
  };
}

/**
 * Web 脱敏/完整视图（无密钥）
 * @param {object} cfg
 * @param {{ apps?: object[] }} [extra]
 */
function getPublicSettings(cfg, extra = {}) {
  const dataDir = cfg.dataDir || '';
  const file = readSettingsFile(dataDir);
  const fileOn = hasFile(dataDir);
  // 运行时合并视图：交给 soft-audit.getSoftConfig 算最终值
  let runtime = null;
  try {
    // eslint-disable-next-line global-require
    runtime = require('./soft-audit').getSoftConfig(cfg);
  } catch {
    runtime = null;
  }

  const apps = Array.isArray(extra.apps) ? extra.apps : [];
  const allowSet = new Set(file.robotUuidAllowlist || []);
  // 按 robotUuid 去重（防御：上游列表偶发重复）
  const seenChoice = new Set();
  const appChoices = [];
  for (const a of apps) {
    const id = String((a && (a.robotUuid || a.id)) || '').trim();
    if (!id || seenChoice.has(id)) continue;
    seenChoice.add(id);
    appChoices.push({
      robotUuid: id,
      name: (a && (a.name || a.robotName)) || id,
      selected: allowSet.has(id),
    });
  }
  appChoices.sort((x, y) =>
    String(x.name || '').localeCompare(String(y.name || ''), 'zh'),
  );

  return {
    ok: true,
    productName: PRODUCT_NAME,
    productHint:
      '对「任务状态成功」的运行记录抽查末尾日志。若日志里仍有错误（常见于流程里 try-catch 吞掉），会记为问题供排查。可限定只抽检部分应用以控制接口次数。',
    enabled: runtime ? runtime.enabled : file.enabled,
    maxPerPoll: runtime ? runtime.maxPerPoll : file.maxPerPoll,
    maxPerAppPerPoll: runtime ? runtime.maxPerAppPerPoll : file.maxPerAppPerPoll,
    tailSize: runtime ? runtime.tailSize : file.tailSize,
    sort: runtime ? runtime.sort : file.sort,
    minIntervalMs: runtime ? runtime.minIntervalMs : file.minIntervalMs,
    retainDays: runtime ? runtime.retainDays : file.retainDays,
    robotUuidAllowlist: runtime ? runtime.robotUuidAllowlist : file.robotUuidAllowlist,
    robotUuidPriority: runtime ? runtime.robotUuidPriority : file.robotUuidPriority,
    allowlistMode: (runtime ? runtime.robotUuidAllowlist : file.robotUuidAllowlist).length > 0,
    appChoices,
    source: fileOn ? 'settings.success-check.json' : 'default+config',
    hasFile: fileOn,
    updatedAt: file.updatedAt || null,
    settingsEnabled: true,
    envLocked: {
      enabled: process.env.SOFT_FAIL != null && String(process.env.SOFT_FAIL).trim() !== '',
      maxPerPoll:
        process.env.SOFT_FAIL_MAX_PER_POLL != null &&
        String(process.env.SOFT_FAIL_MAX_PER_POLL).trim() !== '',
    },
  };
}

/**
 * @param {string} dataDir
 * @param {object} body
 * @param {{ settingsEnabled?: boolean }} [opts]
 */
function saveSettings(dataDir, body = {}, opts = {}) {
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
  if (body.maxPerPoll !== undefined) {
    next.maxPerPoll = clampInt(body.maxPerPoll, prev.maxPerPoll, 0, 200);
  }
  if (body.maxPerAppPerPoll !== undefined) {
    next.maxPerAppPerPoll = clampInt(body.maxPerAppPerPoll, prev.maxPerAppPerPoll, 0, 50);
  }
  if (body.tailSize !== undefined) {
    next.tailSize = clampInt(body.tailSize, prev.tailSize, 1, 50);
  }
  if (body.sort !== undefined && String(body.sort).trim() !== '') {
    next.sort = String(body.sort).trim();
  }
  if (body.minIntervalMs !== undefined) {
    next.minIntervalMs = clampInt(body.minIntervalMs, prev.minIntervalMs, 0, 5000);
  }
  if (body.retainDays !== undefined) {
    next.retainDays = clampInt(body.retainDays, prev.retainDays, 1, 90);
  }
  if (body.robotUuidAllowlist !== undefined || body.allowlistText !== undefined) {
    next.robotUuidAllowlist = normalizeUuidList(
      body.robotUuidAllowlist !== undefined ? body.robotUuidAllowlist : body.allowlistText,
    );
  }
  if (body.clearAllowlist === true) {
    next.robotUuidAllowlist = [];
  }
  if (body.robotUuidPriority !== undefined || body.priorityText !== undefined) {
    next.robotUuidPriority = normalizeUuidList(
      body.robotUuidPriority !== undefined ? body.robotUuidPriority : body.priorityText,
    );
  }

  const written = writeSettingsFile(dataDir, next);
  return {
    ok: true,
    saved: true,
    updatedAt: written.updatedAt,
  };
}

module.exports = {
  SETTINGS_FILE,
  PRODUCT_NAME,
  settingsPath,
  emptySettings,
  readSettingsFile,
  writeSettingsFile,
  invalidateCache,
  hasFile,
  getFileOverlay,
  getPublicSettings,
  saveSettings,
  normalizeUuidList,
};
