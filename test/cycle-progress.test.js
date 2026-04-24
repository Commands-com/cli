import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCycleProgress,
  shouldStopForStall,
} from '../src/cycle-progress.js';

function state({
  kind = 'review',
  cycles = [],
  stalledCycles = 0,
  stallCycles = 2,
} = {}) {
  return {
    kind,
    cycles,
    stalledCycles,
    options: { stallCycles },
  };
}

test('applyCycleProgress marks the first cycle as changed progress', () => {
  const cycle = { cycle: 1, score: 'C', issueCount: 2, synopsis: 'Initial findings.' };
  const runState = state({ cycles: [cycle], stalledCycles: 4 });

  const progress = applyCycleProgress(runState, cycle);

  assert.deepEqual(progress, {
    improved: true,
    changed: true,
    stalledCycles: 0,
  });
  assert.equal(runState.stalledCycles, 0);
  assert.equal(cycle.progress, progress);
});

test('applyCycleProgress detects repeated unchanged cycles and stall thresholds', () => {
  const previous = { cycle: 1, score: 'B', issueCount: 2, synopsis: 'Same issue.' };
  const current = { cycle: 2, score: 'B', issueCount: 2, synopsis: 'Same issue.' };
  const runState = state({ cycles: [previous, current], stallCycles: 1 });

  const progress = applyCycleProgress(runState, current);

  assert.deepEqual(progress, {
    improved: false,
    changed: false,
    stalledCycles: 1,
  });
  assert.equal(shouldStopForStall(runState, current), true);
});

test('applyCycleProgress requires the current cycle to be recorded first', () => {
  const previous = { cycle: 1, score: 'B', issueCount: 2, synopsis: 'Same issue.' };
  const current = { cycle: 2, score: 'B', issueCount: 2, synopsis: 'Same issue.' };
  const runState = state({ cycles: [previous] });

  assert.throws(
    () => applyCycleProgress(runState, current),
    /cycleRecord to be recorded as the latest state cycle/,
  );
});

test('applyCycleProgress treats score improvement as progress for review cycles', () => {
  const previous = { cycle: 1, score: 'C', issueCount: 2, synopsis: 'Same issue.' };
  const current = { cycle: 2, score: 'B', issueCount: 2, synopsis: 'Same issue.' };
  const runState = state({ cycles: [previous, current], stalledCycles: 3 });

  const progress = applyCycleProgress(runState, current);

  assert.deepEqual(progress, {
    improved: true,
    changed: true,
    stalledCycles: 0,
  });
});

test('applyCycleProgress treats changed findings as non-stalled without claiming improvement', () => {
  const previous = { cycle: 1, score: 'B', issueCount: 2, synopsis: 'Old issue.' };
  const current = { cycle: 2, score: 'B', issueCount: 2, synthesis: 'New issue.' };
  const runState = state({ cycles: [previous, current], stalledCycles: 2 });

  const progress = applyCycleProgress(runState, current);

  assert.deepEqual(progress, {
    improved: false,
    changed: true,
    stalledCycles: 0,
  });
});

test('applyCycleProgress normalizes invalid counts before comparing progress', () => {
  const previous = { cycle: 1, score: 'B', issueCount: -1, synopsis: 'Same issue.' };
  const current = { cycle: 2, score: 'B', issueCount: Number.NaN, synopsis: 'Same issue.' };
  const runState = state({ cycles: [previous, current], stalledCycles: Number.NaN });

  const progress = applyCycleProgress(runState, current);

  assert.deepEqual(progress, {
    improved: false,
    changed: false,
    stalledCycles: 1,
  });
});

test('applyCycleProgress coerces numeric issue counts before comparing progress', () => {
  const previous = { cycle: 1, score: 'B', issueCount: '2', synopsis: 'Same issue.' };
  const current = { cycle: 2, score: 'B', issueCount: '1', synopsis: 'Same issue.' };
  const runState = state({ cycles: [previous, current], stalledCycles: 3 });

  const progress = applyCycleProgress(runState, current);

  assert.deepEqual(progress, {
    improved: true,
    changed: true,
    stalledCycles: 0,
  });
});

test('shouldStopForStall clamps invalid stall values', () => {
  assert.equal(
    shouldStopForStall(
      { options: { stallCycles: 0 } },
      { progress: { stalledCycles: 99 } },
    ),
    false,
  );
  assert.equal(
    shouldStopForStall(
      { options: { stallCycles: 1 } },
      { progress: { stalledCycles: Number.POSITIVE_INFINITY } },
    ),
    false,
  );
});
