import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runAssessmentProviderFanout,
} from '../src/cycle-fanout.js';
import {
  providerItemArtifactDescriptor,
} from '../src/artifact-paths.js';
import {
  createCycleRecorder,
} from '../src/cycle-state.js';
import {
  formatPriorFindings,
  runSynthesisWithFallback,
} from '../src/cycle-synthesis.js';
import {
  tempDir,
  localCycleState,
} from './support/review-quality-workflow-fixtures.js';

test('formatPriorFindings preserves synthesis and findings sections', () => {
  assert.equal(
    formatPriorFindings({
      synthesisText: 'synthesized review',
      findingsTitle: 'Reviewer outputs',
      findingsText: 'reviewer details',
    }),
    [
      '## Synthesis',
      'synthesized review',
      '',
      '## Reviewer outputs',
      'reviewer details',
    ].join('\n'),
  );

  assert.equal(
    formatPriorFindings({
      synthesisError: 'provider failed',
      findingsTitle: 'Provider outputs',
    }),
    [
      '## Synthesis',
      'Synthesis failed: provider failed',
      '',
      '## Provider outputs',
      '(none)',
    ].join('\n'),
  );
});

test('runSynthesisWithFallback writes prompt and synthesis artifacts', async () => {
  const cwd = await tempDir();
  try {
    const storeDir = path.join(cwd, 'store');
    const state = localCycleState(cwd, { dir: storeDir, kind: 'review' });
    const prompt = [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      'Reviewer outputs:',
      '## mock / correctness',
      '',
      '```yaml',
      'verdict: issues',
      'major_issue_count: 1',
      '```',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","cycle":1,"inputLabel":"Reviewer outputs:"} -->',
    ].join('\n');

    const result = await runSynthesisWithFallback(state, {
      cycle: 1,
      prompt,
      fallbackDescription: 'reviewer summaries',
    });

    assert.equal(result.synthesisProvider, 'mock');
    assert.equal(result.synthesisError, '');
    assert.match(result.synthesisText, /Mock synthesis/);
    assert.equal(
      await fs.readFile(path.join(storeDir, 'prompts/cycle-1-synthesis-mock.md'), 'utf8'),
      prompt,
    );
    assert.equal(
      await fs.readFile(path.join(storeDir, 'cycle-1/synthesis.md'), 'utf8'),
      result.synthesisText,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentProviderFanout writes descriptor-based prompt and artifact paths', async () => {
  const cwd = await tempDir();
  try {
    const storeDir = path.join(cwd, 'store');
    const state = localCycleState(cwd, { dir: storeDir, kind: 'quality' });
    const mirroredPaths = [];

    const { outputs } = await runAssessmentProviderFanout(state, {
      cycle: 1,
      internal: {
        artifactPaths: providerItemArtifactDescriptor,
      },
      items: [{ value: 'maintainability', label: 'maintainability', pathSegment: 'maintainability' }],
      label: 'quality fan-out',
      adapter: {
        artifactRoot: 'areas',
        writeAdditionalArtifacts: async ({ cycle, artifact, text }) => {
          if (cycle === 1) {
            const mirrorPath = `areas/${artifact.providerFile}/${artifact.itemFile}.md`;
            mirroredPaths.push(mirrorPath);
            await state.store.write(mirrorPath, text);
          }
        },
        buildPrompt: ({ item, cycle }) => [
          `Audit ${item}`,
          `Cycle ${cycle}`,
          '<!-- commands-com-prompt-intent: {"kind":"quality","area":"maintainability","cycle":1} -->',
        ].join('\n'),
        buildOutput: ({ provider, item, itemDescriptor, text }) => ({
          provider: provider.id,
          area: item,
          pathSegment: itemDescriptor.pathSegment,
          text,
        }),
      },
    });

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].provider, 'mock');
    assert.equal(outputs[0].area, 'maintainability');
    assert.equal(outputs[0].pathSegment, 'maintainability');
    assert.match(outputs[0].text, /Mock provider finding/);
    assert.match(
      await fs.readFile(path.join(storeDir, 'prompts/cycle-1-mock-maintainability.md'), 'utf8'),
      /Audit maintainability/,
    );
    assert.equal(
      await fs.readFile(path.join(storeDir, 'cycle-1/areas/mock/maintainability.md'), 'utf8'),
      outputs[0].text,
    );
    assert.deepEqual(mirroredPaths, ['areas/mock/maintainability.md']);
    assert.equal(
      await fs.readFile(path.join(storeDir, 'areas/mock/maintainability.md'), 'utf8'),
      outputs[0].text,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runAssessmentProviderFanout does not write caller-specific mirror artifacts by default', async () => {
  const cwd = await tempDir();
  try {
    const storeDir = path.join(cwd, 'store');
    const state = localCycleState(cwd, { dir: storeDir, kind: 'quality' });

    await runAssessmentProviderFanout(state, {
      cycle: 1,
      internal: {
        artifactPaths: providerItemArtifactDescriptor,
      },
      items: [{ value: 'tests', label: 'tests', pathSegment: 'tests' }],
      label: 'quality fan-out',
      adapter: {
        artifactRoot: 'areas',
        buildPrompt: () => [
          'Audit tests',
          '<!-- commands-com-prompt-intent: {"kind":"quality","area":"tests","cycle":1} -->',
        ].join('\n'),
        buildOutput: ({ provider, item, text }) => ({ provider: provider.id, area: item, text }),
      },
    });

    assert.match(
      await fs.readFile(path.join(storeDir, 'cycle-1/areas/mock/tests.md'), 'utf8'),
      /Mock provider finding/,
    );
    await assert.rejects(
      fs.readFile(path.join(storeDir, 'areas/mock/tests.md'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('createCycleRecorder owns cycle records, prior findings, and record mutations', async () => {
  const cwd = await tempDir();
  try {
    const state = localCycleState(cwd);
    const recorder = createCycleRecorder(state);
    const details = { issueCount: 0, score: 'B' };
    const cycleRecord = /** @type {any} */ (recorder.beginCycle(1, details, { priorFindings: 'next findings' }));

    assert.notEqual(cycleRecord, details);
    assert.deepEqual(cycleRecord, { cycle: 1, issueCount: 0, score: 'B' });
    assert.deepEqual(state.cycles, [cycleRecord]);
    assert.equal(state.priorFindings, 'next findings');

    recorder.applyImplementationResult(cycleRecord, {
      implementation: {
        plan: 'implementation plan',
        tasks: [{ id: 'task-1' }],
        batches: [['task-1']],
        implementations: [{ provider: 'mock', text: 'done' }],
        text: 'implementation text',
      },
    });
    assert.equal(Reflect.get(cycleRecord, 'implementationPlan'), 'implementation plan');
    assert.deepEqual(Reflect.get(cycleRecord, 'implementationTasks'), [{ id: 'task-1' }]);
    assert.deepEqual(Reflect.get(cycleRecord, 'implementationBatches'), [['task-1']]);
    assert.equal(Reflect.get(cycleRecord, 'implementation'), 'implementation text');

    recorder.applyImplementationResult(cycleRecord, {
      testResult: { ok: false, exitCode: 17 },
    }, {
      testFailureUpdates: { score: 'F' },
    });
    assert.equal(cycleRecord.issueCount, 1);
    assert.equal(Reflect.get(cycleRecord, 'testIssueCount'), 1);
    assert.equal(cycleRecord.score, 'F');
    assert.equal(state.hasUnresolvedTestFailure, true);

    const passingRecord = { cycle: 2, issueCount: 0 };
    recorder.applyImplementationResult(passingRecord, {
      testResult: { ok: true, exitCode: 0 },
    });
    assert.deepEqual(passingRecord.test, { ok: true, exitCode: 0 });
    assert.equal(state.hasUnresolvedTestFailure, false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
