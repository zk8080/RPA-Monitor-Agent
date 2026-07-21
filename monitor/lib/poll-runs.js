/**
 * 每次 poll 的影刀 job 日志档案（方案 A）
 * 落盘：data/poll-runs/<id>.json
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_RUNS = 50;
const DEFAULT_MAX_LOG_LINES = 100;
const ID_RE = /^[a-zA-Z0-9._-]+$/;

function runsDir(dataDir) {
  return path.join(dataDir, 'poll-runs');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function makeRunId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const rand = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${rand}`;
}

/**
 * 压缩单行日志，去掉未知大字段
 * @param {any} line
 */
function compactLogLine(line) {
  if (line == null) return { text: '' };
  if (typeof line === 'string') return { text: line };
  if (typeof line !== 'object') return { text: String(line) };
  const text =
    line.text != null
      ? String(line.text)
      : line.message != null
        ? String(line.message)
        : line.content != null
          ? String(line.content)
          : line.log != null
            ? String(line.log)
            : '';
  return {
    level: line.level != null ? String(line.level) : line.logLevel != null ? String(line.logLevel) : '',
    text,
    flowName: line.flowName != null ? String(line.flowName) : '',
    lineNumber:
      line.lineNumber != null && line.lineNumber !== ''
        ? String(line.lineNumber)
        : line.line != null
          ? String(line.line)
          : '',
    time:
      line.time != null
        ? String(line.time)
        : line.logTime != null
          ? String(line.logTime)
          : line.createTime != null
            ? String(line.createTime)
            : line.timestamp != null
              ? String(line.timestamp)
              : '',
  };
}

/**
 * @param {any[]} logs
 * @param {number} [maxLines]
 */
function compactLogs(logs, maxLines = DEFAULT_MAX_LOG_LINES) {
  if (!Array.isArray(logs)) return [];
  return logs.slice(0, maxLines).map(compactLogLine);
}

/**
 * @param {object} job
 * @param {{ maxLogLines?: number }} [opts]
 */
function compactJobEntry(job, opts = {}) {
  const maxLogLines = opts.maxLogLines != null ? opts.maxLogLines : DEFAULT_MAX_LOG_LINES;
  const logs = compactLogs(job.logs, maxLogLines);
  return {
    jobUuid: job.jobUuid || '',
    robotUuid: job.robotUuid || '',
    robotName: job.robotName || '',
    taskName: job.taskName || '',
    robotClientName: job.robotClientName || '',
    robotClientUuid: job.robotClientUuid || '',
    status: job.status || '',
    fingerprint: job.fingerprint || '',
    failureAt: job.failureAt || null,
    remark: job.remark != null ? String(job.remark).slice(0, 2000) : '',
    flowName: job.flowName || '',
    lineNumber: job.lineNumber != null ? String(job.lineNumber) : '',
    errorType: job.errorType || '',
    logFetchError: job.logFetchError || null,
    logSkipped: job.logSkipped === true,
    logCount: logs.length,
    logs,
  };
}

/**
 * 写入一次 poll 档案并淘汰旧文件
 *
 * @param {string} dataDir
 * @param {{
 *   trigger?: string,
 *   startedAt?: string,
 *   finishedAt?: string,
 *   stats?: object,
 *   window?: object,
 *   jobs?: object[],
 *   maxRuns?: number,
 *   maxLogLines?: number,
 * }} payload
 */
function saveRun(dataDir, payload = {}) {
  const finishedAt = payload.finishedAt || new Date().toISOString();
  const startedAt = payload.startedAt || finishedAt;
  const id = payload.id && ID_RE.test(payload.id) ? payload.id : makeRunId(new Date(finishedAt));
  const jobs = (payload.jobs || []).map((j) =>
    compactJobEntry(j, { maxLogLines: payload.maxLogLines }),
  );
  const withLogs = jobs.filter((j) => j.logCount > 0).length;
  const withError = jobs.filter((j) => j.logFetchError).length;

  const stats = payload.stats && typeof payload.stats === 'object' ? { ...payload.stats } : {};
  const run = {
    id,
    startedAt,
    finishedAt,
    trigger: payload.trigger || 'unknown',
    stats,
    window: payload.window && typeof payload.window === 'object' ? payload.window : null,
    jobCount: jobs.length,
    logJobCount: withLogs,
    logErrorCount: withError,
    jobs,
  };

  const dir = runsDir(dataDir);
  ensureDir(dir);
  const file = path.join(dir, `${id}.json`);
  atomicWriteJson(file, run);

  const maxRuns =
    payload.maxRuns != null
      ? Number(payload.maxRuns)
      : process.env.POLL_RUNS_MAX != null
        ? Number(process.env.POLL_RUNS_MAX)
        : DEFAULT_MAX_RUNS;
  pruneRuns(dataDir, Number.isFinite(maxRuns) && maxRuns > 0 ? maxRuns : DEFAULT_MAX_RUNS);

  return run;
}

/**
 * 保留最近 maxRuns 条（按文件 mtime / 文件名）
 */
function pruneRuns(dataDir, maxRuns = DEFAULT_MAX_RUNS) {
  const dir = runsDir(dataDir);
  if (!fs.existsSync(dir)) return { removed: 0 };
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { f, full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || b.f.localeCompare(a.f));

  let removed = 0;
  for (let i = maxRuns; i < files.length; i += 1) {
    try {
      fs.unlinkSync(files[i].full);
      removed += 1;
    } catch {
      // ignore
    }
  }
  return { removed };
}

/**
 * 列表：不含 logs 正文
 * @param {string} dataDir
 * @param {{ limit?: number }} [opts]
 */
function listRuns(dataDir, opts = {}) {
  const dir = runsDir(dataDir);
  if (!fs.existsSync(dir)) {
    return { ok: true, count: 0, runs: [], runsDir: dir };
  }
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  const runs = [];
  for (const f of files) {
    if (runs.length >= limit) break;
    const full = path.join(dir, f);
    try {
      const raw = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!raw || typeof raw !== 'object') continue;
      runs.push(summarizeRun(raw));
    } catch {
      // skip corrupt
    }
  }

  // 优先按 finishedAt 降序
  runs.sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));

  return { ok: true, count: runs.length, runs, runsDir: dir };
}

function summarizeRun(raw) {
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  return {
    id: raw.id,
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    trigger: raw.trigger || 'unknown',
    jobCount: raw.jobCount != null ? raw.jobCount : Array.isArray(raw.jobs) ? raw.jobs.length : 0,
    logJobCount: raw.logJobCount != null ? raw.logJobCount : 0,
    logErrorCount: raw.logErrorCount != null ? raw.logErrorCount : 0,
    stats: {
      scanned: stats.scanned || 0,
      failed: stats.failed || 0,
      enqueued: stats.enqueued || 0,
      updated: stats.updated || 0,
      enriched: stats.enriched || 0,
      urgent: stats.urgent || 0,
      pages: stats.pages || 0,
      truncated: !!stats.truncated,
      findings: stats.findings || 0,
    },
    window: raw.window || null,
  };
}

/**
 * 详情：含 jobs[].logs
 * @param {string} dataDir
 * @param {string} id
 */
function getRun(dataDir, id) {
  if (!id || !ID_RE.test(id)) {
    return { ok: false, code: 'bad_id', message: '无效的拉取记录 id' };
  }
  const file = path.join(runsDir(dataDir), `${id}.json`);
  if (!fs.existsSync(file)) {
    return { ok: false, code: 'not_found', message: '找不到该次拉取记录' };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'corrupt', message: '拉取记录文件损坏' };
    }
    const jobs = Array.isArray(raw.jobs)
      ? raw.jobs.map((j) => ({
          ...j,
          logs: Array.isArray(j.logs) ? j.logs.map(compactLogLine) : [],
        }))
      : [];
    return {
      ok: true,
      run: {
        id: raw.id || id,
        startedAt: raw.startedAt || null,
        finishedAt: raw.finishedAt || null,
        trigger: raw.trigger || 'unknown',
        stats: raw.stats || {},
        window: raw.window || null,
        jobCount: raw.jobCount != null ? raw.jobCount : jobs.length,
        logJobCount: raw.logJobCount != null ? raw.logJobCount : jobs.filter((j) => (j.logs || []).length).length,
        logErrorCount: raw.logErrorCount != null ? raw.logErrorCount : 0,
        jobs,
      },
    };
  } catch (e) {
    return { ok: false, code: 'read_error', message: e.message || String(e) };
  }
}

module.exports = {
  DEFAULT_MAX_RUNS,
  DEFAULT_MAX_LOG_LINES,
  runsDir,
  makeRunId,
  compactLogLine,
  compactLogs,
  compactJobEntry,
  saveRun,
  pruneRuns,
  listRuns,
  getRun,
  summarizeRun,
};
