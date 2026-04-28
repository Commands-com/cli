import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAssessmentProviderFanout,
} from '../src/cycle-fanout.js';
import {
  cycleProviderItemArtifactDescriptor,
} from '../src/artifact-paths.js';
import {
  createCyclePhaseView,
  createCycleRecorder,
  createCycleState,
} from '../src/cycle-state.js';

function testStore() {
  return {
    runId: 'run-1',
    dir: '/tmp/run-1',
    writes: [],
    async write(name, content) {
      this.writes.push({ name, content: String(content || '') });
      return `${this.dir}/${name}`;
    },
  };
}

/** @param {any} [options] @returns {any} */
function testOptions(options = {}) {
  const providers = options.providers || [{ id: 'mock' }];
  return {
    providers,
    primaryProvider: providers[0],
    providerIds: providers.map((provider) => provider.id),
    model: '',
    changed: false,
    fix: false,
    worktree: false,
    keepWorktree: false,
    allowDirty: false,
    serial: true,
    parallel: false,
    failOnIssues: false,
    json: true,
    timeoutMs: 30_000,
    maxCycles: 1,
    maxImplementers: 1,
    providerRetries: 0,
    testCommand: '',
    ...options,
  };
}

function testState(options = {}) {
  return createCycleState({
    kind: 'review',
    store: testStore(),
    workspace: { mode: 'current', cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main', status: '', diffStat: '', diff: '' },
    options: testOptions(options),
  });
}

test('createCycleState owns raw command options under state.options', () => {
  const rawOptions = testOptions({
    maxCycles: 3,
    testCommand: 'npm test',
    customOption: 'preserved',
  });
  const state = createCycleState({
    kind: 'review',
    store: testStore(),
    workspace: { mode: 'current', cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main', status: '', diffStat: '', diff: '' },
    options: rawOptions,
  });

  assert.notEqual(state.options, rawOptions);
  assert.equal(state.options.maxCycles, 3);
  assert.equal(state.options.testCommand, 'npm test');
  assert.equal(state.options.customOption, 'preserved');
  assert.equal(Reflect.get(state, 'runtimeOptions'), undefined);
  assert.equal(Object.hasOwn(state, 'runtimeOptions'), false);
  for (const optionKey of [
    'providers',
    'primaryProvider',
    'providerIds',
    'model',
    'json',
    'timeoutMs',
    'providerRetries',
    'maxCycles',
    'testCommand',
  ]) {
    assert.equal(Reflect.get(state, optionKey), undefined);
    assert.equal(optionKey in state, false);
    assert.equal(Object.keys(state).includes(optionKey), false);
  }

  rawOptions.maxCycles = 99;
  rawOptions.customOption = 'mutated';
  assert.equal(state.options.maxCycles, 3);
  assert.equal(state.options.customOption, 'preserved');
});

test('createCycleState preserves nested runtimeOptions only under owned options', () => {
  const state = createCycleState({
    kind: 'review',
    store: testStore(),
    workspace: { mode: 'current', cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main', status: '', diffStat: '', diff: '' },
    options: {
      ...testOptions(),
      runtimeOptions: { model: 'unused' },
    },
  });

  assert.deepEqual(state.options.runtimeOptions, { model: 'unused' });
  assert.equal(Reflect.get(state, 'runtimeOptions'), undefined);
  assert.equal(Object.hasOwn(state, 'runtimeOptions'), false);
});

test('createCyclePhaseView projects state.options for fan-out', async () => {
  const state = testState({
    providers: [{ id: 'mock' }],
    json: true,
  });
  Reflect.set(state, 'providers', []);
  Reflect.set(state, 'parallel', true);
  Reflect.set(state, 'model', 'stale-model');
  Reflect.set(state, 'timeoutMs', 1);
  Reflect.set(state, 'providerRetries', 99);
  Reflect.set(state, 'json', false);

  const phaseView = createCyclePhaseView(state);
  const { outputs } = await runAssessmentProviderFanout(phaseView, {
    cycle: 2,
    internal: {
      artifactPaths: cycleProviderItemArtifactDescriptor,
    },
    items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
    label: 'state-options-contract',
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: ({ item, cycle }) => [
        `Audit ${item}`,
        `Cycle ${cycle}`,
        '<!-- commands-com-prompt-intent: {"kind":"quality","area":"maintainability","cycle":2} -->',
      ].join('\n'),
      buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
      logOutput: () => assert.fail('state.options.json should suppress fanout logging'),
    },
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].provider, 'mock');
  assert.equal(outputs[0].area, 'maintainability');
  assert.match(outputs[0].text, /Mock provider finding/);
  assert.deepEqual(
    state.store.writes.map((write) => write.name),
    [
      'prompts/cycle-2-mock-maintainability.md',
      'cycle-2/areas/mock/maintainability.md',
    ],
  );
});

test('cycle phase view reads from state.options without widening state', () => {
  const state = testState({
    providers: [{ id: 'mock' }, { id: 'codex' }],
    primaryProvider: { id: 'mock' },
    model: 'resolved-model',
    timeoutMs: 12_345,
    providerRetries: 2,
    maxImplementers: 3,
    serial: false,
    testCommand: 'npm test',
    customOption: 'preserved',
    runtimeOptions: { shouldNotLeak: true },
  });
  Reflect.set(state, 'providers', [{ id: 'stale-provider' }]);
  Reflect.set(state, 'primaryProvider', { id: 'stale-provider' });
  Reflect.set(state, 'model', 'stale-model');
  Reflect.set(state, 'timeoutMs', 1);
  Reflect.set(state, 'providerRetries', 99);
  Reflect.set(state, 'runtimeOptions', {
    providers: [{ id: 'stale-provider' }],
  });

  const view = createCyclePhaseView(state);

  assert.equal(view.options, state.options);
  assert.equal(view.options.providers, state.options.providers);
  assert.equal(Object.hasOwn(view, 'runtimeOptions'), false);
  assert.equal(Object.hasOwn(view, 'fanoutRuntimeOptions'), false);
});

test('beginCycle creates and stores a cycle record with optional prior findings', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const details = { issueCount: 2, score: 'B' };

  const cycleRecord = recorder.beginCycle(4, details, { priorFindings: 'carry forward' });

  assert.notEqual(cycleRecord, details);
  assert.deepEqual(cycleRecord, { cycle: 4, issueCount: 2, score: 'B' });
  assert.deepEqual(state.cycles, [cycleRecord]);
  assert.equal(state.priorFindings, 'carry forward');
});

test('applyImplementationResult applies implementation fields to the cycle record', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1);
  const implementation = {
    plan: 'plan text',
    tasks: [{ id: 'task-1', title: 'Tighten state' }],
    batches: [['task-1']],
    implementations: [{ provider: 'mock', text: 'done' }],
    text: 'implementation transcript',
  };

  const updatedRecord = recorder.applyImplementationResult(cycleRecord, { implementation });

  assert.equal(updatedRecord, cycleRecord);
  assert.equal(cycleRecord.implementationPlan, implementation.plan);
  assert.deepEqual(cycleRecord.implementationTasks, implementation.tasks);
  assert.deepEqual(cycleRecord.implementationBatches, implementation.batches);
  assert.deepEqual(cycleRecord.implementations, implementation.implementations);
  assert.equal(cycleRecord.implementation, implementation.text);
});

test('applyImplementationResult records passing tests and clears unresolved test failure', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 0 });
  state.hasUnresolvedTestFailure = true;

  recorder.applyImplementationResult(cycleRecord, { testResult: { ok: true, exitCode: 0 } });

  assert.deepEqual(cycleRecord.test, { ok: true, exitCode: 0 });
  assert.equal(state.hasUnresolvedTestFailure, false);
  assert.equal(cycleRecord.issueCount, 0);
  assert.equal(cycleRecord.testIssueCount, undefined);
});

test('applyImplementationResult records failing tests as at least one unresolved issue', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 3, score: 'B' });

  recorder.applyImplementationResult(cycleRecord, { testResult: { ok: false, exitCode: 17 } }, {
    testFailureUpdates: { score: 'F', failureSummary: 'tests failed' },
  });

  assert.deepEqual(cycleRecord.test, { ok: false, exitCode: 17 });
  assert.equal(cycleRecord.issueCount, 3);
  assert.equal(cycleRecord.testIssueCount, 1);
  assert.equal(cycleRecord.score, 'F');
  assert.equal(cycleRecord.failureSummary, 'tests failed');
  assert.equal(state.hasUnresolvedTestFailure, true);
});

test('applyImplementationResult raises empty issue counts on failing tests', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1);

  recorder.applyImplementationResult(cycleRecord, { testResult: { ok: false, exitCode: 1 } });

  assert.equal(cycleRecord.issueCount, 1);
  assert.equal(cycleRecord.testIssueCount, 1);
});

test('applyImplementationResult records successful implementation state', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 0 });
  const nextContext = { repoRoot: '/repo', branch: 'after-fix', status: ' M src/file.js' };
  const implementation = {
    plan: 'fix plan',
    tasks: [{ id: 'task-1', title: 'Apply fix' }],
    batches: [['task-1']],
    implementations: [{ provider: 'mock', text: 'fixed' }],
    text: 'implementation summary',
  };
  state.hasUnresolvedTestFailure = true;

  const updatedRecord = recorder.applyImplementationResult(cycleRecord, {
    implementation,
    testResult: { ok: true, exitCode: 0 },
    nextContext,
    nextFindings: 'remaining findings',
  });

  assert.equal(updatedRecord, cycleRecord);
  assert.equal(cycleRecord.implementationPlan, implementation.plan);
  assert.deepEqual(cycleRecord.implementationTasks, implementation.tasks);
  assert.deepEqual(cycleRecord.implementationBatches, implementation.batches);
  assert.deepEqual(cycleRecord.implementations, implementation.implementations);
  assert.equal(cycleRecord.implementation, implementation.text);
  assert.deepEqual(cycleRecord.test, { ok: true, exitCode: 0 });
  assert.equal(cycleRecord.issueCount, 0);
  assert.equal(cycleRecord.testIssueCount, undefined);
  assert.equal(state.hasUnresolvedTestFailure, false);
  assert.equal(state.context, nextContext);
  assert.equal(state.priorFindings, 'remaining findings');
});

test('applyImplementationResult applies validation failure updates', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 0, score: 'B' });
  const nextContext = { repoRoot: '/repo', branch: 'validation-failed', status: ' M src/file.js' };

  recorder.applyImplementationResult(cycleRecord, {
    implementation: { text: 'attempted fix' },
    testResult: { ok: false, exitCode: 17 },
    nextContext,
    nextFindings: 'prior findings plus test failure',
  }, {
    testFailureUpdates: { score: 'F', synopsis: 'validation failed' },
  });

  assert.equal(cycleRecord.implementation, 'attempted fix');
  assert.deepEqual(cycleRecord.test, { ok: false, exitCode: 17 });
  assert.equal(cycleRecord.issueCount, 1);
  assert.equal(cycleRecord.testIssueCount, 1);
  assert.equal(cycleRecord.score, 'F');
  assert.equal(cycleRecord.synopsis, 'validation failed');
  assert.equal(state.hasUnresolvedTestFailure, true);
  assert.equal(state.context, nextContext);
  assert.equal(state.priorFindings, 'prior findings plus test failure');
});

test('applyImplementationResult handles absent testResult', () => {
  const state = testState();
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 2 });
  const nextContext = { repoRoot: '/repo', branch: 'no-validation', status: ' M src/file.js' };
  state.hasUnresolvedTestFailure = true;

  recorder.applyImplementationResult(cycleRecord, {
    implementation: { text: 'fix without validation' },
    nextContext,
    nextFindings: '',
  });

  assert.equal(cycleRecord.implementation, 'fix without validation');
  assert.equal(cycleRecord.test, undefined);
  assert.equal(cycleRecord.testIssueCount, undefined);
  assert.equal(cycleRecord.issueCount, 2);
  assert.equal(state.hasUnresolvedTestFailure, true);
  assert.equal(state.context, nextContext);
  assert.equal(state.priorFindings, '');
});
