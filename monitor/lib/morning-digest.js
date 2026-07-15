/**
 * 晨间摘要：从 queue / priority 生成钉钉 Markdown
 * 每天固定一条；无异常也发（区分服务挂了 vs 真无失败）
 */

const settingsDingtalk = require('./settings-dingtalk');
const notify = require('./notify-dingtalk');
const workStatusLib = require('./work-status');
const bucketLib = require('./bucket');
const memory = require('./memory');

/**
 * @param {Date|string|number} [now]
 */
function localDateLabel(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
}

/**
 * @param {object} item
 * @param {number} recentDays
 * @param {Date} now
 */
function inRecentWindow(item, recentDays, now) {
  if (recentDays == null || recentDays <= 0) return true;
  return workStatusLib.isPriorityEligible(
    { ...item, workStatus: 'open' },
    { now, recentDays },
  );
}

/**
 * 构建摘要正文（不发送）
 * @param {object} cfg
 * @param {{ recentDays?: number, topN?: number, now?: Date }} [opts]
 * @returns {{ title: string, text: string, stats: object }}
 */
function buildMorningDigest(cfg, opts = {}) {
  const now = opts.now || new Date();
  const recentDays =
    opts.recentDays != null ? Number(opts.recentDays) : 1;
  const topN = opts.topN > 0 ? Math.min(Number(opts.topN), 30) : 8;

  const queueItems = memory.listQueueItems(cfg.dataDir) || [];
  const windowItems = queueItems.filter((it) => inRecentWindow(it, recentDays, now));

  let undiagnosed = 0;
  let openCount = 0;
  let snoozed = 0;
  let ignored = 0;
  const byBucket = {};
  for (const it of windowItems) {
    if (!it.diagnosed) undiagnosed += 1;
    const eff = workStatusLib.resolveEffectiveWorkStatus(it, now);
    if (eff.workStatus === 'snoozed') snoozed += 1;
    else if (eff.workStatus === 'ignored') ignored += 1;
    else openCount += 1;
    try {
      const b = bucketLib.classifyBucket(it).bucket;
      byBucket[b] = (byBucket[b] || 0) + 1;
    } catch {
      byBucket.unknown = (byBucket.unknown || 0) + 1;
    }
  }

  const devN =
    (byBucket.code || 0) + (byBucket.element || 0) + (byBucket.data_config || 0);
  const opsN = (byBucket.env_robot || 0) + (byBucket.schedule || 0);

  // 优先候选：open + 窗口内 + 有失败时间，按失败时间新→旧，再按 occurrence
  const openItems = windowItems
    .filter((it) => workStatusLib.isPriorityEligible(it, { now, recentDays: recentDays > 0 ? recentDays : undefined }))
    .sort((a, b) => {
      const ta = String(a.lastFailureAt || a.lastSeen || '');
      const tb = String(b.lastFailureAt || b.lastSeen || '');
      if (tb !== ta) return tb.localeCompare(ta);
      return (Number(b.occurrenceCount) || 0) - (Number(a.occurrenceCount) || 0);
    });

  const top = openItems.slice(0, topN);
  const windowLabel =
    recentDays === 0 ? '不限时间' : recentDays === 1 ? '近 24 小时' : `近 ${recentDays} 天`;
  const dateStr = localDateLabel(now);
  const title = `RPA 晨间 · ${dateStr.slice(0, 10)}`;

  const lines = [];
  lines.push(`### RPA 晨间汇报`);
  lines.push(``);
  lines.push(`**时间** ${dateStr}  ·  **窗口** ${windowLabel}`);
  lines.push(``);

  if (windowItems.length === 0) {
    lines.push(`✅ **无异常**：${windowLabel}内 queue 无失败指纹。`);
    lines.push(``);
    lines.push(`（本条为固定日报；若连续多天收不到，请检查本机 service 是否在跑。）`);
  } else {
    lines.push(
      `**概况** 失败指纹 **${windowItems.length}** · 待处理 open **${openCount}** · 未诊断 **${undiagnosed}**`,
    );
    lines.push(
      `可开发 ${devN} · 环境/调度 ${opsN} · 稍后 ${snoozed} · 不提醒 ${ignored}`,
    );
    lines.push(``);

    if (top.length === 0) {
      lines.push(`优先列表为空（窗口内失败均已「稍后/不再提醒」）。`);
    } else {
      lines.push(`**待处理明细（前 ${topN} 条）**`);
      top.forEach((it, i) => {
        const app = String(it.robotName || it.robotUuid || '未知应用').trim();
        const robot = String(it.robotClientName || '').trim();
        const flow =
          it.flowName && !/^(unknown-flow|no-flow|调度层)$/i.test(String(it.flowName))
            ? String(it.flowName).trim()
            : '';
        const err = String(it.errorType || '失败').trim();
        const bits = [flow, err, app].filter(Boolean);
        const head = bits.join(' · ') || it.fingerprint;
        const meta = [
          robot ? `机器人 ${robot}` : '',
          it.occurrenceCount > 1 ? `${it.occurrenceCount} 次` : '',
          !it.diagnosed ? '未诊断' : '',
        ]
          .filter(Boolean)
          .join(' · ');
        lines.push(`${i + 1}. ${head}${meta ? `  \n   ${meta}` : ''}`);
      });
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(`本机工作台：http://127.0.0.1:${cfg.healthPort || 8787}/`);
  lines.push(`（仅开发机可打开；详细诊断请用 Web 工作台）`);

  return {
    title,
    text: lines.join('\n'),
    stats: {
      windowLabel,
      total: windowItems.length,
      open: openCount,
      undiagnosed,
      snoozed,
      ignored,
      dev: devN,
      ops: opsN,
      topCount: top.length,
      healthy: windowItems.length === 0,
    },
  };
}

/**
 * 发送晨间摘要（enabled 校验；force 可绕过 enabled 做测试）
 * @param {object} cfg
 * @param {{ force?: boolean, recentDays?: number, topN?: number }} [opts]
 */
async function sendMorningDigest(cfg, opts = {}) {
  const dataDir = cfg.dataDir;
  const runtime = settingsDingtalk.getRuntimeConfig(dataDir);

  if (!opts.force && !runtime.enabled) {
    return {
      ok: false,
      code: 'disabled',
      message: '钉钉晨报未启用（设置页打开开关）',
      skipped: true,
    };
  }
  if (!runtime.webhookUrl) {
    return {
      ok: false,
      code: 'not_configured',
      message: '未配置钉钉 Webhook',
      skipped: true,
    };
  }

  const recentDays =
    opts.recentDays != null ? Number(opts.recentDays) : runtime.recentDays;
  const topN = opts.topN != null ? Number(opts.topN) : runtime.topN;
  const digest = buildMorningDigest(cfg, { recentDays, topN });

  // @：有手机号或 @所有人时启用；atAlways=false 时仅有失败才 @
  const shouldAt =
    runtime.atAlways !== false || !(digest.stats && digest.stats.healthy);
  const at =
    shouldAt && (runtime.atAll || (runtime.atMobiles && runtime.atMobiles.length))
      ? { atMobiles: runtime.atMobiles || [], atAll: runtime.atAll === true }
      : null;

  const result = await notify.sendMarkdown(
    { webhookUrl: runtime.webhookUrl, secret: runtime.secret },
    { title: digest.title, text: digest.text, at },
  );

  try {
    settingsDingtalk.recordSendResult(dataDir, {
      ok: result.ok === true,
      error: result.ok ? null : result.message || result.code,
    });
  } catch {
    /* ignore record errors */
  }

  return {
    ...result,
    title: digest.title,
    stats: digest.stats,
    preview: digest.text.slice(0, 400),
  };
}

module.exports = {
  buildMorningDigest,
  sendMorningDigest,
  localDateLabel,
};
