/**
 * 错误指纹：queue 主键 / 去重 / KB 命中基础
 *
 * 指纹 = robotUuid + flowName + 错误类型 + 元素名/文件名特征
 * 输入优先级：① remark 正则 ② 日志 level=错误 的 flowName/lineNumber/text
 */

const crypto = require('crypto');

const FAIL_STATUSES = new Set(['error', 'stopped', 'fail']);

const URGENT_PATTERNS = [
  /断连/,
  /未连接/,
  /鉴权/,
  /登录失败/,
  /认证失败/,
  /token.*(失效|过期)/i,
  /机器人.*(离线|断开)/,
];

/** 常见错误类型关键词（长词优先匹配；调度类须在泛化「超时」之前） */
const ERROR_TYPE_PATTERNS = [
  /匹配到多个元素/,
  /元素未找到|找不到元素|未找到元素/,
  /元素.*(不存在|失效|超时)/,
  /文件被占用|文件正在使用|Sharing violation/i,
  /文件不存在|找不到文件|No such file/i,
  /任务等待运行超时/,
  /未分配空闲机器人/,
  /机器人未连接|机器人断连/,
  /登录失败|鉴权失败/,
  /断连|未连接/,
  /超时|timeout/i,
  /网络异常|连接失败|ECONNREFUSED/i,
  /权限不足|拒绝访问|Access is denied/i,
  /Excel.*(打开|占用|损坏)/i,
];

/**
 * @param {string} text
 * @returns {string}
 */
function normalizeFeature(text) {
  if (!text) return '';
  return String(text)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '')
    .replace(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}([日\sT]\d{1,2}:\d{2}(:\d{2})?)?/g, '')
    .replace(/[A-Za-z]:\\[^\s，,;；]+/g, (p) => {
      const base = p.split(/[/\\]/).pop() || '';
      return base;
    })
    .replace(/\/[^\s，,;；]+/g, (p) => {
      const base = p.split('/').pop() || '';
      return base;
    })
    .replace(/\d{6,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 remark 解析定位信息
 * 例：【uuid】任务失败，在【获取发票税金号】中第35行：出错：匹配到多个元素... 元素名: 发票方案号
 * @param {string} remark
 */
function parseRemark(remark) {
  const raw = remark || '';
  let flowName = '';
  let lineNumber = '';
  let errorType = '';
  let elementName = '';

  // 优先「在【子流程】中第N行」；避免匹配 remark 前缀的【jobUuid】
  const flowInContext = raw.match(/在【([^】]+)】中/);
  if (flowInContext) {
    flowName = flowInContext[1].trim();
  } else {
    const brackets = [...raw.matchAll(/【([^】]+)】/g)].map((m) => m[1].trim());
    const nonUuid = brackets.find((b) => !/^[0-9a-f-]{36}$/i.test(b));
    if (nonUuid) flowName = nonUuid;
  }

  const lineMatch = raw.match(/第\s*(\d+)\s*行/);
  if (lineMatch) lineNumber = lineMatch[1];

  for (const re of ERROR_TYPE_PATTERNS) {
    const m = raw.match(re);
    if (m) {
      errorType = m[0];
      break;
    }
  }
  if (!errorType) {
    const errAfter = raw.match(/出错\s*[:：]\s*([^,，;；]+)/);
    if (errAfter) errorType = normalizeFeature(errAfter[1]).slice(0, 40);
    else {
      const after = raw.split(/[：:]/).slice(1).join('：').trim();
      if (after) errorType = normalizeFeature(after).slice(0, 40);
    }
  }

  const elMatch =
    raw.match(/元素名\s*[:：]\s*([^\s,，;；]+)/) ||
    raw.match(/元素名\s*[:：]\s*(.+?)(?:$|[,，;；])/);
  if (elMatch) {
    const el = elMatch[1].trim();
    // 纯短数字多半是误解析，忽略
    if (!/^\d{1,4}$/.test(el)) elementName = el;
  }

  const fileMatch = raw.match(/文件不存在\s*[:：]?\s*([^\s,，;；]+)/) ||
    raw.match(/(?:文件|路径)\s*[:：]?\s*([^\s,，;；]+\.\w+)/);
  if (!elementName && fileMatch) elementName = fileMatch[1].split(/[/\\]/).pop();

  // 调度/平台类 remark 常无「在【流程】中」：用「原因：…」作区分特征，避免全变成 unknown-flow|超时
  const reasonMatch = raw.match(/原因\s*[:：]\s*([^\n\r。；;]+)/);
  if (reasonMatch) {
    const reason = reasonMatch[1].trim();
    if (reason && !/^\d{1,4}$/.test(reason)) {
      if (!elementName) elementName = reason.slice(0, 40);
      // 泛化「超时」时，用更具体原因抬高 errorType 可读性
      if (!errorType || errorType === '超时' || /^timeout$/i.test(errorType)) {
        if (/未分配空闲/.test(reason)) errorType = '未分配空闲机器人';
        else if (/未连接|断连|离线/.test(reason)) errorType = '机器人未连接';
        else if (reason.length <= 24) errorType = reason;
      }
    }
  }

  return { flowName, lineNumber, errorType, elementName, rawRemark: raw };
}


/**
 * 从步骤日志补全
 * @param {any[]} logs
 */
function parseLogs(logs) {
  if (!Array.isArray(logs) || !logs.length) {
    return { flowName: '', lineNumber: '', errorType: '', elementName: '', rawText: '' };
  }

  const errLogs = logs.filter((l) => l && /错误|error|err/i.test(String(l.level || '')));
  const target = errLogs[0] || logs[logs.length - 1] || {};
  const text = String(target.text || '');

  const fromText = parseRemark(text);
  return {
    flowName: target.flowName || fromText.flowName || '',
    lineNumber: target.lineNumber != null ? String(target.lineNumber) : fromText.lineNumber || '',
    errorType: fromText.errorType || normalizeFeature(text).slice(0, 40),
    elementName: fromText.elementName || '',
    rawText: text,
  };
}

/**
 * 稳定指纹字符串（短 hash，便于文件名）
 * @param {{ robotUuid: string, flowName: string, errorType: string, elementName: string }} parts
 */
/**
 * 无流程名时的指纹前缀：调度类用「调度层」，其余 unknown-flow
 * （unknown-flow 表示解析不到子流程，不是影刀里的真实流程名）
 */
function flowKeyPart(flowName, errorType, elementName, rawRemark) {
  const flow = normalizeFeature(flowName || '');
  if (flow) return flow;
  const blob = `${errorType || ''} ${elementName || ''} ${rawRemark || ''}`;
  if (/任务等待|未分配空闲|机器人未连接|机器人断连|调度|未连接/.test(blob)) {
    return '调度层';
  }
  return 'unknown-flow';
}

function makeFingerprintKey(parts) {
  const robot = parts.robotUuid || 'unknown-robot';
  const flow =
    flowKeyPart(parts.flowName, parts.errorType, parts.elementName, parts.rawRemark) ||
    'unknown-flow';
  const err = normalizeFeature(parts.errorType || 'unknown-error') || 'unknown-error';
  const el = normalizeFeature(parts.elementName || '') || '-';
  const material = [robot, flow, err, el].join('|').toLowerCase();
  const hash = crypto.createHash('sha1').update(material, 'utf8').digest('hex').slice(0, 16);
  // 可读前缀 + hash，文件名安全
  const safeFlow = flow.replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 24);
  return `${safeFlow}_${hash}`;
}

/**
 * 跨应用归并用特征（不含 robotUuid）
 */
function makeErrorSignature(parts) {
  const flow =
    flowKeyPart(parts.flowName, parts.errorType, parts.elementName, parts.rawRemark) ||
    'unknown-flow';
  const err = normalizeFeature(parts.errorType || '') || 'unknown-error';
  const el = normalizeFeature(parts.elementName || '') || '-';
  return [flow, err, el].join('|').toLowerCase();
}

/**
 * @param {{
 *   robotUuid?: string,
 *   robotName?: string,
 *   remark?: string,
 *   logs?: any[],
 *   jobUuid?: string,
 * }} input
 * @returns {{
 *   fingerprint: string,
 *   errorSignature: string,
 *   robotUuid: string,
 *   robotName: string,
 *   flowName: string,
 *   lineNumber: string,
 *   errorType: string,
 *   elementName: string,
 *   rawRemark: string,
 *   needsLogEnrichment: boolean,
 * }}
 */
function buildFingerprint(input = {}) {
  const remarkInfo = parseRemark(input.remark || '');
  const logInfo = parseLogs(input.logs || []);

  const flowName = remarkInfo.flowName || logInfo.flowName || '';
  const lineNumber = remarkInfo.lineNumber || logInfo.lineNumber || '';
  const errorType = remarkInfo.errorType || logInfo.errorType || '';
  const elementName = remarkInfo.elementName || logInfo.elementName || '';
  const rawRemark = remarkInfo.rawRemark || logInfo.rawText || '';

  // remark 解析不到 flow 或错误类型时，建议 poll 再拉日志补全
  const needsLogEnrichment =
    !input.logs?.length && (!flowName || !errorType) && Boolean(input.remark || input.jobUuid);

  const robotUuid = input.robotUuid || '';
  const parts = { robotUuid, flowName, errorType, elementName, rawRemark };

  return {
    fingerprint: makeFingerprintKey(parts),
    errorSignature: makeErrorSignature(parts),
    robotUuid,
    robotName: input.robotName || '',
    // flowName 保持真实解析结果（可为空）；指纹前缀可能用「调度层」
    flowName,
    lineNumber,
    errorType,
    elementName,
    rawRemark,
    needsLogEnrichment,
  };
}

function isFailedStatus(status) {
  return FAIL_STATUSES.has(String(status || '').toLowerCase());
}

function isUrgentRemark(remark) {
  const t = String(remark || '');
  return URGENT_PATTERNS.some((re) => re.test(t));
}

module.exports = {
  FAIL_STATUSES,
  URGENT_PATTERNS,
  buildFingerprint,
  parseRemark,
  parseLogs,
  normalizeFeature,
  makeFingerprintKey,
  makeErrorSignature,
  flowKeyPart,
  isFailedStatus,
  isUrgentRemark,
};
