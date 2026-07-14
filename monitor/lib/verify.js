/**
 * S18：修复验证闭环
 * apply 后 → fixed_pending_verify
 * 同 fingerprint 再出现 → regressed（建议 rollback）
 * 静默 quietDays 天无再出现 → verified
 */

const path = require('path');
const memory = require('./memory');
const kb = require('./kb');
const patchLib = require('./patch');

function getVerifyConfig(cfg = {}) {
  const m = (cfg.maintain && cfg.maintain.verify) || {};
  const quietDays = parseInt(
    String(
      process.env.MAINTAIN_VERIFY_QUIET_DAYS ||
        m.quietDays ||
        3,
    ),
    10,
  );
  return {
    quietDays: Number.isFinite(quietDays) && quietDays > 0 ? quietDays : 3,
  };
}

function daysBetween(isoA, isoB) {
  const a = Date.parse(isoA || '');
  const b = Date.parse(isoB || '');
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return (b - a) / (24 * 60 * 60 * 1000);
}

/**
 * apply 成功后：进入待验证
 * @param {string} dataDir
 * @param {string} patchId
 * @param {{ fingerprint?: string, kbId?: string }} [extra]
 */
function markPatchPendingVerify(dataDir, patchId, extra = {}) {
  const loaded = patchLib.loadPatch(dataDir, patchId);
  if (!loaded) return { ok: false, error: 'patch_not_found' };
  const { root, meta } = loaded;
  if (meta.status !== 'applied' && meta.status !== 'fixed_pending_verify') {
    // 允许从 applied 进入；若已是 pending 则刷新时间
    if (meta.status !== 'applied') {
      return { ok: false, error: `bad_status:${meta.status}` };
    }
  }

  meta.status = 'fixed_pending_verify';
  meta.verify = {
    ...(meta.verify || {}),
    startedAt: meta.verify?.startedAt || meta.appliedAt || new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    quietDaysRequired: extra.quietDaysRequired || meta.verify?.quietDaysRequired || null,
    fingerprint: extra.fingerprint || meta.fingerprint || null,
    kbId: extra.kbId || meta.verify?.kbId || null,
    regressedAt: null,
    verifiedAt: null,
  };
  if (extra.fingerprint) meta.fingerprint = extra.fingerprint;
  memory.atomicWriteJson(path.join(root, 'meta.json'), meta);

  // queue 侧记一笔，便于工作台/排查
  const fp = meta.fingerprint;
  if (fp) {
    const q = memory.loadQueueItem(dataDir, fp);
    if (q) {
      const next = {
        ...q,
        fixStatus: 'fixed_pending_verify',
        lastPatchId: patchId,
        fixedAt: meta.appliedAt || new Date().toISOString(),
      };
      memory.atomicWriteJson(memory.queuePath(dataDir, fp), next);
    }
  }

  if (meta.verify.kbId || extra.kbId) {
    try {
      kb.writeKb(dataDir, {
        id: meta.verify.kbId || extra.kbId,
        fingerprint: fp,
        status: 'fixed_pending_verify',
        notes: `patch ${patchId} applied, awaiting verification`,
      });
    } catch {
      // ignore kb miss
    }
  } else if (fp) {
    // 按 fingerprint 更新已有 KB
    try {
      kb.writeKb(dataDir, {
        fingerprint: fp,
        status: 'fixed_pending_verify',
        notes: `patch ${patchId} applied, awaiting verification`,
      });
    } catch {
      // ignore
    }
  }

  return { ok: true, meta };
}

/**
 * 同指纹再次入队（poll 发现失败）→ regressed
 * @param {string} dataDir
 * @param {string} fingerprint
 * @param {{ jobUuid?: string, now?: string }} [ctx]
 */
function onFingerprintRecurred(dataDir, fingerprint, ctx = {}) {
  if (!fingerprint) return null;
  const pending = patchLib
    .listPatches(dataDir)
    .filter(
      (p) =>
        p.fingerprint === fingerprint &&
        (p.status === 'fixed_pending_verify' || p.status === 'applied'),
    );
  if (!pending.length) return null;

  const now = ctx.now || new Date().toISOString();
  const results = [];

  for (const p of pending) {
    const loaded = patchLib.loadPatch(dataDir, p.patchId);
    if (!loaded) continue;
    const { root, meta } = loaded;
    // applied 但未 mark pending 的也标 regressed
    meta.status = 'regressed';
    meta.verify = {
      ...(meta.verify || {}),
      regressedAt: now,
      lastCheckedAt: now,
      lastRegressJobUuid: ctx.jobUuid || null,
      suggestion: '建议 maintain rollback --patch ' + meta.patchId,
    };
    memory.atomicWriteJson(path.join(root, 'meta.json'), meta);

    const q = memory.loadQueueItem(dataDir, fingerprint);
    if (q) {
      // eslint-disable-next-line global-require
      const workStatusLib = require('./work-status');
      memory.atomicWriteJson(memory.queuePath(dataDir, fingerprint), {
        ...q,
        fixStatus: 'regressed',
        lastPatchId: meta.patchId,
        regressedAt: now,
        // 验证复发：强制 open，盖过 snoozed / ignored
        ...workStatusLib.forceOpenFields('regressed', now),
      });
    }

    try {
      kb.writeKb(dataDir, {
        fingerprint,
        status: 'regressed',
        notes: `fingerprint recurred after patch ${meta.patchId}; consider rollback`,
      });
    } catch {
      // ignore
    }

    results.push({
      patchId: meta.patchId,
      status: 'regressed',
      message: `修复后复发，建议 rollback: node monitor/agent.js maintain rollback --patch ${meta.patchId}`,
    });
  }

  return results.length ? { ok: true, regressed: results } : null;
}

/**
 * 检查待验证 patch：静默 quietDays 天无复发 → verified
 * @param {string} dataDir
 * @param {{ quietDays?: number, now?: string }} [opts]
 */
function tickVerification(dataDir, opts = {}) {
  const quietDays = opts.quietDays || 3;
  const now = opts.now || new Date().toISOString();
  const pending = patchLib.listPatches(dataDir).filter((p) => p.status === 'fixed_pending_verify');
  const verified = [];
  const stillPending = [];

  for (const p of pending) {
    const started = p.verify?.startedAt || p.appliedAt || p.createdAt;
    const elapsed = daysBetween(started, now);
    const fp = p.fingerprint;

    // 复发只由 afterQueueUpsert(isNewJob) 标记；此处仅做静默期满 → verified
    if (elapsed >= quietDays) {
      const loaded = patchLib.loadPatch(dataDir, p.patchId);
      if (!loaded) continue;
      const { root, meta } = loaded;
      // 若期间已被标 regressed 则跳过
      if (meta.status !== 'fixed_pending_verify') continue;
      meta.status = 'verified';
      meta.verify = {
        ...(meta.verify || {}),
        verifiedAt: now,
        lastCheckedAt: now,
        quietDays,
      };
      memory.atomicWriteJson(path.join(root, 'meta.json'), meta);

      if (fp) {
        const qi = memory.loadQueueItem(dataDir, fp);
        if (qi) {
          memory.atomicWriteJson(memory.queuePath(dataDir, fp), {
            ...qi,
            fixStatus: 'verified',
            lastPatchId: meta.patchId,
            verifiedAt: now,
          });
        }
        try {
          kb.writeKb(dataDir, {
            fingerprint: fp,
            status: 'verified',
            notes: `patch ${meta.patchId} verified after ${quietDays} quiet day(s)`,
          });
        } catch {
          // ignore
        }
      }
      verified.push({ patchId: meta.patchId, fingerprint: fp, quietDays });
    } else {
      stillPending.push({
        patchId: p.patchId,
        fingerprint: fp,
        daysElapsed: Number(elapsed.toFixed(2)),
        quietDaysRequired: quietDays,
      });
    }
  }

  return {
    ok: true,
    quietDays,
    verified,
    pending: stillPending,
    checked: pending.length,
  };
}

/**
 * poll 入队后调用：仅当 isNewJob 且存在待验证/已 apply patch 时标 regressed
 * （避免同一时间窗重扫历史失败误报）
 */
function afterQueueUpsert(dataDir, fingerprint, meta = {}) {
  if (!fingerprint) return null;
  if (!meta.isNewJob) return null;

  const patches = patchLib.listPatches(dataDir).filter(
    (p) =>
      p.fingerprint === fingerprint &&
      (p.status === 'fixed_pending_verify' || p.status === 'applied'),
  );
  if (!patches.length) return null;

  const appliedAt = patches
    .map((p) => p.appliedAt)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];
  if (!appliedAt) return null;

  return onFingerprintRecurred(dataDir, fingerprint, {
    jobUuid: meta.jobUuid,
    now: meta.now || new Date().toISOString(),
  });
}

module.exports = {
  getVerifyConfig,
  markPatchPendingVerify,
  onFingerprintRecurred,
  tickVerification,
  afterQueueUpsert,
  daysBetween,
};
