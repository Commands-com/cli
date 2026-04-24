import { artifactPath } from './artifact-paths.js';
import { shouldBlockUnsafeFix } from './workflow.js';

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
  ];
}

function check(name, ok, message) {
  return {
    name,
    ok: Boolean(ok),
    message: ok ? '' : message,
  };
}
