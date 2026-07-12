/**
 * Agent HTTP 入口：health + workbench API + 静态页
 * 业务在 workbench / tools；本文件只绑端口与转发。
 */

const http = require('http');
const { handleRequest } = require('./routes');
const { getWorkbenchConfig } = require('../workbench');

/**
 * @param {object} cfg
 * @param {object} state runtime state (startedAt, lastPollAt, ...)
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {import('http').Server | null}
 */
function startHttpServer(cfg, state, opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const port = parseInt(String(cfg.healthPort || 0), 10) || 0;
  if (!port) {
    log('http disabled (healthPort=0)');
    return null;
  }

  const wb = getWorkbenchConfig(cfg);
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { cfg, state }).catch((e) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(`${JSON.stringify({ ok: false, code: 'internal_error', message: e.message })}\n`);
      } catch {
        // ignore
      }
    });
  });

  server.listen(port, '127.0.0.1', () => {
    log(`health listening on http://127.0.0.1:${port}/health`);
    if (wb.enabled) {
      log(`workbench listening on http://127.0.0.1:${port}/`);
    } else {
      log('workbench disabled (workbench.enabled=false)');
    }
  });

  return server;
}

module.exports = {
  startHttpServer,
};
