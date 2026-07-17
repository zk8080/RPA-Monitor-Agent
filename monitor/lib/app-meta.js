/**
 * 应用业务标签 + 优先池标签配置（本机 data/app-meta.json）
 *
 * - tags：应用业务标签（PV / 招募 / 财务 …）
 * - priorityTags：进入「优先处理」池的标签；空 = 全部应用
 * - priorityScope：all | tags（有 priorityTags 时为 tags；兼容旧 watched）
 */

const fs = require('fs');
const path = require('path');

const META_FILE = 'app-meta.json';
const MAX_TAGS_PER_APP = 12;
const MAX_PRIORITY_TAGS = 24;
const MAX_TAG_LEN = 32;
const MAX_APPS = 2000;

/** 常用业务标签建议（可自由添加其它） */
const SUGGESTED_TAGS = Object.freeze(['PV', '招募', '财务', '运营', '测试', '核心']);

/** @type {{ at: number, mtimeMs: number, data: object|null, dataDir: string }|null} */
let cache = null;
const CACHE_MS = 1500;

function metaPath(dataDir) {
  return path.join(dataDir, META_FILE);
}

function emptyStore() {
  return {
    version: 2,
    updatedAt: null,
    /** @type {'all'|'tags'} */
    priorityScope: 'all',
    /** @type {string[]} 优先池包含的业务标签；非空时仅这些标签的应用入池 */
    priorityTags: [],
    byRobot: {},
  };
}

/**
 * @param {unknown} raw
 * @param {number} [max]
 * @returns {string[]}
 */
function normalizeTags(raw, max = MAX_TAGS_PER_APP) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (out.length >= max) break;
    const s = String(t == null ? '' : t)
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, MAX_TAG_LEN);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * @param {unknown} scope
 * @param {string[]} [priorityTags]
 * @returns {'all'|'tags'}
 */
function normalizePriorityScope(scope, priorityTags) {
  const s = String(scope || '')
    .trim()
    .toLowerCase();
  // 旧版 watched → 视为 tags 模式（需用户改配 priorityTags；空则仍 all）
  if (s === 'tags' || s === 'watched') {
    if (Array.isArray(priorityTags) && priorityTags.length > 0) return 'tags';
    if (s === 'tags') return 'tags';
    return 'all';
  }
  if (Array.isArray(priorityTags) && priorityTags.length > 0 && s !== 'all') {
    return 'tags';
  }
  // 有配置优先标签时默认走 tags
  if (Array.isArray(priorityTags) && priorityTags.length > 0 && (s === '' || s === 'tags')) {
    return 'tags';
  }
  if (Array.isArray(priorityTags) && priorityTags.length > 0 && s === 'all') {
    return 'all'; // 用户显式选全部时保留 all，但 UI 一般清空标签
  }
  return 'all';
}

/**
 * 有效优先范围：priorityTags 非空 → tags，否则 all
 * （简化心智：勾了标签就按标签池，没勾 = 全部）
 * @param {object} store
 * @returns {'all'|'tags'}
 */
function effectivePriorityScope(store) {
  const tags = (store && store.priorityTags) || [];
  if (tags.length > 0) return 'tags';
  return 'all';
}

/**
 * @param {unknown} raw
 */
function normalizeRobotEntry(raw) {
  if (!raw || typeof raw !== 'object') {
    return { tags: [], updatedAt: null };
  }
  return {
    tags: normalizeTags(raw.tags),
    // 兼容旧 watched 字段（列表可忽略；不再驱动优先池）
    watched: raw.watched === true,
    updatedAt: raw.updatedAt || null,
  };
}

/**
 * @param {unknown} raw
 */
function normalizeStore(raw) {
  if (!raw || typeof raw !== 'object') return emptyStore();
  const byRobot = {};
  const src = raw.byRobot && typeof raw.byRobot === 'object' ? raw.byRobot : {};
  let n = 0;
  for (const [uuid, ent] of Object.entries(src)) {
    if (n >= MAX_APPS) break;
    const id = String(uuid || '').trim();
    if (!id) continue;
    byRobot[id] = normalizeRobotEntry(ent);
    n += 1;
  }
  const priorityTags = normalizeTags(raw.priorityTags, MAX_PRIORITY_TAGS);
  // 迁移：旧 priorityScope=watched 且无 priorityTags → 保持 all（需用户自选业务标签）
  let priorityScope = normalizePriorityScope(raw.priorityScope, priorityTags);
  if (priorityTags.length > 0) priorityScope = 'tags';
  else priorityScope = 'all';

  return {
    version: 2,
    updatedAt: raw.updatedAt || null,
    priorityScope,
    priorityTags,
    byRobot,
  };
}

/**
 * @param {string} dataDir
 * @param {{ force?: boolean }} [opts]
 */
function loadStore(dataDir, opts = {}) {
  if (!dataDir) return emptyStore();
  const file = metaPath(dataDir);
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
      return normalizeStore(cache.data);
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const data = normalizeStore(raw);
    cache = { at: now, mtimeMs: st.mtimeMs, data, dataDir };
    return data;
  } catch {
    const empty = emptyStore();
    cache = { at: now, mtimeMs: 0, data: empty, dataDir };
    return empty;
  }
}

/**
 * @param {string} dataDir
 * @param {object} store
 */
function saveStore(dataDir, store) {
  if (!dataDir) throw new Error('dataDir required');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = metaPath(dataDir);
  const next = normalizeStore(store);
  next.updatedAt = new Date().toISOString();
  next.version = 2;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  cache = { at: Date.now(), mtimeMs: fs.statSync(file).mtimeMs, data: next, dataDir };
  return next;
}

/**
 * 应用是否命中优先池（priorityTags 与 app.tags 有交集）
 * @param {string[]} appTags
 * @param {string[]} priorityTags
 */
function appMatchesPriorityTags(appTags, priorityTags) {
  const want = normalizeTags(priorityTags, MAX_PRIORITY_TAGS);
  if (!want.length) return true; // 未配置 = 不限制
  const have = new Set(
    normalizeTags(appTags).map((t) => t.toLowerCase()),
  );
  return want.some((t) => have.has(t.toLowerCase()));
}

/**
 * @param {string} dataDir
 * @param {string} robotUuid
 */
function getRobotMeta(dataDir, robotUuid) {
  const id = String(robotUuid || '').trim();
  const store = loadStore(dataDir);
  if (!id) {
    return {
      robotUuid: '',
      tags: [],
      updatedAt: null,
      priorityScope: effectivePriorityScope(store),
      priorityTags: store.priorityTags.slice(),
    };
  }
  const ent = store.byRobot[id] || normalizeRobotEntry(null);
  return {
    robotUuid: id,
    tags: ent.tags.slice(),
    watched: ent.watched === true,
    updatedAt: ent.updatedAt,
    priorityScope: effectivePriorityScope(store),
    priorityTags: store.priorityTags.slice(),
  };
}

/**
 * 合并更新单个应用的 tags
 * @param {string} dataDir
 * @param {string} robotUuid
 * @param {{ tags?: string[], addTags?: string[], removeTags?: string[], watched?: boolean }} patch
 */
function updateRobotMeta(dataDir, robotUuid, patch = {}) {
  const id = String(robotUuid || '').trim();
  if (!id) {
    return { ok: false, code: 'missing_robot', message: '缺少 robotUuid' };
  }
  const store = loadStore(dataDir, { force: true });
  const prev = store.byRobot[id] || normalizeRobotEntry(null);
  let tags = prev.tags.slice();
  let watched = prev.watched === true;

  if (typeof patch.watched === 'boolean') {
    watched = patch.watched;
  }

  if (Array.isArray(patch.tags)) {
    tags = normalizeTags(patch.tags);
  } else {
    if (Array.isArray(patch.addTags)) {
      tags = normalizeTags(tags.concat(patch.addTags));
    }
    if (Array.isArray(patch.removeTags) && patch.removeTags.length) {
      const remove = new Set(
        patch.removeTags.map((t) =>
          String(t || '')
            .trim()
            .toLowerCase(),
        ),
      );
      tags = tags.filter((t) => !remove.has(t.toLowerCase()));
    }
  }

  const now = new Date().toISOString();
  if (!watched && !tags.length) {
    delete store.byRobot[id];
  } else {
    store.byRobot[id] = {
      tags,
      watched,
      updatedAt: now,
    };
  }
  const saved = saveStore(dataDir, store);
  const ent = saved.byRobot[id] || { tags: [], watched: false, updatedAt: now };
  return {
    ok: true,
    robotUuid: id,
    tags: (ent.tags || []).slice(),
    watched: ent.watched === true,
    updatedAt: ent.updatedAt || now,
    priorityScope: effectivePriorityScope(saved),
    priorityTags: saved.priorityTags.slice(),
  };
}

/**
 * 设置优先池业务标签（空数组 = 全部应用）
 * @param {string} dataDir
 * @param {string[]|unknown} tags
 */
function setPriorityTags(dataDir, tags) {
  const store = loadStore(dataDir, { force: true });
  store.priorityTags = normalizeTags(tags, MAX_PRIORITY_TAGS);
  store.priorityScope = store.priorityTags.length ? 'tags' : 'all';
  const saved = saveStore(dataDir, store);
  return {
    ok: true,
    priorityScope: effectivePriorityScope(saved),
    priorityTags: saved.priorityTags.slice(),
    tagCatalog: listTagCatalog(saved),
    suggestedTags: SUGGESTED_TAGS.slice(),
  };
}

/**
 * @param {string} dataDir
 * @param {'all'|'tags'|'watched'|string} scope
 * @param {string[]} [priorityTags] 切到 tags 时可一并写入
 */
function setPriorityScope(dataDir, scope, priorityTags) {
  const store = loadStore(dataDir, { force: true });
  if (Array.isArray(priorityTags)) {
    store.priorityTags = normalizeTags(priorityTags, MAX_PRIORITY_TAGS);
  }
  const s = String(scope || '')
    .trim()
    .toLowerCase();
  if (s === 'all') {
    // 显式全部：清空优先标签
    store.priorityTags = [];
    store.priorityScope = 'all';
  } else if (s === 'tags' || s === 'watched') {
    store.priorityScope = store.priorityTags.length ? 'tags' : 'all';
  }
  const saved = saveStore(dataDir, store);
  return {
    ok: true,
    priorityScope: effectivePriorityScope(saved),
    priorityTags: saved.priorityTags.slice(),
    tagCatalog: listTagCatalog(saved),
    suggestedTags: SUGGESTED_TAGS.slice(),
  };
}

/**
 * robotUuid → 是否应进入优先池
 * @param {string} dataDir
 * @returns {(robotUuid: string) => boolean}
 */
function makePriorityRobotFilter(dataDir) {
  const store = loadStore(dataDir);
  const scope = effectivePriorityScope(store);
  if (scope !== 'tags') {
    return () => true;
  }
  const want = store.priorityTags;
  const map = store.byRobot || {};
  return (robotUuid) => {
    const id = String(robotUuid || '').trim();
    if (!id) return false;
    const ent = map[id];
    const tags = (ent && ent.tags) || [];
    return appMatchesPriorityTags(tags, want);
  };
}

/**
 * @param {string} dataDir
 * @returns {Set<string>} 命中优先池的 robotUuid
 */
function priorityRobotSet(dataDir) {
  const store = loadStore(dataDir);
  const set = new Set();
  if (effectivePriorityScope(store) !== 'tags') {
    // all：不预计算全集
    return set;
  }
  for (const [id, ent] of Object.entries(store.byRobot || {})) {
    if (appMatchesPriorityTags((ent && ent.tags) || [], store.priorityTags)) {
      set.add(id);
    }
  }
  return set;
}

/**
 * @param {object} store
 * @returns {string[]}
 */
function listTagCatalog(store) {
  const seen = new Set();
  const out = [];
  const push = (t) => {
    const s = String(t || '').trim();
    if (!s) return;
    const key = s.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  for (const t of SUGGESTED_TAGS) push(t);
  for (const t of (store && store.priorityTags) || []) push(t);
  for (const ent of Object.values((store && store.byRobot) || {})) {
    for (const t of (ent && ent.tags) || []) push(t);
  }
  out.sort((a, b) => String(a).localeCompare(String(b), 'zh'));
  return out;
}

/**
 * @param {string} dataDir
 * @returns {Map<string, { tags: string[], watched: boolean }>}
 */
function robotMetaMap(dataDir) {
  const store = loadStore(dataDir);
  const map = new Map();
  for (const [id, ent] of Object.entries(store.byRobot || {})) {
    map.set(id, {
      tags: (ent.tags || []).slice(),
      watched: ent.watched === true,
    });
  }
  return map;
}

/**
 * @param {string} dataDir
 */
function getSummary(dataDir) {
  const store = loadStore(dataDir);
  const scope = effectivePriorityScope(store);
  let matchedAppCount = 0;
  if (scope === 'tags') {
    for (const ent of Object.values(store.byRobot || {})) {
      if (appMatchesPriorityTags((ent && ent.tags) || [], store.priorityTags)) {
        matchedAppCount += 1;
      }
    }
  }
  return {
    priorityScope: scope,
    priorityTags: store.priorityTags.slice(),
    matchedAppCount,
    taggedAppCount: Object.keys(store.byRobot || {}).length,
    tagCatalog: listTagCatalog(store),
    suggestedTags: SUGGESTED_TAGS.slice(),
    updatedAt: store.updatedAt,
  };
}

// 兼容旧名
function watchedRobotSet(dataDir) {
  return priorityRobotSet(dataDir);
}

function countWatched(store) {
  let n = 0;
  for (const ent of Object.values((store && store.byRobot) || {})) {
    if (ent && ent.watched) n += 1;
  }
  return n;
}

module.exports = {
  META_FILE,
  MAX_TAGS_PER_APP,
  MAX_PRIORITY_TAGS,
  SUGGESTED_TAGS,
  loadStore,
  saveStore,
  getRobotMeta,
  updateRobotMeta,
  setPriorityTags,
  setPriorityScope,
  normalizePriorityScope,
  normalizeTags,
  effectivePriorityScope,
  appMatchesPriorityTags,
  makePriorityRobotFilter,
  priorityRobotSet,
  watchedRobotSet,
  robotMetaMap,
  getSummary,
  countWatched,
  listTagCatalog,
};
