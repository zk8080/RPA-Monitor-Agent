/**
 * 本机开发者工作台：聚合 overview / apps / understand（无 HTTP 细节）
 */

const memory = require('./memory');
const rpa = require('./rpa');
const understandCache = require('./understand-cache');
const openPath = require('./http/open-path');

/** @type {{ at: number, apps: object, queueStats: Map } | null} */
let memCache = null;
const MEM_TTL_MS = 45 * 1000;

function getWorkbenchConfig(cfg = {}) {
  const w = cfg.workbench && typeof cfg.workbench === 'object' ? cfg.workbench : {};
  return {
    enabled: w.enabled !== false,
    openFolderEnabled: w.openFolderEnabled !== false,
    understandCache: w.understandCache !== false,
    openCommand: w.openCommand || null,
  };
}

/**
 * queue → 按 robotUuid 聚合
 * @param {object[]} items
 * @returns {Map<string, { robotUuid, robotName, failureCount, undiagnosedCount, lastSeen, items }>}
 */
function aggregateFailuresByRobot(items) {
  const map = new Map();
  for (const it of items || []) {
    const id = it.robotUuid || 'unknown';
    let row = map.get(id);
    if (!row) {
      row = {
        robotUuid: id,
        robotName: it.robotName || '',
        failureCount: 0,
        undiagnosedCount: 0,
        lastSeen: null,
        items: [],
      };
      map.set(id, row);
    }
    row.failureCount += 1;
    if (!it.diagnosed) row.undiagnosedCount += 1;
    if (!row.robotName && it.robotName) row.robotName = it.robotName;
    if (!row.lastSeen || String(it.lastSeen || '') > String(row.lastSeen || '')) {
      row.lastSeen = it.lastSeen || null;
    }
    row.items.push(it);
  }
  return map;
}

function listQueueSorted(dataDir) {
  const items = memory.listQueueItems(dataDir);
  items.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  return items;
}

function getAppsBundle(cfg, { force = false } = {}) {
  const now = Date.now();
  if (!force && memCache && now - memCache.at < MEM_TTL_MS) {
    return memCache;
  }
  const scan = rpa.scanLocalApps(cfg);
  const queueItems = listQueueSorted(cfg.dataDir);
  const queueStats = aggregateFailuresByRobot(queueItems);
  memCache = { at: now, scan, queueItems, queueStats };
  return memCache;
}

function invalidateAppsCache() {
  memCache = null;
}

/**
 * @param {object} cfg
 * @param {{ startedAt?: number, lastPollAt?: string|null, lastDiagnoseAt?: string|null, lastReportAt?: string|null }} state
 */
function buildOverview(cfg, state = {}) {
  const bundle = getAppsBundle(cfg);
  const { scan, queueItems, queueStats } = bundle;
  const undiagnosed = queueItems.filter((q) => !q.diagnosed).length;

  const problemApps = [...queueStats.values()]
    .filter((r) => r.robotUuid && r.robotUuid !== 'unknown')
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .slice(0, 10)
    .map((r) => ({
      robotUuid: r.robotUuid,
      robotName: r.robotName,
      failureCount: r.failureCount,
      undiagnosedCount: r.undiagnosedCount,
      lastSeen: r.lastSeen,
    }));

  const startedAt = state.startedAt || Date.now();

  return {
    ok: true,
    runtime: {
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      lastPollAt: state.lastPollAt || null,
      lastDiagnoseAt: state.lastDiagnoseAt || null,
      lastReportAt: state.lastReportAt || null,
      pid: process.pid,
      dataDir: cfg.dataDir,
    },
    localApps: {
      count: scan.apps.length,
      usersRoot: scan.usersRoot,
      userCount: scan.userCount,
    },
    queue: {
      depth: queueItems.length,
      undiagnosed,
    },
    problemApps,
  };
}

function listAppsWithStats(cfg) {
  const bundle = getAppsBundle(cfg);
  const { scan, queueStats } = bundle;

  const apps = scan.apps.map((a) => {
    const st = queueStats.get(a.robotUuid);
    return {
      robotUuid: a.robotUuid,
      name: a.name || (st && st.robotName) || a.robotUuid,
      userId: a.userId,
      xbotDir: a.xbotDir,
      failureCount: st ? st.failureCount : 0,
      undiagnosedCount: st ? st.undiagnosedCount : 0,
      lastFailureAt: st ? st.lastSeen : null,
    };
  });

  apps.sort((a, b) => {
    if (b.failureCount !== a.failureCount) return b.failureCount - a.failureCount;
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
  });

  return {
    ok: true,
    usersRoot: scan.usersRoot,
    userCount: scan.userCount,
    count: apps.length,
    apps,
  };
}

/**
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ failureLimit?: number }} [opts]
 */
function getAppDetail(robotUuid, cfg, opts = {}) {
  if (!robotUuid) {
    return { ok: false, code: 'missing_robotUuid', message: '缺少 robotUuid' };
  }

  const resolved = rpa.resolveXbotDir(robotUuid, { cfg });
  const bundle = getAppsBundle(cfg);
  const local = bundle.scan.apps.find((a) => a.robotUuid === robotUuid) || null;
  const st = bundle.queueStats.get(robotUuid);

  const limit = opts.failureLimit || 20;
  const failures = (st ? st.items : [])
    .slice()
    .sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
    .slice(0, limit)
    .map((it) => ({
      fingerprint: it.fingerprint,
      flowName: it.flowName,
      errorType: it.errorType,
      elementName: it.elementName,
      rawRemark: it.rawRemark,
      diagnosed: !!it.diagnosed,
      occurrenceCount: it.occurrenceCount,
      lastSeen: it.lastSeen,
      firstSeen: it.firstSeen,
      kbId: it.kbId || null,
    }));

  return {
    ok: true,
    robotUuid,
    name: (local && local.name) || resolved.name || (st && st.robotName) || robotUuid,
    userId: (local && local.userId) || null,
    xbotDir: resolved.xbotDir || (local && local.xbotDir) || null,
    resolve: {
      mapped: !!resolved.mapped,
      source: resolved.source || null,
      reason: resolved.reason || null,
    },
    failureCount: st ? st.failureCount : 0,
    undiagnosedCount: st ? st.undiagnosedCount : 0,
    lastFailureAt: st ? st.lastSeen : null,
    failures,
  };
}

/**
 * @param {string} robotUuid
 * @param {object} cfg
 * @param {{ flowName?: string, skipCache?: boolean }} [opts]
 */
function getAppUnderstand(robotUuid, cfg, opts = {}) {
  const wb = getWorkbenchConfig(cfg);
  const detail = getAppDetail(robotUuid, cfg);
  if (!detail.ok) return detail;

  const xbotDir = detail.xbotDir;
  if (!xbotDir) {
    return {
      ok: false,
      code: 'xbotDir_missing',
      message: detail.resolve.reason || '本机未找到流程目录',
      robotUuid,
    };
  }

  const flowName = opts.flowName || '';

  if (wb.understandCache && !opts.skipCache) {
    const cached = understandCache.readCache(cfg.dataDir, xbotDir, flowName);
    if (cached.hit && cached.payload && cached.payload.result) {
      return {
        ok: true,
        robotUuid,
        xbotDir,
        cached: true,
        cacheKey: cached.key,
        result: cached.payload.result,
      };
    }
  }

  let result;
  try {
    result = rpa.understandFlow(xbotDir, flowName, { cfg });
  } catch (e) {
    const msg = e.message || String(e);
    const code = /rpa-skill|不存在/.test(msg) ? 'rpa_skill_missing' : 'understand_error';
    return { ok: false, code, message: msg, robotUuid, xbotDir };
  }

  let cacheKey = null;
  if (wb.understandCache && result && result.ok) {
    cacheKey = understandCache.makeCacheKey(xbotDir, flowName);
    try {
      understandCache.writeCache(cfg.dataDir, cacheKey, result);
    } catch {
      // 缓存失败不阻塞
    }
  }

  return {
    ok: true,
    robotUuid,
    xbotDir,
    cached: false,
    cacheKey,
    result,
  };
}

/**
 * @param {string} robotUuid
 * @param {object} cfg
 */
function openAppFolder(robotUuid, cfg) {
  const wb = getWorkbenchConfig(cfg);
  return openPath.openRobotFolder(robotUuid, {
    cfg,
    enabled: wb.openFolderEnabled,
    openCommand: wb.openCommand,
  });
}

/**
 * health JSON（兼容原 /health）
 */
function buildHealth(cfg, state = {}) {
  const queue = memory.listQueueItems(cfg.dataDir);
  const startedAt = state.startedAt || Date.now();
  return {
    ok: true,
    service: 'rpa-monitor-agent',
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    lastPollAt: state.lastPollAt || null,
    lastDiagnoseAt: state.lastDiagnoseAt || null,
    lastReportAt: state.lastReportAt || null,
    queueDepth: queue.length,
    undiagnosed: queue.filter((q) => !q.diagnosed).length,
    pid: process.pid,
    dataDir: cfg.dataDir,
    workbench: getWorkbenchConfig(cfg).enabled,
  };
}

module.exports = {
  getWorkbenchConfig,
  aggregateFailuresByRobot,
  buildOverview,
  listAppsWithStats,
  getAppDetail,
  getAppUnderstand,
  openAppFolder,
  buildHealth,
  invalidateAppsCache,
  getAppsBundle,
};
