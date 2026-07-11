/**
 * 确定性感知流水线：poll OpenAPI → 指纹 → 紧急分流 / 入队
 * 默认按 triggerTime 最近 N 小时（24h）拉全量分页，不调 AI。
 */

const yingdao = require('./yingdao');
const { buildFingerprint, isFailedStatus, isUrgentRemark } = require('./fingerprint');
const memory = require('./memory');

/**
 * 影刀时间格式：yyyy-MM-dd HH:mm:ss（本地时区）
 * @param {Date} d
 */
function formatYingdaoDateTime(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/**
 * @param {object} cfg loadConfig() 结果
 * @param {{
 *   maxPages?: number,
 *   enrichLogs?: boolean,
 *   lookbackHours?: number,
 *   triggerTimeBegin?: string,
 *   triggerTimeEnd?: string,
 * }} [options]
 */
async function pollOnce(cfg, options = {}) {
  const enrichLogs = options.enrichLogs !== false;
  const lookbackHours = Number(
    options.lookbackHours != null ? options.lookbackHours : cfg.pollLookbackHours != null ? cfg.pollLookbackHours : 24,
  );

  // 时间窗模式：尽量拉全；条数模式（lookbackHours=0）保留旧行为上限
  const defaultMaxPages = lookbackHours > 0 ? 50 : 3;
  const maxPages = options.maxPages ?? cfg.pollMaxPages ?? defaultMaxPages;

  const dataDir = cfg.dataDir;
  memory.ensureDir(dataDir);

  const token = await yingdao.getToken({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
  });

  const end = new Date();
  let triggerTimeBegin;
  let triggerTimeEnd;
  if (options.triggerTimeBegin && options.triggerTimeEnd) {
    triggerTimeBegin = options.triggerTimeBegin;
    triggerTimeEnd = options.triggerTimeEnd;
  } else if (lookbackHours > 0) {
    const start = new Date(end.getTime() - lookbackHours * 3600 * 1000);
    triggerTimeBegin = formatYingdaoDateTime(start);
    triggerTimeEnd = formatYingdaoDateTime(end);
  }

  // 时间窗模式每次从首页翻完；不用旧 cursor 续扫（避免窗与游标错位）
  let cursorId;
  let pages = 0;
  let lastNextId = null;

  const stats = {
    scanned: 0,
    failed: 0,
    enqueued: 0,
    updated: 0,
    urgent: 0,
    enriched: 0,
    pages: 0,
    lookbackHours: lookbackHours > 0 ? lookbackHours : 0,
    triggerTimeBegin: triggerTimeBegin || null,
    triggerTimeEnd: triggerTimeEnd || null,
    truncated: false,
  };

  const samples = [];
  const findings = [];
  const seenFp = new Set();

  while (pages < maxPages) {
    const result = await yingdao.listJobs(token, {
      robotClientUuid: cfg.robotClientUuid || undefined,
      size: cfg.size,
      cursorDirection: 'next',
      cursorId,
      triggerTimeBegin,
      triggerTimeEnd,
    });
    pages += 1;
    stats.pages += 1;

    const { dataList, nextId } = result;
    stats.scanned += dataList.length;

    for (const job of dataList) {
      if (!isFailedStatus(job.status)) continue;
      stats.failed += 1;

      let fp = buildFingerprint({
        robotUuid: job.robotUuid,
        robotName: job.robotName,
        remark: job.remark,
        jobUuid: job.jobUuid,
      });

      if (enrichLogs && fp.needsLogEnrichment && job.jobUuid) {
        try {
          const logRes = await yingdao.searchLogs(token, job.jobUuid, { page: 1, size: 100 });
          stats.enriched += 1;
          fp = buildFingerprint({
            robotUuid: job.robotUuid,
            robotName: job.robotName,
            remark: job.remark,
            jobUuid: job.jobUuid,
            logs: logRes.logs,
          });
        } catch (e) {
          fp = {
            ...fp,
            rawRemark: `${fp.rawRemark || job.remark || ''} [log_fetch_error: ${e.message}]`.trim(),
          };
        }
      }

      if (isUrgentRemark(job.remark || fp.rawRemark)) {
        stats.urgent += 1;
        const alertFile = memory.writeAlert(dataDir, {
          type: 'urgent',
          status: job.status,
          robotUuid: job.robotUuid,
          robotName: job.robotName,
          jobUuid: job.jobUuid,
          remark: job.remark,
          fingerprint: fp.fingerprint,
        });
        console.error(`⚠️ 紧急告警: [${job.robotName}] ${job.remark || ''} → ${alertFile}`);
      }

      const existed = memory.loadQueueItem(dataDir, fp.fingerprint);
      const item = memory.upsertQueueItem(dataDir, fp, { jobUuid: job.jobUuid });
      if (existed) stats.updated += 1;
      else stats.enqueued += 1;

      if (fp.fingerprint && !seenFp.has(fp.fingerprint)) {
        seenFp.add(fp.fingerprint);
        findings.push({
          fingerprint: fp.fingerprint,
          robotUuid: item.robotUuid,
          robotName: item.robotName,
          jobUuid: job.jobUuid,
          status: job.status,
          triggerTime: job.triggerTime || job.startTime || null,
          count: 1,
        });
      } else if (fp.fingerprint) {
        const f = findings.find((x) => x.fingerprint === fp.fingerprint);
        if (f) {
          f.count = (f.count || 1) + 1;
          // 保留一个样例 jobUuid 即可
        }
      }


      if (samples.length < 8) {
        samples.push({
          fingerprint: item.fingerprint,
          robotName: item.robotName,
          flowName: item.flowName,
          lineNumber: item.lineNumber,
          errorType: item.errorType,
          occurrenceCount: item.occurrenceCount,
          jobUuid: job.jobUuid,
        });
      }
    }

    if (nextId) lastNextId = nextId;

    if (!nextId || dataList.length === 0) break;
    if (dataList.length < (cfg.size || 50)) break;
    if (cursorId && String(nextId) === String(cursorId)) break;

    cursorId = nextId;
  }

  if (pages >= maxPages) {
    stats.truncated = true;
  }

  const now = new Date().toISOString();
  memory.saveCursor(dataDir, {
    lastNextId,
    lastPollAt: now,
    lastLookbackHours: stats.lookbackHours,
    lastTriggerTimeBegin: stats.triggerTimeBegin,
    lastTriggerTimeEnd: stats.triggerTimeEnd,
    lastScanned: stats.scanned,
    lastFailed: stats.failed,
    lastPollFindings: findings,
  });

  return {
    stats: { ...stats, findings: findings.length },
    samples,
    findings,
    cursor: {
      lastNextId,
      lastPollAt: now,
      triggerTimeBegin: stats.triggerTimeBegin,
      triggerTimeEnd: stats.triggerTimeEnd,
    },
  };
}


module.exports = {
  pollOnce,
  formatYingdaoDateTime,
};
