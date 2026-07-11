/**
 * Fixer 注册表：match → plan
 */

const pythonIndexError = require('./python_index_error');
const pythonNoneGuard = require('./python_none_guard');

const FIXERS = [pythonIndexError, pythonNoneGuard];

/**
 * @param {object} ctx { text, working, fileContent, relativePath, absolutePath, diagnosis }
 */
function matchFixers(ctx) {
  return FIXERS.map((f) => ({
    fixer: f,
    score: f.match(ctx) || 0,
  }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

function getFixer(id) {
  return FIXERS.find((f) => f.id === id) || null;
}

module.exports = {
  FIXERS,
  matchFixers,
  getFixer,
};
