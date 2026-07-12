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

  // ===== rpa-skill 路径（诊断 / 工作台流程图，本机只读 require）=====
  // 方案 A：与 Monitor 同机安装一份 skill（推荐同级目录 D:/RPA-Skill）
  //   powershell -File scripts/bootstrap-rpa-skill.ps1 -Repo <git地址> -WriteConfig
  // 也可用环境变量 RPA_SKILL_PATH 覆盖。不要填 http URL（当前不支持远程 skill 服务）。
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

  // ===== diagnose =====
  diagnose: {
    // S10a：仅 status=confirmed 且同 fingerprint、高置信时短路完整 diagnose
    // 环境变量 DIAGNOSE_KB_FIRST=1 等价开启
    kbFirst: false,
    kbFirstMinConfidence: 0.8,
  },

  // ===== maintain（巡检 / py 受控修复）=====
  maintain: {
    // S17：diagnose 完成后若 fixability=auto 且含 python，自动 dry-run 存 patch（绝不 apply）
    // 也可用环境变量 MAINTAIN_AUTO_PLAN=1
    autoPlanOnDiagnose: false,
    // S18：apply 后验证期（天）；静默期满 → verified；新 job 同指纹 → regressed
    verify: {
      quietDays: 3, // 或 MAINTAIN_VERIFY_QUIET_DAYS
    },
    autoFix: {
      enabled: false, // 永不建议在 service 默认打开；写盘仅 CLI --apply
      classes: ['code_boundary', 'null_guard', 'config'],
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
  // 0=关闭 HTTP；>0 时绑定 127.0.0.1：/health + 本机工作台 /
  healthPort: 8787,

  // ===== 本机开发者工作台（S25）=====
  workbench: {
    enabled: true, // false：仅 /health，不挂 /api 与静态页
    openFolderEnabled: true, // POST 打开 xbot 目录 / open-agent
    understandCache: true, // data/cache/understand
    actionsEnabled: true, // S25b：Web 一键 diagnose / fix dry-run（永不 apply）
    // openCommand: null, // 可选：自定义打开文件夹命令，默认 Windows explorer
    // agents：在 Coding Agent 打开（默认 cursor / vscode / qoder / claude / codex）
    // 对象按 id 覆盖；false 禁用；或传数组全量替换
    // agents: {
    //   cursor: { command: 'cursor', args: ['{path}'] },
    //   qoder: { command: 'qoder', args: ['{path}'] }, // CLI 名不同时可改
    //   vscode: false, // 禁用
    //   claude: { run: 'claude' },
    //   windsurf: { label: 'Windsurf', kind: 'editor', command: 'windsurf', args: ['{path}'] },
    // },
  },


  // dataDir: 'D:/rpa-monitor-data',
  alertWebhook: '',
};
