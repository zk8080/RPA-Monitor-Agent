/**
 * 工作台聚合 / 路径校验 / HTTP 路由自检（不依赖影刀密钥）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const {
  aggregateFailuresByRobot,
  buildOverview,
  buildPriorityQueue,
  listAppsWithStats,
  getAppDetail,
} = require('./lib/workbench');
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

// 已处理 / 不提醒 不计入「待处理」failureCount
const aggWs = aggregateFailuresByRobot([
  {
    robotUuid: 'rw',
    diagnosed: false,
    workStatus: 'open',
    lastSeen: '2026-07-12T10:00:00.000Z',
  },
  {
    robotUuid: 'rw',
    diagnosed: false,
    workStatus: 'resolved',
    lastSeen: '2026-07-12T11:00:00.000Z',
  },
  {
    robotUuid: 'rw',
    diagnosed: false,
    workStatus: 'ignored',
    lastSeen: '2026-07-12T12:00:00.000Z',
  },
  {
    robotUuid: 'rw',
    diagnosed: true,
    workStatus: 'snoozed',
    snoozedUntil: '2099-01-01T00:00:00.000Z',
    lastSeen: '2026-07-12T13:00:00.000Z',
  },
]);
assert.strictEqual(aggWs.get('rw').failureCount, 1);
assert.strictEqual(aggWs.get('rw').undiagnosedCount, 1);
assert.strictEqual(aggWs.get('rw').resolvedCount, 1);
assert.strictEqual(aggWs.get('rw').items.length, 4);

// --- priority queue ranking ---
const pq = buildPriorityQueue(
  [
    {
      fingerprint: 'fp-diag-high',
      robotUuid: 'r-a',
      robotName: 'A',
      diagnosed: true,
      occurrenceCount: 8,
      errorType: '超时',
      lastSeen: '2026-07-12T08:00:00.000Z',
    },
    {
      fingerprint: 'fp-undiag',
      robotUuid: 'r-b',
      robotName: 'B',
      diagnosed: false,
      occurrenceCount: 1,
      errorType: '元素未找到',
      lastSeen: '2026-07-12T07:00:00.000Z',
    },
    {
      fingerprint: 'fp-regressed',
      robotUuid: 'r-c',
      robotName: 'C',
      diagnosed: true,
      occurrenceCount: 2,
      fixStatus: 'regressed',
      errorType: 'IndexError',
      lastSeen: '2026-07-12T09:00:00.000Z',
    },
    {
      fingerprint: 'fp-cross',
      robotUuid: 'r-d',
      robotName: 'D',
      diagnosed: true,
      occurrenceCount: 1,
      errorSignature: 'flow|err|el',
      errorType: '元素未找到',
      lastSeen: '2026-07-12T06:00:00.000Z',
    },
    {
      fingerprint: 'fp-quiet',
      robotUuid: 'r-e',
      robotName: 'E',
      diagnosed: true,
      occurrenceCount: 1,
      errorType: 'other',
      lastSeen: '2026-07-12T10:00:00.000Z',
    },
  ],
  {
    limit: 10,
    crossFpSet: new Set(['fp-cross']),
    patchIndex: new Map(),
    recentDays: 0, // 不限时间，避免环境日期影响单测
  },
);
assert.ok(pq.length >= 5);
assert.strictEqual(pq[0].fingerprint, 'fp-undiag', '未诊断应排最前');
assert.strictEqual(pq[1].fingerprint, 'fp-regressed', '复发次之');
assert.ok(pq.some((x) => x.fingerprint === 'fp-cross' && x.reasons.includes('cross_app')));
assert.ok(pq.some((x) => x.fingerprint === 'fp-diag-high' && x.reasons.includes('high_occurrence')));
const quiet = pq.find((x) => x.fingerprint === 'fp-quiet');
assert.ok(quiet, '无强信号的 open 也应进优先');
assert.ok(quiet.reasons.includes('recent_open'));
assert.ok(quiet.reasonLabels.includes('近 24h'));
assert.ok(quiet.score < pq[0].score, '兜底分应低于强信号');
assert.strictEqual(pq[pq.length - 1].fingerprint, 'fp-quiet', '无强信号应排最后');
assert.ok(pq[0].reasonLabels.includes('未诊断'));

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
// 失败时间用「现在」：默认优先窗口 = 滚动 24h
const recentFailAt = new Date().toISOString();
fs.writeFileSync(
  path.join(dataDir, 'queue', 'fp1.json'),
  JSON.stringify({
    fingerprint: 'fp1',
    robotUuid: 'r-demo',
    robotName: 'Demo',
    diagnosed: false,
    lastFailureAt: recentFailAt,
    lastSeen: recentFailAt,
    occurrenceCount: 1,
  }),
  'utf8',
);
// 超过 24h 的失败：仍进 queue/应用列表，但不进优先处理
fs.writeFileSync(
  path.join(dataDir, 'queue', 'fp-old.json'),
  JSON.stringify({
    fingerprint: 'fp-old',
    robotUuid: 'r-old',
    robotName: 'Old',
    diagnosed: false,
    lastFailureAt: '2020-01-01T00:00:00.000Z',
    lastSeen: '2020-01-01T00:00:00.000Z',
    occurrenceCount: 3,
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

const overview = buildOverview(cfg, { startedAt: Date.now() - 5000, lastPollAt: recentFailAt });
assert.strictEqual(overview.ok, true);
assert.ok(overview.queue.depth >= 2);
assert.strictEqual(overview.queue.priorityRecentDays, 1, '默认优先窗口 1 天=24h');
assert.ok(overview.problemApps.some((p) => p.robotUuid === 'r-demo'));
assert.ok(Array.isArray(overview.priorityQueue), 'overview 应含 priorityQueue');
assert.ok(
  overview.priorityQueue.some((p) => p.fingerprint === 'fp1' && p.reasons.includes('undiagnosed')),
  '24h 内未诊断条目应进优先处理',
);
assert.ok(
  !overview.priorityQueue.some((p) => p.fingerprint === 'fp-old'),
  '超过 24h 的失败不进优先处理',
);

const apps = listAppsWithStats(cfg);
assert.strictEqual(apps.ok, true);
// 本机空目录时仍会合并 queue 中的失败应用
assert.strictEqual(apps.localCount, 0);
assert.ok(apps.count >= 1);
assert.ok(apps.apps.some((a) => a.robotUuid === 'r-demo'));

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

  // 手动 poll 路由存在：handleRequest 会热读 loadConfig()（可能有本机密钥）
  // 有密钥则可能 200 真 poll；无密钥 400；busy 409 —— 只要不 404/崩
  const pollRes = await new Promise((resolve, reject) => {
    const addr = server.address();
    const body = JSON.stringify({ lookbackHours: 1, maxPages: 1, enrichLogs: false });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: '/api/poll',
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
  assert.notStrictEqual(pollRes.status, 404);
  const pollJson = JSON.parse(pollRes.body);
  assert.ok(typeof pollJson.ok === 'boolean');
  if (pollJson.ok) {
    assert.strictEqual(pollJson.action, 'poll');
    assert.ok(pollJson.stats && typeof pollJson.stats.scanned === 'number');
  } else {
    assert.ok(pollJson.message || pollJson.code);
  }

  const index = await request(server, 'GET', '/');
  assert.strictEqual(index.status, 200);
  assert.ok(String(index.headers['content-type'] || '').includes('text/html'));
  assert.ok(index.body.includes('RPA'));
  assert.ok(index.body.includes('btn-poll-now') || index.body.includes('立即拉取'));

  // S25b routes exist
  const findingMiss = await request(server, 'GET', '/api/findings/no-such-fp');
  assert.strictEqual(findingMiss.status, 404);

  // S27a handoff routes
  const handoffMiss = await request(server, 'GET', '/api/findings/no-such-fp/handoff');
  assert.strictEqual(handoffMiss.status, 404);

  // S27d work-status route exists
  const wsMiss = await new Promise((resolve, reject) => {
    const addr = server.address();
    const body = JSON.stringify({ status: 'snoozed' });
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: '/api/findings/no-such-fp/work-status',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  assert.strictEqual(wsMiss.status, 404);
  const appHandoff = await request(server, 'GET', '/api/apps/no-such-robot/handoff');
  assert.strictEqual(appHandoff.status, 200);
  const appHandoffJson = JSON.parse(appHandoff.body);
  assert.strictEqual(appHandoffJson.ok, true);
  assert.strictEqual(appHandoffJson.mode, 'develop');
  assert.ok(String(appHandoffJson.markdown || '').includes('开发'));

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