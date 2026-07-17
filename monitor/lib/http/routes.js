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
  // 每次请求热读 config（含 data/settings.llm.json），避免常驻 service 持有旧 cfg
  let cfg = ctx.cfg;
  try {
    // eslint-disable-next-line global-require
    const { loadConfig } = require('../config');
    cfg = loadConfig();
  } catch {
    cfg = ctx.cfg;
  }
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
      // S26：LLM 设置
      if (method === 'GET' && pathname === '/api/settings/llm') {
        sendJson(res, 200, workbench.getLlmSettings(cfg));
        return true;
      }
      if (method === 'PUT' && pathname === '/api/settings/llm') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad_json', message: '请求体须为 JSON' });
          return true;
        }
        const result = workbench.saveLlmSettingsFromWeb(cfg, body);
        const status = result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400;
        sendJson(res, status, result);
        return true;
      }
      if (method === 'POST' && pathname === '/api/settings/llm/test') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const result = await workbench.testLlmSettingsFromWeb(cfg, body);
        sendJson(res, result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400, result);
        return true;
      }

      // 成功抽检（成功任务末尾日志）
      if (
        method === 'GET' &&
        (pathname === '/api/settings/success-check' || pathname === '/api/settings/soft-fail')
      ) {
        sendJson(res, 200, workbench.getSuccessCheckSettings(cfg));
        return true;
      }
      if (
        method === 'PUT' &&
        (pathname === '/api/settings/success-check' || pathname === '/api/settings/soft-fail')
      ) {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad_json', message: '请求体须为 JSON' });
          return true;
        }
        const result = workbench.saveSuccessCheckSettingsFromWeb(cfg, body);
        const status = result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400;
        sendJson(res, status, result);
        return true;
      }

      // 钉钉机器人晨报
      if (method === 'GET' && pathname === '/api/settings/dingtalk') {
        sendJson(res, 200, workbench.getDingtalkSettings(cfg));
        return true;
      }
      if (method === 'PUT' && pathname === '/api/settings/dingtalk') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad_json', message: '请求体须为 JSON' });
          return true;
        }
        const result = workbench.saveDingtalkSettingsFromWeb(cfg, body);
        const status = result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400;
        sendJson(res, status, result);
        return true;
      }
      if (method === 'POST' && pathname === '/api/settings/dingtalk/test') {
        // force：忽略 enabled，用当前已保存配置发一条晨报（测通）
        const result = await workbench.sendDingtalkDigestFromWeb(cfg, { force: true });
        sendJson(
          res,
          result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400,
          result,
        );
        return true;
      }
      if (method === 'POST' && pathname === '/api/settings/dingtalk/send') {
        // 正式发送：须 enabled
        const result = await workbench.sendDingtalkDigestFromWeb(cfg, { force: false });
        sendJson(
          res,
          result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400,
          result,
        );
        return true;
      }

      // 业务解读提示词模板
      if (method === 'GET' && pathname === '/api/settings/business-brief') {
        sendJson(res, 200, workbench.getBusinessBriefPromptSettings(cfg));
        return true;
      }
      if (method === 'PUT' && pathname === '/api/settings/business-brief') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { ok: false, code: 'bad_json', message: '请求体须为 JSON' });
          return true;
        }
        const result = workbench.saveBusinessBriefPromptSettings(cfg, body);
        const status = result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400;
        sendJson(res, status, result);
        return true;
      }
      if (method === 'POST' && pathname === '/api/settings/business-brief/reset') {
        const result = workbench.resetBusinessBriefPromptSettings(cfg);
        const status = result.ok ? 200 : result.code === 'settings_disabled' ? 403 : 400;
        sendJson(res, status, result);
        return true;
      }

      if (method === 'GET' && pathname === '/api/overview') {
        sendJson(res, 200, workbench.buildOverview(cfg, state));
        return true;
      }

      // 手动触发 poll（与 service / CLI 同一 pollOnce；不 diagnose、不 apply）
      if (method === 'POST' && pathname === '/api/poll') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const input = {};
        if (body.lookbackHours != null) input.lookbackHours = body.lookbackHours;
        if (body.hours != null && input.lookbackHours == null) input.lookbackHours = body.hours;
        if (body.maxPages != null) input.maxPages = body.maxPages;
        if (body.enrichLogs === false || body.noEnrich === true) input.enrichLogs = false;

        const result = await workbench.runManualPoll(cfg, input);
        if (result.ok && result.polledAt) {
          state.lastPollAt = result.polledAt;
        }
        const status = result.ok
          ? 200
          : result.code === 'busy'
            ? 409
            : result.code === 'MISSING_CREDENTIALS' || result.code === 'no_credentials'
              ? 400
              : 400;
        sendJson(res, status, result);
        return true;
      }

      if (method === 'GET' && pathname === '/api/apps') {
        sendJson(res, 200, workbench.listAppsWithStats(cfg));
        return true;
      }

      // 应用关注/标签：优先池范围
      if (method === 'GET' && pathname === '/api/settings/app-meta') {
        sendJson(res, 200, workbench.getAppMetaSummary(cfg));
        return true;
      }
      if (method === 'PUT' && pathname === '/api/settings/app-meta') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        // 优先池业务标签（空数组 = 全部应用）
        if (Array.isArray(body.priorityTags)) {
          sendJson(res, 200, workbench.setPriorityTags(cfg, body.priorityTags));
          return true;
        }
        if (body.priorityScope != null) {
          sendJson(
            res,
            200,
            workbench.setPriorityScope(
              cfg,
              body.priorityScope,
              Array.isArray(body.priorityTags) ? body.priorityTags : undefined,
            ),
          );
          return true;
        }
        sendJson(res, 400, {
          ok: false,
          code: 'bad_request',
          message: '需要 priorityTags: string[] 或 priorityScope: all|tags',
        });
        return true;
      }

      const appMetaRoute = pathname.match(/^\/api\/apps\/([^/]+)\/meta\/?$/);
      if (method === 'GET' && appMetaRoute) {
        const robotUuid = decodeURIComponent(appMetaRoute[1]);
        const summary = workbench.getAppMetaSummary(cfg);
        const detail = workbench.getAppDetail(robotUuid, cfg);
        if (!detail.ok) {
          sendJson(res, 404, detail);
          return true;
        }
        sendJson(res, 200, {
          ok: true,
          robotUuid,
          watched: detail.watched === true,
          tags: detail.tags || [],
          metaUpdatedAt: detail.metaUpdatedAt || null,
          priorityScope: summary.priorityScope,
        });
        return true;
      }
      if (method === 'PUT' && appMetaRoute) {
        const robotUuid = decodeURIComponent(appMetaRoute[1]);
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const result = workbench.setAppMeta(robotUuid, cfg, body);
        sendJson(res, result.ok ? 200 : 400, result);
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

      // 业务解读：GET 只读缓存；POST 生成（可 force）
      const appBrief = pathname.match(/^\/api\/apps\/([^/]+)\/business-brief\/?$/);
      if (method === 'GET' && appBrief) {
        const robotUuid = decodeURIComponent(appBrief[1]);
        const result = await workbench.getAppBusinessBrief(robotUuid, cfg, {
          cacheOnly: true,
          flowName: url.searchParams.get('flowName') || '',
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return true;
      }
      if (method === 'POST' && appBrief) {
        const robotUuid = decodeURIComponent(appBrief[1]);
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const result = await workbench.getAppBusinessBrief(robotUuid, cfg, {
          force: body.force === true || url.searchParams.get('refresh') === '1',
          flowName: body.flowName || url.searchParams.get('flowName') || '',
        });
        const status = result.ok
          ? 200
          : result.code === 'llm_not_configured' || result.code === 'actions_disabled'
            ? 403
            : 400;
        sendJson(res, status, result);
        return true;
      }

      // 导出 Markdown：业务流程 / 实现流程
      const appExportBiz = pathname.match(
        /^\/api\/apps\/([^/]+)\/export\/business(?:\.md)?\/?$/,
      );
      if (method === 'GET' && appExportBiz) {
        const robotUuid = decodeURIComponent(appExportBiz[1]);
        const result = await workbench.exportAppBusinessMarkdown(robotUuid, cfg, {
          flowName: url.searchParams.get('flowName') || '',
        });
        sendJson(res, result.ok ? 200 : result.code === 'no_brief' ? 404 : 400, result);
        return true;
      }
      const appExportImpl = pathname.match(
        /^\/api\/apps\/([^/]+)\/export\/impl(?:\.md)?\/?$/,
      );
      if (method === 'GET' && appExportImpl) {
        const robotUuid = decodeURIComponent(appExportImpl[1]);
        const result = workbench.exportAppImplMarkdown(robotUuid, cfg, {
          flowName: url.searchParams.get('flowName') || '',
          skipCache: url.searchParams.get('refresh') === '1',
        });
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

      // 在 Cursor / Claude Code / Codex 等打开（白名单 agent）
      const appOpenAgent = pathname.match(/^\/api\/apps\/([^/]+)\/open-agent\/?$/);
      if (method === 'POST' && appOpenAgent) {
        const robotUuid = decodeURIComponent(appOpenAgent[1]);
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const agent = body.agent || body.agentId || '';
        const result = workbench.openAppWithAgent(robotUuid, agent, cfg);
        sendJson(res, result.ok ? 200 : result.code === 'disabled' ? 403 : 400, result);
        return true;
      }

      if (method === 'GET' && pathname === '/api/agents') {
        sendJson(res, 200, workbench.listOpenAgents(cfg));
        return true;
      }

      // S25b：失败详情
      const findingGet = pathname.match(/^\/api\/findings\/([^/]+)\/?$/);
      if (method === 'GET' && findingGet) {
        const fingerprint = decodeURIComponent(findingGet[1]);
        const result = workbench.getFindingDetail(fingerprint, cfg);
        sendJson(res, result.ok ? 200 : 404, result);
        return true;
      }

      // S27a：失败修复交接提示词（瘦身；?includeDiagnose=1 可选）
      const findingHandoff = pathname.match(/^\/api\/findings\/([^/]+)\/handoff\/?$/);
      if (method === 'GET' && findingHandoff) {
        const fingerprint = decodeURIComponent(findingHandoff[1]);
        const result = workbench.getFindingHandoff(fingerprint, cfg, {
          includeDiagnose: url.searchParams.get('includeDiagnose'),
        });
        sendJson(res, result.ok ? 200 : result.code === 'not_found' ? 404 : 400, result);
        return true;
      }

      // S27d：处置态 open | snoozed | ignored | resolved
      const findingWork = pathname.match(/^\/api\/findings\/([^/]+)\/work-status\/?$/);
      if (method === 'POST' && findingWork) {
        const fingerprint = decodeURIComponent(findingWork[1]);
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const result = workbench.setFindingWorkStatus(fingerprint, cfg, body);
        const status = result.ok
          ? 200
          : result.code === 'not_found'
            ? 404
            : result.code === 'invalid_status' || result.code === 'terminal_resolved'
              ? 400
              : 400;
        sendJson(res, status, result);
        return true;
      }

      // S27a：应用开发交接提示词（GET 瘦身默认；POST 可带 focusNodes / taskNote）
      const appHandoff = pathname.match(/^\/api\/apps\/([^/]+)\/handoff\/?$/);
      if ((method === 'GET' || method === 'POST') && appHandoff) {
        const robotUuid = decodeURIComponent(appHandoff[1]);
        let body = {};
        if (method === 'POST') {
          try {
            const raw = await readBody(req);
            if (raw) body = JSON.parse(raw);
          } catch {
            body = {};
          }
        }
        const taskNote =
          (body && body.taskNote) || url.searchParams.get('taskNote') || '';
        const focusNodes =
          body && Array.isArray(body.focusNodes)
            ? body.focusNodes
            : undefined;
        const includeCandidates =
          body && body.includeCandidates === true
            ? true
            : url.searchParams.get('includeCandidates') === '1' ||
              url.searchParams.get('includeCandidates') === 'true';
        const result = workbench.getAppHandoff(robotUuid, cfg, {
          taskNote,
          focusNodes,
          includeCandidates,
        });
        sendJson(res, result.ok ? 200 : result.code === 'not_found' ? 404 : 400, result);
        return true;
      }

      // S25b：触发 skill（仅 diagnose / fix-dry-run）
      const findingAction = pathname.match(/^\/api\/findings\/([^/]+)\/(diagnose|fix-dry-run)\/?$/);
      if (method === 'POST' && findingAction) {
        const fingerprint = decodeURIComponent(findingAction[1]);
        const action = findingAction[2];
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        // useLlm：仅当 body 显式传 boolean 时覆盖；否则走 cfg.diagnoseUseLlm
        const actionInput = {
          fingerprint,
          force: body.force === true,
        };
        if (typeof body.useLlm === 'boolean') actionInput.useLlm = body.useLlm;
        const result = await workbench.runWorkbenchAction(action, actionInput, cfg);
        const status = result.ok ? 200 : result.code === 'busy' ? 409 : result.code === 'actions_disabled' ? 403 : 400;
        sendJson(res, status, result);
        return true;
      }

      // S25b：patches
      if (method === 'GET' && pathname === '/api/patches') {
        const result = workbench.listPatchesForWorkbench(cfg, {
          fingerprint: url.searchParams.get('fingerprint') || undefined,
          robotUuid: url.searchParams.get('robotUuid') || undefined,
          status: url.searchParams.get('status') || undefined,
          limit: parseInt(url.searchParams.get('limit') || '50', 10),
        });
        sendJson(res, 200, result);
        return true;
      }

      const patchGet = pathname.match(/^\/api\/patches\/([^/]+)\/?$/);
      if (method === 'GET' && patchGet) {
        const patchId = decodeURIComponent(patchGet[1]);
        const result = workbench.getPatchDetail(cfg, patchId);
        sendJson(res, result.ok ? 200 : 404, result);
        return true;
      }

      // 拉取日志档案（每次 poll 的影刀 job 步骤日志）
      if (method === 'GET' && pathname === '/api/poll-runs') {
        const result = workbench.listPollRuns(cfg, {
          limit: parseInt(url.searchParams.get('limit') || '50', 10),
        });
        sendJson(res, 200, result);
        return true;
      }

      const pollRunGet = pathname.match(/^\/api\/poll-runs\/([^/]+)\/?$/);
      if (method === 'GET' && pollRunGet) {
        const id = decodeURIComponent(pollRunGet[1]);
        const result = workbench.getPollRun(cfg, id);
        sendJson(res, result.ok ? 200 : result.code === 'not_found' ? 404 : 400, result);
        return true;
      }

      // 日报
      if (method === 'GET' && pathname === '/api/reports') {
        const result = workbench.listReports(cfg, {
          limit: parseInt(url.searchParams.get('limit') || '60', 10),
        });
        sendJson(res, 200, result);
        return true;
      }

      if (method === 'POST' && pathname === '/api/reports/generate') {
        let body = {};
        try {
          const raw = await readBody(req);
          if (raw) body = JSON.parse(raw);
        } catch {
          body = {};
        }
        const result = workbench.generateReport(cfg, {
          date: body.date || url.searchParams.get('date') || undefined,
          scope: body.scope || url.searchParams.get('scope') || undefined,
        });
        sendJson(res, result.ok ? 200 : 400, result);
        return true;
      }

      const reportGet = pathname.match(/^\/api\/reports\/(\d{4}-\d{2}-\d{2})\/?$/);
      if (method === 'GET' && reportGet) {
        const date = reportGet[1];
        const result = workbench.getReport(cfg, date);
        sendJson(res, result.ok ? 200 : 404, result);
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
