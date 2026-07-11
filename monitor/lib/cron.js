/**
 * 极简 cron：仅支持 "分 时 * * *" 或 "分 时"（本地时区）
 * 用于 diagnoseCron / reportCron。
 */

/**
 * @param {string} expr
 * @returns {{ minute: number, hour: number } | null}
 */
function parseSimpleCron(expr) {
  if (!expr || typeof expr !== 'string') return null;
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const minute = parts[0] === '*' ? null : parseInt(parts[0], 10);
  const hour = parts[1] === '*' ? null : parseInt(parts[1], 10);
  if (minute != null && (Number.isNaN(minute) || minute < 0 || minute > 59)) return null;
  if (hour != null && (Number.isNaN(hour) || hour < 0 || hour > 23)) return null;
  return { minute: minute ?? 0, hour: hour ?? 0 };
}

/**
 * 当前本地时间是否命中 cron（精确到分钟，调用方需防重入）
 * @param {string} expr
 * @param {Date} [now]
 */
function cronMatchesNow(expr, now = new Date()) {
  const p = parseSimpleCron(expr);
  if (!p) return false;
  return now.getHours() === p.hour && now.getMinutes() === p.minute;
}

/**
 * 当日 key：YYYY-MM-DD-HH-mm 用于标记已触发
 */
function slotKey(expr, now = new Date()) {
  const p = parseSimpleCron(expr);
  if (!p) return null;
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}T${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

module.exports = {
  parseSimpleCron,
  cronMatchesNow,
  slotKey,
};
