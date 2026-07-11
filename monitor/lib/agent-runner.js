/**
 * Agent Runner：skill 路由
 */

const { listToolsForSkill } = require('./tools');
const { loadConfig } = require('./config');
const { runDiagnosePlaybook, drainQueue } = require('./skills/diagnose');
const { runMaintain } = require('./skills/maintain');

const IMPLEMENTED_SKILLS = new Set(['diagnose', 'maintain']);
const RESERVED_SKILLS = new Set(['develop']);

/**
 * @param {string} skill
 * @param {object} [input]
 * @param {{ cfg?: object, dryRun?: boolean }} [options]
 */
async function runSkill(skill, input = {}, options = {}) {
  const cfg = options.cfg || loadConfig();
  const name = String(skill || '').toLowerCase();

  if (RESERVED_SKILLS.has(name) && !IMPLEMENTED_SKILLS.has(name)) {
    return {
      ok: false,
      code: 'skill_not_implemented',
      skill: name,
      message: `skill "${name}" 已预留，尚未实现。当前支持: diagnose, maintain`,
    };
  }

  if (!IMPLEMENTED_SKILLS.has(name)) {
    return {
      ok: false,
      code: 'unknown_skill',
      skill: name,
      message: `未知 skill: ${name}。可用: diagnose, maintain；预留: develop`,
    };
  }

  if (name === 'diagnose') {
    if ((input.queue || input.fromQueue) && (input.limit > 0 || input.drain)) {
      const limit = input.limit > 0 ? input.limit : 5;
      return drainQueue(cfg, { limit, dryRun: options.dryRun || input.dryRun });
    }
    return runDiagnosePlaybook(input, cfg, {
      dryRun: options.dryRun || input.dryRun,
    });
  }

  if (name === 'maintain') {
    return runMaintain(input, cfg);
  }

  return {
    ok: false,
    code: 'skill_not_implemented',
    skill: name,
    message: `skill "${name}" 未实现`,
  };
}

function describeDiagnose() {
  return {
    skill: 'diagnose',
    visibleTools: listToolsForSkill('diagnose').map((t) => t.name),
    stage: 'M1-min',
  };
}

module.exports = {
  runSkill,
  describeDiagnose,
  IMPLEMENTED_SKILLS,
  RESERVED_SKILLS,
};
