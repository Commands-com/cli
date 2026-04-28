import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runCyclePreflight } from '../src/cycle-preflight.js';
import { memoryStore } from './support/memory-store.js';
import { tempDir } from './support/cli.js';
import { initGitRepo } from './support/git.js';

/** @param {any} args @returns {any} */
function testState({
  status = '',
  gitRoot = '/repo',
  repoRoot,
  options = {},
} = {}) {
  const store = memoryStore();
  const logs = [];
  return /** @type {any} */ ({
    store,
    logs,
    context: { status, gitRoot, repoRoot },
    logger: {
      info(message) {
        logs.push(message);
      },
    },
    options: {
      providers: [{ id: 'mock' }],
      primaryProvider: { id: 'mock' },
      fix: false,
      worktree: false,
      allowDirty: false,
      maxCycles: 1,
      ...options,
    },
  });
}

test('runCyclePreflight writes a passing preflight payload', async () => {
  const state = testState();

  const payload = await runCyclePreflight(state);

  assert.equal(payload.ok, true);
  assert.deepEqual(state.logs, ['preflight: passed']);
  assert.deepEqual(state.store.writes, [
    {
      name: 'preflight.json',
      value: payload,
    },
  ]);
  assert.deepEqual(
    payload.checks.map((check) => [check.name, check.ok, check.message]),
    [
      ['providers', true, ''],
      ['primary-provider', true, ''],
      ['dirty-worktree', true, ''],
      ['worktree-git-repo', true, ''],
      ['base-ref', true, ''],
      ['test-command', true, ''],
      ['test-repo-root', true, ''],
      ['cycle-cap', true, ''],
      ['max-implementers', true, ''],
      ['stall-cycles', true, ''],
      ['until-score', true, ''],
    ],
  );
});

test('runCyclePreflight rejects out-of-range maxImplementers from a tampered resume state', async () => {
  const state = testState({ options: { maxImplementers: 1000 } });

  await assert.rejects(
    runCyclePreflight(state),
    /--max-implementers must be between 1 and 32/,
  );
});

test('runCyclePreflight rejects negative stallCycles from a tampered resume state', async () => {
  const state = testState({ options: { stallCycles: -1 } });

  await assert.rejects(
    runCyclePreflight(state),
    /--stall-cycles must be a non-negative integer/,
  );
});

test('runCyclePreflight passes when --until is omitted', async () => {
  const state = testState();

  const payload = await runCyclePreflight(state);
  const untilCheck = payload.checks.find((check) => check.name === 'until-score');

  assert.equal(untilCheck.ok, true);
  assert.equal(untilCheck.message, '');
});

test('runCyclePreflight passes when --until is a valid SCORE_ORDER value', async () => {
  for (const score of ['A', 'B', 'C', 'D', 'F']) {
    const state = testState({ options: { untilScore: score } });

    const payload = await runCyclePreflight(state);
    const untilCheck = payload.checks.find((check) => check.name === 'until-score');

    assert.equal(untilCheck.ok, true, `expected ${score} to pass`);
  }
});

test('runCyclePreflight fails with a usage message when --until is not a SCORE_ORDER value', async () => {
  const state = testState({ options: { untilScore: 'Z' } });

  await assert.rejects(
    runCyclePreflight(state),
    /--until must be one of A, B, C, D, F/,
  );

  const untilCheck = state.store.writes[0].value.checks.find((check) => check.name === 'until-score');
  assert.equal(untilCheck.ok, false);
  assert.match(untilCheck.message, /--until must be one of A, B, C, D, F/);
});

test('runCyclePreflight treats empty or whitespace --until as missing (matches resolver default)', async () => {
  for (const value of ['', '   ', '\t']) {
    const state = testState({ options: { untilScore: value } });

    const payload = await runCyclePreflight(state);
    const untilCheck = payload.checks.find((check) => check.name === 'until-score');

    assert.equal(untilCheck.ok, true, `expected ${JSON.stringify(value)} to pass`);
  }
});

test('runCyclePreflight blocks unsafe fix attempts in a dirty worktree', async () => {
  const state = testState({
    status: ' M src/cycle-preflight.js\n?? test/cycle-preflight.test.js',
    options: { fix: true },
  });

  await assert.rejects(
    runCyclePreflight(state),
    /--fix would edit a dirty working tree/,
  );

  const payload = state.store.writes[0].value;
  const dirtyCheck = payload.checks.find((check) => check.name === 'dirty-worktree');
  assert.equal(payload.ok, false);
  assert.equal(dirtyCheck.ok, false);
  assert.match(dirtyCheck.message, /pass --allow-dirty, or use --worktree/);
  assert.deepEqual(state.logs, ['preflight: failed']);
});

test('runCyclePreflight allows isolated or explicit dirty fix modes', async () => {
  for (const options of [{ fix: true, allowDirty: true }, { fix: true, worktree: true }]) {
    const state = testState({
      status: ' M src/cycle-preflight.js',
      options,
    });

    const payload = await runCyclePreflight(state);
    const dirtyCheck = payload.checks.find((check) => check.name === 'dirty-worktree');

    assert.equal(payload.ok, true);
    assert.equal(dirtyCheck.ok, true);
  }
});

test('runCyclePreflight reports missing required runtime inputs together', async () => {
  const state = testState({
    options: {
      providers: [],
      primaryProvider: null,
      fix: true,
      maxCycles: 0,
      testCommand: null,
    },
  });

  await assert.rejects(
    runCyclePreflight(state),
    /no providers resolved.*no primary provider.*--test must be a shell command string.*--fix requires at least one cycle/s,
  );

  const failedChecks = state.store.writes[0].value.checks
    .filter((check) => !check.ok)
    .map((check) => check.name);
  assert.deepEqual(failedChecks, [
    'providers',
    'primary-provider',
    'test-command',
    'cycle-cap',
  ]);
});

test('runCyclePreflight gates --worktree on a git repo regardless of --fix', async () => {
  const cases = [
    { fix: true, gitRoot: '', expectedOk: false },
    { fix: true, gitRoot: '/repo', expectedOk: true },
    { fix: false, gitRoot: '', expectedOk: false },
    { fix: false, gitRoot: '/repo', expectedOk: true },
  ];

  for (const { fix, gitRoot, expectedOk } of cases) {
    const label = `fix=${fix} gitRoot=${JSON.stringify(gitRoot)}`;
    const state = testState({ gitRoot, options: { fix, worktree: true } });

    if (expectedOk) {
      const payload = await runCyclePreflight(state);
      const worktreeCheck = payload.checks.find((check) => check.name === 'worktree-git-repo');
      assert.equal(payload.ok, true, `${label}: payload.ok`);
      assert.equal(worktreeCheck.ok, true, `${label}: worktree check`);
    } else {
      await assert.rejects(
        runCyclePreflight(state),
        /--worktree requires a git repo/,
        label,
      );
      const worktreeCheck = state.store.writes[0].value.checks.find(
        (check) => check.name === 'worktree-git-repo',
      );
      assert.equal(worktreeCheck.ok, false, `${label}: worktree check`);
    }
  }
});

test('runCyclePreflight test-repo-root check enforces a real, readable repoRoot when --test is set', async () => {
  const dir = await tempDir('commands-com-preflight-repo-');
  try {
    const filePath = path.join(dir, 'not-a-dir');
    await fs.writeFile(filePath, 'x', 'utf8');

    const cases = [
      { label: 'missing repoRoot', repoRoot: '', expectedOk: false },
      { label: 'non-directory repoRoot', repoRoot: filePath, expectedOk: false },
      { label: 'valid repoRoot', repoRoot: dir, expectedOk: true },
    ];

    for (const { label, repoRoot, expectedOk } of cases) {
      const state = testState({ repoRoot, options: { testCommand: 'npm test' } });

      if (expectedOk) {
        const payload = await runCyclePreflight(state);
        const repoRootCheck = payload.checks.find((check) => check.name === 'test-repo-root');
        assert.equal(repoRootCheck.ok, true, `${label}: ok`);
      } else {
        await assert.rejects(
          runCyclePreflight(state),
          /--test requires a readable repo root/,
          label,
        );
        const repoRootCheck = state.store.writes[0].value.checks.find(
          (check) => check.name === 'test-repo-root',
        );
        assert.equal(repoRootCheck.ok, false, `${label}: ok`);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('runCyclePreflight base-ref check resolves --base-ref against the git root when --worktree is set', async () => {
  const repo = await tempDir('commands-com-preflight-baseref-');
  try {
    await initGitRepo(repo);

    const unsetState = testState({
      gitRoot: repo,
      options: { worktree: true, baseRef: undefined },
    });
    const unsetPayload = await runCyclePreflight(unsetState);
    const unsetCheck = unsetPayload.checks.find((check) => check.name === 'base-ref');
    assert.equal(unsetCheck.ok, true, 'unset base-ref should pass');

    const validState = testState({
      gitRoot: repo,
      options: { worktree: true, baseRef: 'HEAD' },
    });
    const validPayload = await runCyclePreflight(validState);
    const validCheck = validPayload.checks.find((check) => check.name === 'base-ref');
    assert.equal(validCheck.ok, true, 'HEAD should resolve in a real repo');

    const invalidState = testState({
      gitRoot: repo,
      options: { worktree: true, baseRef: 'definitely-not-a-real-ref' },
    });
    await assert.rejects(
      runCyclePreflight(invalidState),
      /--base-ref must resolve to a known git ref/,
    );
    const invalidCheck = invalidState.store.writes[0].value.checks.find(
      (check) => check.name === 'base-ref',
    );
    assert.equal(invalidCheck.ok, false);
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test('runCyclePreflight base-ref check is skipped when --worktree is not set (no git rev-parse I/O)', async () => {
  const state = testState({
    gitRoot: '/definitely/not/a/git/repo',
    options: { worktree: false, baseRef: 'definitely-not-a-real-ref' },
  });

  const payload = await runCyclePreflight(state);
  const baseRefCheck = payload.checks.find((check) => check.name === 'base-ref');

  assert.equal(payload.ok, true);
  assert.equal(baseRefCheck.ok, true);
  assert.equal(baseRefCheck.message, '');
});
