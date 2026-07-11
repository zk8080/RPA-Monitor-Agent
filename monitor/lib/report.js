/**
 * 日报渲染：读 queue / kb / alerts → Markdown
 * 默认按「最近一次 poll 命中」展示；条数用本轮失败数，不展示历史 occurrence 累计。
 */

const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const kb = require('./kb');

function toDateKey(date) {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) {
    return formatLocalDate(new Date());
  }
  return formatLocalDate(d);
}

function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startsWithDate(iso, dateKey) {
  if (!iso) return false;
  const s = String(iso);
  if (s.startsWith(dateKey)) return true;
  try {
    return formatLocalDate(new Date(s)) === dateKey;
  } catch {
    return false;
  }
}

function loadAlertsForDate(dataDir, dateKey) {
  const dir = memory.paths(dataDir).alertsDir;
  if (!fs.existsSync(dir)) return [];
  const compact = dateKey.replace(/-/g, '');
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(dir, f);
      const data = memory.readJson(full, null);
      if (!data) return null;
      if (f.startsWith(compact) || startsWithDate(data.writtenAt, dateKey)) {
        return { file: f, ...data };
      }
      return null;
    })
    .filter(Boolean);
}

/**
 * 选取报告条目
 * scope: poll_window | calendar_day | all
 */
function selectReportItems(queueItems, cursor, dateKey, scope) {
  if (scope === 'all') {
    return { items: queueItems, usedFallback: false, scopeLabel: '全量 queue 快照' };
  }

  // poll_window 默认：优先用本轮 poll 实际命中的指纹列表
  if (scope !== 'calendar_day') {
    const findings = Array.isArray(cursor.lastPollFindings) ? cursor.lastPollFindings : [];
    if (findings.length) {
      const fpSet = new Set(findings.map((f) => f.fingerprint).filter(Boolean));
      const items = queueItems.filter((q) => fpSet.has(q.fingerprint));
      const order = new Map([...fpSet].map((fp, i) => [fp, i]));
      items.sort((a, b) => (order.get(a.fingerprint) ?? 0) - (order.get(b.fingerprint) ?? 0));
      const window =
        cursor.lastTriggerTimeBegin && cursor.lastTriggerTimeEnd
          ? `${cursor.lastTriggerTimeBegin} ~ ${cursor.lastTriggerTimeEnd}`
          : cursor.lastPollAt || '';
      return {
        items,
        usedFallback: false,
        scopeLabel: `最近一次 poll 命中（${findings.length} 个失败类型）${window ? ` · 查询窗 ${window}` : ''}`,
      };
    }
  }

  if (scope === 'calendar_day' || scope === 'poll_window') {
    const dayQueue = queueItems.filter(
      (q) =>
        startsWithDate(q.lastSeen, dateKey) ||
        startsWithDate(q.firstSeen, dateKey) ||
        startsWithDate(q.diagnosedAt, dateKey),
    );
    if (dayQueue.length) {
      return {
        items: dayQueue,
        usedFallback: false,
        scopeLabel:
          scope === 'calendar_day'
            ? `自然日 ${dateKey}`
            : `自然日 ${dateKey}（无 lastPollFindings，已降级）`,
      };
    }
    return {
      items: [],
      usedFallback: false,
      scopeLabel: `自然日 ${dateKey}（无匹配条目）`,
    };
  }

  return {
    items: queueItems,
    usedFallback: true,
    scopeLabel: '全量 queue',
  };
}

/**
 * @param {object} cfg
 * @param {{ date?: string, write?: boolean, scope?: 'poll_window'|'calendar_day'|'all' }} [options]
 */
function buildDailyReport(cfg, options = {}) {
  const dateKey = toDateKey(options.date);
  const dataDir = cfg.dataDir;
  const queueItems = memory.listQueueItems(dataDir);
  const allKb = kb.loadAllKb(dataDir);
  const alerts = loadAlertsForDate(dataDir, dateKey);
  const cursor = memory.loadCursor(dataDir) || {};
  const scope = options.scope || cfg.reportScope || 'poll_window';

  const { items, usedFallback, scopeLabel } = selectReportItems(queueItems, cursor, dateKey, scope);

  // 本轮 poll 命中次数（findings.count）；不用 queue 历史 occurrenceCount
  const findings = Array.isArray(cursor.lastPollFindings) ? cursor.lastPollFindings : [];
  const countByFp = new Map(findings.map((f) => [f.fingerprint, f.count || 1]));
  const pollCount = (item) => {
    if (countByFp.has(item.fingerprint)) return countByFp.get(item.fingerprint);
    return 1;
  };

  const rootCauseCount = items.length;
  const diagnosed = items.filter((i) => i.diagnosed);
  const pending = items.filter((i) => !i.diagnosed);

  // 本轮失败运行条数
  let failedRuns = null;
  if (findings.length && (scope === 'poll_window' || !options.scope)) {
    failedRuns = findings.reduce((s, f) => s + (f.count || 1), 0);
  }
  if (failedRuns == null && cursor.lastFailed != null && scope !== 'all' && scope !== 'calendar_day') {
    failedRuns = Number(cursor.lastFailed);
  }
  if (failedRuns == null || Number.isNaN(failedRuns)) {
    failedRuns = items.reduce((s, i) => s + pollCount(i), 0);
  }

  const ranked = [...items].sort((a, b) => pollCount(b) - pollCount(a));

  const kbById = new Map(allKb.map((k) => [k.id, k]));
  const kbByFp = new Map(allKb.map((k) => [k.fingerprint, k]));

  const categoryStats = {};
  for (const item of ranked) {
    const k = kbById.get(item.kbId) || kbByFp.get(item.fingerprint);
    const cat =
      (item.lastDiagnosis && item.lastDiagnosis.errorCategory) ||
      (k && k.errorCategory) ||
      'unknown';
    categoryStats[cat] = (categoryStats[cat] || 0) + pollCount(item);
  }

  const lines = [];
  lines.push(`【影刀每日诊断报告 ${dateKey}】`);
  lines.push('');
  lines.push(`> 报告范围：${scopeLabel}`);
  if (cursor.lastPollAt) {
    lines.push(
      `> 最近 poll：${cursor.lastPollAt}` +
        (cursor.lastScanned != null ? ` · 扫描 ${cursor.lastScanned} 条` : '') +
        (cursor.lastFailed != null ? ` · 失败 ${cursor.lastFailed} 条` : ''),
    );
  }
  lines.push('');

  if (usedFallback) {
    lines.push('> ⚠️ 已回退全量 queue，可能混入历史失败，请检查 poll 是否成功。');
    lines.push('');
  }

  lines.push(
    `本次范围内失败运行 **${failedRuns}** 条，归并为 **${rootCauseCount}** 个根因` +
      `（已诊断 ${diagnosed.length}，待诊断 ${pending.length}）。`,
  );
  lines.push('');

  if (Object.keys(categoryStats).length) {
    lines.push('### 类别分布（本轮）');
    Object.entries(categoryStats)
      .sort((a, b) => b[1] - a[1])
      .forEach(([cat, n]) => lines.push(`- ${cat}: ${n} 条`));
    lines.push('');
  }

  if (alerts.length) {
    lines.push(`### 紧急告警（${alerts.length}）`);
    alerts.slice(0, 10).forEach((a) => {
      lines.push(`- ⚠️ [${a.robotName || a.robotUuid || ''}] ${a.remark || a.type || ''}`);
    });
    lines.push('');
  }

  lines.push('### 根因清单');
  lines.push('');

  if (!ranked.length) {
    lines.push('（范围内无失败。可先 `node monitor/poll.js --once` 再生成日报。）');
  } else {
    ranked.forEach((item, idx) => {
      const entry = kbById.get(item.kbId) || kbByFp.get(item.fingerprint);
      const diag = item.lastDiagnosis || {};
      const title =
        diag.rootCause ||
        (entry && entry.rootCause) ||
        item.errorType ||
        item.rawRemark ||
        '未命名失败';
      const loc =
        diag.location ||
        (entry && entry.location) ||
        [item.robotName, item.flowName && `${item.flowName}/第${item.lineNumber || '?'}行`]
          .filter(Boolean)
          .join(' · ');
      const suggestion = diag.suggestion || (entry && entry.solution) || '（待诊断）';
      const conf = diag.confidence != null ? diag.confidence : entry && entry.confidence;
      const status = item.diagnosed
        ? entry
          ? `已入库 ${entry.id}（${entry.status || 'pending_review'}）`
          : '已诊断'
        : '⏳ 待诊断';
      const n = pollCount(item);

      lines.push(`■ ${idx + 1}. ${title}${n > 1 ? `（本轮 ${n} 条）` : ''}`);
      lines.push(`  应用：${item.robotName || item.robotUuid || '未知'}`);
      if (loc) lines.push(`  定位：${loc}`);
      if (item.errorType) {
        lines.push(
          `  类型：${item.errorType}${item.elementName ? ` / ${item.elementName}` : ''}`,
        );
      }
      lines.push(
        `  根因：${diag.rootCause || (entry && entry.rootCause) || '（待 diagnose skill 产出）'}`,
      );
      lines.push(`  建议：${suggestion}`);
      if (conf != null) lines.push(`  置信：${conf}`);
      lines.push(`  状态：${status}`);
      if (item.sampleJobUuids && item.sampleJobUuids[0]) {
        lines.push(`  样例 jobUuid：${item.sampleJobUuids[0]}`);
      }
      lines.push('');
    });
  }

  lines.push('--');
  lines.push('_Generated by RPA Monitor & Diagnosis Agent_');

  const markdown = lines.join('\n');
  let filePath = null;
  if (options.write !== false) {
    const reportsDir = memory.paths(dataDir).reportsDir;
    memory.ensureDir(reportsDir);
    filePath = path.join(reportsDir, `${dateKey}.md`);
    fs.writeFileSync(filePath, `${markdown}\n`, 'utf8');
  }

  return {
    ok: true,
    date: dateKey,
    markdown,
    filePath,
    scope: scopeLabel,
    stats: {
      failedRuns,
      rootCauseCount,
      diagnosed: diagnosed.length,
      pending: pending.length,
      alerts: alerts.length,
      usedFallback,
    },
  };
}

module.exports = {
  buildDailyReport,
  toDateKey,
  formatLocalDate,
  selectReportItems,
};
