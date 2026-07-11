/**
 * 配置加载：环境变量 > config.local.js > 默认值
 * 供 poll / agent / verify / lib 共用。
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const MONITOR_DIR = path.resolve(__dirname, '..');

function resolveDataDir(local = {}) {
  return (
    process.env.DATA_DIR ||
    process.env.RPA_MONITOR_DATA_DIR ||
    local.dataDir ||
    path.join(ROOT, 'data')
  );
}

const DEFAULTS = {
  accessKeyId: '',
  accessKeySecret: '',
  robotClientUuid: '',
  size: 50,
  rpaSkillPath: 'D:/RPA-Skill',

  // ===== 通用 LLM（推荐）：baseUrl + apiKey + model =====
  // 也可用嵌套 cfg.llm = { baseUrl, apiKey, model, apiStyle }
  llmBaseUrl: '', // 例 https://api.openai.com/v1 或三方 https://xxx/v1
  llmApiKey: '',
  llmModel: '',
  llmApiStyle: '', // openai（默认）| anthropic
  llmTimeoutMs: 600000,


  // 旧字段兼容（仍可读，等价映射到 llm.*）
  anthropicApiKey: '',
  anthropicModel: '',
  anthropicBaseUrl: '',

  maxToolRounds: 8,
  pollIntervalMinutes: 15,
  // 感知时间窗：最近 N 小时（用 triggerTimeBegin/End）；0 = 不按时间、仅条数分页
  pollLookbackHours: 24,
  // 时间窗内最多翻页（每页 size 条）；防止异常死循环。24h 一般够用
  pollMaxPages: 50,
  diagnoseCron: '0 9 * * *',
  reportCron: '5 9 * * *',
  healthPort: 8787,
  alertWebhook: '',
};


function loadLocalConfig() {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(path.join(MONITOR_DIR, 'config.local.js'));
  } catch {
    return {};
  }
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

/**
 * @returns {typeof DEFAULTS & { dataDir: string, rootDir: string, monitorDir: string, llm: object }}
 */
function loadConfig() {
  const local = loadLocalConfig();
  const nestedLlm = local.llm && typeof local.llm === 'object' ? local.llm : {};
  const sizeRaw = firstNonEmpty(process.env.YD_JOB_SIZE, local.size, DEFAULTS.size);
  const size = Math.min(100, Math.max(1, parseInt(String(sizeRaw), 10) || 50));
  const dataDir = resolveDataDir(local);

  const llmApiKey =
    firstNonEmpty(
      process.env.LLM_API_KEY,
      process.env.OPENAI_API_KEY,
      nestedLlm.apiKey,
      local.llmApiKey,
      process.env.ANTHROPIC_API_KEY,
      local.anthropicApiKey,
      DEFAULTS.llmApiKey,
    ) || '';

  const llmBaseUrl =
    firstNonEmpty(
      process.env.LLM_BASE_URL,
      process.env.OPENAI_BASE_URL,
      nestedLlm.baseUrl,
      local.llmBaseUrl,
      process.env.ANTHROPIC_BASE_URL,
      local.anthropicBaseUrl,
      DEFAULTS.llmBaseUrl,
    ) || '';

  const llmModel =
    firstNonEmpty(
      process.env.LLM_MODEL,
      process.env.OPENAI_MODEL,
      nestedLlm.model,
      local.llmModel,
      process.env.ANTHROPIC_MODEL,
      local.anthropicModel,
      DEFAULTS.llmModel,
    ) || '';

  const llmApiStyle =
    firstNonEmpty(
      process.env.LLM_API_STYLE,
      nestedLlm.apiStyle,
      local.llmApiStyle,
      DEFAULTS.llmApiStyle,
    ) || '';

  const llmTimeoutMs =
    parseInt(
      String(
        firstNonEmpty(
          process.env.LLM_TIMEOUT_MS,
          nestedLlm.timeoutMs,
          local.llmTimeoutMs,
          DEFAULTS.llmTimeoutMs,
        ),
      ),
      10,
    ) || 60000;

  return {
    ...DEFAULTS,
    ...local,
    accessKeyId: firstNonEmpty(process.env.YD_ACCESS_KEY_ID, local.accessKeyId, DEFAULTS.accessKeyId) || '',
    accessKeySecret: firstNonEmpty(process.env.YD_ACCESS_KEY_SECRET, local.accessKeySecret, DEFAULTS.accessKeySecret) || '',
    robotClientUuid: firstNonEmpty(process.env.YD_ROBOT_CLIENT_UUID, local.robotClientUuid, DEFAULTS.robotClientUuid) || '',
    size,
    rpaSkillPath: firstNonEmpty(process.env.RPA_SKILL_PATH, local.rpaSkillPath, DEFAULTS.rpaSkillPath) || DEFAULTS.rpaSkillPath,

    llmBaseUrl,
    llmApiKey,
    llmModel,
    llmApiStyle,
    llmTimeoutMs,
    // 统一嵌套对象，供 lib/llm 使用
    llm: {
      baseUrl: llmBaseUrl,
      apiKey: llmApiKey,
      model: llmModel,
      apiStyle: llmApiStyle,
      timeoutMs: llmTimeoutMs,
    },

    // 旧字段保留读取结果，避免外部直接引用挂掉
    anthropicApiKey: firstNonEmpty(local.anthropicApiKey, process.env.ANTHROPIC_API_KEY, '') || '',
    anthropicModel: firstNonEmpty(local.anthropicModel, process.env.ANTHROPIC_MODEL, '') || '',
    anthropicBaseUrl: firstNonEmpty(local.anthropicBaseUrl, process.env.ANTHROPIC_BASE_URL, '') || '',

    maxToolRounds: parseInt(String(firstNonEmpty(local.maxToolRounds, DEFAULTS.maxToolRounds)), 10) || 8,
    pollIntervalMinutes: parseInt(String(firstNonEmpty(local.pollIntervalMinutes, DEFAULTS.pollIntervalMinutes)), 10) || 15,
    pollLookbackHours: parseInt(
      String(firstNonEmpty(process.env.POLL_LOOKBACK_HOURS, local.pollLookbackHours, DEFAULTS.pollLookbackHours)),
      10,
    ),
    pollMaxPages: parseInt(
      String(firstNonEmpty(process.env.POLL_MAX_PAGES, local.pollMaxPages, DEFAULTS.pollMaxPages)),
      10,
    ) || 50,
    healthPort: parseInt(
      String(firstNonEmpty(process.env.HEALTH_PORT, local.healthPort, DEFAULTS.healthPort)),
      10,
    ),
    dataDir,
    rootDir: ROOT,
    monitorDir: MONITOR_DIR,
  };
}


function requireYingdaoCredentials(cfg = loadConfig()) {
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    const err = new Error(
      '缺少 accessKeyId / accessKeySecret。请编辑 monitor/config.local.js 或设置 YD_ACCESS_KEY_ID / YD_ACCESS_KEY_SECRET',
    );
    err.code = 'MISSING_CREDENTIALS';
    throw err;
  }
  return cfg;
}

module.exports = {
  DEFAULTS,
  ROOT,
  MONITOR_DIR,
  get DATA_DIR() {
    return resolveDataDir(loadLocalConfig());
  },
  loadConfig,
  requireYingdaoCredentials,
};
