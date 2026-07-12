/**
 * 本机打开目录 / 在 Coding Agent 中打开（仅允许已校验的 xbotDir）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const rpa = require('../rpa');

/**
 * 校验目标目录是否可作为 open 目标
 * @param {string} dir
 */
function assertOpenableDir(dir) {
  if (!dir || typeof dir !== 'string') {
    return { ok: false, code: 'missing_path', message: '路径为空' };
  }
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    return { ok: false, code: 'not_found', message: `目录不存在: ${resolved}` };
  }
  let st;
  try {
    st = fs.statSync(resolved);
  } catch (e) {
    return { ok: false, code: 'stat_failed', message: e.message };
  }
  if (!st.isDirectory()) {
    return { ok: false, code: 'not_directory', message: `不是目录: ${resolved}` };
  }
  // 须像 xbot 工程（与 rpa 解析一致）
  const looksValid =
    fs.existsSync(path.join(resolved, 'package.json')) || fs.existsSync(path.join(resolved, '.dev'));
  if (!looksValid) {
    return { ok: false, code: 'not_xbot_dir', message: '不是有效的 xbot_robot 目录' };
  }
  return { ok: true, path: resolved };
}

/**
 * 内置 Agent 预设（可被 config.workbench.agents 覆盖 / 禁用）
 * - editor：spawn command + args（{path} 替换为目录）
 * - terminal：在该目录打开终端并执行 run 命令
 */
function defaultAgents() {
  const isWin = process.platform === 'win32';
  return [
    {
      id: 'cursor',
      label: 'Cursor',
      kind: 'editor',
      command: 'cursor',
      args: ['{path}'],
      hint: '以该目录为工作区打开 Cursor',
    },
    {
      id: 'vscode',
      label: 'VS Code',
      kind: 'editor',
      command: 'code',
      args: ['{path}'],
      hint: '以该目录为工作区打开 VS Code',
    },
    {
      id: 'qoder',
      label: 'Qoder',
      kind: 'editor',
      command: 'qoder',
      args: ['{path}'],
      hint: '以该目录为工作区打开 Qoder（需已安装 shell 命令）',
    },
    {
      id: 'claude',
      label: 'Claude Code',
      kind: 'terminal',
      run: 'claude',
      hint: isWin
        ? '在该目录打开终端并运行 claude（需已安装 CLI）'
        : '在该目录打开终端并运行 claude',
    },
    {
      id: 'codex',
      label: 'Codex',
      kind: 'terminal',
      run: 'codex',
      hint: '在该目录打开终端并运行 codex（需已安装 CLI）',
    },
  ];
}

/**
 * @param {object} [raw]
 * @returns {object[]}
 */
function resolveAgentsConfig(raw) {
  const defaults = defaultAgents();
  if (!raw) return defaults.map(normalizeAgent).filter(Boolean);

  // 完整数组：替换默认列表
  if (Array.isArray(raw)) {
    return raw.map(normalizeAgent).filter((a) => a && a.enabled !== false);
  }

  // 对象：按 id 覆盖；false 禁用
  if (typeof raw === 'object') {
    const out = [];
    const seen = new Set();
    for (const d of defaults) {
      const o = raw[d.id];
      if (o === false || o === null) {
        seen.add(d.id);
        continue;
      }
      const merged = normalizeAgent({
        ...d,
        ...(typeof o === 'object' && o ? o : {}),
        id: d.id,
      });
      if (merged && merged.enabled !== false) out.push(merged);
      seen.add(d.id);
    }
    // 允许新增自定义 id
    for (const [id, o] of Object.entries(raw)) {
      if (seen.has(id) || o === false || o === null) continue;
      if (typeof o !== 'object') continue;
      const merged = normalizeAgent({ ...o, id });
      if (merged && merged.enabled !== false) out.push(merged);
    }
    return out;
  }

  return defaults.map(normalizeAgent).filter(Boolean);
}

/**
 * @param {object} a
 */
function normalizeAgent(a) {
  if (!a || typeof a !== 'object') return null;
  const id = String(a.id || '').trim();
  if (!id || !/^[a-zA-Z0-9_-]{1,32}$/.test(id)) return null;
  const kind = a.kind === 'terminal' ? 'terminal' : 'editor';
  const label = String(a.label || id).slice(0, 40);
  const hint = a.hint != null ? String(a.hint).slice(0, 160) : '';
  const enabled = a.enabled !== false;

  if (kind === 'terminal') {
    const run = String(a.run || a.command || '').trim();
    if (!run) return null;
    // 禁止注入：run 仅允许简单可执行名或带空格的简单 argv 串（无重定向）
    if (/[|&><`]/.test(run) || run.includes('\n')) return null;
    return { id, label, kind, run, hint, enabled };
  }

  const command = String(a.command || '').trim();
  if (!command) return null;
  if (/[|&><`]/.test(command) || command.includes('\n')) return null;
  let args = Array.isArray(a.args) ? a.args.map((x) => String(x)) : ['{path}'];
  if (!args.length) args = ['{path}'];
  // 参数只允许 {path} 占位或普通路径片段，禁止 shell 元字符
  for (const arg of args) {
    if (/[|&><`]/.test(arg) || String(arg).includes('\n')) return null;
  }
  return { id, label, kind, command, args, hint, enabled };
}

/**
 * 供 API / UI 展示（不含敏感绝对路径配置细节以外的字段）
 * @param {object[]|object|null} agentsConfig
 */
function listAgents(agentsConfig) {
  return resolveAgentsConfig(agentsConfig).map((a) => ({
    id: a.id,
    label: a.label,
    kind: a.kind,
    hint: a.hint || '',
  }));
}

/**
 * 按 robotUuid resolve 后打开文件夹
 * @param {string} robotUuid
 * @param {{ cfg?: object, enabled?: boolean, openCommand?: string|null }} [opts]
 */
function openRobotFolder(robotUuid, opts = {}) {
  if (opts.enabled === false) {
    return { ok: false, code: 'disabled', message: 'workbench.openFolderEnabled=false' };
  }
  if (!robotUuid) {
    return { ok: false, code: 'missing_robotUuid', message: '缺少 robotUuid' };
  }

  const resolved = rpa.resolveXbotDir(robotUuid, { cfg: opts.cfg });
  if (!resolved.mapped || !resolved.xbotDir) {
    return {
      ok: false,
      code: 'not_resolved',
      message: resolved.reason || '无法解析本机流程目录',
      resolve: resolved,
    };
  }

  const check = assertOpenableDir(resolved.xbotDir);
  if (!check.ok) return { ...check, resolve: resolved };

  return openDirectory(check.path, {
    openCommand: opts.openCommand || null,
  });
}

/**
 * 在指定 Coding Agent 中打开已 resolve 的应用目录
 * @param {string} robotUuid
 * @param {string} agentId
 * @param {{ cfg?: object, enabled?: boolean, agents?: object[]|object|null }} [opts]
 */
function openRobotWithAgent(robotUuid, agentId, opts = {}) {
  if (opts.enabled === false) {
    return { ok: false, code: 'disabled', message: 'workbench.openFolderEnabled=false' };
  }
  if (!robotUuid) {
    return { ok: false, code: 'missing_robotUuid', message: '缺少 robotUuid' };
  }
  const id = String(agentId || '').trim();
  if (!id) {
    return { ok: false, code: 'missing_agent', message: '缺少 agent' };
  }

  const agents = resolveAgentsConfig(opts.agents);
  const agent = agents.find((a) => a.id === id);
  if (!agent) {
    return {
      ok: false,
      code: 'unknown_agent',
      message: `未知 agent: ${id}`,
      agents: agents.map((a) => a.id),
    };
  }

  const resolved = rpa.resolveXbotDir(robotUuid, { cfg: opts.cfg });
  if (!resolved.mapped || !resolved.xbotDir) {
    return {
      ok: false,
      code: 'not_resolved',
      message: resolved.reason || '无法解析本机流程目录',
      resolve: resolved,
    };
  }

  const check = assertOpenableDir(resolved.xbotDir);
  if (!check.ok) return { ...check, resolve: resolved };

  return openWithAgent(check.path, agent);
}

/**
 * @param {string} dir absolute path already validated
 * @param {object} agent normalized agent
 */
function openWithAgent(dir, agent) {
  const target = path.resolve(dir);
  try {
    if (agent.kind === 'terminal') {
      return openInTerminal(target, agent.run, agent.id);
    }
    const args = (agent.args || ['{path}']).map((a) =>
      String(a).split('{path}').join(target),
    );
    const child = spawn(agent.command, args, {
      detached: true,
      stdio: 'ignore',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    child.unref();
    return {
      ok: true,
      opened: target,
      agent: agent.id,
      method: 'editor',
      command: agent.command,
      args,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'spawn_failed',
      message: e.message,
      opened: target,
      agent: agent.id,
    };
  }
}

/**
 * 在目录下打开终端并执行 CLI（Claude Code / Codex 等）
 * @param {string} dir
 * @param {string} runCmd simple command, e.g. "claude"
 * @param {string} [agentId]
 */
function openInTerminal(dir, runCmd, agentId) {
  const target = path.resolve(dir);
  const run = String(runCmd || '').trim();
  if (!run) {
    return { ok: false, code: 'missing_run', message: 'terminal agent 缺少 run', opened: target };
  }

  try {
    if (process.platform === 'win32') {
      // start "title" /D path cmd /k <run>
      const child = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/c', 'start', agentId || 'agent', '/D', target, 'cmd', '/k', run],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.unref();
      return {
        ok: true,
        opened: target,
        agent: agentId || null,
        method: 'terminal-cmd',
        run,
      };
    }

    if (process.platform === 'darwin') {
      // osascript 打开 Terminal 并 cd + run
      const script = `tell application "Terminal" to do script "cd ${shellQuote(target)} && ${run}"`;
      const child = spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return {
        ok: true,
        opened: target,
        agent: agentId || null,
        method: 'terminal-osascript',
        run,
      };
    }

    // Linux：优先 x-terminal-emulator / gnome-terminal
    const term = process.env.TERMINAL || 'x-terminal-emulator';
    const child = spawn(term, ['-e', `bash -lc ${shellQuote(`cd ${shellQuote(target)} && ${run}; exec bash`)}`], {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.unref();
    return {
      ok: true,
      opened: target,
      agent: agentId || null,
      method: 'terminal-linux',
      run,
    };
  } catch (e) {
    return {
      ok: false,
      code: 'spawn_failed',
      message: e.message,
      opened: target,
      agent: agentId || null,
    };
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string} dir absolute path already validated
 * @param {{ openCommand?: string|null }} [opts]
 */
function openDirectory(dir, opts = {}) {
  const target = path.resolve(dir);
  const custom = opts.openCommand || process.env.WORKBENCH_OPEN_COMMAND || '';

  try {
    if (custom) {
      // 简单：命令 + 路径作为唯一参数
      const child = spawn(custom, [target], {
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      child.unref();
      return { ok: true, opened: target, method: 'custom', command: custom };
    }

    if (process.platform === 'win32') {
      // Windows：cmd start 比直接 spawn explorer 更稳（后者常静默失败/闪退）
      // start "" "C:\path with spaces"
      const child = spawn(
        process.env.ComSpec || 'cmd.exe',
        ['/c', 'start', '""', target],
        {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        },
      );
      child.unref();
      return { ok: true, opened: target, method: 'cmd-start' };
    }

    if (process.platform === 'darwin') {
      const child = spawn('open', [target], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, opened: target, method: 'open' };
    }

    const child = spawn('xdg-open', [target], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, opened: target, method: 'xdg-open' };
  } catch (e) {
    return { ok: false, code: 'spawn_failed', message: e.message, opened: target };
  }
}

module.exports = {
  assertOpenableDir,
  openRobotFolder,
  openRobotWithAgent,
  openDirectory,
  openWithAgent,
  listAgents,
  resolveAgentsConfig,
  defaultAgents,
  normalizeAgent,
};
