import test from 'node:test';
import assert from 'node:assert/strict';
import { runAssessmentProviderFanout } from '../src/cycle-fanout.js';
import { createCyclePhaseView } from '../src/cycle-state.js';
import { fanoutError } from './support/assertions.js';
import { cycleArtifactOptions } from './support/cycle-artifact-fixtures.js';
import { fanoutDependencies, testState } from './support/cycle-fanout-fixtures.js';
import { memoryStore } from './support/memory-store.js';

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
      const actual = fanoutError(error);
      assert.match(actual.message, /quality fan-out failed/);
      assert.match(actual.message, /unsupported provider: unsupported-test-provider/);
      assert.match(actual.message, /unsupported provider: another-unsupported-test-provider/);
      assert.equal(actual.cause.length, 2);
      for (const failure of actual.cause) {
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
      const actual = fanoutError(error);
      assert.match(actual.message, /quality fan-out failed/);
      assert.match(actual.message, /unsupported provider: unsupported-test-provider/);
      assert.match(actual.message, /unsupported provider: another-unsupported-test-provider/);
      assert.equal(actual.cause.length, 2);
      for (const failure of actual.cause) {
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
