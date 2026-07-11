/**
 * 简易文件锁：防止双开 poll/service
 */

const fs = require('fs');
const path = require('path');

function lockPath(dataDir) {
  return path.join(dataDir, 'service.pid');
}

/**
 * @param {string} dataDir
 * @returns {{ ok: true, path: string } | { ok: false, reason: string, pid?: number }}
 */
function acquireLock(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = lockPath(dataDir);
  if (fs.existsSync(file)) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (pid && isProcessAlive(pid)) {
        return { ok: false, reason: 'already_running', pid };
      }
    } catch {
      // stale lock
    }
  }
  fs.writeFileSync(file, `${process.pid}\n`, 'utf8');
  return { ok: true, path: file };
}

function releaseLock(dataDir) {
  const file = lockPath(dataDir);
  try {
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (String(process.pid) === raw || !isProcessAlive(parseInt(raw, 10))) {
      fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
}

function isProcessAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  lockPath,
  acquireLock,
  releaseLock,
  isProcessAlive,
};
