import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { COMMAND_OPTIONS } from '../src/command-option-schema.js';
import {
  CYCLE_RESUME_OPTION_OVERRIDES,
  mergeResumeOptions,
  runCycleWorkflow,
} from '../src/cycle-workflow.js';

const FIELD_VALUES = Object.freeze({
  providers: {
    stored: Object.freeze([{ id: 'stored-provider' }]),
    next: Object.freeze([{ id: 'next-provider' }]),
  },
  providerIds: {
    stored: Object.freeze(['stored-provider']),
    next: Object.freeze(['next-provider']),
  },
  primaryProvider: {
    stored: Object.freeze({ id: 'stored-provider' }),
    next: Object.freeze({ id: 'next-provider' }),
  },
  model: { stored: 'stored-model', next: 'next-model' },
  changed: { stored: false, next: true },
  fix: { stored: false, next: true },
  worktree: { stored: false, next: true },
  allowDirty: { stored: false, next: true },
  keepWorktree: { stored: false, next: true },
  untilScore: { stored: 'C', next: 'A' },
  maxCycles: { stored: 2, next: 7 },
  maxImplementers: { stored: 3, next: 8 },
  stallCycles: { stored: 4, next: 0 },
  parallel: { stored: false, next: true },
  serial: { stored: true, next: false },
  providerRetries: { stored: 1, next: 5 },
  testCommand: { stored: 'npm test', next: 'npm run validate' },
  timeoutMs: { stored: 1000, next: 2000 },
  failOnIssues: { stored: false, next: true },
});

function resumeFields() {
  return [...new Set(CYCLE_RESUME_OPTION_OVERRIDES.flatMap((override) => override.fields))];
}

function optionsFor(kind) {
  const options = {
    json: kind === 'next',
    resume: `${kind}-resume`,
  };
  for (const field of resumeFields()) {
    assert.ok(FIELD_VALUES[field], `missing test values for resume field ${field}`);
    options[field] = FIELD_VALUES[field][kind];
  }
  return options;
}

function assertMergedFields(merged, overriddenFields, message) {
  const overridden = new Set(overriddenFields);
  for (const field of resumeFields()) {
    const source = overridden.has(field) ? 'next' : 'stored';
    assert.deepEqual(merged[field], FIELD_VALUES[field][source], `${message}: ${field}`);
  }
  assert.equal(merged.json, true, `${message}: json follows this invocation`);
  assert.equal(merged.resume, 'next-resume', `${message}: resume follows this invocation`);
}

test('cycle resume override flags are derived from command option schema entries', () => {
  assert.ok(CYCLE_RESUME_OPTION_OVERRIDES.length > 0);
  for (const override of CYCLE_RESUME_OPTION_OVERRIDES) {
    const option = COMMAND_OPTIONS.find((item) => item.name === override.option);
    assert.ok(option, `--${override.option} should be declared in the schema`);
    assert.deepEqual(override.flags, [option.name, ...option.aliases]);
    assert.equal(override.fields.includes('resume'), false);
    assert.equal(override.fields.includes('json'), false);
  }
});

test('mergeResumeOptions keeps stored resume-eligible values without explicit flags', () => {
  const merged = mergeResumeOptions(optionsFor('stored'), optionsFor('next'), new Map());

  assertMergedFields(merged, [], 'without explicit flags');
});

test('mergeResumeOptions applies each resume override only when its flag is explicit', () => {
  const stored = optionsFor('stored');
  const next = optionsFor('next');

  for (const override of CYCLE_RESUME_OPTION_OVERRIDES) {
    const merged = mergeResumeOptions(stored, next, new Map([[override.option, 'true']]));

    assertMergedFields(merged, override.fields, `--${override.option}`);
  }
});

test('mergeResumeOptions lets explicit --parallel clear stored serial mode', () => {
  const merged = mergeResumeOptions(
    { parallel: false, serial: true },
    { parallel: true, serial: false },
    new Map([['parallel', 'true']]),
  );

  assert.equal(merged.parallel, true);
  assert.equal(merged.serial, false);
});

test('mergeResumeOptions lets explicit --serial clear stored parallel mode', () => {
  const merged = mergeResumeOptions(
    { parallel: true, serial: false },
    { parallel: false, serial: true },
    new Map([['serial', 'true']]),
  );

  assert.equal(merged.parallel, false);
  assert.equal(merged.serial, true);
});

test('mergeResumeOptions recomputes maxCycles when report-only resume becomes fix or until mode', () => {
  const reportOnly = { fix: false, untilScore: '', maxCycles: 1 };

  assert.deepEqual(
    pickCycleModeFields(mergeResumeOptions(
      reportOnly,
      { fix: true, untilScore: '', maxCycles: 3 },
      new Map([['fix', 'true']]),
    )),
    { fix: true, untilScore: '', maxCycles: 3 },
  );

  assert.deepEqual(
    pickCycleModeFields(mergeResumeOptions(
      reportOnly,
      { fix: true, untilScore: 'A', maxCycles: 30 },
      new Map([['until', 'A']]),
    )),
    { fix: true, untilScore: 'A', maxCycles: 30 },
  );

  assert.deepEqual(
    pickCycleModeFields(mergeResumeOptions(
      reportOnly,
      { fix: true, untilScore: 'A', maxCycles: 5 },
      new Map([['until', 'A'], ['max-cycles', '5']]),
    )),
    { fix: true, untilScore: 'A', maxCycles: 5 },
  );
});

function pickCycleModeFields(options) {
  return {
    fix: options.fix,
    untilScore: options.untilScore,
    maxCycles: options.maxCycles,
  };
}

// Behaviour-level guardrails for env/config × CLI × stored-resume precedence
// on cycle option fields populated through resolveRuntimeOptions (notably
// `model` and provider env vars). See docs/design/option-pipeline-collapse.md
// Section 5 #7: any consolidation of the option pipeline must preserve the
// values these tests assert today, not silently re-order them.

function noopLogger() {
  return { info() {}, warn() {}, error() {} };
}

function noopRunAssessmentCycles(captured) {
  return async (state) => { captured.options = state.options; };
}

async function writeStoredRunState(runDir, options) {
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'run-state.json'),
    `${JSON.stringify({
      version: 1,
      kind: 'review',
      runId: path.basename(runDir),
      cycles: [],
      options,
    }, null, 2)}\n`,
    'utf8',
  );
}

test('runCycleWorkflow uses COMMANDS_COM_MODEL when no --model flag and no resume', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-model-env-only-'));
  const originalCommandsComModel = process.env.COMMANDS_COM_MODEL;
  const originalCommandsComProvider = process.env.COMMANDS_COM_PROVIDER;
  const originalCommandsComProviders = process.env.COMMANDS_COM_PROVIDERS;
  try {
    process.env.COMMANDS_COM_MODEL = 'env-model';
    process.env.COMMANDS_COM_PROVIDER = 'mock';
    delete process.env.COMMANDS_COM_PROVIDERS;

    const captured = {};
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map(),
    }, {
      cwd,
      kind: 'review',
      label: 'model env only',
      logger: noopLogger(),
      adapter: {},
      dependencies: { runAssessmentCycles: noopRunAssessmentCycles(captured) },
    });

    assert.equal(state.options.model, 'env-model');
    assert.equal(captured.options.model, 'env-model');
  } finally {
    if (originalCommandsComModel === undefined) delete process.env.COMMANDS_COM_MODEL;
    else process.env.COMMANDS_COM_MODEL = originalCommandsComModel;
    if (originalCommandsComProvider === undefined) delete process.env.COMMANDS_COM_PROVIDER;
    else process.env.COMMANDS_COM_PROVIDER = originalCommandsComProvider;
    if (originalCommandsComProviders !== undefined) process.env.COMMANDS_COM_PROVIDERS = originalCommandsComProviders;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runCycleWorkflow lets --model flag override COMMANDS_COM_MODEL when no resume', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-model-cli-over-env-'));
  const originalCommandsComModel = process.env.COMMANDS_COM_MODEL;
  const originalCommandsComProvider = process.env.COMMANDS_COM_PROVIDER;
  const originalCommandsComProviders = process.env.COMMANDS_COM_PROVIDERS;
  try {
    process.env.COMMANDS_COM_MODEL = 'env-model';
    process.env.COMMANDS_COM_PROVIDER = 'mock';
    delete process.env.COMMANDS_COM_PROVIDERS;

    const captured = {};
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map([['model', 'cli-model']]),
    }, {
      cwd,
      kind: 'review',
      label: 'model cli over env',
      logger: noopLogger(),
      adapter: {},
      dependencies: { runAssessmentCycles: noopRunAssessmentCycles(captured) },
    });

    assert.equal(state.options.model, 'cli-model');
    assert.equal(captured.options.model, 'cli-model');
  } finally {
    if (originalCommandsComModel === undefined) delete process.env.COMMANDS_COM_MODEL;
    else process.env.COMMANDS_COM_MODEL = originalCommandsComModel;
    if (originalCommandsComProvider === undefined) delete process.env.COMMANDS_COM_PROVIDER;
    else process.env.COMMANDS_COM_PROVIDER = originalCommandsComProvider;
    if (originalCommandsComProviders !== undefined) process.env.COMMANDS_COM_PROVIDERS = originalCommandsComProviders;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

// Locks today's behaviour: stored resume model wins over COMMANDS_COM_MODEL
// when no --model flag is passed. resolveCycleOptions sets options.model from
// runtimeOptions (env), then mergeResumeOptions does { ...next, ...stored },
// so stored.model overwrites it; --model is a resume-override field but only
// restores nextOptions.model when the flag is explicit.
test('runCycleWorkflow keeps stored resume model over COMMANDS_COM_MODEL when no --model flag', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-model-resume-over-env-'));
  const originalPath = process.env.PATH;
  const originalCommandsComModel = process.env.COMMANDS_COM_MODEL;
  const originalCommandsComProvider = process.env.COMMANDS_COM_PROVIDER;
  const originalCommandsComProviders = process.env.COMMANDS_COM_PROVIDERS;
  try {
    const storedProviders = [{ id: 'mock', command: '/path/that/does/not/exist' }];
    const runDir = path.join(cwd, 'stored-run');
    await writeStoredRunState(runDir, { providers: storedProviders, model: 'stored-model' });

    process.env.PATH = '';
    process.env.COMMANDS_COM_MODEL = 'env-model';
    delete process.env.COMMANDS_COM_PROVIDER;
    delete process.env.COMMANDS_COM_PROVIDERS;

    const captured = {};
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map([['resume', runDir]]),
    }, {
      cwd,
      kind: 'review',
      label: 'model resume over env',
      logger: noopLogger(),
      adapter: {},
      dependencies: { runAssessmentCycles: noopRunAssessmentCycles(captured) },
    });

    assert.equal(state.options.model, 'stored-model');
    assert.equal(captured.options.model, 'stored-model');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCommandsComModel === undefined) delete process.env.COMMANDS_COM_MODEL;
    else process.env.COMMANDS_COM_MODEL = originalCommandsComModel;
    if (originalCommandsComProvider !== undefined) process.env.COMMANDS_COM_PROVIDER = originalCommandsComProvider;
    if (originalCommandsComProviders !== undefined) process.env.COMMANDS_COM_PROVIDERS = originalCommandsComProviders;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runCycleWorkflow lets explicit --model flag override stored resume model', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-model-cli-over-resume-'));
  const originalPath = process.env.PATH;
  const originalCommandsComModel = process.env.COMMANDS_COM_MODEL;
  const originalCommandsComProvider = process.env.COMMANDS_COM_PROVIDER;
  const originalCommandsComProviders = process.env.COMMANDS_COM_PROVIDERS;
  try {
    const storedProviders = [{ id: 'mock', command: '/path/that/does/not/exist' }];
    const runDir = path.join(cwd, 'stored-run');
    await writeStoredRunState(runDir, { providers: storedProviders, model: 'stored-model' });

    process.env.PATH = '';
    process.env.COMMANDS_COM_MODEL = 'env-model';
    delete process.env.COMMANDS_COM_PROVIDER;
    delete process.env.COMMANDS_COM_PROVIDERS;

    const captured = {};
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map([['resume', runDir], ['model', 'cli-model']]),
    }, {
      cwd,
      kind: 'review',
      label: 'model cli over resume',
      logger: noopLogger(),
      adapter: {},
      dependencies: { runAssessmentCycles: noopRunAssessmentCycles(captured) },
    });

    assert.equal(state.options.model, 'cli-model');
    assert.equal(captured.options.model, 'cli-model');
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCommandsComModel === undefined) delete process.env.COMMANDS_COM_MODEL;
    else process.env.COMMANDS_COM_MODEL = originalCommandsComModel;
    if (originalCommandsComProvider !== undefined) process.env.COMMANDS_COM_PROVIDER = originalCommandsComProvider;
    if (originalCommandsComProviders !== undefined) process.env.COMMANDS_COM_PROVIDERS = originalCommandsComProviders;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runCycleWorkflow uses COMMANDS_COM_PROVIDER when no --provider/--providers flag and no resume', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-env-only-'));
  const originalCommandsComProvider = process.env.COMMANDS_COM_PROVIDER;
  const originalCommandsComProviders = process.env.COMMANDS_COM_PROVIDERS;
  try {
    process.env.COMMANDS_COM_PROVIDER = 'mock';
    delete process.env.COMMANDS_COM_PROVIDERS;

    const captured = {};
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map(),
    }, {
      cwd,
      kind: 'review',
      label: 'provider env only',
      logger: noopLogger(),
      adapter: {},
      dependencies: { runAssessmentCycles: noopRunAssessmentCycles(captured) },
    });

    assert.deepEqual(state.options.providerIds, ['mock']);
    assert.equal(state.options.primaryProvider.id, 'mock');
    assert.equal(state.options.providers.length, 1);
    assert.equal(state.options.providers[0].id, 'mock');
    assert.deepEqual(captured.options.providerIds, ['mock']);
  } finally {
    if (originalCommandsComProvider === undefined) delete process.env.COMMANDS_COM_PROVIDER;
    else process.env.COMMANDS_COM_PROVIDER = originalCommandsComProvider;
    if (originalCommandsComProviders !== undefined) process.env.COMMANDS_COM_PROVIDERS = originalCommandsComProviders;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runCycleWorkflow on resume short-circuits to stored providers in a providerless environment', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-resume-providerless-'));
  const originalPath = process.env.PATH;
  const originalCommandsComProvider = process.env.COMMANDS_COM_PROVIDER;
  const originalCommandsComProviders = process.env.COMMANDS_COM_PROVIDERS;
  try {
    const storedProviders = [{ id: 'mock', command: '/path/that/does/not/exist' }];
    const runDir = path.join(cwd, 'stored-run');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'run-state.json'),
      `${JSON.stringify({
        version: 1,
        kind: 'review',
        runId: path.basename(runDir),
        cycles: [],
        options: { providers: storedProviders },
      }, null, 2)}\n`,
      'utf8',
    );

    process.env.PATH = '';
    delete process.env.COMMANDS_COM_PROVIDER;
    delete process.env.COMMANDS_COM_PROVIDERS;

    let observedOptions;
    const state = await runCycleWorkflow({
      positionals: [],
      flags: new Map([['resume', runDir]]),
    }, {
      cwd,
      kind: 'review',
      label: 'resume providerless',
      logger: { info() {}, warn() {}, error() {} },
      adapter: {},
      dependencies: {
        runAssessmentCycles: async (runState) => { observedOptions = runState.options; },
      },
    });

    assert.deepEqual(state.options.providers, storedProviders);
    assert.deepEqual(state.options.primaryProvider, storedProviders[0]);
    assert.deepEqual(state.options.providerIds, ['mock']);
    assert.equal(state.options.resume, runDir);
    assert.equal(observedOptions, state.options);
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalCommandsComProvider !== undefined) process.env.COMMANDS_COM_PROVIDER = originalCommandsComProvider;
    if (originalCommandsComProviders !== undefined) process.env.COMMANDS_COM_PROVIDERS = originalCommandsComProviders;
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
