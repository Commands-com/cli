import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  artifactPath,
  cycleArtifactPath,
  cycleMarkdownArtifactPath,
  cyclePromptArtifactPath,
  cycleProviderItemArtifactDescriptor,
  markdownArtifactPath,
  promptArtifactPath,
  providerItemArtifactDescriptor,
  providerItemResolvedArtifactPath,
} from '../src/artifact-paths.js';
import {
  runAssessmentProviderFanout,
} from '../src/cycle-fanout.js';
import {
  runImplementationAndValidationPhase,
} from '../src/cycle-implementation.js';
import {
  createCycleState,
} from '../src/cycle-state.js';
import { runSynthesisWithFallback } from '../src/cycle-synthesis.js';
import { runQualityCommand } from '../src/quality.js';
import { runReviewCommand } from '../src/review.js';
import { runRoomCommand } from '../src/rooms.js';
import { taskArtifacts } from '../src/implementation-task-artifacts.js';
import { tempDir } from './support/cli.js';
import { cycleArtifactOptions } from './support/cycle-artifact-fixtures.js';
import { memoryStore } from './support/memory-store.js';

function writeNames(store) {
  return store.writes.map((write) => write.name);
}

function testLogger({ jsonMode = true } = {}) {
  return {
    jsonMode,
    messages: [],
    payloads: [],
    info(message) {
      this.messages.push(String(message));
    },
    line(message) {
      this.messages.push(String(message));
    },
    json(payload) {
      this.payloads.push(payload);
    },
    error(message) {
      this.messages.push(String(message));
    },
  };
}

function parsed(positionals = [], flags = {}) {
  return {
    positionals: [...positionals],
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

function cycleState({
  kind = 'quality',
  store = memoryStore(),
  cwd = '/unit/repo',
  providers = [{ id: 'mock' }],
  options = {},
  logger = testLogger(),
} = {}) {
  const primaryProvider = providers[0];
  return createCycleState({
    kind,
    store,
    workspace: { mode: 'current', cwd },
    context: {
      repoRoot: cwd,
      gitRoot: cwd,
      branch: 'main',
      head: 'abc123',
      status: '',
      diffStat: '',
      diff: '',
    },
    options: {
      providers,
      primaryProvider,
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
      timeoutMs: 5_000,
      maxCycles: 1,
      maxImplementers: 2,
      providerRetries: 0,
      testCommand: '',
      ...options,
    },
    logger,
  });
}

async function singleRunDir(cwd) {
  const runsRoot = path.join(cwd, '.commands-com', 'runs');
  const runIds = await fs.readdir(runsRoot);
  assert.equal(runIds.length, 1);
  return path.join(runsRoot, runIds[0]);
}

test('cycle artifact paths normalize numeric cycle identifiers', () => {
  assert.equal(cycleArtifactPath('002', 'report'), 'cycle-2/report');
  assert.throws(() => cycleArtifactPath('next', 'report'), /cycle must be a positive integer/);
  assert.throws(() => cycleArtifactPath(0, 'report'), /cycle must be a positive integer/);
});

test('review artifact paths normalize provider and reviewer segments', () => {
  const paths = cycleProviderItemArtifactDescriptor({
    cycle: '01',
    artifactRoot: 'reviewers',
    provider: 'Mock Provider/CLI',
    item: '01-../Correctness & Tests',
  });

  assert.equal(paths.promptPath, 'prompts/cycle-1-mock-provider-cli-01-correctness-tests.md');
  assert.equal(paths.path, 'cycle-1/reviewers/mock-provider-cli/01-correctness-tests.md');
});

test('quality artifact paths normalize area output paths', () => {
  const paths = cycleProviderItemArtifactDescriptor({
    cycle: 2,
    artifactRoot: 'areas',
    provider: 'Gemini CLI.v2',
    item: 'Maintainability / Architecture',
  });

  assert.equal(paths.promptPath, 'prompts/cycle-2-gemini-cli-v2-maintainability-architecture.md');
  assert.equal(paths.path, 'cycle-2/areas/gemini-cli-v2/maintainability-architecture.md');
});

test('provider item artifact helpers sanitize descriptor objects with semantic fallbacks', () => {
  assert.deepEqual(
    cycleProviderItemArtifactDescriptor({
      cycle: '007',
      artifactRoot: '../Review Outputs',
      provider: { id: '../Codex.Provider/CLI!' },
      item: { pathSegment: '01-../Correctness.Tests' },
    }),
    {
      path: 'cycle-7/review-outputs/codex-provider-cli/01-correctness-tests.md',
      promptPath: 'prompts/cycle-7-codex-provider-cli-01-correctness-tests.md',
      artifactRoot: 'review-outputs',
      providerFile: 'codex-provider-cli',
      itemFile: '01-correctness-tests',
    },
  );

  assert.deepEqual(
    providerItemArtifactDescriptor({
      artifactRoot: '!!!',
      provider: {},
      item: {},
    }),
    {
      path: 'artifact/provider/item.md',
      promptPath: 'prompts/provider-item.md',
      artifactRoot: 'artifact',
      providerFile: 'provider',
      itemFile: 'item',
    },
  );
});

test('top-level artifact paths normalize reports, metadata, and mirrored provider outputs', () => {
  assert.equal(markdownArtifactPath('review-cycle'), 'review-cycle.md');
  assert.equal(markdownArtifactPath('code-quality'), 'code-quality.md');
  assert.equal(markdownArtifactPath('context'), 'context.md');
  assert.equal(artifactPath('metadata.json'), 'metadata.json');
  assert.equal(promptArtifactPath('synthesis', 'Mock Provider/CLI'), 'prompts/synthesis-mock-provider-cli.md');

  assert.equal(
    providerItemResolvedArtifactPath({
      artifactRoot: 'areas',
      provider: 'Mock Provider',
      item: 'Maintainability',
    }),
    'areas/mock-provider/maintainability.md',
  );

  assert.equal(
    providerItemResolvedArtifactPath({
      artifactRoot: 'areas',
      providerFile: 'mock-provider',
      itemFile: 'maintainability',
    }),
    'areas/mock-provider/maintainability.md',
  );
});

test('room artifact paths mirror provider item fan-out layout', () => {
  assert.deepEqual(
    providerItemArtifactDescriptor({
      artifactRoot: 'participants',
      provider: 'Mock Provider/CLI',
      item: 'Threat Modeler',
    }),
    {
      path: 'participants/mock-provider-cli/threat-modeler.md',
      promptPath: 'prompts/mock-provider-cli-threat-modeler.md',
      artifactRoot: 'participants',
      providerFile: 'mock-provider-cli',
      itemFile: 'threat-modeler',
    },
  );
});

test('synthesis artifact paths normalize prompt, result, and error paths', () => {
  assert.equal(
    cyclePromptArtifactPath('003', 'synthesis', 'Codex/Primary'),
    'prompts/cycle-3-synthesis-codex-primary.md',
  );
  assert.equal(cycleMarkdownArtifactPath('003', 'synthesis'), 'cycle-3/synthesis.md');
  assert.equal(cycleMarkdownArtifactPath('003', 'synthesis-error'), 'cycle-3/synthesis-error.md');
});

test('implementation artifact paths normalize plan and task outputs', () => {
  const artifacts = taskArtifacts(4, { id: 'Task 1: Fix Paths' });
  assert.equal(
    cyclePromptArtifactPath(4, 'implementation-plan'),
    'prompts/cycle-4-implementation-plan.md',
  );
  assert.equal(
    cycleMarkdownArtifactPath(4, 'implementation-plan.attempt-1-error'),
    'cycle-4/implementation-plan.attempt-1-error.md',
  );
  assert.equal(artifacts.prompt, 'prompts/cycle-4-task-task-1-fix-paths.md');
  assert.equal(artifacts.output, 'cycle-4/tasks/task-1-fix-paths/output.md');
  assert.equal(cycleMarkdownArtifactPath(4, 'implementation'), 'cycle-4/implementation.md');
  assert.equal(
    cycleMarkdownArtifactPath(4, 'post-implementation-context'),
    'cycle-4/post-implementation-context.md',
  );
});

test('test artifact paths preserve non-markdown extensions', () => {
  assert.equal(cycleArtifactPath('05', 'test.log'), 'cycle-5/test.log');
});

test('artifact filename normalization preserves meaningful dots in final file segments', () => {
  assert.equal(artifactPath('logs.v1', 'test.log'), 'logs-v1/test.log');
  assert.equal(markdownArtifactPath('implementation-plan.attempt-1-error'), 'implementation-plan.attempt-1-error.md');
});

test('artifact filename normalization handles edge inputs through path helpers', () => {
  assert.equal(artifactPath(null), 'artifact');
  assert.equal(artifactPath('...'), 'artifact');
  assert.equal(markdownArtifactPath('!!!'), 'artifact.md');
  assert.equal(artifactPath('Release..Candidate...v1..tar.gz'), 'release.candidate.v1.tar.gz');
  assert.equal(artifactPath('report.-draft'), 'report-draft');
  assert.equal(artifactPath('report-.draft'), 'report-draft');
  assert.equal(artifactPath('..Task../attempt..1..error..'), 'task-attempt.1.error');
  assert.equal(cycleArtifactPath(1, 'attempts', '001', '.hidden.env'), 'cycle-1/attempts/001/hidden.env');
  assert.equal(
    cycleMarkdownArtifactPath(1, 'tasks', 'Task/01', 'error...attempt--2'),
    'cycle-1/tasks/task-01/error.attempt-2.md',
  );
});

test('cycle fan-out writes normalized prompt and output artifacts through the artifact contract', async () => {
  const store = memoryStore();
  const state = cycleState({ store });
  const mirroredPaths = [];

  const { outputs } = await runAssessmentProviderFanout(state, {
    cycle: '002',
    ...cycleArtifactOptions(),
    items: [
      {
        value: 'Correctness & Tests',
        label: 'Correctness & Tests',
        pathSegment: '01-../Correctness & Tests',
      },
    ],
    label: 'reviewer fan-out',
    adapter: {
      artifactRoot: '../Review Outputs',
      writeAdditionalArtifacts: ({ artifact }) => {
        mirroredPaths.push(artifact.path);
      },
      buildPrompt: ({ item }) => `Review ${item}`,
      buildOutput: ({ provider, item, text }) => ({ provider: provider.id, item, text }),
    },
  });

  assert.equal(outputs[0].provider, 'mock');
  assert.match(outputs[0].text, /Mock provider finding/);
  assert.deepEqual(mirroredPaths, ['cycle-2/review-outputs/mock/01-correctness-tests.md']);
  assert.deepEqual(writeNames(store), [
    'prompts/cycle-2-mock-01-correctness-tests.md',
    'cycle-2/review-outputs/mock/01-correctness-tests.md',
  ]);
});

test('cycle synthesis writes normalized prompt, result, and fallback error artifacts', async () => {
  const successStore = memoryStore();
  const success = await runSynthesisWithFallback(cycleState({
    store: successStore,
    providers: [{ id: 'mock' }],
  }), {
    cycle: '003',
    prompt: '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","synthesisIssueCount":0} -->',
    fallbackDescription: 'reviewer summaries',
  });

  assert.equal(success.synthesisProvider, 'mock');
  assert.equal(success.synthesisError, '');
  assert.deepEqual(writeNames(successStore), [
    'prompts/cycle-3-synthesis-mock.md',
    'cycle-3/synthesis.md',
  ]);

  const failureStore = memoryStore();
  const failure = await runSynthesisWithFallback(cycleState({
    store: failureStore,
    providers: [{ id: 'Unsupported Provider/CLI' }],
  }), {
    cycle: '003',
    prompt: 'Synthesize provider outputs.',
    fallbackDescription: 'provider outputs',
  });

  assert.equal(failure.synthesisProvider, 'Unsupported Provider/CLI');
  assert.equal(failure.synthesisText, '');
  assert.match(failure.synthesisError, /unsupported provider: Unsupported Provider\/CLI/);
  assert.deepEqual(writeNames(failureStore), [
    'prompts/cycle-3-synthesis-unsupported-provider-cli.md',
    'cycle-3/synthesis-error.md',
  ]);
});

test('implementation validation writes normalized planner, implementer, test, and post-context artifacts', async () => {
  const cwd = await tempDir();
  try {
    const store = memoryStore({ runId: 'unit-run', dir: path.join(cwd, 'store') });
    const state = cycleState({
      kind: 'quality',
      cwd,
      store,
      options: {
        fix: true,
        testCommand: 'node -e "process.stdout.write(\'ok\')"',
      },
    });

    await runImplementationAndValidationPhase(state, {
      cycle: '005',
      objective: 'Normalize validation artifacts',
      findings: 'Finding text.',
    });

    assert.deepEqual(writeNames(store), [
      'prompts/cycle-5-implementation-plan.md',
      'cycle-5/implementation-plan.md',
      'cycle-5/tasks.json',
      'cycle-5/tasks/task-1/status.json',
      'prompts/cycle-5-task-task-1.md',
      'cycle-5/tasks/task-1/output.md',
      'cycle-5/tasks/task-1/status.json',
      'cycle-5/tasks/task-2/status.json',
      'prompts/cycle-5-task-task-2.md',
      'cycle-5/tasks/task-2/output.md',
      'cycle-5/tasks/task-2/status.json',
      'cycle-5/implementation.md',
      'cycle-5/test.log',
      'cycle-5/post-implementation-context.md',
    ]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('quality workflow writes normalized single-output cycle, mirrored area, and report artifacts', async () => {
  const cwd = await tempDir();
  try {
    const logger = testLogger();
    const result = await runQualityCommand(parsed([], {
      provider: 'mock',
      area: 'Maintainability / Architecture',
      json: 'true',
    }), { cwd, logger });

    assert.deepEqual(result, { failed: false, exitCode: 0 });
    assert.equal(logger.payloads.length, 1);
    const runDir = await singleRunDir(cwd);

    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'cycle-1-mock-maintainability-architecture.md'), 'utf8'),
      /code quality audit for area: Maintainability \/ Architecture/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'cycle-1', 'areas', 'mock', 'maintainability-architecture.md'), 'utf8'),
      /Mock provider finding/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'areas', 'mock', 'maintainability-architecture.md'), 'utf8'),
      /Mock provider finding/,
    );
    await assert.rejects(fs.stat(path.join(runDir, 'prompts', 'cycle-1-synthesis-mock.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'cycle-1', 'synthesis.md')), /ENOENT/);
    assert.match(await fs.readFile(path.join(runDir, 'code-quality.md'), 'utf8'), /# Code Quality Report/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('review workflow writes normalized single-output reviewer and report artifacts', async () => {
  const cwd = await tempDir();
  try {
    const logger = testLogger();
    const result = await runReviewCommand(parsed(['Normalize', 'artifact', 'paths'], {
      provider: 'mock',
      reviewers: 'Correctness & Tests',
      json: 'true',
    }), { cwd, logger });

    assert.deepEqual(result, { failed: false, exitCode: 0 });
    assert.equal(logger.payloads.length, 1);
    const runDir = await singleRunDir(cwd);

    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'cycle-1-mock-01-correctness-tests.md'), 'utf8'),
      /Correctness & Tests reviewer/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'cycle-1', 'reviewers', 'mock', '01-correctness-tests.md'), 'utf8'),
      /Mock provider finding/,
    );
    await assert.rejects(fs.stat(path.join(runDir, 'prompts', 'cycle-1-synthesis-mock.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'cycle-1', 'synthesis.md')), /ENOENT/);
    assert.match(await fs.readFile(path.join(runDir, 'review-cycle.md'), 'utf8'), /# Review Cycle: Normalize artifact paths/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('room workflow writes normalized participant, synthesis, and report artifacts', async () => {
  const cwd = await tempDir();
  try {
    const logger = testLogger();
    const result = await runRoomCommand(parsed(['security', 'Normalize room artifact paths'], {
      provider: 'mock',
      participants: '2',
      json: 'true',
    }), { cwd, logger });

    assert.deepEqual(result, { failed: false, exitCode: 0 });
    assert.equal(logger.payloads.length, 1);
    const runDir = await singleRunDir(cwd);

    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'mock-threat-modeler.md'), 'utf8'),
      /Room objective: Normalize room artifact paths/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'participants', 'mock', 'threat-modeler.md'), 'utf8'),
      /Mock room participant/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'mock-application-security-reviewer.md'), 'utf8'),
      /application security reviewer/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'participants', 'mock', 'application-security-reviewer.md'), 'utf8'),
      /Mock room participant/,
    );
    assert.match(await fs.readFile(path.join(runDir, 'prompts', 'synthesis-mock.md'), 'utf8'), /Participant outputs:/);
    assert.match(await fs.readFile(path.join(runDir, 'synthesis.md'), 'utf8'), /Mock room synthesis/);
    assert.match(await fs.readFile(path.join(runDir, 'room.md'), 'utf8'), /# Security Room: Normalize room artifact paths/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
