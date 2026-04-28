import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCyclePhaseView,
  createCycleRecorder,
  createCycleRunContext,
  createCycleState,
} from '../src/cycle-state.js';
import {
  WORKSPACE_MODES,
} from '../src/workflow-constants.js';
import { memoryStore } from './support/memory-store.js';

function baseStateArgs(options) {
  return {
    kind: 'review',
    store: memoryStore(),
    workspace: { mode: WORKSPACE_MODES.CURRENT, cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main', status: '', diffStat: '', diff: '' },
    options,
    logger: {
      jsonMode: true,
      info() {},
    },
  };
}

function trackPropertyWrites(events, object, property, label, formatValue) {
  let current = object[property];
  Object.defineProperty(object, property, {
    enumerable: true,
    configurable: true,
    get() {
      return current;
    },
    set(value) {
      events.push(formatValue ? `${label}:${formatValue(value)}` : label);
      current = value;
    },
  });
}

test('createCycleState owns cycle options', () => {
  const provider = { id: 'mock' };
  const rawOptions = {
    providers: [provider],
    primaryProvider: provider,
    providerIds: [provider.id],
    model: 'gpt-test',
    json: true,
    maxCycles: 3,
    testCommand: 'npm test',
    customAdapterOption: 'preserved',
  };

  const state = createCycleState(baseStateArgs(rawOptions));

  assert.notEqual(state.options, rawOptions);
  assert.equal(state.options.maxCycles, 3);
  assert.equal(state.options.model, 'gpt-test');
  assert.equal(state.options.testCommand, 'npm test');
  assert.equal(state.options.customAdapterOption, 'preserved');
  assert.equal(Object.hasOwn(state, 'runtimeOptions'), false);

  rawOptions.maxCycles = 99;
  rawOptions.customAdapterOption = 'mutated';
  assert.equal(state.options.maxCycles, 3);
  assert.equal(state.options.customAdapterOption, 'preserved');
});

test('createCycleState treats nested runtimeOptions as ordinary owned options', () => {
  const provider = { id: 'mock' };

  const state = createCycleState(baseStateArgs({
    providers: [provider],
    primaryProvider: provider,
    providerIds: [provider.id],
    runtimeOptions: { model: 'internal-config-value' },
  }));

  assert.deepEqual(state.options.runtimeOptions, { model: 'internal-config-value' });
  assert.equal(Object.hasOwn(state, 'runtimeOptions'), false);
});

test('createCycleRunContext exposes adapter-readable state', () => {
  const provider = { id: 'mock' };
  const state = createCycleState({
    ...baseStateArgs({
      providers: [provider],
      primaryProvider: provider,
      providerIds: [provider.id],
      fix: true,
    }),
    hasUnresolvedTestFailure: true,
  });
  createCycleRecorder(state).beginCycle(1, {}, { priorFindings: 'prior finding' });

  const run = createCycleRunContext(state);

  assert.equal(Object.isFrozen(run), true);
  assert.deepEqual(Object.keys(run).sort(), [
    'context',
    'hasUnresolvedTestFailure',
    'kind',
    'logger',
    'options',
    'priorFindings',
    'store',
  ]);
  assert.equal(run.kind, 'review');
  assert.equal(run.context, state.context);
  assert.equal(run.options, state.options);
  assert.equal(run.logger, state.logger);
  assert.equal(run.store, state.store);
  assert.equal(run.priorFindings, 'prior finding');
  assert.equal(run.hasUnresolvedTestFailure, true);
});

test('createCycleRecorder applies mutation methods', () => {
  const state = createCycleState(baseStateArgs({}));
  const recorder = createCycleRecorder(state);

  const cycleRecord = recorder.beginCycle(1, { issueCount: 1 }, { priorFindings: 'provider findings' });
  recorder.applyImplementationResult(cycleRecord, {
    nextFindings: 'next findings',
    testResult: { ok: true, exitCode: 0 },
  });

  assert.equal(Object.isFrozen(recorder), true);
  assert.deepEqual(Object.keys(recorder).sort(), [
    'applyImplementationResult',
    'beginCycle',
    'priorFindings',
    'setContext',
  ]);
  assert.equal(state.cycles[0], cycleRecord);
  assert.equal(state.priorFindings, 'next findings');
  assert.equal(recorder.priorFindings, 'next findings');
  assert.deepEqual(cycleRecord.test, { ok: true, exitCode: 0 });
});

test('createCycleRecorder beginCycle stores the record before updating priorFindings', () => {
  const state = createCycleState(baseStateArgs({}));
  const recorder = createCycleRecorder(state);
  state.priorFindings = 'existing findings';
  const originalPush = state.cycles.push;
  let findingsDuringCycleStore;
  Object.defineProperty(state.cycles, 'push', {
    value: function pushWithProbe(...records) {
      findingsDuringCycleStore = state.priorFindings;
      return originalPush.apply(this, records);
    },
    enumerable: false,
    configurable: true,
  });

  const cycleRecord = recorder.beginCycle(1, { issueCount: 2 }, {
    priorFindings: 'next findings',
  });

  assert.equal(findingsDuringCycleStore, 'existing findings');
  assert.deepEqual(state.cycles, [cycleRecord]);
  assert.equal(state.priorFindings, 'next findings');
});

test('createCycleRecorder records implementation transitions with a stable state shape', () => {
  const state = createCycleState(baseStateArgs({}));
  const recorder = createCycleRecorder(state);
  const nextContext = { repoRoot: '/repo', branch: 'after-fix', status: ' M src/file.js' };
  const implementation = {
    plan: 'fix plan',
    tasks: [{ id: 'task-1', title: 'Tighten mutation API' }],
    batches: [['task-1']],
    implementations: [{ provider: 'mock', text: 'patched' }],
    text: 'implementation summary',
  };

  const cycleRecord = recorder.beginCycle(2, { issueCount: 0, score: 'B' }, {
    priorFindings: 'initial findings',
  });
  const updatedRecord = recorder.applyImplementationResult(cycleRecord, {
    implementation,
    testResult: { ok: false, exitCode: 17 },
    nextContext,
    nextFindings: 'follow-up findings',
  }, {
    testFailureUpdates: { score: 'F', synopsis: 'validation failed' },
  });

  assert.equal(updatedRecord, cycleRecord);
  assert.equal(state.context, nextContext);
  assert.equal(state.priorFindings, 'follow-up findings');
  assert.equal(state.hasUnresolvedTestFailure, true);
  assert.deepEqual(state.cycles, [cycleRecord]);
  assert.deepEqual(cycleRecord, {
    cycle: 2,
    issueCount: 1,
    score: 'F',
    implementationPlan: 'fix plan',
    implementationTasks: [{ id: 'task-1', title: 'Tighten mutation API' }],
    implementationBatches: [['task-1']],
    implementations: [{ provider: 'mock', text: 'patched' }],
    implementation: 'implementation summary',
    test: { ok: false, exitCode: 17 },
    testIssueCount: 1,
    synopsis: 'validation failed',
  });
});

test('createCycleRecorder applyImplementationResult applies nested mutations in order', () => {
  const state = createCycleState(baseStateArgs({}));
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 0, score: 'B' });
  const nextContext = { repoRoot: '/repo', branch: 'after-fix', status: ' M src/file.js' };
  const events = [];

  trackPropertyWrites(events, cycleRecord, 'implementation', 'recordImplementation');
  trackPropertyWrites(events, cycleRecord, 'test', 'recordTestResult');
  trackPropertyWrites(events, state, 'hasUnresolvedTestFailure', 'setUnresolvedTestFailure', String);
  trackPropertyWrites(events, state, 'context', 'setContext', ({ branch }) => branch);
  trackPropertyWrites(events, state, 'priorFindings', 'setPriorFindings', String);

  recorder.applyImplementationResult(cycleRecord, {
    implementation: { text: 'implementation summary' },
    testResult: { ok: false, exitCode: 17 },
    nextContext,
    nextFindings: 'follow-up findings',
  }, {
    testFailureUpdates: { score: 'F' },
  });

  assert.deepEqual(events, [
    'recordImplementation',
    'setUnresolvedTestFailure:true',
    'recordTestResult',
    'setContext:after-fix',
    'setPriorFindings:follow-up findings',
  ]);
  assert.equal(cycleRecord.implementation, 'implementation summary');
  assert.deepEqual(cycleRecord.test, { ok: false, exitCode: 17 });
  assert.equal(cycleRecord.score, 'F');
  assert.equal(state.context, nextContext);
  assert.equal(state.priorFindings, 'follow-up findings');
});

test('createCycleRecorder records test failure state changes', () => {
  const state = createCycleState(baseStateArgs({}));
  const recorder = createCycleRecorder(state);
  const failedCycle = recorder.beginCycle(1, { issueCount: 0, score: 'B' });

  recorder.applyImplementationResult(failedCycle, { testResult: { ok: false, exitCode: 12 } }, {
    testFailureUpdates: { score: 'F', synopsis: 'validation failed' },
  });

  assert.equal(state.hasUnresolvedTestFailure, true);
  assert.deepEqual(failedCycle.test, { ok: false, exitCode: 12 });
  assert.equal(failedCycle.issueCount, 1);
  assert.equal(failedCycle.testIssueCount, 1);
  assert.equal(failedCycle.score, 'F');
  assert.equal(failedCycle.synopsis, 'validation failed');

  const passedCycle = recorder.beginCycle(2, { issueCount: 0 });
  recorder.applyImplementationResult(passedCycle, { testResult: { ok: true, exitCode: 0 } });

  assert.equal(state.hasUnresolvedTestFailure, false);
  assert.deepEqual(passedCycle.test, { ok: true, exitCode: 0 });
  assert.equal(passedCycle.issueCount, 0);
  assert.equal(passedCycle.testIssueCount, undefined);
});

test('createCycleRecorder treats non-finite issue counts as zero when tests fail', () => {
  for (const issueCount of [undefined, NaN, Infinity, -Infinity, -2]) {
    const state = createCycleState(baseStateArgs({}));
    const recorder = createCycleRecorder(state);
    const cycleRecord = recorder.beginCycle(1, { issueCount });

    recorder.applyImplementationResult(cycleRecord, { testResult: { ok: false, exitCode: 1 } });

    assert.equal(cycleRecord.issueCount, 1);
    assert.equal(cycleRecord.testIssueCount, 1);
    assert.equal(state.hasUnresolvedTestFailure, true);
  }
});

test('createCycleRecorder preserves positive issue counts when tests fail', () => {
  const state = createCycleState(baseStateArgs({}));
  const recorder = createCycleRecorder(state);
  const cycleRecord = recorder.beginCycle(1, { issueCount: 3.5 });

  recorder.applyImplementationResult(cycleRecord, { testResult: { ok: false, exitCode: 1 } });

  assert.equal(cycleRecord.issueCount, 3.5);
  assert.equal(cycleRecord.testIssueCount, 1);
});

test('createCyclePhaseView exposes shared phase dependencies without custom options', () => {
  const provider = { id: 'mock' };
  const state = createCycleState(baseStateArgs({
    providers: [provider],
    primaryProvider: provider,
    providerIds: [provider.id],
    parallel: false,
    serial: false,
    model: 'gpt-test',
    timeoutMs: 1234,
    providerRetries: 2,
    testCommand: 'npm test',
    maxImplementers: 3,
    customAdapterOption: 'preserved',
    runtimeOptions: { shouldNotLeak: true },
  }));

  const view = createCyclePhaseView(state);

  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.fanoutRuntimeOptions), true);
  assert.equal(Object.isFrozen(view.synthesisRuntimeOptions), true);
  assert.equal(Object.isFrozen(view.implementationRuntimeOptions), true);
  assert.equal(view.kind, 'review');
  assert.equal(view.context, state.context);
  assert.equal(view.store, state.store);
  assert.equal(view.logger, state.logger);
  assert.equal(view.workspace, state.workspace);
  assert.deepEqual(view.fanoutRuntimeOptions, {
    providers: [provider],
    fanoutParallel: false,
    model: 'gpt-test',
    timeoutMs: 1234,
    providerRetries: 2,
  });
  assert.deepEqual(view.synthesisRuntimeOptions, {
    providers: [provider],
    primaryProvider: provider,
    model: 'gpt-test',
    timeoutMs: 1234,
    providerRetries: 2,
  });
  assert.deepEqual(view.implementationRuntimeOptions, {
    providers: [provider],
    primaryProvider: provider,
    implementationParallel: true,
    model: 'gpt-test',
    timeoutMs: 1234,
    providerRetries: 2,
    testCommand: 'npm test',
    maxImplementers: 3,
  });
  assert.equal(Object.hasOwn(view, 'options'), false);
  assert.equal(Object.hasOwn(view, 'runtimeOptions'), false);
});

test('createCyclePhaseView projects phase parallel flags from runtime options', () => {
  const cases = [
    {
      name: 'serial disables both phase parallel flags',
      options: { serial: true, parallel: true, maxImplementers: 3 },
      expected: { fanoutParallel: false, implementationParallel: false },
    },
    {
      name: 'single implementer enables only fanout parallel',
      options: { serial: false, parallel: true, maxImplementers: 1 },
      expected: { fanoutParallel: true, implementationParallel: false },
    },
    {
      name: 'multiple implementers enable only implementation parallel when fanout is not parallel',
      options: { serial: false, parallel: false, maxImplementers: 2 },
      expected: { fanoutParallel: false, implementationParallel: true },
    },
    {
      name: 'multiple implementers keep implementation parallel enabled when fanout is parallel',
      options: { serial: false, parallel: true, maxImplementers: 2 },
      expected: { fanoutParallel: true, implementationParallel: true },
    },
  ];

  for (const { name, options, expected } of cases) {
    const view = createCyclePhaseView(createCycleState(baseStateArgs(options)));

    assert.deepEqual({
      fanoutParallel: view.fanoutRuntimeOptions.fanoutParallel,
      implementationParallel: view.implementationRuntimeOptions.implementationParallel,
    }, expected, name);
  }
});
