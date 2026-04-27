import test from 'node:test';
import assert from 'node:assert/strict';
import { runCyclePreflight } from '../src/cycle-preflight.js';
import { memoryStore } from './support/memory-store.js';

function testState({
  status = '',
  options = {},
} = {}) {
  const store = memoryStore();
  const logs = [];
  return {
    store,
    logs,
    context: { status },
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
      testCommand: '',
      ...options,
    },
  };
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
      ['test-command', true, ''],
      ['cycle-cap', true, ''],
      ['until-score', true, ''],
    ],
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
