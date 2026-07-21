/**
 * poll-runs 档案读写 / 淘汰 / API 路由（不依赖影刀密钥）
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const pollRuns = require('./lib/poll-runs');
const workbench = require('./lib/workbench');
const { handleRequest } = require('./lib/http/routes');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-poll-runs-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// --- compact ---
const line = pollRuns.compactLogLine({
  level: '错误',
  text: 'boom',
  flowName: '主流程',
  lineNumber: 12,
  time: '2026-07-15 10:00:00',
  huge: 'x'.repeat(1000),
});
assert.strictEqual(line.level, '错误');
assert.strictEqual(line.text, 'boom');
assert.strictEqual(line.flowName, '主流程');
assert.strictEqual(line.lineNumber, '12');
assert.strictEqual(line.huge, undefined);

// --- save + list + get ---
const run1 = pollRuns.saveRun(dataDir, {
  trigger: 'manual',
  startedAt: '2026-07-15T01:00:00.000Z',
  finishedAt: '2026-07-15T01:00:05.000Z',
  stats: { scanned: 10, failed: 1, enqueued: 1, updated: 0, enriched: 1 },
  window: { lookbackHours: 24, triggerTimeBegin: 'a', triggerTimeEnd: 'b' },
  jobs: [
    {
      jobUuid: 'job-1',
      robotUuid: 'r1',
      robotName: 'AppA',
      taskName: '任务A',
      robotClientName: 'RPA01@corp',
      robotClientUuid: 'client-uuid-1',
      fingerprint: 'fp-1',
      remark: '失败备注',
      flowName: '主流程',
      errorType: '超时',
      logs: [
        { level: '信息', text: 'start' },
        { level: '错误', text: 'timeout', flowName: '主流程', lineNumber: 9 },
      ],
    },
  ],
  maxRuns: 3,
});
assert.ok(run1.id);
assert.strictEqual(run1.jobCount, 1);
assert.strictEqual(run1.logJobCount, 1);
assert.strictEqual(run1.jobs[0].logCount, 2);
assert.strictEqual(run1.jobs[0].logs[1].text, 'timeout');
assert.strictEqual(run1.jobs[0].robotClientName, 'RPA01@corp');
assert.strictEqual(run1.jobs[0].robotClientUuid, 'client-uuid-1');

const run2 = pollRuns.saveRun(dataDir, {
  id: '20260715-020000-test',
  trigger: 'boot',
  finishedAt: '2026-07-15T02:00:00.000Z',
  stats: { scanned: 5, failed: 0 },
  jobs: [],
  maxRuns: 3,
});
assert.strictEqual(run2.id, '20260715-020000-test');

// prune keeps max 3
for (let i = 0; i < 5; i += 1) {
  pollRuns.saveRun(dataDir, {
    id: `20260715-03000${i}-x`,
    finishedAt: `2026-07-15T03:0${i}:00.000Z`,
    jobs: [],
    maxRuns: 3,
  });
}
const listed = pollRuns.listRuns(dataDir, { limit: 20 });
assert.ok(listed.ok);
assert.ok(listed.count <= 3, `expected ≤3 after prune, got ${listed.count}`);
assert.ok(listed.runs.every((r) => r.logs === undefined));

const detail = pollRuns.getRun(dataDir, listed.runs[0].id);
assert.ok(detail.ok);
assert.ok(Array.isArray(detail.run.jobs));

const bad = pollRuns.getRun(dataDir, '../evil');
assert.strictEqual(bad.ok, false);
assert.strictEqual(bad.code, 'bad_id');

const missing = pollRuns.getRun(dataDir, 'no-such-run-id');
assert.strictEqual(missing.ok, false);
assert.strictEqual(missing.code, 'not_found');

// --- workbench wrappers ---
const cfg = { dataDir, workbench: { enabled: true } };
const wbList = workbench.listPollRuns(cfg, { limit: 10 });
assert.ok(wbList.ok);
assert.ok(wbList.count >= 1);

const wbGet = workbench.getPollRun(cfg, wbList.runs[0].id);
assert.ok(wbGet.ok);
assert.strictEqual(wbGet.run.id, wbList.runs[0].id);

// --- HTTP routes ---
function request(server, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: urlPath,
        method,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body = text;
          try {
            body = JSON.parse(text);
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode, body });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res, { cfg, state: {} }).catch((e) => {
    res.writeHead(500);
    res.end(e.message);
  });
});

server.listen(0, '127.0.0.1', async () => {
  try {
    // routes 会热读 loadConfig()，不一定用测试 dataDir；只校验路由形状
    const listRes = await request(server, 'GET', '/api/poll-runs');
    assert.strictEqual(listRes.status, 200);
    assert.ok(listRes.body && listRes.body.ok !== false);
    assert.ok(Array.isArray(listRes.body.runs));

    const nf = await request(server, 'GET', '/api/poll-runs/does-not-exist-zz');
    assert.strictEqual(nf.status, 404);
    assert.strictEqual(listRes.body.ok === false || nf.body.ok === false || nf.body.code === 'not_found', true);

    // 若列表非空，抽一条详情
    if (listRes.body.runs.length) {
      const id = listRes.body.runs[0].id;
      const one = await request(server, 'GET', `/api/poll-runs/${encodeURIComponent(id)}`);
      assert.strictEqual(one.status, 200);
      assert.ok(one.body.ok);
      assert.ok(Array.isArray(one.body.run.jobs));
    } else {
      // 用 workbench 写入的 tmp 数据直接验 getRun（不经热读 config）
      const direct = workbench.getPollRun(cfg, wbList.runs[0].id);
      assert.ok(direct.ok);
    }

    console.log('test_poll_runs: ok');
    server.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    server.close();
    process.exit(1);
  }
});
