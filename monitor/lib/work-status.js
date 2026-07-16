/**
 * Queue 人工处置态（workStatus）
 *
 * 状态：open | snoozed | ignored | resolved
 * 仅影响「优先处理」待办面；不删 queue、默认不改全量统计。
 *
 * 新失败 = 同 fingerprint 出现新的 jobUuid。
 * - snoozed + 新 job → 回 open
 * - resolved + 新 job → 回 open（处理完成但复发）
 * - ignored + 新 job → 保持 ignored（只更新失败统计）
 * - regressed / 验证复发 → 强制 open
 * - 无新 job 的 poll → 不改 workStatus
 * - snoozed 到期 → 视为 open（读时生效 + 可选写回）
 */

const WORK_STATUSES = Object.freeze({
  open: 'open',
  snoozed: 'snoozed',
  ignored: 'ignored',
  resolved: 'resolved',
});

const WORK_STATUS_LABELS = Object.freeze({
  open: '待处理',
  snoozed: '稍后处理',
  ignored: '不再提醒',
  resolved: '处理完成',
});

const DEFAULT_SNOOZE_DAYS = 3;

/**
 * @param {string|null|undefined} status
 * @returns {'open'|'snoozed'|'ignored'|'resolved'}
 */
function normalizeWorkStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  if (
    s === WORK_STATUSES.snoozed ||
    s === WORK_STATUSES.ignored ||
    s === WORK_STATUSES.resolved
  ) {
    return s;
  }
  return WORK_STATUSES.open;
}

/**
 * @param {string|null|undefined} iso
 * @param {string|Date|number} [now]
 */
function isSnoozeActive(untilIso, now = new Date()) {
  if (!untilIso) return false;
  const t = Date.parse(String(untilIso));
  if (Number.isNaN(t)) return false;
  const n = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const nowMs = Number.isNaN(n) ? Date.now() : n;
  return t > nowMs;
}

/**
 * 规范化人工处理说明（原因 / 方案）
 * @param {unknown} v
 * @param {number} [maxLen]
 */
function normalizeResolutionText(v, maxLen = 2000) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/**
 * 从条目或 opts 取处理说明字段
 * @param {object} [item]
 */
function pickResolutionFields(item = {}) {
  return {
    resolutionRootCause: normalizeResolutionText(item.resolutionRootCause),
    resolutionSolution: normalizeResolutionText(item.resolutionSolution),
    resolvedAt: item.resolvedAt || null,
  };
}

/**
 * 有效状态（读路径）：snoozed 过期 → open
 * @param {object} item queue 条目
 * @param {string|Date} [now]
 * @returns {{
 *   workStatus: string,
 *   workStatusLabel: string,
 *   snoozedUntil: string|null,
 *   effectiveOpen: boolean,
 *   snoozeExpired: boolean,
 *   ignoredStillFailing: boolean,
 *   resolutionRootCause: string,
 *   resolutionSolution: string,
 *   resolvedAt: string|null,
 * }}
 */
function resolveEffectiveWorkStatus(item = {}, now = new Date()) {
  const raw = normalizeWorkStatus(item.workStatus);
  let workStatus = raw;
  let snoozeExpired = false;

  if (raw === WORK_STATUSES.snoozed) {
    if (isSnoozeActive(item.snoozedUntil, now)) {
      workStatus = WORK_STATUSES.snoozed;
    } else {
      workStatus = WORK_STATUSES.open;
      snoozeExpired = true;
    }
  }

  const res = pickResolutionFields(item);

  return {
    workStatus,
    workStatusLabel: WORK_STATUS_LABELS[workStatus] || WORK_STATUS_LABELS.open,
    snoozedUntil: item.snoozedUntil || null,
    workStatusUpdatedAt: item.workStatusUpdatedAt || null,
    workStatusReason: item.workStatusReason || null,
    reopenedBy: item.reopenedBy || null,
    effectiveOpen: workStatus === WORK_STATUSES.open,
    snoozeExpired,
    ignoredStillFailing:
      workStatus === WORK_STATUSES.ignored && item.ignoredStillFailing === true,
    resolutionRootCause: res.resolutionRootCause,
    resolutionSolution: res.resolutionSolution,
    resolvedAt: res.resolvedAt,
  };
}

/**
 * 是否应进入「优先处理」候选（仅 open；可选滚动近 N 天有失败，1=24h）
 * @param {object} item
 * @param {{ now?: Date|string, recentDays?: number }} [opts]
 */
function isPriorityEligible(item, opts = {}) {
  const now = opts.now || new Date();
  const eff = resolveEffectiveWorkStatus(item, now);
  if (!eff.effectiveOpen) return false;

  const recentDays = opts.recentDays;
  if (recentDays != null && recentDays > 0) {
    const failIso = item.lastFailureAt || item.lastSeen || item.firstFailureAt;
    if (!failIso) return false;
    const t = Date.parse(String(failIso));
    if (Number.isNaN(t)) return false;
    const n = now instanceof Date ? now.getTime() : Date.parse(String(now));
    const nowMs = Number.isNaN(n) ? Date.now() : n;
    // recentDays=1 → 滚动 24h（非自然日 0 点）
    const windowMs = recentDays * 24 * 60 * 60 * 1000;
    if (nowMs - t > windowMs) return false;
  }
  return true;
}

/**
 * upsert 时：在已有条目 + 是否新 job 上合并 workStatus
 * @param {object|null} existing
 * @param {{ isNewJob?: boolean, forceOpen?: boolean, now?: string }} [ctx]
 * @returns {object} workStatus 相关字段
 */
function mergeWorkStatusOnUpsert(existing, ctx = {}) {
  const now = ctx.now || new Date().toISOString();
  const forceOpen = ctx.forceOpen === true;
  const isNewJob = ctx.isNewJob === true;

  if (!existing) {
    return {
      workStatus: WORK_STATUSES.open,
      snoozedUntil: null,
      workStatusUpdatedAt: null,
      workStatusReason: null,
      reopenedBy: null,
      ignoredStillFailing: false,
      resolutionRootCause: '',
      resolutionSolution: '',
      resolvedAt: null,
    };
  }

  const prevRes = pickResolutionFields(existing);

  // 先消化过期 snooze（仅字段，不强制写 reason）
  let status = normalizeWorkStatus(existing.workStatus);
  let snoozedUntil = existing.snoozedUntil || null;
  let reopenedBy = existing.reopenedBy || null;
  let workStatusReason = existing.workStatusReason || null;
  let workStatusUpdatedAt = existing.workStatusUpdatedAt || null;
  let ignoredStillFailing = existing.ignoredStillFailing === true;

  if (status === WORK_STATUSES.snoozed && !isSnoozeActive(snoozedUntil, now)) {
    status = WORK_STATUSES.open;
    snoozedUntil = null;
    // 到期自动 open，不记 reopenedBy（与新 job 区分）
  }

  if (forceOpen) {
    return {
      workStatus: WORK_STATUSES.open,
      snoozedUntil: null,
      workStatusUpdatedAt: now,
      workStatusReason: 'regressed',
      reopenedBy: 'regressed',
      ignoredStillFailing: false,
      // 保留历史处理说明，便于对照「以为修好了」
      resolutionRootCause: prevRes.resolutionRootCause,
      resolutionSolution: prevRes.resolutionSolution,
      resolvedAt: prevRes.resolvedAt,
    };
  }

  if (isNewJob) {
    if (status === WORK_STATUSES.snoozed || status === WORK_STATUSES.resolved) {
      status = WORK_STATUSES.open;
      snoozedUntil = null;
      reopenedBy = 'new_job';
      workStatusReason = 'new_job';
      workStatusUpdatedAt = now;
      ignoredStillFailing = false;
    } else if (status === WORK_STATUSES.ignored) {
      // 保持 ignored，标记仍在失败
      ignoredStillFailing = true;
      // 不改 workStatusUpdatedAt / reopenedBy
    } else {
      // open：保持
      ignoredStillFailing = false;
    }
  }

  return {
    workStatus: status,
    snoozedUntil,
    workStatusUpdatedAt,
    workStatusReason,
    reopenedBy,
    ignoredStillFailing,
    resolutionRootCause: prevRes.resolutionRootCause,
    resolutionSolution: prevRes.resolutionSolution,
    resolvedAt: prevRes.resolvedAt,
  };
}

/**
 * 人工状态迁移是否允许。
 * resolved 为人工终态：仅允许保持 resolved（补说明）或 open（恢复待处理）；
 * 不可再改为 snoozed / ignored。新 job / regressed 的自动拉回走 merge，不经此校验。
 *
 * @param {string|null|undefined} fromStatus
 * @param {string|null|undefined} toStatus
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function assertManualTransition(fromStatus, toStatus) {
  const from = normalizeWorkStatus(fromStatus);
  const to = normalizeWorkStatus(toStatus);
  if (
    from === WORK_STATUSES.resolved &&
    to !== WORK_STATUSES.resolved &&
    to !== WORK_STATUSES.open
  ) {
    return {
      ok: false,
      code: 'terminal_resolved',
      message:
        '处理完成是终态，不能改为稍后/不再提醒。可点「恢复待处理」，或等同指纹新失败自动拉回。',
    };
  }
  return { ok: true };
}

/**
 * 人工设置 workStatus
 * @param {object} item 现有 queue
 * @param {'open'|'snoozed'|'ignored'|'resolved'} status
 * @param {{
 *   snoozeDays?: number,
 *   snoozedUntil?: string,
 *   reason?: string,
 *   now?: string,
 *   rootCause?: string,
 *   solution?: string,
 *   resolutionRootCause?: string,
 *   resolutionSolution?: string,
 * }} [opts]
 */
function applyManualWorkStatus(item, status, opts = {}) {
  const now = opts.now || new Date().toISOString();
  const nextStatus = normalizeWorkStatus(status);
  const base = { ...(item || {}) };
  const prev = normalizeWorkStatus(base.workStatus);
  const prevRes = pickResolutionFields(base);

  // 入参优先 rootCause/solution；未传则保留旧说明
  const hasRoot =
    opts.rootCause != null || opts.resolutionRootCause != null;
  const hasSol =
    opts.solution != null || opts.resolutionSolution != null;
  const nextRoot = hasRoot
    ? normalizeResolutionText(
        opts.rootCause != null ? opts.rootCause : opts.resolutionRootCause,
      )
    : prevRes.resolutionRootCause;
  const nextSol = hasSol
    ? normalizeResolutionText(
        opts.solution != null ? opts.solution : opts.resolutionSolution,
      )
    : prevRes.resolutionSolution;

  if (nextStatus === WORK_STATUSES.snoozed) {
    let until = opts.snoozedUntil || null;
    if (!until) {
      const days =
        opts.snoozeDays > 0 ? Number(opts.snoozeDays) : DEFAULT_SNOOZE_DAYS;
      const d = new Date(now);
      d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
      until = d.toISOString();
    }
    return {
      ...base,
      workStatus: WORK_STATUSES.snoozed,
      snoozedUntil: until,
      workStatusUpdatedAt: now,
      workStatusReason: opts.reason || 'manual_snooze',
      reopenedBy: null,
      ignoredStillFailing: false,
      resolutionRootCause: nextRoot,
      resolutionSolution: nextSol,
      resolvedAt: prevRes.resolvedAt,
    };
  }

  if (nextStatus === WORK_STATUSES.ignored) {
    return {
      ...base,
      workStatus: WORK_STATUSES.ignored,
      snoozedUntil: null,
      workStatusUpdatedAt: now,
      workStatusReason: opts.reason || 'manual_ignore',
      reopenedBy: null,
      ignoredStillFailing: false,
      resolutionRootCause: nextRoot,
      resolutionSolution: nextSol,
      resolvedAt: prevRes.resolvedAt,
    };
  }

  if (nextStatus === WORK_STATUSES.resolved) {
    // 处理完成：写说明（可空）；新失败会拉回 open
    return {
      ...base,
      workStatus: WORK_STATUSES.resolved,
      snoozedUntil: null,
      workStatusUpdatedAt: now,
      workStatusReason: opts.reason || 'manual_resolve',
      reopenedBy: null,
      ignoredStillFailing: false,
      resolutionRootCause: nextRoot,
      resolutionSolution: nextSol,
      resolvedAt: now,
    };
  }

  // open（从 resolved 恢复时记 manual reopen）
  const fromResolved = prev === WORK_STATUSES.resolved;
  return {
    ...base,
    workStatus: WORK_STATUSES.open,
    snoozedUntil: null,
    workStatusUpdatedAt: now,
    workStatusReason:
      opts.reason || (fromResolved ? 'manual_reopen' : 'manual_open'),
    reopenedBy: fromResolved ? 'manual' : null,
    ignoredStillFailing: false,
    resolutionRootCause: nextRoot,
    resolutionSolution: nextSol,
    resolvedAt: prevRes.resolvedAt,
  };
}

/**
 * regressed 时强制 open（写盘字段片段）
 */
function forceOpenFields(reason = 'regressed', now = new Date().toISOString()) {
  return {
    workStatus: WORK_STATUSES.open,
    snoozedUntil: null,
    workStatusUpdatedAt: now,
    workStatusReason: reason,
    reopenedBy: reason,
    ignoredStillFailing: false,
  };
}

module.exports = {
  WORK_STATUSES,
  WORK_STATUS_LABELS,
  DEFAULT_SNOOZE_DAYS,
  normalizeWorkStatus,
  isSnoozeActive,
  normalizeResolutionText,
  pickResolutionFields,
  resolveEffectiveWorkStatus,
  isPriorityEligible,
  mergeWorkStatusOnUpsert,
  assertManualTransition,
  applyManualWorkStatus,
  forceOpenFields,
};
