import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runImplementationAndValidationPhase,
} from '../src/cycle-implementation.js';
import {
  collectRepoContext,
  runGit,
} from '../src/git.js';
import {
  createCyclePhaseView,
  createCycleRecorder,
  createCycleState,
} from '../src/cycle-state.js';
import { initGitRepo, tempDir } from './support/cli.js';
import { writeFakeProvider } from './support/fake-provider.js';
import { memoryStore } from './support/memory-store.js';

function testState(cwd, {
  providers = [{ id: 'mock' }],
  primaryProvider = providers[0],
  testCommand = '',
  serial = false,
  parallel = false,
  maxImplementers = 2,
} = {}) {
  return createCycleState({
    kind: 'quality',
    store: memoryStore({ dir: path.join(cwd, 'store') }),
    workspace: { mode: 'current', cwd },
    context: { repoRoot: cwd, branch: 'main', status: '', diffStat: '', diff: '' },
    options: {
      providers,
      primaryProvider,
      providerIds: providers.map((provider) => provider.id),
      model: '',
      changed: false,
      fix: true,
      worktree: false,
      keepWorktree: false,
      allowDirty: false,
      serial,
      parallel,
      failOnIssues: false,
      json: true,
      timeoutMs: 30_000,
      maxCycles: 1,
      maxImplementers,
      providerRetries: 0,
      testCommand,
    },
    logger: {
      jsonMode: true,
      info() {},
    },
  });
}

test('runImplementationAndValidationPhase records implementation results and failing validation', async () => {
  const cwd = await tempDir();
  try {
    const testCommand = 'node -e "process.stdout.write(\'validation failed\'); process.exit(7)"';
    const state = testState(cwd, { testCommand });
    const phaseView = createCyclePhaseView(state);
    assert.equal(phaseView.implementationRuntimeOptions.implementationParallel, true);
    assert.equal(Object.hasOwn(phaseView.implementationRuntimeOptions, 'parallel'), false);
    const recorder = createCycleRecorder(state);
    const cycleRecord = recorder.beginCycle(1, { issueCount: 0, score: 'B' });

    const phase = await runImplementationAndValidationPhase(phaseView, {
      cycle: 1,
      objective: 'Improve maintainability',
      findings: 'Existing synthesized findings.',
    });
    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    const result = phase.result;
    recorder.applyImplementationResult(cycleRecord, result, {
      testFailureUpdates: { score: 'F' },
    });

    assert.match(cycleRecord.implementationPlan, /"id": "task-1"/);
    assert.deepEqual(cycleRecord.implementationTasks.map((task) => task.id), ['task-1', 'task-2']);
    assert.deepEqual(cycleRecord.implementationBatches, [['task-1', 'task-2']]);
    assert.equal(cycleRecord.implementations.length, 2);
    assert.equal(cycleRecord.implementations[0].provider, 'mock');
    assert.match(cycleRecord.implementation, /## task-1: Apply the highest-priority fix/);
    assert.match(cycleRecord.implementation, /Mock implementer/);

    assert.deepEqual(cycleRecord.test, { ok: false, exitCode: 7 });
    assert.equal(cycleRecord.issueCount, 1);
    assert.equal(cycleRecord.testIssueCount, 1);
    assert.equal(cycleRecord.score, 'F');
    assert.equal(state.hasUnresolvedTestFailure, true);
    assert.equal(result.testResult.exitCode, 7);
    assert.match(result.nextFindings, /Existing synthesized findings/);
    assert.match(result.nextFindings, /## Validation failure/);
    assert.match(result.nextFindings, /Exit code: 7/);
    assert.match(result.nextFindings, /validation failed/);
    assert.equal(state.context.repoRoot, await fs.realpath(cwd));

    assert.deepEqual(
      state.store.writes.map((write) => write.name).filter((name) => [
        'cycle-1/implementation.md',
        'cycle-1/test.log',
        'cycle-1/post-implementation-context.md',
      ].includes(name)),
      [
        'cycle-1/implementation.md',
        'cycle-1/test.log',
        'cycle-1/post-implementation-context.md',
      ],
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runImplementationAndValidationPhase preserves partial result when validation artifact write fails', { skip: process.platform === 'win32' }, async () => {
  const tmp = await tempDir();
  try {
    const planText = [
      '```json',
      JSON.stringify({
        tasks: [
          {
            id: 'task-one',
            title: 'First completed batch',
            files: ['src/shared.txt'],
            instructions: 'Complete the first batch.',
          },
          {
            id: 'task-two',
            title: 'Second failing batch',
            files: ['src/shared.txt'],
            instructions: 'Fail the second batch.',
          },
        ],
      }),
      '```',
    ].join('\n');
    const providerPath = await writeFakeProvider(path.join(tmp, 'bin'), 'codex', [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const prompt = fs.readFileSync(0, 'utf8');",
      `const planText = ${JSON.stringify(planText)};`,
      "function complete(text) { console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })); }",
      'if (prompt.includes(\'"kind":"implementation-plan"\')) { complete(planText); process.exit(0); }',
      "fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });",
      "if (prompt.includes('First completed batch')) {",
      "  fs.writeFileSync(path.join(process.cwd(), 'src', 'shared.txt'), 'partial edit\\n', 'utf8');",
      "  complete('batch one implementation complete');",
      '  process.exit(0);',
      '}',
      "if (prompt.includes('Second failing batch')) { console.error('batch two failed intentionally'); process.exit(9); }",
      "console.error('unexpected implementation prompt');",
      'process.exit(1);',
    ]);
    const state = testState(tmp, {
      providers: [{ id: 'codex', command: providerPath }],
      testCommand: 'node -e "process.stdout.write(\'validation failed after partial\'); process.exit(6)"',
    });
    const originalWrite = state.store.write.bind(state.store);
    state.store.write = async (name, value) => {
      if (name === 'cycle-1/test.log') {
        throw new Error('test log write failed');
      }
      return originalWrite(name, value);
    };

    const phase = await runImplementationAndValidationPhase(createCyclePhaseView(state), {
      cycle: 1,
      objective: 'preserve partial result',
      findings: 'Original findings.',
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /batch two failed intentionally/);
    assert.match(phase.error.message, /test log write failed/);
    assert.deepEqual(phase.result.implementation.batches, [['task-one'], ['task-two']]);
    assert.deepEqual(phase.result.implementation.implementations.map((item) => item.task.id), ['task-one']);
    assert.equal(phase.result.testResult.exitCode, 6);
    assert.match(phase.result.nextFindings, /Original findings/);
    assert.match(phase.result.nextFindings, /validation failed after partial/);
    assert.equal(phase.result.nextContext.repoRoot, await fs.realpath(tmp));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationAndValidationPhase rejects incomplete dependencies', async () => {
  const cwd = await tempDir();
  try {
    const state = testState(cwd);
    const args = {
      cycle: 1,
      objective: 'Improve maintainability',
      findings: 'Existing synthesized findings.',
    };

    await assert.rejects(
      runImplementationAndValidationPhase({
        ...createCyclePhaseView(state),
        workspace: undefined,
      }, args),
      /requires dependencies\.workspace\.cwd/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runImplementationAndValidationPhase rejects legacy runtimeOptions-only dependencies', async () => {
  const cwd = await tempDir();
  try {
    const state = testState(cwd);
    const {
      implementationRuntimeOptions,
      ...legacyDependencies
    } = createCyclePhaseView(state);

    await assert.rejects(
      runImplementationAndValidationPhase({
        ...legacyDependencies,
        runtimeOptions: implementationRuntimeOptions,
      }, {
        cycle: 1,
        objective: 'Improve maintainability',
        findings: 'Existing synthesized findings.',
      }),
      /runImplementationAndValidationPhase requires dependencies\.implementationRuntimeOptions/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runImplementationAndValidationPhase seeds later scoped task worktrees with prior batch edits', { skip: process.platform === 'win32' }, async () => {
  const tmp = await tempDir();
  const repoRoot = path.join(tmp, 'repo');
  const appRoot = path.join(repoRoot, 'packages', 'app');

  try {
    await fs.mkdir(appRoot, { recursive: true });
    await initGitRepo(repoRoot);
    await fs.mkdir(path.join(appRoot, 'src'), { recursive: true });
    await fs.writeFile(path.join(appRoot, 'src', 'base.js'), 'export const base = true;\n', 'utf8');
    const added = await runGit(['add', 'packages/app/src/base.js'], repoRoot);
    assert.equal(added.ok, true, added.stderr);
    const committed = await runGit([
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test User',
      'commit',
      '-m',
      'add scoped app',
    ], repoRoot);
    assert.equal(committed.ok, true, committed.stderr);

    const planText = [
      '```json',
      JSON.stringify({
        tasks: [
          {
            id: 'task-one',
            title: 'Create generated file',
            files: ['src/generated.js'],
            instructions: 'Create the generated file for the next batch.',
          },
          {
            id: 'task-two',
            title: 'Use generated file',
            files: ['src/generated.js', 'src/uses-generated.txt'],
            instructions: 'Read the generated file from the prior batch.',
          },
        ],
      }),
      '```',
    ].join('\n');
    const providerPath = await writeFakeProvider(path.join(tmp, 'bin'), 'codex', [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const prompt = fs.readFileSync(0, 'utf8');",
      `const planText = ${JSON.stringify(planText)};`,
      "function complete(text) { console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })); }",
      'if (prompt.includes(\'"kind":"implementation-plan"\')) { complete(planText); process.exit(0); }',
      "fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });",
      "if (prompt.includes('Create generated file')) {",
      "  fs.writeFileSync(path.join(process.cwd(), 'src', 'generated.js'), 'export const generated = 1;\\n', 'utf8');",
      "  complete('created generated file');",
      '  process.exit(0);',
      '}',
      "if (prompt.includes('Use generated file')) {",
      "  const generatedPath = path.join(process.cwd(), 'src', 'generated.js');",
      "  if (!fs.existsSync(generatedPath)) { console.error('missing generated seed'); process.exit(8); }",
      "  const generated = fs.readFileSync(generatedPath, 'utf8');",
      "  fs.writeFileSync(path.join(process.cwd(), 'src', 'uses-generated.txt'), `saw ${generated}`, 'utf8');",
      "  complete('used generated file');",
      '  process.exit(0);',
      '}',
      "console.error('unexpected implementation prompt');",
      'process.exit(1);',
    ]);

    const provider = { id: 'codex', command: providerPath };
    const context = await collectRepoContext(appRoot);
    const state = createCycleState({
      kind: 'quality',
      store: memoryStore({ dir: path.join(tmp, 'store') }),
      workspace: { mode: 'current', cwd: appRoot, originalRepoRoot: tmp },
      context,
      options: {
        providers: [provider],
        primaryProvider: provider,
        providerIds: [provider.id],
        model: '',
        serial: false,
        parallel: true,
        json: true,
        timeoutMs: 5_000,
        maxImplementers: 2,
        providerRetries: 0,
        testCommand: '',
      },
      logger: { jsonMode: true, info() {} },
    });

    const phase = await runImplementationAndValidationPhase(createCyclePhaseView(state), {
      cycle: 1,
      objective: 'carry scoped worktree changes across batches',
      findings: 'batch two depends on the generated file from batch one',
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    const result = phase.result;
    assert.deepEqual(result.implementation.batches, [['task-one'], ['task-two']]);
    assert.deepEqual(
      result.implementation.implementations.map((implementation) => implementation.changedFiles),
      [['src/generated.js'], ['src/uses-generated.txt']],
    );
    assert.equal(await fs.readFile(path.join(appRoot, 'src', 'generated.js'), 'utf8'), 'export const generated = 1;\n');
    assert.equal(await fs.readFile(path.join(appRoot, 'src', 'uses-generated.txt'), 'utf8'), 'saw export const generated = 1;\n');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
