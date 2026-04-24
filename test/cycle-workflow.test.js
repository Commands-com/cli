import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_OPTIONS } from '../src/command-option-schema.js';
import {
  CYCLE_RESUME_OPTION_OVERRIDES,
  mergeResumeOptions,
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
