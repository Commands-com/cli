import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { COMMAND_OPTIONS } from '../src/command-option-schema.js';
import { runCycleWorkflow } from '../src/cycle-workflow.js';
import { RESUME_FIELD_RULES, mergeResumeOptions } from '../src/resume-merge.js';

const RESUME_OVERRIDE_OPTIONS = COMMAND_OPTIONS.filter(
  (option) => option.resumeOverrideFields.length && !option.resumeAlwaysOverrides,
);

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
  return [...new Set(RESUME_OVERRIDE_OPTIONS.flatMap((option) => option.resumeOverrideFields))];
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

test('cycle resume rules are derived from command option schema entries', () => {
  assert.ok(RESUME_OVERRIDE_OPTIONS.length > 0);
  for (const option of RESUME_OVERRIDE_OPTIONS) {
    for (const field of option.resumeOverrideFields) {
      const rule = RESUME_FIELD_RULES[field];
      assert.ok(rule, `${field} should have a rule`);
      if (rule.kind === 'always-next') {
        assert.fail(`${field} should be flag-driven, not always-next`);
      }
      assert.ok(
        [option.name, ...option.aliases].some((flag) => rule.flags.includes(flag)),
        `RESUME_FIELD_RULES.${field}.flags should include flags from --${option.name}`,
      );
    }
  }
  assert.equal(RESUME_FIELD_RULES.json.kind, 'always-next');
  assert.equal(RESUME_FIELD_RULES.resume.kind, 'always-next');
});

test('mergeResumeOptions keeps stored resume-eligible values without explicit flags', () => {
  const merged = mergeResumeOptions(optionsFor('stored'), optionsFor('next'), new Map());

  assertMergedFields(merged, [], 'without explicit flags');
});

test('mergeResumeOptions applies each resume override only when its flag is explicit', () => {
  const stored = optionsFor('stored');
  const next = optionsFor('next');

  for (const option of RESUME_OVERRIDE_OPTIONS) {
    const merged = mergeResumeOptions(stored, next, new Map([[option.name, 'true']]));

    assertMergedFields(merged, option.resumeOverrideFields, `--${option.name}`);
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

// Save/restore COMMANDS_COM_* env vars so each parametric case is independent.
async function withEnvVars(setVars, fn) {
  const keys = ['COMMANDS_COM_MODEL', 'COMMANDS_COM_PROVIDER', 'COMMANDS_COM_PROVIDERS', 'PATH'];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) {
    if (Object.hasOwn(setVars, key)) {
      const value = setVars[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// Each case asserts options precedence between env vars, --flags, and stored resume state.
// `--test 'true'` is supplied so `runCyclePreflight` accepts the run; the test seam stubs
// `runAssessmentCycles` before the test command would actually be invoked.
const RUN_CYCLE_WORKFLOW_OPTION_CASES = [
  {
    name: 'runCycleWorkflow uses COMMANDS_COM_MODEL when no --model flag and no resume',
    env: { COMMANDS_COM_MODEL: 'env-model', COMMANDS_COM_PROVIDER: 'mock', COMMANDS_COM_PROVIDERS: undefined },
    flags: [['test', 'true']],
    expect: { model: 'env-model' },
  },
  {
    name: 'runCycleWorkflow lets --model flag override COMMANDS_COM_MODEL when no resume',
    env: { COMMANDS_COM_MODEL: 'env-model', COMMANDS_COM_PROVIDER: 'mock', COMMANDS_COM_PROVIDERS: undefined },
    flags: [['model', 'cli-model'], ['test', 'true']],
    expect: { model: 'cli-model' },
  },
  {
    // Locks today's behaviour: stored resume model wins over COMMANDS_COM_MODEL when no --model
    // flag is passed. resolveCycleOptions sets options.model from runtimeOptions (env), then
    // mergeResumeOptions overwrites it with stored.model; --model is a resume-override field
    // but only restores nextOptions.model when the flag is explicit.
    name: 'runCycleWorkflow keeps stored resume model over COMMANDS_COM_MODEL when no --model flag',
    env: { PATH: '', COMMANDS_COM_MODEL: 'env-model', COMMANDS_COM_PROVIDER: undefined, COMMANDS_COM_PROVIDERS: undefined },
    storedRunOptions: { providers: [{ id: 'mock', command: '/path/that/does/not/exist' }], model: 'stored-model' },
    resumeFlag: true,
    flags: [['test', 'true']],
    expect: { model: 'stored-model' },
  },
  {
    name: 'runCycleWorkflow lets explicit --model flag override stored resume model',
    env: { PATH: '', COMMANDS_COM_MODEL: 'env-model', COMMANDS_COM_PROVIDER: undefined, COMMANDS_COM_PROVIDERS: undefined },
    storedRunOptions: { providers: [{ id: 'mock', command: '/path/that/does/not/exist' }], model: 'stored-model' },
    resumeFlag: true,
    flags: [['model', 'cli-model'], ['test', 'true']],
    expect: { model: 'cli-model' },
  },
  {
    name: 'runCycleWorkflow uses COMMANDS_COM_PROVIDER when no --provider/--providers flag and no resume',
    env: { COMMANDS_COM_PROVIDER: 'mock', COMMANDS_COM_PROVIDERS: undefined },
    flags: [['test', 'true']],
    expect: {
      providerIds: ['mock'],
      primaryProviderId: 'mock',
      providersLength: 1,
      firstProviderId: 'mock',
    },
  },
  {
    name: 'runCycleWorkflow on resume short-circuits to stored providers in a providerless environment',
    env: { PATH: '', COMMANDS_COM_PROVIDER: undefined, COMMANDS_COM_PROVIDERS: undefined },
    storedRunOptions: { providers: [{ id: 'mock', command: '/path/that/does/not/exist' }] },
    resumeFlag: true,
    flags: [['test', 'true']],
    expect: {
      providers: [{ id: 'mock', command: '/path/that/does/not/exist' }],
      primaryProvider: { id: 'mock', command: '/path/that/does/not/exist' },
      providerIds: ['mock'],
      observedSameAsStateOptions: true,
    },
    assertResume: true,
  },
];

for (const testCase of RUN_CYCLE_WORKFLOW_OPTION_CASES) {
  test(testCase.name, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-cycle-workflow-'));
    try {
      await withEnvVars(testCase.env, async () => {
        const flags = new Map(/** @type {Array<[string, any]>} */ (testCase.flags));
        if (testCase.storedRunOptions) {
          const runDir = path.join(cwd, 'stored-run');
          await writeStoredRunState(runDir, testCase.storedRunOptions);
          flags.set('resume', runDir);
        }

        const captured = {};
        const state = await runCycleWorkflow({
          positionals: [],
          flags,
        }, {
          cwd,
          kind: 'review',
          label: testCase.name,
          logger: noopLogger(),
          adapter: {},
          dependencies: { runAssessmentCycles: noopRunAssessmentCycles(captured) },
        });

        const { expect } = testCase;
        if (expect.model !== undefined) {
          assert.equal(state.options.model, expect.model);
          assert.equal(captured.options.model, expect.model);
        }
        if (expect.providerIds !== undefined) {
          assert.deepEqual(state.options.providerIds, expect.providerIds);
          assert.deepEqual(captured.options.providerIds, expect.providerIds);
        }
        if (expect.primaryProviderId !== undefined) {
          assert.equal(state.options.primaryProvider.id, expect.primaryProviderId);
        }
        if (expect.providersLength !== undefined) {
          assert.equal(state.options.providers.length, expect.providersLength);
        }
        if (expect.firstProviderId !== undefined) {
          assert.equal(state.options.providers[0].id, expect.firstProviderId);
        }
        if (expect.providers !== undefined) {
          assert.deepEqual(state.options.providers, expect.providers);
        }
        if (expect.primaryProvider !== undefined) {
          assert.deepEqual(state.options.primaryProvider, expect.primaryProvider);
        }
        if (expect.observedSameAsStateOptions) {
          assert.equal(captured.options, state.options);
        }
        if (testCase.assertResume) {
          assert.equal(state.options.resume, flags.get('resume'));
        }
      });
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
}
