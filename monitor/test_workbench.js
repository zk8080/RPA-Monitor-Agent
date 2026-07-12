/**
 * 工作台聚合 / 路径校验 / HTTP 路由自检（不依赖影刀密钥）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { aggregateFailuresByRobot, buildOverview, listAppsWithStats, getAppDetail } = require('./lib/workbench');
const { assertOpenableDir } = require('./lib/http/open-path');
const { handleRequest } = require('./lib/http/routes');
const understandCache = require('./lib/understand-cache');

// --- aggregate ---
const agg = aggregateFailuresByRobot([
  {
    robotUuid: 'r1',
    robotName: 'AppA',
    diagnosed: false,
    lastSeen: '2026-07-12T10:00:00.000Z',
  },
  {
    robotUuid: 'r1',
    robotName: 'AppA',
    diagnosed: true,
    lastSeen: '2026-07-12T11:00:00.000Z',
  },
  {
    robotUuid: 'r2',
    robotName: 'AppB',
    diagnosed: false,
    lastSeen: '2026-07-12T09:00:00.000Z',
  },
]);
assert.strictEqual(agg.get('r1').failureCount, 2);
assert.strictEqual(agg.get('r1').undiagnosedCount, 1);
assert.strictEqual(agg.get('r1').lastSeen, '2026-07-12T11:00:00.000Z');
assert.strictEqual(agg.get('r2').failureCount, 1);

// --- open path guard ---
const bad = assertOpenableDir(path.join(os.tmpdir(), 'no-such-xbot-dir-xyz'));
assert.strictEqual(bad.ok, false);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-wb-'));
const xbot = path.join(tmp, 'xbot_robot');
fs.mkdirSync(xbot);
fs.writeFileSync(path.join(xbot, 'package.json'), JSON.stringify({ name: 'demo-app' }), 'utf8');
const good = assertOpenableDir(xbot);
assert.strictEqual(good.ok, true);

// --- understand cache key stable ---
const k1 = understandCache.makeCacheKey(xbot, '');
const k2 = understandCache.makeCacheKey(xbot, '');
assert.strictEqual(k1, k2);
understandCache.writeCache(tmp, k1, { ok: true, summary: 'hi' });
const hit = understandCache.readCache(tmp, xbot, '');
assert.strictEqual(hit.hit, true);
assert.strictEqual(hit.payload.result.summary, 'hi');

// --- overview with temp dataDir (no local apps required) ---
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(path.join(dataDir, 'queue'), { recursive: true });
fs.writeFileSync(
  path.join(dataDir, 'queue', 'fp1.json'),
  JSON.stringify({
    fingerprint: 'fp1',
    robotUuid: 'r-demo',
    robotName: 'Demo',
    diagnosed: false,
    lastSeen: '2026-07-12T12:00:00.000Z',
    occurrenceCount: 1,
  }),
  'utf8',
);

const cfg = {
  dataDir,
  workbench: { enabled: true, openFolderEnabled: true, understandCache: true },
  // 指向空 ShadowBot 根，避免扫到本机大量 apps 影响断言
  shadowbotUsersRoot: path.join(tmp, 'empty-sb'),
};
fs.mkdirSync(cfg.shadowbotUsersRoot, { recursive: true });

const overview = buildOverview(cfg, { startedAt: Date.now() - 5000, lastPollAt: '2026-07-12T12:00:00.000Z' });
assert.strictEqual(overview.ok, true);
assert.ok(overview.queue.depth >= 1);
assert.ok(overview.problemApps.some((p) => p.robotUuid === 'r-demo'));

const apps = listAppsWithStats(cfg);
assert.strictEqual(apps.ok, true);
assert.strictEqual(apps.count, 0);

const detail = getAppDetail('r-demo', cfg);
assert.strictEqual(detail.ok, true);
assert.strictEqual(detail.failureCount, 1);
assert.strictEqual(detail.failures[0].fingerprint, 'fp1');

// --- HTTP health + overview ---
function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, path: urlPath, method },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const state = { startedAt: Date.now(), lastPollAt: null, lastDiagnoseAt: null, lastReportAt: null };

(async () => {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, { cfg, state }).catch((e) => {
      res.writeHead(500);
      res.end(e.message);
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const health = await request(server, 'GET', '/health');
  assert.strictEqual(health.status, 200);
  const healthJson = JSON.parse(health.body);
  assert.strictEqual(healthJson.ok, true);
  assert.strictEqual(healthJson.workbench, true);

  const ov = await request(server, 'GET', '/api/overview');
  assert.strictEqual(ov.status, 200);
  assert.strictEqual(JSON.parse(ov.body).ok, true);

  const index = await request(server, 'GET', '/');
  assert.strictEqual(index.status, 200);
  assert.ok(String(index.headers['content-type'] || '').includes('text/html'));
  assert.ok(index.body.includes('RPA'));

  // S25b routes exist
  const findingMiss = await request(server, 'GET', '/api/findings/no-such-fp');
  assert.strictEqual(findingMiss.status, 404);

  const patches = await request(server, 'GET', '/api/patches');
  assert.strictEqual(patches.status, 200);
  assert.strictEqual(JSON.parse(patches.body).ok, true);

  const reports = await request(server, 'GET', '/api/reports');
  assert.strictEqual(reports.status, 200);
  assert.strictEqual(JSON.parse(reports.body).ok, true);

  const missing = await request(server, 'GET', '/api/nope');
  assert.strictEqual(missing.status, 404);

  const agents = await request(server, 'GET', '/api/agents');
  assert.strictEqual(agents.status, 200);
  const agentsJson = JSON.parse(agents.body);
  assert.strictEqual(agentsJson.ok, true);
  assert.ok(Array.isArray(agentsJson.agents));
  assert.ok(agentsJson.agents.some((a) => a.id === 'cursor'));
  assert.ok(agentsJson.agents.some((a) => a.id === 'qoder'));

  // open-agent：未知 agent / 未解析目录应 400，不崩溃
  const openAgent = await new Promise((resolve, reject) => {
    const addr = server.address();
    const body = JSON.stringify({ agent: 'cursor' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: '/api/apps/no-such-robot/open-agent',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.ok(openAgent.status >= 400);
  assert.strictEqual(JSON.parse(openAgent.body).ok, false);

  const unknownAgent = await new Promise((resolve, reject) => {
    const addr = server.address();
    const body = JSON.stringify({ agent: 'not-a-real-agent' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: '/api/apps/r-demo/open-agent',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(unknownAgent.status, 400);
  assert.strictEqual(JSON.parse(unknownAgent.body).code, 'unknown_agent');

  await new Promise((r) => server.close(r));

  // cleanup best-effort
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }

  console.log('test_workbench: ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});