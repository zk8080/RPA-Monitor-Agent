/**
 * rpa-skill 只读适配（Agent tools：resolve_app / understand_flow / load_blocks）
 * 不修改 rpa-skill 源码与目录。
 *
 * xbotDir 解析优先级：
 *  1) data/app-map.json 手工覆盖
 *  2) 影刀本机目录自动发现：
 *     %LOCALAPPDATA%\ShadowBot\users\<userId>\apps\<robotUuid>\xbot_robot
 */

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

function getRpaSkillPath(cfg) {
  return process.env.RPA_SKILL_PATH || (cfg && cfg.rpaSkillPath) || 'D:/RPA-Skill';
}

/**
 * 影刀 users 根目录，默认 %LOCALAPPDATA%\ShadowBot\users
 */
function getShadowBotUsersRoot(cfg = {}) {
  return (
    process.env.SHADOWBOT_USERS_ROOT ||
    (cfg && cfg.shadowbotUsersRoot) ||
    path.join(process.env.LOCALAPPDATA || '', 'ShadowBot', 'users')
  );
}

function loadAppMap(dataDir) {
  const p = path.join(dataDir, 'app-map.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function isValidXbotDir(dir) {
  if (!dir || !fs.existsSync(dir)) return false;
  // package.json 或 .dev 任一存在即认为是流程工程
  return (
    fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(dir, '.dev'))
  );
}

/**
 * 列出 users 下的账号目录
 * @param {string} usersRoot
 * @returns {string[]} absolute paths
 */
function listShadowBotUserHomes(usersRoot) {
  if (!usersRoot || !fs.existsSync(usersRoot)) return [];
  return fs
    .readdirSync(usersRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(usersRoot, d.name))
    .filter((p) => fs.existsSync(path.join(p, 'apps')));
}

/**
 * 在指定 userHome 下解析 robotUuid → xbot_robot
 */
function xbotDirUnderUser(userHome, robotUuid) {
  const candidate = path.join(userHome, 'apps', robotUuid, 'xbot_robot');
  if (isValidXbotDir(candidate)) return candidate;
  // 少数版本可能不带 xbot_robot 子目录
  const alt = path.join(userHome, 'apps', robotUuid);
  if (isValidXbotDir(alt)) return alt;
  return null;
}

/**
 * 自动发现 xbotDir（不写 app-map）
 * @returns {{ xbotDir: string|null, userHome: string|null, source: string, reason?: string }}
 */
function discoverXbotDir(robotUuid, cfg = {}) {
  if (!robotUuid) {
    return { xbotDir: null, userHome: null, source: 'auto', reason: 'missing_robotUuid' };
  }

  const usersRoot = getShadowBotUsersRoot(cfg);
  if (!fs.existsSync(usersRoot)) {
    return {
      xbotDir: null,
      userHome: null,
      source: 'auto',
      reason: `shadowbot_users_root_missing:${usersRoot}`,
    };
  }

  // 配置了固定 userId 时只查该账号
  const fixedUserId = process.env.SHADOWBOT_USER_ID || cfg.shadowbotUserId || '';
  let homes = listShadowBotUserHomes(usersRoot);
  if (fixedUserId) {
    const fixed = path.join(usersRoot, fixedUserId);
    homes = fs.existsSync(fixed) ? [fixed] : [];
    if (!homes.length) {
      return {
        xbotDir: null,
        userHome: null,
        source: 'auto',
        reason: `shadowbot_user_not_found:${fixedUserId}`,
      };
    }
  }

  const hits = [];
  for (const home of homes) {
    const xbotDir = xbotDirUnderUser(home, robotUuid);
    if (xbotDir) hits.push({ userHome: home, xbotDir });
  }

  if (hits.length === 1) {
    return { ...hits[0], source: 'auto', reason: null };
  }
  if (hits.length > 1) {
    // 多账号命中：优先最近修改的 xbot_robot
    hits.sort((a, b) => {
      try {
        return fs.statSync(b.xbotDir).mtimeMs - fs.statSync(a.xbotDir).mtimeMs;
      } catch {
        return 0;
      }
    });
    return {
      ...hits[0],
      source: 'auto',
      reason: null,
      ambiguousUsers: hits.map((h) => path.basename(h.userHome)),
    };
  }

  return {
    xbotDir: null,
    userHome: homes[0] || null,
    source: 'auto',
    reason: homes.length ? 'app_not_on_this_machine' : 'no_shadowbot_user_homes',
  };
}

/**
 * @param {string} robotUuid
 * @param {{ cfg?: object, dataDir?: string }} [opts]
 */
function resolveXbotDir(robotUuid, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const dataDir = opts.dataDir || cfg.dataDir;
  if (!robotUuid) {
    return { robotUuid: '', mapped: false, xbotDir: null, reason: 'missing_robotUuid', source: null };
  }

  // 1) 手工 app-map 优先（可覆盖自动路径）
  const map = loadAppMap(dataDir);
  const entry = map[robotUuid];
  if (entry) {
    const xbotDir = entry.xbotDir || entry.path || null;
    if (!xbotDir) {
      return {
        robotUuid,
        mapped: true,
        name: entry.name,
        xbotDir: null,
        reason: 'entry_missing_xbotDir',
        source: 'app-map',
      };
    }
    if (!fs.existsSync(xbotDir)) {
      return {
        robotUuid,
        mapped: true,
        name: entry.name,
        xbotDir,
        reason: 'xbotDir_not_found',
        source: 'app-map',
      };
    }
    return {
      robotUuid,
      mapped: true,
      name: entry.name || '',
      xbotDir,
      reason: null,
      source: 'app-map',
    };
  }

  // 2) 本机 ShadowBot 目录自动发现
  const auto = discoverXbotDir(robotUuid, cfg);
  if (auto.xbotDir) {
    let name = '';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(auto.xbotDir, 'package.json'), 'utf8'));
      name = pkg.name || '';
    } catch {
      // ignore
    }
    return {
      robotUuid,
      mapped: true,
      name,
      xbotDir: auto.xbotDir,
      userHome: auto.userHome,
      reason: auto.ambiguousUsers ? `auto_picked_among:${auto.ambiguousUsers.join(',')}` : null,
      source: 'shadowbot-auto',
    };
  }

  return {
    robotUuid,
    mapped: false,
    xbotDir: null,
    userHome: auto.userHome,
    reason: auto.reason || 'not_found',
    source: 'shadowbot-auto',
  };
}

/**
 * 从 xbot_robot/package.json 读取列表可用的元信息（名称、描述、流程数等）
 * @param {string} xbotDir
 * @returns {{
 *   name: string,
 *   description: string,
 *   version: string,
 *   startup: string,
 *   robotType: string,
 *   flowCount: number,
 *   packageMtime: string|null,
 * }}
 */
function readPackageMeta(xbotDir) {
  const empty = {
    name: '',
    description: '',
    version: '',
    startup: '',
    robotType: '',
    flowCount: 0,
    packageMtime: null,
  };
  if (!xbotDir) return empty;
  const pkgPath = path.join(xbotDir, 'package.json');
  try {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    const pkg = JSON.parse(raw);
    let packageMtime = null;
    try {
      packageMtime = fs.statSync(pkgPath).mtime.toISOString();
    } catch {
      // ignore
    }
    const flows = Array.isArray(pkg.flows) ? pkg.flows : [];
    return {
      name: pkg.name != null ? String(pkg.name) : '',
      description: pkg.description != null ? String(pkg.description).trim() : '',
      version: pkg.version != null ? String(pkg.version) : '',
      startup: pkg.startup != null ? String(pkg.startup) : '',
      robotType: pkg.robot_type != null ? String(pkg.robot_type) : '',
      flowCount: flows.length,
      packageMtime,
    };
  } catch {
    return empty;
  }
}

/**
 * 扫描本机 apps 目录，生成 app-map 草稿（不覆盖已有手工项时可合并）
 */
function scanLocalApps(cfg = {}) {
  const usersRoot = getShadowBotUsersRoot(cfg);
  const homes = listShadowBotUserHomes(usersRoot);
  const apps = [];
  for (const home of homes) {
    const appsDir = path.join(home, 'apps');
    if (!fs.existsSync(appsDir)) continue;
    for (const ent of fs.readdirSync(appsDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const robotUuid = ent.name;
      const xbotDir = xbotDirUnderUser(home, robotUuid);
      if (!xbotDir) continue;
      const meta = readPackageMeta(xbotDir);
      apps.push({
        robotUuid,
        name: meta.name,
        description: meta.description,
        version: meta.version,
        startup: meta.startup,
        robotType: meta.robotType,
        flowCount: meta.flowCount,
        packageMtime: meta.packageMtime,
        xbotDir,
        userId: path.basename(home),
        userHome: home,
      });
    }
  }
  return { usersRoot, userCount: homes.length, apps };
}

function requireProjectReader(cfg) {
  const skillPath = getRpaSkillPath(cfg);
  const readerPath = path.join(skillPath, 'scripts', 'project_reader.js');
  if (!fs.existsSync(readerPath)) {
    throw new Error(`rpa-skill project_reader 不存在: ${readerPath}`);
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(readerPath);
}

function requireUnderstand(cfg) {
  const skillPath = getRpaSkillPath(cfg);
  const understandPath = path.join(skillPath, 'scripts', 'understand.js');
  if (!fs.existsSync(understandPath)) {
    throw new Error(`rpa-skill understand 不存在: ${understandPath}`);
  }
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(understandPath);
}

/**
 * @param {string} xbotDir
 * @param {string} [flowName]
 * @param {{ cfg?: object }} [opts]
 */
function understandFlow(xbotDir, flowName, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!xbotDir || !fs.existsSync(xbotDir)) {
    return {
      ok: false,
      reason: 'xbotDir_missing',
      xbotDir: xbotDir || null,
    };
  }

  try {
    const { readProject } = requireProjectReader(cfg);
    const { analyze } = requireUnderstand(cfg);
    const project = readProject(xbotDir, flowName || '');
    if (project.errors && project.errors.length && !project.allFlows?.length) {
      return {
        ok: false,
        reason: 'read_project_failed',
        errors: project.errors,
        warnings: project.warnings,
      };
    }
    // maxEdges 与 rpa-skill understand CLI 默认一致，保证有流程图
    const report = analyze(project, { maxEdges: 50 });
    const mg = report.mermaidGraph || null;
    const cg = report.callGraph || null;
    return {
      ok: true,
      projectName: report.projectName,
      summary: report.summary,
      businessObjects: report.businessObjects,
      inputs: report.inputs || [],
      outputs: report.outputs || [],
      stages: (report.stages || []).slice(0, 12),
      flowRoles: (report.flowRoles || []).slice(0, 40),
      rules: (report.rules || []).slice(0, 10),
      warnings: report.warnings || [],
      errors: report.errors || [],
      // 流程图：rpa-skill callGraph → mermaid（工作台渲染用）
      mermaidGraph: mg
        ? {
            title: (mg.title || report.projectName || '') + '',
            mermaid: mg.mermaid || '',
            body: mg.body || '',
            truncated: !!mg.truncated,
            totalEdges: mg.totalEdges ?? null,
            omitted: mg.omitted ?? 0,
            edgeCount: mg.edgeCount ?? null,
            nodeCount: mg.nodeCount ?? null,
          }
        : null,
      callGraph: cg
        ? {
            stats: cg.stats || null,
            edges: (cg.edges || []).slice(0, 80).map((e) => ({
              type: e.type,
              from: e.from,
              to: e.to,
              toKind: e.toKind,
              enabled: e.enabled !== false,
            })),
            codeModules: (cg.codeModules || []).slice(0, 30).map((m) => ({
              name: m.name || m.filename,
              filename: m.filename,
              pyExists: m.pyExists,
              summary: m.summary || m.pySummary || '',
            })),
          }
        : null,
      callStats: cg?.stats || null,
    };
  } catch (e) {
    return {
      ok: false,
      reason: 'understand_error',
      error: e.message,
    };
  }
}

/**
 * 加载 flowName 在 lineNumber 附近的指令块
 */
function loadFlowBlocks(xbotDir, flowName, lineNumber, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  const radius = opts.radius ?? 3;

  if (!xbotDir || !fs.existsSync(xbotDir)) {
    return { ok: false, reason: 'xbotDir_missing', blocks: [] };
  }

  try {
    const { readProject, getBlocks, findFlowEntry } = requireProjectReader(cfg);
    const project = readProject(xbotDir, '');
    const allFlows = project.allFlows || project.flows || [];
    let entry = findFlowEntry(allFlows, flowName);
    if (!entry && flowName) {
      entry = allFlows.find(
        (f) => f.name === flowName || f.filename === flowName || (f.name && f.name.includes(flowName)),
      );
    }
    if (!entry) {
      return {
        ok: false,
        reason: 'flow_not_found',
        flowName,
        availableFlows: allFlows.map((f) => ({ name: f.name, filename: f.filename })),
        blocks: [],
      };
    }

    const blocks = getBlocks(entry);
    const line = parseInt(String(lineNumber || ''), 10);
    let start = 0;
    let end = Math.min(blocks.length, 12);
    let focusIndex = null;

    if (Number.isFinite(line) && line > 0) {
      focusIndex = Math.min(Math.max(line - 1, 0), blocks.length - 1);
      start = Math.max(0, focusIndex - radius);
      end = Math.min(blocks.length, focusIndex + radius + 1);
    }

    const slice = blocks.slice(start, end).map((block, i) => {
      const index = start + i;
      const inputsSummary = summarizeInputs(block.inputs);
      return {
        index: index + 1,
        name: block.name || '',
        comment: block.comment || '',
        isEnabled: block.isEnabled !== false,
        isFocus: focusIndex !== null && index === focusIndex,
        inputsSummary,
      };
    });

    return {
      ok: true,
      flowName: entry.name,
      filename: entry.filename,
      totalBlocks: blocks.length,
      lineNumber: lineNumber != null ? String(lineNumber) : null,
      focusIndex: focusIndex !== null ? focusIndex + 1 : null,
      blocks: slice,
    };
  } catch (e) {
    return { ok: false, reason: 'load_blocks_error', error: e.message, blocks: [] };
  }
}

function summarizeInputs(inputs, maxKeys = 6) {
  if (!inputs || typeof inputs !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [key, val] of Object.entries(inputs)) {
    if (n >= maxKeys) break;
    const raw = val && typeof val === 'object' ? val.value ?? val.display : val;
    let text = raw == null ? '' : String(raw);
    const colon = text.indexOf(':');
    if (colon > 0 && colon <= 3 && /^\d+$/.test(text.slice(0, colon))) {
      text = text.slice(colon + 1);
    }
    if (text.length > 80) text = `${text.slice(0, 80)}…`;
    out[key] = text;
    n += 1;
  }
  return out;
}

function requireInspect(cfg) {
  const skillPath = getRpaSkillPath(cfg);
  const p = path.join(skillPath, 'scripts', 'inspect.js');
  if (!fs.existsSync(p)) throw new Error(`rpa-skill inspect 不存在: ${p}`);
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(p);
}

function requireValidate(cfg) {
  const skillPath = getRpaSkillPath(cfg);
  const p = path.join(skillPath, 'scripts', 'validate.js');
  if (!fs.existsSync(p)) throw new Error(`rpa-skill validate 不存在: ${p}`);
  // eslint-disable-next-line import/no-dynamic-require, global-require
  return require(p);
}

/**
 * 结构巡检（rpa-skill inspect.analyze）
 */
function inspectProject(xbotDir, flowName, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  if (!xbotDir || !fs.existsSync(xbotDir)) {
    return { ok: false, reason: 'xbotDir_missing', xbotDir: xbotDir || null };
  }
  try {
    const { readProject } = requireProjectReader(cfg);
    const { analyze } = requireInspect(cfg);
    const project = readProject(xbotDir, flowName || '');
    const report = analyze(project);
    // 压缩大字段
    return {
      ok: true,
      projectName: report.projectName,
      xbotDir: report.xbotDir,
      flowCount: report.flowCount,
      totalFlowCount: report.totalFlowCount,
      risks: report.risks || [],
      unknownBlocks: (report.unknownBlocks || []).slice(0, 30),
      flows: (report.flows || []).slice(0, 40),
      callStats: report.callGraph?.stats || null,
      missingPy: (report.callGraph?.codeModules || [])
        .filter((m) => !m.pyExists)
        .map((m) => m.filename)
        .slice(0, 20),
      unreferencedFlows: (report.callGraph?.unreferencedFlows || []).slice(0, 20),
      validationErrors: report.validation?.errors || [],
      validationWarnings: report.validation?.warnings || [],
      warnings: report.warnings || [],
      errors: report.errors || [],
    };
  } catch (e) {
    return { ok: false, reason: 'inspect_error', error: e.message };
  }
}

/**
 * 读取项目内文件（限制在 xbotDir 下）
 */
function readProjectFile(xbotDir, relativePath, opts = {}) {
  if (!xbotDir || !relativePath) {
    return { ok: false, reason: 'missing_args' };
  }
  const maxBytes = opts.maxBytes || 200000;
  const abs = path.resolve(xbotDir, relativePath);
  const root = path.resolve(xbotDir);
  if (!abs.startsWith(root)) {
    return { ok: false, reason: 'path_escape' };
  }
  if (!fs.existsSync(abs)) {
    return { ok: false, reason: 'not_found', absolutePath: abs };
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) return { ok: false, reason: 'not_file' };
  if (stat.size > maxBytes) {
    return { ok: false, reason: 'too_large', size: stat.size, maxBytes };
  }
  const content = fs.readFileSync(abs, 'utf8');
  return {
    ok: true,
    relativePath: path.relative(root, abs).replace(/\\/g, '/'),
    absolutePath: abs,
    content,
    size: stat.size,
  };
}

function validateXbotProject(xbotDir, flowName, opts = {}) {
  const cfg = opts.cfg || loadConfig();
  try {
    const { validateProject } = requireValidate(cfg);
    return { ok: true, result: validateProject(xbotDir, flowName || '') };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  getRpaSkillPath,
  getShadowBotUsersRoot,
  loadAppMap,
  listShadowBotUserHomes,
  discoverXbotDir,
  resolveXbotDir,
  scanLocalApps,
  readPackageMeta,
  understandFlow,
  loadFlowBlocks,
  inspectProject,
  readProjectFile,
  validateXbotProject,
};
