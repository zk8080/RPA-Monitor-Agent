/**
 * understand 结果磁盘缓存（按 xbotDir + flowName + mtime）
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function cacheDir(dataDir) {
  return path.join(dataDir, 'cache', 'understand');
}

function dirMtimeMs(xbotDir) {
  try {
    const pkg = path.join(xbotDir, 'package.json');
    if (fs.existsSync(pkg)) return fs.statSync(pkg).mtimeMs;
    return fs.statSync(xbotDir).mtimeMs;
  } catch {
    return 0;
  }
}

// 缓存版本：understand 返回字段变更时递增，避免旧缓存缺流程图
const CACHE_VERSION = 'v2-mermaid';

function makeCacheKey(xbotDir, flowName = '') {
  const mtime = dirMtimeMs(xbotDir);
  const material = `${CACHE_VERSION}|${path.resolve(xbotDir)}|${flowName || ''}|${mtime}`;
  return crypto.createHash('sha1').update(material).digest('hex');
}

function cachePath(dataDir, key) {
  return path.join(cacheDir(dataDir), `${key}.json`);
}

/**
 * @returns {{ hit: boolean, key: string, payload?: object }}
 */
function readCache(dataDir, xbotDir, flowName = '') {
  const key = makeCacheKey(xbotDir, flowName);
  const file = cachePath(dataDir, key);
  try {
    if (!fs.existsSync(file)) return { hit: false, key };
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { hit: true, key, payload };
  } catch {
    return { hit: false, key };
  }
}

function writeCache(dataDir, key, result) {
  const dir = cacheDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = cachePath(dataDir, key);
  const tmp = `${file}.${process.pid}.tmp`;
  const body = {
    cachedAt: new Date().toISOString(),
    key,
    result,
  };
  fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  return body;
}

module.exports = {
  makeCacheKey,
  dirMtimeMs,
  readCache,
  writeCache,
  cacheDir,
};
