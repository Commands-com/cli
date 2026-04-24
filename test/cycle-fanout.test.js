import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runAssessmentProviderFanout,
} from '../src/cycle-fanout.js';
import {
  createCyclePhaseView,
  createCycleState,
} from '../src/cycle-state.js';
import {
  cycleProviderItemArtifactDescriptor,
  providerItemArtifactDescriptor,
} from '../src/artifact-paths.js';
import { cycleArtifactOptions } from './support/cycle-artifact-fixtures.js';
import { memoryStore } from './support/memory-store.js';

function testState({
  providers = [{ id: 'mock' }],
  parallel = false,
  logger,
} = {}) {
  const provider = providers[0];
  return createCycleState({
    kind: 'quality',
    store: memoryStore(),
    workspace: { mode: 'current', cwd: '/repo' },
    context: { repoRoot: '/repo', branch: 'main', status: '', diffStat: '', diff: '' },
    options: {
      providers,
      primaryProvider: provider,
      providerIds: providers.map((item) => item.id),
      model: '',
      parallel,
      timeoutMs: 30_000,
      providerRetries: 0,
      json: false,
    },
    logger: logger || {
      jsonMode: false,
      info() {},
    },
  });
}

function fanoutDependencies({
  store = memoryStore(),
  logger = {},
  providers = [{ id: 'mock' }],
  fanoutParallel,
} = {}) {
  return {
    context: { repoRoot: '/repo' },
    store,
    logger,
    fanoutRuntimeOptions: {
      providers,
      model: '',
      timeoutMs: 30_000,
      providerRetries: 0,
      ...(fanoutParallel === undefined ? {} : { fanoutParallel }),
    },
  };
}

test('runAssessmentProviderFanout normalizes primitive items for prompts, artifacts, and hooks', async () => {
  const state = testState();
  const promptCalls = [];
  const outputCalls = [];
  const mirrorCalls = [];
  const logCalls = [];

  const result = await runAssessmentProviderFanout(createCyclePhaseView(state), {
    cycle: 2,
    ...cycleArtifactOptions(),
    items: ['Maintainability & Tests'],
    label: 'quality fan-out',
    adapter: {
      artifactRoot: 'areas',
      writeAdditionalArtifacts: (args) => {
        mirrorCalls.push(args.artifact.path);
      },
      buildPrompt: (args) => {
        promptCalls.push(args);
        return [
          `Audit ${args.item}`,
          `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: args.item, cycle: args.cycle })} -->`,
        ].join('\n');
      },
      buildOutput: (args) => {
        outputCalls.push(args);
        return {
          provider: args.provider.id,
          area: args.item,
          itemIndex: args.itemIndex,
          pathSegment: args.itemDescriptor.pathSegment,
          sawArtifactDuringBuild: Boolean(args.artifact),
          text: args.text,
        };
      },
      logOutput: (args) => {
        logCalls.push(`${args.provider.id}/${args.itemDescriptor.label}:${args.output.pathSegment}`);
      },
    },
  });
  const { outputs, failures } = result;

  assert.equal('partial' in result, false);
  assert.deepEqual(failures, []);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].provider, 'mock');
  assert.equal(outputs[0].area, 'Maintainability & Tests');
  assert.equal(outputs[0].itemIndex, 0);
  assert.equal(outputs[0].pathSegment, 'maintainability-tests');
  assert.equal(outputs[0].sawArtifactDuringBuild, false);
  assert.match(outputs[0].text, /Mock provider finding/);

  assert.deepEqual(promptCalls[0].itemDescriptor, {
    value: 'Maintainability & Tests',
    label: 'Maintainability & Tests',
    pathSegment: 'maintainability-tests',
    itemIndex: 0,
  });
  assert.equal(outputCalls[0].itemDescriptor, promptCalls[0].itemDescriptor);
  assert.deepEqual(mirrorCalls, ['cycle-2/areas/mock/maintainability-tests.md']);
  assert.deepEqual(logCalls, ['mock/Maintainability & Tests:maintainability-tests']);
  assert.deepEqual(
    state.store.writes.map((write) => write.name),
    [
      'prompts/cycle-2-mock-maintainability-tests.md',
      'cycle-2/areas/mock/maintainability-tests.md',
    ],
  );
});

test('runAssessmentProviderFanout expands descriptor items across multiple providers', async () => {
  const state = testState({
    providers: [
      { id: 'mock', slot: 'first' },
      { id: 'mock', slot: 'second' },
    ],
  });

  const { outputs } = await runAssessmentProviderFanout(createCyclePhaseView(state), {
    cycle: 1,
    ...cycleArtifactOptions(),
    items: [
      { value: { area: 'API Design' }, label: 'API Design / Contracts', pathSegment: '01-api-design' },
      { value: 'Regression Tests', label: 'Regression Tests' },
    ],
    label: 'quality fan-out',
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: ({ provider, item, itemDescriptor, itemIndex, cycle }) => [
        `Audit ${provider.slot}:${itemDescriptor.label}:${itemIndex}:${cycle}`,
        `<!-- commands-com-prompt-intent: ${JSON.stringify({
          kind: 'quality',
          area: typeof item === 'string' ? item : item.area,
          cycle,
        })} -->`,
      ].join('\n'),
      buildOutput: ({ provider, item, itemDescriptor, itemIndex, text }) => ({
        slot: provider.slot,
        item,
        itemIndex,
        label: itemDescriptor.label,
        pathSegment: itemDescriptor.pathSegment,
        text,
      }),
    },
  });

  assert.equal(outputs.length, 4);
  assert.deepEqual(
    outputs.map((output) => [output.slot, output.label, output.pathSegment, output.itemIndex]),
    [
      ['first', 'API Design / Contracts', '01-api-design', 0],
      ['first', 'Regression Tests', 'regression-tests', 1],
      ['second', 'API Design / Contracts', '01-api-design', 0],
      ['second', 'Regression Tests', 'regression-tests', 1],
    ],
  );
  assert.deepEqual(outputs[0].item, { area: 'API Design' });
  assert.match(outputs[3].text, /Mock provider finding/);
  assert.deepEqual(
    state.store.writes.map((write) => write.name),
    [
      'prompts/cycle-1-mock-01-api-design.md',
      'cycle-1/areas/mock/01-api-design.md',
      'prompts/cycle-1-mock-regression-tests.md',
      'cycle-1/areas/mock/regression-tests.md',
      'prompts/cycle-1-mock-01-api-design.md',
      'cycle-1/areas/mock/01-api-design.md',
      'prompts/cycle-1-mock-regression-tests.md',
      'cycle-1/areas/mock/regression-tests.md',
    ],
  );
});

test('runAssessmentProviderFanout uses non-cycle default artifact paths without explicit cycle artifacts', async () => {
  const store = memoryStore();
  const provider = { id: 'mock' };
  const item = { value: 'Threat Modeler', label: 'Threat Modeler', pathSegment: 'threat-modeler' };
  const additionalArtifacts = [];

  const { outputs } = await runAssessmentProviderFanout(fanoutDependencies({
    store,
    logger: { jsonMode: true, info() {} },
    providers: [provider],
  }), {
    cycle: 7,
    items: [item],
    label: 'room fan-out',
    adapter: {
      artifactRoot: 'participants',
      writeAdditionalArtifacts: ({ artifact }) => {
        additionalArtifacts.push({
          path: artifact.path,
          promptPath: artifact.promptPath,
          artifactRoot: artifact.artifactRoot,
          providerFile: artifact.providerFile,
          itemFile: artifact.itemFile,
        });
      },
      buildPrompt: ({ item }) => `Ask ${item}`,
      buildOutput: ({ provider, item, text, artifact }) => ({
        provider: provider.id,
        item,
        text,
        sawArtifactDuringBuild: Boolean(artifact),
      }),
    },
  });

  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].provider, 'mock');
  assert.equal(outputs[0].item, 'Threat Modeler');
  assert.equal(outputs[0].sawArtifactDuringBuild, false);
  assert.match(outputs[0].text, /Mock provider finding/);
  assert.deepEqual(additionalArtifacts, [
    providerItemArtifactDescriptor({
      artifactRoot: 'participants',
      provider,
      item: { ...item, itemIndex: 0 },
    }),
  ]);
  assert.deepEqual(
    store.writes.map((write) => write.name),
    [
      'prompts/mock-threat-modeler.md',
      'participants/mock/threat-modeler.md',
    ],
  );
});

test('runAssessmentProviderFanout uses explicit cycle artifact defaults', async () => {
  const state = testState();
  const item = { value: 'API Design', label: 'API Design', pathSegment: 'api-design' };
  const additionalArtifacts = [];

  const { outputs } = await runAssessmentProviderFanout(createCyclePhaseView(state), {
    cycle: 5,
    ...cycleArtifactOptions(),
    items: [item],
    label: 'quality fan-out',
    adapter: {
      artifactRoot: 'areas',
      writeAdditionalArtifacts: ({ artifact }) => {
        additionalArtifacts.push({
          path: artifact.path,
          promptPath: artifact.promptPath,
          artifactRoot: artifact.artifactRoot,
          providerFile: artifact.providerFile,
          itemFile: artifact.itemFile,
        });
      },
      buildPrompt: ({ item, cycle }) => [
        `Audit ${item}`,
        `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
      ].join('\n'),
      buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
    },
  });

  assert.equal(outputs.length, 1);
  assert.deepEqual(additionalArtifacts, [
    cycleProviderItemArtifactDescriptor({
      cycle: 5,
      artifactRoot: 'areas',
      provider: { id: 'mock' },
      item: { ...item, itemIndex: 0 },
    }),
  ]);
  assert.deepEqual(
    state.store.writes.map((write) => write.name),
    [
      'prompts/cycle-5-mock-api-design.md',
      'cycle-5/areas/mock/api-design.md',
    ],
  );
});

test('runAssessmentProviderFanout ignores legacy option-level artifact paths without internal contract', async () => {
  const state = testState();

  const { outputs } = await runAssessmentProviderFanout(createCyclePhaseView(state), {
    cycle: 4,
    artifactPaths: cycleProviderItemArtifactDescriptor,
    items: [{ value: 'stability', label: 'stability', pathSegment: 'stability' }],
    label: 'generic fan-out',
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: ({ item, cycle }) => [
        `Audit ${item}`,
        `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
      ].join('\n'),
      buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
    },
  });

  assert.equal(outputs.length, 1);
  assert.deepEqual(
    state.store.writes.map((write) => write.name),
    [
      'prompts/mock-stability.md',
      'areas/mock/stability.md',
    ],
  );
});

test('runAssessmentProviderFanout validates its dependencies and adapter contract', async () => {
  const state = testState();
  const dependencies = createCyclePhaseView(state);
  const validOptions = {
    cycle: 1,
    ...cycleArtifactOptions(),
    items: ['maintainability'],
    label: 'quality fan-out',
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: () => 'prompt',
      buildOutput: () => ({}),
    },
  };

  await assert.rejects(
    runAssessmentProviderFanout(state, validOptions),
    /runAssessmentProviderFanout requires fanoutRuntimeOptions/,
  );
  await assert.rejects(
    runAssessmentProviderFanout({ ...dependencies, fanoutRuntimeOptions: undefined }, validOptions),
    /runAssessmentProviderFanout requires fanoutRuntimeOptions/,
  );
  await assert.rejects(
    runAssessmentProviderFanout({ ...dependencies, fanoutRuntimeOptions: {} }, validOptions),
    /runAssessmentProviderFanout requires providers/,
  );
  await assert.rejects(
    runAssessmentProviderFanout({ ...dependencies, context: {} }, validOptions),
    /runAssessmentProviderFanout requires context\.repoRoot/,
  );
  await assert.rejects(
    runAssessmentProviderFanout({ ...dependencies, store: {} }, validOptions),
    /runAssessmentProviderFanout requires store\.write/,
  );
  await assert.rejects(
    runAssessmentProviderFanout(dependencies, { ...validOptions, items: 'maintainability' }),
    /runAssessmentProviderFanout requires items/,
  );
  await assert.rejects(
    runAssessmentProviderFanout(dependencies, { ...validOptions, adapter: undefined }),
    /runAssessmentProviderFanout requires buildPrompt/,
  );
  await assert.rejects(
    runAssessmentProviderFanout(dependencies, {
      ...validOptions,
      adapter: {
        artifactRoot: 'areas',
        buildOutput: () => ({}),
      },
    }),
    /runAssessmentProviderFanout requires buildPrompt/,
  );
  await assert.rejects(
    runAssessmentProviderFanout(dependencies, {
      ...validOptions,
      adapter: {
        artifactRoot: 'areas',
        buildPrompt: () => 'prompt',
      },
    }),
    /runAssessmentProviderFanout requires buildOutput/,
  );
});

test('runAssessmentProviderFanout rejects dependencies without fanoutRuntimeOptions', async () => {
  const state = testState();
  const {
    fanoutRuntimeOptions,
    ...dependenciesWithoutFanoutRuntimeOptions
  } = createCyclePhaseView(state);

  await assert.rejects(
    runAssessmentProviderFanout({
      ...dependenciesWithoutFanoutRuntimeOptions,
      runtimeOptions: fanoutRuntimeOptions,
    }, {
      cycle: 1,
      ...cycleArtifactOptions(),
      items: ['maintainability'],
      label: 'quality fan-out',
      adapter: {
        artifactRoot: 'areas',
        buildPrompt: () => 'prompt',
        buildOutput: () => ({}),
      },
    }),
    /runAssessmentProviderFanout requires fanoutRuntimeOptions/,
  );
});

test('runAssessmentProviderFanout uses internal failure artifact hook and ignores adapter and option-level hooks', async () => {
  const store = memoryStore();
  const failureCalls = [];

  await assert.rejects(
    runAssessmentProviderFanout(fanoutDependencies({
      store,
      providers: [{ id: 'unsupported-test-provider' }],
      fanoutParallel: false,
    }), {
      cycle: 8,
      writeFailureArtifact: () => {
        failureCalls.push('options');
      },
      internal: {
        writeFailureArtifact: async ({ store: artifactStore, artifact, error }) => {
          failureCalls.push('internal');
          await artifactStore.write(
            `${artifact.artifactRoot}/${artifact.providerFile}/${artifact.itemFile}.error.md`,
            error.message,
          );
        },
      },
      items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
      label: 'quality fan-out',
      adapter: {
        artifactRoot: 'areas',
        artifactPaths: () => {
          throw new Error('adapter artifactPaths should not run');
        },
        writeFailureArtifact: () => {
          failureCalls.push('adapter');
        },
        buildPrompt: ({ item, cycle }) => [
          `Audit ${item}`,
          `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
        ].join('\n'),
        buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
      },
    }),
    /unsupported provider: unsupported-test-provider/,
  );

  assert.deepEqual(failureCalls, ['internal']);
  assert.deepEqual(
    store.writes.map((write) => write.name),
    [
      'prompts/unsupported-test-provider-maintainability.md',
      'areas/unsupported-test-provider/maintainability.error.md',
    ],
  );
});

test('runAssessmentProviderFanout partial mode returns deduplicated outputs alongside per-job failures with no logger side effects', async () => {
  const loggerCalls = [];
  const state = testState({
    providers: [
      { id: 'mock' },
      { id: 'unsupported-test-provider' },
    ],
    parallel: true,
    logger: {
      jsonMode: true,
      info(message) { loggerCalls.push(['info', message]); },
      json(value) { loggerCalls.push(['json', value]); },
    },
  });

  const result = await runAssessmentProviderFanout(createCyclePhaseView(state), {
    cycle: 3,
    ...cycleArtifactOptions(),
    items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
    label: 'quality fan-out',
    partial: true,
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: ({ provider, item, cycle }) => [
        `Audit ${provider.id}:${item}`,
        `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
      ].join('\n'),
      buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
    },
  });

  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].provider, 'mock');
  assert.equal(result.outputs[0].area, 'maintainability');
  assert.match(result.outputs[0].text, /Mock provider finding/);

  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].provider, 'unsupported-test-provider');
  assert.equal(result.failures[0].item, 'maintainability');
  assert.match(result.failures[0].error, /unsupported provider: unsupported-test-provider/);

  assert.deepEqual(loggerCalls, []);

  const writesByName = Object.fromEntries(state.store.writes.map((write) => [write.name, write.value]));
  assert.match(
    writesByName['cycle-3/areas/mock/maintainability.md'],
    /Mock provider finding/,
  );
  assert.equal(
    writesByName['cycle-3/areas/unsupported-test-provider/maintainability.error.md'],
    undefined,
  );
  assert.match(
    writesByName['prompts/cycle-3-unsupported-test-provider-maintainability.md'],
    /Audit unsupported-test-provider:maintainability/,
  );
});

test('runAssessmentProviderFanout partial mode flags partial-success returns with partial: true', async () => {
  const state = testState({
    providers: [
      { id: 'mock' },
      { id: 'unsupported-test-provider' },
    ],
    parallel: true,
  });

  const result = await runAssessmentProviderFanout(createCyclePhaseView(state), {
    cycle: 6,
    ...cycleArtifactOptions(),
    items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
    label: 'quality fan-out',
    partial: true,
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: ({ provider, item, cycle }) => [
        `Audit ${provider.id}:${item}`,
        `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
      ].join('\n'),
      buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
    },
  });

  assert.equal(result.partial, true);
  assert.equal(result.outputs.length, 1);
  assert.equal(result.failures.length, 1);
});

test('runAssessmentProviderFanout partial mode throws when every job fails so fix-cycle flows surface a hard failure', async () => {
  const loggerCalls = [];
  const state = testState({
    providers: [
      { id: 'unsupported-test-provider' },
      { id: 'another-unsupported-test-provider' },
    ],
    parallel: true,
    logger: {
      jsonMode: false,
      info(message) { loggerCalls.push(message); },
    },
  });

  await assert.rejects(
    runAssessmentProviderFanout(createCyclePhaseView(state), {
      cycle: 4,
      ...cycleArtifactOptions(),
      items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
      label: 'quality fan-out',
      partial: true,
      adapter: {
        artifactRoot: 'areas',
        buildPrompt: ({ provider, item, cycle }) => [
          `Audit ${provider.id}:${item}`,
          `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
        ].join('\n'),
        buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
      },
    }),
    (error) => {
      assert.match(error.message, /quality fan-out failed/);
      assert.match(error.message, /unsupported provider: unsupported-test-provider/);
      assert.match(error.message, /unsupported provider: another-unsupported-test-provider/);
      assert.equal(error.cause.length, 2);
      for (const failure of error.cause) {
        assert.equal(typeof failure.provider, 'string');
        assert.ok(failure.provider.length > 0);
        assert.equal(failure.item, 'maintainability');
        assert.equal(typeof failure.error, 'string');
        assert.ok(failure.error.length > 0);
      }
      return true;
    },
  );
  assert.deepEqual(loggerCalls, []);
});

test('runAssessmentProviderFanout partial mode throws on serial all-failed fan-out so serial fix-cycle flows hard-fail too', async () => {
  const state = testState({
    providers: [
      { id: 'unsupported-test-provider' },
      { id: 'another-unsupported-test-provider' },
    ],
    parallel: false,
  });

  await assert.rejects(
    runAssessmentProviderFanout(createCyclePhaseView(state), {
      cycle: 5,
      ...cycleArtifactOptions(),
      items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
      label: 'quality fan-out',
      partial: true,
      adapter: {
        artifactRoot: 'areas',
        buildPrompt: ({ provider, item, cycle }) => [
          `Audit ${provider.id}:${item}`,
          `<!-- commands-com-prompt-intent: ${JSON.stringify({ kind: 'quality', area: item, cycle })} -->`,
        ].join('\n'),
        buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
      },
    }),
    (error) => {
      assert.match(error.message, /quality fan-out failed/);
      assert.match(error.message, /unsupported provider: unsupported-test-provider/);
      assert.match(error.message, /unsupported provider: another-unsupported-test-provider/);
      assert.equal(error.cause.length, 2);
      for (const failure of error.cause) {
        assert.equal(typeof failure.provider, 'string');
        assert.ok(failure.provider.length > 0);
        assert.equal(failure.item, 'maintainability');
        assert.equal(typeof failure.error, 'string');
        assert.ok(failure.error.length > 0);
      }
      return true;
    },
  );
});
