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

test('createCyclePhaseView defaults testCommand and maxImplementers when undefined', () => {
  const provider = { id: 'mock' };
  const view = createCyclePhaseView(phaseState({
    providers: [provider],
    primaryProvider: provider,
    model: 'gpt-test',
    timeoutMs: 1234,
    providerRetries: 2,
    testCommand: undefined,
  }));

  assert.equal(view.testCommand, '');
  assert.equal(view.maxImplementers, 1);
  assert.equal(view.fanoutParallel, false);
  assert.equal(view.implementationParallel, false);
});
