/**
 * Agent Runner：skill 路由 + diagnose playbook（M1-min）
 * CLI 与未来 service 共用；禁止平行 diagnose.js 业务栈。
 */

const { listToolsForSkill } = require('./tools');
const { loadConfig } = require('./config');
const { runDiagnosePlaybook, drainQueue } = require('./skills/diagnose');

const IMPLEMENTED_SKILLS = new Set(['diagnose']);
const RESERVED_SKILLS = new Set(['develop', 'maintain']);

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
      message: `skill "${name}" 已预留，尚未实现。当前仅支持: diagnose`,
    };
  }

  if (!IMPLEMENTED_SKILLS.has(name)) {
    return {
      ok: false,
      code: 'unknown_skill',
      skill: name,
      message: `未知 skill: ${name}。可用: diagnose；预留: develop, maintain`,
    };
  }

  if (name === 'diagnose') {
    // 批量队列消费
    if ((input.queue || input.fromQueue) && (input.limit > 0 || input.drain)) {
      const limit = input.limit > 0 ? input.limit : 5;
      return drainQueue(cfg, { limit, dryRun: options.dryRun || input.dryRun });
    }
    return runDiagnosePlaybook(input, cfg, {
      dryRun: options.dryRun || input.dryRun,
    });
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
