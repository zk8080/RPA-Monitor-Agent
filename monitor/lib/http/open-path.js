/**
 * 本机打开目录（仅允许已校验的 xbotDir）
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
 * 按 robotUuid resolve 后打开文件夹
 * @param {string} robotUuid
 * @param {{ cfg?: object, enabled?: boolean }} [opts]
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
  openDirectory,
};
