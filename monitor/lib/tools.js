/**
 * Agent Tool 注册表
 *
 * 每个 tool: { name, description, skills, inputSchema, handler }
 * list_jobs 仅 perception（poll），不进 diagnose 主 loop。
 */

const yingdao = require('./yingdao');
const fingerprint = require('./fingerprint');
const memory = require('./memory');
const rpa = require('./rpa');
const kb = require('./kb');
const openPath = require('./http/open-path');
const { loadConfig } = require('./config');

/**
 * @typedef {object} ToolContext
 * @property {object} cfg
 * @property {string} [skill]
 * @property {string} [token]
 */

async function ensureToken(ctx) {
  if (ctx.token) return ctx.token;
  const cfg = ctx.cfg || loadConfig();
  const token = await yingdao.getToken({
    accessKeyId: cfg.accessKeyId,
    accessKeySecret: cfg.accessKeySecret,
  });
  ctx.token = token;
  return token;
}

/** @type {Array<{
 *   name: string,
 *   description: string,
 *   skills: string[],
 *   inputSchema: object,
 *   handler: (input: object, ctx: ToolContext) => Promise<any>,
 * }>} */
const TOOLS = [
  {
    name: 'list_jobs',
    description: '拉取影刀运行记录列表（仅感知层 poll/调度使用，不进 diagnose 主 loop）',
    skills: ['perception'],
    inputSchema: {
      type: 'object',
      properties: {
        size: { type: 'number' },
        cursorId: { type: 'string' },
        robotClientUuid: { type: 'string' },
        statusList: { type: 'array', items: { type: 'string' } },
      },
    },
    async handler(input, ctx) {
      const token = await ensureToken(ctx);
      const cfg = ctx.cfg || loadConfig();
      return yingdao.listJobs(token, {
        size: input.size ?? cfg.size,
        cursorId: input.cursorId,
        robotClientUuid: input.robotClientUuid || cfg.robotClientUuid || undefined,
        statusList: input.statusList,
        cursorDirection: 'next',
      });
    },
  },
  {
    name: 'search_logs',
    description: '按 jobUuid 查询步骤级日志（flowName / lineNumber / text）',
    skills: ['diagnose', 'perception'],
    inputSchema: {
      type: 'object',
      properties: {
        jobUuid: { type: 'string' },
        page: { type: 'number' },
        size: { type: 'number' },
      },
      required: ['jobUuid'],
    },
    async handler(input, ctx) {
      const token = await ensureToken(ctx);
      return yingdao.searchLogs(token, input.jobUuid, {
        page: input.page ?? 1,
        size: input.size ?? 100,
      });
    },
  },
  {
    name: 'build_fingerprint',
    description: '从 remark / 日志构建错误指纹与定位字段',
    skills: ['diagnose', 'perception'],
    inputSchema: {
      type: 'object',
      properties: {
        robotUuid: { type: 'string' },
        robotName: { type: 'string' },
        remark: { type: 'string' },
        jobUuid: { type: 'string' },
        logs: { type: 'array' },
      },
    },
    async handler(input) {
      return fingerprint.buildFingerprint(input);
    },
  },
  {
    name: 'queue_get',
    description: '读取 data/queue 中的条目（按 fingerprint 或列出未诊断）',
    skills: ['diagnose'],
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string' },
        undiagnosedOnly: { type: 'boolean' },
      },
    },
    async handler(input, ctx) {
      const cfg = ctx.cfg || loadConfig();
      if (input.fingerprint) {
        return memory.loadQueueItem(cfg.dataDir, input.fingerprint);
      }
      let items = memory.listQueueItems(cfg.dataDir);
      if (input.undiagnosedOnly) items = items.filter((i) => !i.diagnosed);
      return { count: items.length, items };
    },
  },
  {
    name: 'resolve_app',
    description: 'robotUuid → 本地 xbotDir（ShadowBot 自动发现 / app-map）',
    skills: ['diagnose', 'maintain'],

    inputSchema: {
      type: 'object',
      properties: { robotUuid: { type: 'string' } },
      required: ['robotUuid'],
    },
    async handler(input, ctx) {
      const cfg = ctx.cfg || loadConfig();
      return rpa.resolveXbotDir(input.robotUuid, { cfg, dataDir: cfg.dataDir });
    },
  },
  {
    name: 'understand_flow',
    description: '调用 rpa-skill understand 解析本地流程结构摘要',
    skills: ['diagnose', 'maintain'],
    inputSchema: {
      type: 'object',
      properties: {
        xbotDir: { type: 'string' },
        flowName: { type: 'string' },
      },
      required: ['xbotDir'],
    },
    async handler(input, ctx) {
      return rpa.understandFlow(input.xbotDir, input.flowName, { cfg: ctx.cfg || loadConfig() });
    },
  },
  {
    name: 'load_blocks',
    description: '读取 flowName 在 lineNumber 附近的指令块',
    skills: ['diagnose', 'maintain'],

    inputSchema: {
      type: 'object',
      properties: {
        xbotDir: { type: 'string' },
        flowName: { type: 'string' },
        lineNumber: { type: ['string', 'number'] },
      },
      required: ['xbotDir'],
    },
    async handler(input, ctx) {
      return rpa.loadFlowBlocks(input.xbotDir, input.flowName, input.lineNumber, {
        cfg: ctx.cfg || loadConfig(),
      });
    },
  },
  {
    name: 'kb_search',
    description: '按 fingerprint / 错误类型 / 元素查历史知识库',
    skills: ['diagnose'],
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string' },
        errorSignature: { type: 'string' },
        errorType: { type: 'string' },
        elementName: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    async handler(input, ctx) {
      const cfg = ctx.cfg || loadConfig();
      return kb.searchKb(cfg.dataDir, input);
    },
  },
  {
    name: 'kb_write',
    description: '写入或更新知识库条目（默认 pending_review）',
    skills: ['diagnose', 'maintain'],
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string' },
        rootCause: { type: 'string' },
        solution: { type: 'string' },
        location: { type: 'string' },
      },
    },
    async handler(input, ctx) {
      const cfg = ctx.cfg || loadConfig();
      return kb.writeKb(cfg.dataDir, input);
    },
  },
  {
    name: 'inspect_project',
    description: 'rpa-skill 结构巡检（只读）',
    skills: ['maintain', 'diagnose'],
    inputSchema: {
      type: 'object',
      properties: {
        xbotDir: { type: 'string' },
        flowName: { type: 'string' },
      },
      required: ['xbotDir'],
    },
    async handler(input, ctx) {
      return rpa.inspectProject(input.xbotDir, input.flowName, { cfg: ctx.cfg || loadConfig() });
    },
  },
  {
    name: 'read_project_file',
    description: '读取 xbot_robot 目录内文件（路径不得逃逸）',
    skills: ['maintain', 'diagnose'],
    inputSchema: {
      type: 'object',
      properties: {
        xbotDir: { type: 'string' },
        relativePath: { type: 'string' },
      },
      required: ['xbotDir', 'relativePath'],
    },
    async handler(input, ctx) {
      return rpa.readProjectFile(input.xbotDir, input.relativePath, {
        maxBytes: input.maxBytes,
      });
    },
  },
  {
    name: 'list_app_failures',
    description: '按 robotUuid 列出 queue 中失败条目',
    skills: ['maintain', 'diagnose'],
    inputSchema: {
      type: 'object',
      properties: {
        robotUuid: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    async handler(input, ctx) {
      const cfg = ctx.cfg || loadConfig();
      let items = memory.listQueueItems(cfg.dataDir);
      if (input.robotUuid) {
        items = items.filter((i) => i.robotUuid === input.robotUuid);
      }
      items.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
      const limit = input.limit || 20;
      return { count: items.length, items: items.slice(0, limit) };
    },
  },
  {
    name: 'scan_local_apps',
    description: '扫描本机 ShadowBot apps',
    skills: ['maintain', 'workbench'],
    inputSchema: { type: 'object', properties: {} },
    async handler(_input, ctx) {
      return rpa.scanLocalApps(ctx.cfg || loadConfig());
    },
  },
  {
    name: 'open_local_path',
    description: '在本机打开已 resolve 的 xbot_robot 目录（仅 robotUuid，禁止任意路径）',
    skills: ['maintain', 'workbench'],
    inputSchema: {
      type: 'object',
      properties: {
        robotUuid: { type: 'string' },
      },
      required: ['robotUuid'],
    },
    async handler(input, ctx) {
      const cfg = ctx.cfg || loadConfig();
      const wb = (cfg.workbench && typeof cfg.workbench === 'object' && cfg.workbench) || {};
      return openPath.openRobotFolder(input.robotUuid, {
        cfg,
        enabled: wb.openFolderEnabled !== false,
        openCommand: wb.openCommand || null,
      });
    },
  },
];


function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

function listToolsForSkill(skill) {
  return TOOLS.filter((t) => t.skills.includes(skill) || t.skills.includes('*'));
}

async function invokeTool(name, input = {}, ctx = {}) {
  const tool = getTool(name);
  if (!tool) {
    const err = new Error(`unknown_tool: ${name}`);
    err.code = 'unknown_tool';
    throw err;
  }
  if (ctx.skill && !tool.skills.includes(ctx.skill) && !tool.skills.includes('*')) {
    const err = new Error(`tool_not_visible_for_skill: ${name} @ ${ctx.skill}`);
    err.code = 'tool_not_visible';
    throw err;
  }
  return tool.handler(input, { ...ctx, cfg: ctx.cfg || loadConfig() });
}

function toApiToolDefinitions(skill) {
  return listToolsForSkill(skill).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

module.exports = {
  TOOLS,
  getTool,
  listToolsForSkill,
  invokeTool,
  toApiToolDefinitions,
  ensureToken,
};
