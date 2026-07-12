/**
 * S10b：跨应用根因归并
 * 主键：errorSignature（不含 robotUuid，见 fingerprint.makeErrorSignature）
 * queue 文件名仍按 fingerprint，不改磁盘语义。
 */

/**
 * @param {object[]} items queue 条目（需含 errorSignature / fingerprint / robot*）
 * @param {{ minApps?: number, countFn?: (item: object) => number }} [opts]
 * @returns {Array<{
 *   errorSignature: string,
 *   flowName: string,
 *   errorType: string,
 *   elementName: string,
 *   rootCauseHint: string,
 *   totalCount: number,
 *   appCount: number,
 *   affectedApps: Array<{ robotUuid: string, robotName: string, fingerprints: string[], count: number }>,
 *   fingerprints: string[],
 *   sampleFingerprint: string,
 *   lastSeen: string|null,
 * }>}
 */
function mergeByErrorSignature(items, opts = {}) {
  const minApps = opts.minApps != null ? opts.minApps : 2;
  const countFn = opts.countFn || (() => 1);
  const map = new Map();

  for (const it of items || []) {
    const sig = String(it.errorSignature || '').trim();
    if (!sig || sig === 'unknown-flow|unknown-error|-') {
      // 特征过弱：不归并
      continue;
    }
    let g = map.get(sig);
    if (!g) {
      g = {
        errorSignature: sig,
        flowName: it.flowName || '',
        errorType: it.errorType || '',
        elementName: it.elementName || '',
        rootCauseHint: '',
        totalCount: 0,
        appMap: new Map(),
        fingerprints: [],
        lastSeen: null,
      };
      map.set(sig, g);
    }
    const n = countFn(it) || 1;
    g.totalCount += n;
    if (!g.flowName && it.flowName) g.flowName = it.flowName;
    if (!g.errorType && it.errorType) g.errorType = it.errorType;
    if (!g.elementName && it.elementName) g.elementName = it.elementName;
    if (!g.rootCauseHint && it.lastDiagnosis && it.lastDiagnosis.rootCause) {
      g.rootCauseHint = it.lastDiagnosis.rootCause;
    }
    if (it.fingerprint && !g.fingerprints.includes(it.fingerprint)) {
      g.fingerprints.push(it.fingerprint);
    }
    if (!g.lastSeen || String(it.lastSeen || '') > String(g.lastSeen || '')) {
      g.lastSeen = it.lastSeen || null;
    }

    const rid = it.robotUuid || 'unknown';
    let app = g.appMap.get(rid);
    if (!app) {
      app = {
        robotUuid: rid,
        robotName: it.robotName || rid,
        fingerprints: [],
        count: 0,
      };
      g.appMap.set(rid, app);
    }
    if (!app.robotName && it.robotName) app.robotName = it.robotName;
    app.count += n;
    if (it.fingerprint && !app.fingerprints.includes(it.fingerprint)) {
      app.fingerprints.push(it.fingerprint);
    }
  }

  const groups = [];
  for (const g of map.values()) {
    const affectedApps = [...g.appMap.values()].sort((a, b) => b.count - a.count);
    if (affectedApps.length < minApps) continue;
    groups.push({
      errorSignature: g.errorSignature,
      flowName: g.flowName,
      errorType: g.errorType,
      elementName: g.elementName,
      rootCauseHint: g.rootCauseHint,
      totalCount: g.totalCount,
      appCount: affectedApps.length,
      affectedApps,
      fingerprints: g.fingerprints,
      sampleFingerprint: g.fingerprints[0] || '',
      lastSeen: g.lastSeen,
    });
  }

  groups.sort((a, b) => {
    if (b.appCount !== a.appCount) return b.appCount - a.appCount;
    if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
    return String(b.lastSeen || '').localeCompare(String(a.lastSeen || ''));
  });

  return groups;
}

/**
 * 从 signature 拆出可读字段（best-effort）
 */
function parseErrorSignature(sig) {
  const parts = String(sig || '').split('|');
  return {
    flowName: parts[0] || '',
    errorType: parts[1] || '',
    elementName: parts[2] === '-' ? '' : parts[2] || '',
  };
}

/**
 * 为 KB 写入合并 affectedApps 列表（uuid 数组）
 */
function affectedAppUuids(group) {
  return (group.affectedApps || []).map((a) => a.robotUuid).filter(Boolean);
}

module.exports = {
  mergeByErrorSignature,
  parseErrorSignature,
  affectedAppUuids,
};
