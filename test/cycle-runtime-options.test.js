import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCyclePhaseView,
  createCycleState,
} from '../src/cycle-state.js';

function phaseState(options) {
  return createCycleState({
    kind: 'quality',
    context: { repoRoot: '/repo' },
    store: { async write() { return ''; } },
    workspace: { mode: 'current', cwd: '/repo' },
    logger: { info() {} },
    options,
  });
}

test('createCyclePhaseView defaults phase-specific runtime options', () => {
  const provider = { id: 'mock' };
  const state = phaseState({
    providers: [provider],
    primaryProvider: provider,
    model: 'gpt-test',
    timeoutMs: 1234,
    providerRetries: 2,
    testCommand: undefined,
  });

  const view = createCyclePhaseView(state);

  assert.equal(view.implementationRuntimeOptions.testCommand, '');
  assert.equal(view.implementationRuntimeOptions.maxImplementers, 1);
  assert.equal(view.fanoutRuntimeOptions.fanoutParallel, false);
  assert.equal(view.implementationRuntimeOptions.implementationParallel, false);
  assert.equal(Object.hasOwn(view, 'runtimeOptions'), false);
});
