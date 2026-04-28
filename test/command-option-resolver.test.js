import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectCycleCommandOptions,
  resolveCycleCommandOptions,
  resolveRoomCommandOptions,
} from '../src/command-options.js';
import { COMMAND_OPTIONS } from '../src/command-option-schema.js';

function flags(entries = []) {
  return new Map(entries);
}

function optionSubset(options, keys) {
  return Object.fromEntries(keys.map((key) => [key, options[key]]));
}

const CYCLE_METADATA_FIELDS = Object.freeze([
  'changed',
  'fix',
  'worktree',
  'allowDirty',
  'keepWorktree',
  'maxCycles',
  'maxImplementers',
  'stallCycles',
  'resume',
  'untilScore',
  'parallel',
  'serial',
  'providerRetries',
  'testCommand',
  'timeoutMs',
  'json',
  'failOnIssues',
]);

function cycleFallback(optionName, field, context = { options: {} }) {
  const option = COMMAND_OPTIONS.find(({ name }) => name === optionName);
  const resolver = option?.resolve.find((entry) => (
    entry.resolver === 'cycle' && entry.field === field
  ));

  assert.ok(resolver, `expected --${optionName} to resolve cycle field ${field}`);
  return typeof resolver.fallback === 'function'
    ? resolver.fallback(context)
    : resolver.fallback;
}

const CYCLE_DEFAULTS = Object.freeze({
  maxCycles: Object.freeze({
    report: cycleFallback('max-cycles', 'maxCycles'),
    fix: cycleFallback('max-cycles', 'maxCycles', { options: { fix: true } }),
    until: cycleFallback('max-cycles', 'maxCycles', { options: { untilScore: 'A' } }),
  }),
  maxImplementers: cycleFallback('max-implementers', 'maxImplementers'),
  stallCycles: cycleFallback('stall-cycles', 'stallCycles'),
  providerRetries: cycleFallback('retries', 'providerRetries'),
  timeoutMs: cycleFallback('timeout-ms', 'timeoutMs'),
});

test('resolveCycleCommandOptions reads cycle flags directly from option metadata', () => {
  const options = resolveCycleCommandOptions(flags([
    ['changed', 'true'],
    ['fix', 'true'],
    ['worktree', 'true'],
    ['allow-dirty', 'true'],
    ['keep-worktree', 'true'],
    ['max-cycles', '2'],
    ['max-implementers', '5'],
    ['stall-cycles', '0'],
    ['resume', 'latest'],
    ['until', 'a'],
    ['parallel', 'true'],
    ['serial', 'true'],
    ['retries', '0'],
    ['test', 'npm test'],
    ['timeout-ms', '250'],
    ['json', 'true'],
    ['fail-on-issues', 'true'],
  ]));

  assert.deepEqual(optionSubset(options, CYCLE_METADATA_FIELDS), {
    changed: true,
    fix: true,
    worktree: true,
    allowDirty: true,
    keepWorktree: true,
    maxCycles: 2,
    maxImplementers: 5,
    stallCycles: 0,
    resume: 'latest',
    untilScore: 'A',
    parallel: false,
    serial: true,
    providerRetries: 0,
    testCommand: 'npm test',
    timeoutMs: 250,
    json: true,
    failOnIssues: true,
  });
});

test('resolveCycleCommandOptions preserves active defaults', () => {
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags()), [
      'fix',
      'maxCycles',
      'maxImplementers',
      'stallCycles',
      'resume',
      'untilScore',
      'providerRetries',
      'timeoutMs',
      'testCommand',
    ]),
    {
      fix: false,
      maxCycles: CYCLE_DEFAULTS.maxCycles.report,
      maxImplementers: CYCLE_DEFAULTS.maxImplementers,
      stallCycles: CYCLE_DEFAULTS.stallCycles,
      resume: '',
      untilScore: '',
      providerRetries: CYCLE_DEFAULTS.providerRetries,
      timeoutMs: CYCLE_DEFAULTS.timeoutMs,
      testCommand: '',
    },
  );
});

test('resolveCycleCommandOptions surfaces invalid scalar option values as UsageError', () => {
  const cases = [
    ['max-cycles', '0', '--max-cycles expects a positive integer, got "0"'],
    ['max-implementers', '0', '--max-implementers expects a positive integer, got "0"'],
    ['stall-cycles', '-1', '--stall-cycles expects a non-negative integer, got "-1"'],
    ['retries', '-1', '--retries expects a non-negative integer, got "-1"'],
    ['timeout-ms', '0', '--timeout-ms expects a positive integer, got "0"'],
  ];

  for (const [flag, value, message] of cases) {
    assert.throws(
      () => resolveCycleCommandOptions(flags([['fix', 'true'], [flag, value]])),
      (error) => error.name === 'UsageError' && error.message === message,
      `expected --${flag} ${value} to throw UsageError`,
    );
  }
});

test('resolveCycleCommandOptions normalizes quality until targets', () => {
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags([
      ['until', 'a'],
    ])), ['fix', 'maxCycles', 'untilScore']),
    {
      fix: true,
      maxCycles: CYCLE_DEFAULTS.maxCycles.until,
      untilScore: 'A',
    },
  );
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags([
      ['until', 'B'],
      ['max-cycles', '4'],
    ])), ['fix', 'maxCycles', 'untilScore']),
    {
      fix: true,
      maxCycles: 4,
      untilScore: 'B',
    },
  );
  assert.throws(
    () => resolveCycleCommandOptions(flags([['until', 'gold']])),
    (error) => error.name === 'UsageError' && error.message === '--until must be one of A, B, C, D, F',
  );
});

test('public option resolvers apply fanout defaults and serial precedence', () => {
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags()), ['serial', 'parallel']),
    { serial: false, parallel: true },
    'cycle fanout should default to parallel',
  );
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags([
      ['parallel', 'true'],
      ['serial', 'true'],
    ])), ['serial', 'parallel']),
    { serial: true, parallel: false },
    'serial should disable explicit and default parallel mode',
  );

  const roomOptions = resolveRoomCommandOptions(flags([
    ['parallel', 'true'],
    ['serial', 'true'],
  ]));
  assert.equal(roomOptions.parallel, true, 'room fanout should ignore serial and honor parallel');
  assert.equal(Object.hasOwn(roomOptions, 'serial'), false, 'room options should not expose serial mode');
});

test('resolveRoomCommandOptions clamps participant limits and keeps synthesis explicit', () => {
  const options = resolveRoomCommandOptions(flags([
    ['changed', 'true'],
    ['participants', '99'],
    ['no-synthesis', 'true'],
    ['parallel', 'true'],
    ['retries', '0'],
    ['timeout-ms', '250'],
  ]), {
    participantCount: 3,
    json: true,
  });

  assert.deepEqual(optionSubset(options, [
    'changed',
    'json',
    'parallel',
    'synthesize',
    'participantLimit',
    'providerRetries',
    'timeoutMs',
  ]), {
    changed: true,
    json: true,
    parallel: true,
    synthesize: false,
    participantLimit: 3,
    providerRetries: 0,
    timeoutMs: 250,
  });
});

test('projectCycleCommandOptions persists only cycle runtime fields', () => {
  const source = Object.fromEntries([
    ...CYCLE_METADATA_FIELDS.map((field, index) => [field, `value:${index}`]),
    ['providerIds', ['mock']],
    ['ignoredField', 'ignored'],
  ]);

  assert.deepEqual(
    projectCycleCommandOptions(source),
    Object.fromEntries(CYCLE_METADATA_FIELDS.map((field) => [field, source[field]])),
  );
  assert.deepEqual(
    projectCycleCommandOptions({}),
    Object.fromEntries(CYCLE_METADATA_FIELDS.map((field) => [field, undefined])),
  );
});
