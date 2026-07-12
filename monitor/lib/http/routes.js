/**
 * Workbench HTTP 路由（薄：解析请求 → workbench/lib）
 */

const fs = require('fs');
const path = require('path');
const workbench = require('../workbench');

const WEB_ROOT = path.resolve(__dirname, '../../web');

function sendJson(res, status, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(text);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safeJoinWeb(urlPath) {
  const rel = urlPath.replace(/^\/+/, '').replace(/\?.*$/, '');
  const candidate = path.normalize(path.join(WEB_ROOT, rel || 'index.html'));
  if (!candidate.startsWith(WEB_ROOT)) return null;
  return candidate;
}

function serveStatic(reqPath, res) {
  let filePath = safeJoinWeb(reqPath === '/' ? 'index.html' : reqPath);
  if (!filePath) {
    sendText(res, 403, 'forbidden');
    return true;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    // SPA fallback：未知路径回 index（hash 路由本不需要，兼容直链）
    filePath = path.join(WEB_ROOT, 'index.html');
    if (!fs.existsSync(filePath)) {
      sendText(res, 404, 'workbench ui missing: monitor/web/index.html');
      return true;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  try {
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, { 'content-type': type, 'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=60' });
    res.end(buf);
  } catch (e) {
    sendText(res, 500, e.message);
  }
  return true;
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ cfg: object, state: object }} ctx
 * @returns {Promise<boolean>} handled
 */
async function handleRequest(req, res, ctx) {
  const cfg = ctx.cfg;
  const state = ctx.state || {};
  const wb = workbench.getWorkbenchConfig(cfg);

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const method = (req.method || 'GET').toUpperCase();

  // health 始终可用
  if (method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
    sendJson(res, 200, workbench.buildHealth(cfg, state));
    return true;
  }

  // workbench 关闭时：仅 health；/ 兼容返回 health JSON（旧行为）
  if (!wb.enabled) {
    if (method === 'GET' && pathname === '/') {
      sendJson(res, 200, workbench.buildHealth(cfg, state));
      return true;
    }
    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, code: 'workbench_disabled', message: 'workbench.enabled=false' });
      return true;
    }
    sendText(res, 404, 'not found');
    return true;
  }

  // API
  if (pathname.startsWith('/api/')) {
    try {
      if (method === 'GET' && pathname === '/api/overview') {
        sendJson(res, 200, workbench.buildOverview(cfg, state));
        return true;
      }

      if (method === 'GET' && pathname === '/api/apps') {
        sendJson(res, 200, workbench.listAppsWithStats(cfg));
        return true;
      }

      const appUnderstand = pathname.match(/^\/api\/apps\/([^/]+)\/understand\/?$/);
      if (method === 'GET' && appUnderstand) {
        const robotUuid = decodeURIComponent(appUnderstand[1]);
        const flowName = url.searchParams.get('flowName') || '';
        const skipCache = url.searchParams.get('refresh') === '1';
        const result = workbench.getAppUnderstand(robotUuid, cfg, { flowName, skipCache });
        sendJson(res, result.ok ? 200 : 404, result);
        return true;
      }

      const appOpen = pathname.match(/^\/api\/apps\/([^/]+)\/open-folder\/?$/);
      if (method === 'POST' && appOpen) {
        const robotUuid = decodeURIComponent(appOpen[1]);
        // body 可选忽略
        try {
          await readBody(req);
        } catch {
          // ignore
        }
        const result = workbench.openAppFolder(robotUuid, cfg);
        sendJson(res, result.ok ? 200 : result.code === 'disabled' ? 403 : 400, result);
        return true;
      }

      const appDetail = pathname.match(/^\/api\/apps\/([^/]+)\/?$/);
      if (method === 'GET' && appDetail) {
        const robotUuid = decodeURIComponent(appDetail[1]);
        const result = workbench.getAppDetail(robotUuid, cfg);
        sendJson(res, result.ok ? 200 : 404, result);
        return true;
      }

      sendJson(res, 404, { ok: false, code: 'not_found', message: `no route ${method} ${pathname}` });
      return true;
    } catch (e) {
      sendJson(res, 500, { ok: false, code: 'internal_error', message: e.message || String(e) });
      return true;
    }
  }

  // 静态资源
  if (method === 'GET' || method === 'HEAD') {
    return serveStatic(pathname, res);
  }

  sendText(res, 405, 'method not allowed');
  return true;
}

module.exports = {
  handleRequest,
  WEB_ROOT,
  sendJson,
};
