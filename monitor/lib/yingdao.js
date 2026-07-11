/**
 * 影刀 OpenAPI 客户端（Agent 感知 tool 底座）
 *
 * 导出形状对齐 TECH-DESIGN §5.2：
 *   getToken / listJobs / searchLogs
 *
 * list_jobs 仅供 poll / 调度；diagnose 主 loop 不使用 list_jobs。
 */

const BASE = 'https://api.yingdao.com/oapi';

/** @type {{ token: string|null, expiresAt: number, key: string }} */
const tokenCache = {
  token: null,
  expiresAt: 0,
  key: '',
};

async function http(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

/**
 * 从未知结构的响应里尽量抠出日志条目数组
 * @param {any} body
 * @returns {any[]}
 */
function extractLogList(body) {
  const d = body && body.data;
  if (Array.isArray(d)) return d;
  if (Array.isArray(d && d.logs)) return d.logs;
  if (Array.isArray(d && d.dataList)) return d.dataList;
  if (Array.isArray(d && d.list)) return d.list;
  if (Array.isArray(d && d.records)) return d.records;
  if (Array.isArray(d && d.rows)) return d.rows;
  // 部分响应 logs 嵌在 data 其它层
  if (d && d.page && Array.isArray(d.logs)) return d.logs;
  return [];
}


/**
 * @param {{ accessKeyId: string, accessKeySecret: string, forceRefresh?: boolean }} opts
 * @returns {Promise<string>}
 */
async function getToken({ accessKeyId, accessKeySecret, forceRefresh = false } = {}) {
  if (!accessKeyId || !accessKeySecret) {
    throw new Error('getToken 需要 accessKeyId / accessKeySecret');
  }

  const cacheKey = `${accessKeyId}:${accessKeySecret}`;
  const now = Date.now();
  if (
    !forceRefresh &&
    tokenCache.token &&
    tokenCache.key === cacheKey &&
    tokenCache.expiresAt > now + 60_000
  ) {
    return tokenCache.token;
  }

  const url =
    `${BASE}/token/v2/token/create` +
    `?accessKeyId=${encodeURIComponent(accessKeyId)}` +
    `&accessKeySecret=${encodeURIComponent(accessKeySecret)}`;

  const { status, body } = await http(url);
  if (!body || !body.success) {
    throw new Error(`鉴权失败 (HTTP ${status}): ${JSON.stringify(body)}`);
  }

  const token = body.data && body.data.accessToken;
  if (!token) {
    throw new Error(`鉴权响应缺少 accessToken: ${JSON.stringify(body)}`);
  }

  // 影刀 token 最长 2h；响应可能带 expiresIn（秒）
  const expiresInSec = Number(body.data.expiresIn) || 7200;
  tokenCache.token = token;
  tokenCache.key = cacheKey;
  tokenCache.expiresAt = now + expiresInSec * 1000;

  return token;
}

/**
 * @param {string} token
 * @param {{
 *   robotClientUuid?: string,
 *   statusList?: string[],
 *   cursorId?: string,
 *   size?: number,
 *   cursorDirection?: 'next'|'pre',
 *   triggerTimeBegin?: string,
 *   triggerTimeEnd?: string,
 * }} [opts]
 * @returns {Promise<{
 *   dataList: any[],
 *   nextId: string|null,
 *   preId: string|null,
 *   hasData: boolean,
 *   status: number,
 *   body: any,
 *   payload: object,
 * }>}
 */
async function listJobs(token, opts = {}) {
  const {
    robotClientUuid,
    statusList,
    cursorId,
    size = 50,
    cursorDirection = 'next',
    triggerTimeBegin,
    triggerTimeEnd,
  } = opts;

  const payload = {
    cursorDirection,
    size,
  };
  if (robotClientUuid) payload.robotClientUuid = robotClientUuid;
  if (statusList && statusList.length) payload.statusList = statusList;
  if (cursorId) payload.cursorId = cursorId;
  if (triggerTimeBegin) payload.triggerTimeBegin = triggerTimeBegin;
  if (triggerTimeEnd) payload.triggerTimeEnd = triggerTimeEnd;

  const { status, body } = await http(`${BASE}/dispatch/v2/job/list`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });

  const data = (body && body.data) || {};
  const dataList = Array.isArray(data.dataList) ? data.dataList : [];
  const hasData = data.hasData === true || dataList.length > 0;

  return {
    dataList,
    nextId: data.nextId ?? null,
    preId: data.preId ?? null,
    hasData,
    status,
    body,
    payload,
  };
}

/**
 * @param {string} token
 * @param {string} jobUuid
 * @param {{ page?: number, size?: number, searchKey?: string, sort?: string }} [opts]
 * @returns {Promise<{
 *   logs: any[],
 *   page: number,
 *   status: number,
 *   body: any,
 *   payload: object,
 * }>}
 */
async function searchLogs(token, jobUuid, opts = {}) {
  if (!jobUuid) throw new Error('searchLogs 需要 jobUuid');

  const page = opts.page ?? 1;
  const size = opts.size ?? 100;
  const payload = { jobUuid, page, size };

  if (opts.searchKey || opts.sort) {
    payload.queryFilter = {};
    if (opts.searchKey) payload.queryFilter.searchKey = opts.searchKey;
    if (opts.sort) payload.queryFilter.sort = opts.sort;
  }

  const { status, body } = await http(`${BASE}/dispatch/v2/job/log/search`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });

  return {
    logs: extractLogList(body),
    page,
    status,
    body,
    payload,
  };
}

/** 测试或进程结束时清空缓存 */
function clearTokenCache() {
  tokenCache.token = null;
  tokenCache.expiresAt = 0;
  tokenCache.key = '';
}

module.exports = {
  BASE,
  getToken,
  listJobs,
  searchLogs,
  extractLogList,
  clearTokenCache,
};
