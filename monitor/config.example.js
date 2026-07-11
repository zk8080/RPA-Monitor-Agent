/**
 * 影刀 / Agent 本地配置模板
 * 复制为 config.local.js 后填入真实密钥：
 *   cp monitor/config.example.js monitor/config.local.js
 *
 * config.local.js 已 gitignore，勿提交。
 * 部署说明见仓库根目录 DEPLOY.md。
 */
module.exports = {
  // ===== 必填：影刀鉴权密钥 =====
  // 企业管理员登录影刀控制台 -> API配置 -> 新增密钥对
  accessKeyId: '',
  accessKeySecret: '',

  // ===== 可选：查询范围 =====
  robotClientUuid: '',
  size: 50,

  // ===== rpa-skill 路径（诊断 Agent tool 用）=====
  rpaSkillPath: 'D:/RPA-Skill',

  // ===== 影刀本机流程目录（自动发现 xbot_robot，一般无需 app-map）=====
  // 默认: %LOCALAPPDATA%\ShadowBot\users
  // shadowbotUsersRoot: 'C:/Users/你/AppData/Local/ShadowBot/users',
  // 多账号时可选固定: shadowbotUserId: '825933221244633088',
  // 手工覆盖仍可用 data/app-map.json（优先于自动发现）


  // ===== 通用 LLM（推荐，任意 OpenAI 兼容三方）=====
  // 不填 apiKey 则 diagnose 走纯规则，不调模型
  // 也可用环境变量：LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / LLM_API_STYLE
  //
  // 方式 A：平铺
  llmBaseUrl: 'https://api.openai.com/v1', // 或 https://your-gateway.com/v1
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  llmApiStyle: 'openai', // openai | anthropic
  llmTimeoutMs: 600000, // 默认 600s，慢模型/代理可再加大

  //
  // 方式 B：嵌套（与平铺二选一即可，嵌套优先于部分平铺合并逻辑见 config.js）
  // llm: {
  //   baseUrl: 'https://your-gateway.com/v1',
  //   apiKey: 'sk-xxx',
  //   model: 'deepseek-chat',
  //   apiStyle: 'openai',
  // },
  //
  // 旧 Anthropic 官方字段仍兼容（仅当未配 llmApiKey 时）：
  // anthropicApiKey: '',
  // anthropicModel: 'claude-sonnet-4-20250514',
  // anthropicBaseUrl: 'https://api.anthropic.com',

  // ===== maintain（巡检 / py 受控修复）=====
  maintain: {
    autoFix: {
      enabled: false,
      classes: ['code_boundary', 'null_guard'],
      requirePyCompile: true,
      requireValidate: false,
      maxFilesPerPatch: 1,
      maxPatchBytes: 200000,
    },
  },


  // ===== 运行时（service.js）=====
  pollIntervalMinutes: 15,
  // 感知：最近 N 小时（triggerTime）；0=不按时间
  pollLookbackHours: 24,
  // 时间窗内最多翻页（每页 size 条）
  pollMaxPages: 50,
  diagnoseCron: '0 9 * * *',
  reportCron: '5 9 * * *',
  healthPort: 8787,


  // dataDir: 'D:/rpa-monitor-data',
  alertWebhook: '',
};
