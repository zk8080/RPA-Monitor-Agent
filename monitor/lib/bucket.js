/**
 * 失败噪声分流（技术向 bucket，非组织 fixOwner）
 *
 * 用途：工作台筛选 / 交接提示 / 统计，把「机器人未连接」等与可开发处理类分开。
 * 运行时计算，不改 queue 磁盘主键。
 *
 * 规则要点：
 * - element：元素找不到/不唯一等 → 不打「代码」
 * - code：仅 py 脚本 / 变量与边界类（IndexError、None 守卫等）
 */

const BUCKETS = Object.freeze({
  env_robot: 'env_robot',
  schedule: 'schedule',
  element: 'element',
  code: 'code',
  data_config: 'data_config',
  unknown: 'unknown',
});

const BUCKET_LABELS = Object.freeze({
  env_robot: '机器人/环境',
  schedule: '调度',
  element: '元素',
  code: '代码',
  data_config: '数据/配置',
  unknown: '未分类',
});

/**
 * 默认可开发处理（筛选「可开发」）
 * 含：py 代码、元素定位、数据配置 —— 不含机器人/调度
 */
const DEV_ACTIONABLE = new Set([BUCKETS.code, BUCKETS.element, BUCKETS.data_config]);

/** 偏运维 / 环境 */
const OPS_BUCKETS = new Set([BUCKETS.env_robot, BUCKETS.schedule]);

/** 元素定位类文案（不归 code） */
const ELEMENT_RE =
  /匹配到多个元素|未找到元素|找不到元素|元素未找到|元素定位|元素.*(不存在|失效|超时)|selector|选择器/i;

/** 仅 py / 变量 / 边界类（代码） */
const CODE_RE =
  /IndexError|list index out of range|索引越界|下标越界|NoneType|AttributeError|SyntaxError|IndentationError|TabError|Traceback|NameError|TypeError|KeyError|ValueError|ZeroDivisionError|\.py\b|File ".*\.py"/i;

/**
 * @param {object} item queue 条目或类似字段
 * @param {{ fixClass?: string, fixability?: string }|null} [triage]
 * @returns {{
 *   bucket: string,
 *   label: string,
 *   actionable: 'ops'|'dev'|'either',
 *   reason: string,
 * }}
 */
function classifyBucket(item = {}, triage = null) {
  const errorType = String(item.errorType || '');
  const rawRemark = String(item.rawRemark || '');
  const flowName = String(item.flowName || '');
  const elementName = String(item.elementName || '');
  const errorSignature = String(item.errorSignature || '');
  const fixClass = String(
    (triage && triage.fixClass) || item.fixClass || item.lastDiagnosis?.fixClass || '',
  );

  const blob = `${errorType}\n${rawRemark}\n${elementName}\n${errorSignature}\n${flowName}`.slice(
    0,
    4000,
  );
  const sigOrFlow = `${errorSignature} ${flowName}`;

  // 1) 机器人连接类
  if (
    /机器人未连接|机器人断连|机器人.*离线|客户端.*未连接|客户端.*离线/.test(blob) ||
    (/未连接|断连/.test(errorType) && /机器人|客户端|调度层/.test(blob))
  ) {
    return hit(BUCKETS.env_robot, '规则：机器人/客户端未连接或断连');
  }

  // 2) 调度层
  if (
    /任务等待运行超时|未分配空闲机器人/.test(blob) ||
    /调度层/.test(sigOrFlow) ||
    (/^调度层/.test(errorSignature) && /超时|未连接|未分配/.test(blob))
  ) {
    if (/未连接|断连|离线/.test(blob) && !/任务等待|未分配/.test(blob)) {
      return hit(BUCKETS.env_robot, '规则：调度特征且连接类文案');
    }
    return hit(BUCKETS.schedule, '规则：调度层 / 任务等待 / 未分配机器人');
  }

  // 3) 分诊 class（element 与 code 严格分开）
  if (fixClass === 'element') {
    return hit(BUCKETS.element, '分诊：fixClass=element');
  }
  if (fixClass === 'config') {
    return hit(BUCKETS.data_config, '分诊：fixClass=config');
  }
  if (fixClass === 'code_boundary' || fixClass === 'null_guard') {
    return hit(BUCKETS.code, `分诊：fixClass=${fixClass}`);
  }

  // 4) 元素定位（在 code 之前，避免误归代码）
  if (ELEMENT_RE.test(blob)) {
    return hit(BUCKETS.element, '规则：元素定位/选择器');
  }

  // 5) 数据/配置
  if (
    /空路径|path is empty|empty path|FileNotFoundError|文件不存在|No such file|找不到文件/i.test(
      blob,
    ) ||
    /配置.*(缺失|错误|为空)|路径为空/.test(blob)
  ) {
    return hit(BUCKETS.data_config, '规则：路径/文件/配置类文案');
  }

  // 6) 代码：仅 py / 变量 / 边界异常
  if (CODE_RE.test(blob)) {
    return hit(BUCKETS.code, '规则：Python/变量/边界类异常');
  }

  // 7) 泛化环境超时
  if (fixClass === 'env' || /超时|timeout|网络异常|连接失败|ECONNREFUSED/i.test(blob)) {
    return hit(BUCKETS.unknown, '规则：环境/超时（未归入机器人或调度）');
  }

  return hit(BUCKETS.unknown, fixClass ? `分诊：fixClass=${fixClass}` : '规则：未命中');
}

/**
 * @param {string} bucket
 */
function hit(bucket, reason) {
  const b = BUCKETS[bucket] ? bucket : BUCKETS.unknown;
  return {
    bucket: b,
    label: BUCKET_LABELS[b] || BUCKET_LABELS.unknown,
    actionable: OPS_BUCKETS.has(b) ? 'ops' : DEV_ACTIONABLE.has(b) ? 'dev' : 'either',
    reason,
  };
}

/**
 * @param {string} bucket
 * @returns {boolean}
 */
function isDevActionable(bucket) {
  return DEV_ACTIONABLE.has(bucket);
}

/**
 * @param {Array<{ bucket?: string }|object>} items
 * @param {{ triageOf?: (it: object) => object|null }} [opts]
 */
function aggregateBuckets(items, opts = {}) {
  const byBucket = {
    [BUCKETS.env_robot]: 0,
    [BUCKETS.schedule]: 0,
    [BUCKETS.element]: 0,
    [BUCKETS.code]: 0,
    [BUCKETS.data_config]: 0,
    [BUCKETS.unknown]: 0,
  };
  let total = 0;
  for (const it of items || []) {
    if (!it) continue;
    total += 1;
    let b = it.bucket;
    if (!b) {
      const tri =
        typeof opts.triageOf === 'function' ? opts.triageOf(it) : it.fixClass ? it : null;
      b = classifyBucket(it, tri).bucket;
    }
    if (byBucket[b] == null) byBucket[BUCKETS.unknown] += 1;
    else byBucket[b] += 1;
  }
  return { total, byBucket, labels: { ...BUCKET_LABELS } };
}

/**
 * @param {object[]} items
 * @param {string} filter all|dev|ops|bucket id
 */
function filterByBucket(items, filter) {
  const f = String(filter || 'all').trim();
  if (!f || f === 'all') return items || [];
  if (f === 'dev') return (items || []).filter((it) => isDevActionable(it.bucket));
  if (f === 'ops') return (items || []).filter((it) => OPS_BUCKETS.has(it.bucket));
  return (items || []).filter((it) => it.bucket === f);
}

/** 可开发指纹数（code + element + data_config） */
function countDevActionable(byBucket = {}) {
  return (
    (byBucket.code || 0) + (byBucket.element || 0) + (byBucket.data_config || 0)
  );
}

function countOpsNoise(byBucket = {}) {
  return (byBucket.env_robot || 0) + (byBucket.schedule || 0);
}

module.exports = {
  BUCKETS,
  BUCKET_LABELS,
  DEV_ACTIONABLE,
  OPS_BUCKETS,
  ELEMENT_RE,
  CODE_RE,
  classifyBucket,
  isDevActionable,
  aggregateBuckets,
  filterByBucket,
  countDevActionable,
  countOpsNoise,
};
