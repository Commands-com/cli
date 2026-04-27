import { artifactPath } from './artifact-paths.js';
import { SCORE_ORDER } from './summary-contract.js';
import { shouldBlockUnsafeFix } from './workflow.js';

/**
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 */

/**
 * Result of a single preflight gate. The collected `checks` array is written
 * verbatim to `preflight.json` and joined into the failure message.
 *
 * @typedef {object} PreflightCheck
 * @property {string} name Stable check identifier surfaced in artifacts and logs.
 * @property {boolean} ok Whether the gate passed.
 * @property {string} message Human-readable failure message; empty when `ok`.
 */

/**
 * @typedef {object} PreflightResult
 * @property {boolean} ok Whether every preflight gate passed.
 * @property {Array<PreflightCheck>} checks Per-gate results, in declaration order.
 */

/**
 * @param {CycleState} state
 * @returns {Promise<PreflightResult>}
 */
export async function runCyclePreflight(state) {
  const checks = preflightChecks(state);
  const ok = checks.every((check) => check.ok);
  const payload = {
    ok,
    checks,
  };
  if (typeof state?.store?.writeJson === 'function') {
    await state.store.writeJson(artifactPath('preflight.json'), payload);
  }
  if (!ok) {
    const failed = checks.filter((check) => !check.ok).map((check) => check.message).join(' ');
    state?.logger?.info?.('preflight: failed');
    throw new Error(failed || 'preflight failed');
  }
  state?.logger?.info?.('preflight: passed');
  return payload;
}

/**
 * @param {CycleState} state
 * @returns {Array<PreflightCheck>}
 */
function preflightChecks(state) {
  const options = state?.options || {};
  const providers = Array.isArray(options.providers) ? options.providers : [];
  return [
    check('providers', providers.length > 0, 'no providers resolved for this run'),
    check(
      'primary-provider',
      Boolean(options.primaryProvider?.id),
      'no primary provider resolved for synthesis and implementation',
    ),
    check(
      'dirty-worktree',
      !shouldBlockUnsafeFix({
        fix: options.fix,
        worktree: options.worktree,
        allowDirty: options.allowDirty,
        status: state?.context?.status,
      }),
      [
        '--fix would edit a dirty working tree.',
        'Commit/stash your changes, pass --allow-dirty, or use --worktree to isolate agent edits.',
      ].join(' '),
    ),
    check(
      'test-command',
      options.testCommand === undefined || typeof options.testCommand === 'string',
      '--test must be a shell command string',
    ),
    check(
      'cycle-cap',
      !options.fix || Math.max(0, Number(options.maxCycles || 0)) > 0,
      '--fix requires at least one cycle',
    ),
    check(
      'until-score',
      options.untilScore === undefined
        || options.untilScore === null
        || (typeof options.untilScore === 'string' && options.untilScore.trim() === '')
        || SCORE_ORDER.includes(options.untilScore),
      `--until must be one of ${SCORE_ORDER.join(', ')}`,
    ),
  ];
}

/**
 * @param {string} name
 * @param {unknown} ok
 * @param {string} message
 * @returns {PreflightCheck}
 */
function check(name, ok, message) {
  return {
    name,
    ok: Boolean(ok),
    message: ok ? '' : message,
  };
}
