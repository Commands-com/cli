import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  resolveCycleCommandOptions,
  resolveRoomCommandOptions,
} from '../src/command-options.js';
import { runCycleWorkflow } from '../src/cycle-workflow.js';
import { tempDir } from './support/cli.js';
import { isUsageError } from './support/assertions.js';

function flags(entries = []) {
  return new Map(entries);
}

function optionSubset(options, keys) {
  return Object.fromEntries(keys.map((key) => [key, options[key]]));
}

const CYCLE_DEFAULT_FIELDS = Object.freeze([
  'maxCycles',
  'maxImplementers',
  'stallCycles',
  'providerRetries',
  'timeoutMs',
]);

function cycleDefaultOptions(flagEntries = []) {
  return Object.freeze(optionSubset(
    resolveCycleCommandOptions(flags(flagEntries)),
    CYCLE_DEFAULT_FIELDS,
  ));
}

const CYCLE_REPORT_DEFAULTS = cycleDefaultOptions();
const CYCLE_FIX_DEFAULTS = cycleDefaultOptions([['fix', 'true']]);
const CYCLE_UNTIL_DEFAULTS = cycleDefaultOptions([['until', 'A']]);

const silentLogger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

test('resolveCycleCommandOptions resolves cycle defaults and scalar flags from one table', () => {
  const cases = [
    {
      name: 'report-only defaults',
      flags: [],
      expected: {
        changed: false,
        fix: false,
        worktree: false,
        keepWorktree: false,
        allowDirty: false,
        failOnIssues: false,
        json: false,
        maxCycles: CYCLE_REPORT_DEFAULTS.maxCycles,
        maxImplementers: CYCLE_REPORT_DEFAULTS.maxImplementers,
        stallCycles: CYCLE_REPORT_DEFAULTS.stallCycles,
        resume: '',
        untilScore: '',
        providerRetries: CYCLE_REPORT_DEFAULTS.providerRetries,
        timeoutMs: CYCLE_REPORT_DEFAULTS.timeoutMs,
        testCommand: '',
      },
    },
    {
      name: 'fix flags and explicit scalar values',
      flags: [
        ['changed', 'true'],
        ['fix', 'true'],
        ['worktree', 'true'],
        ['keep-worktree', 'true'],
        ['allow-dirty', 'true'],
        ['fail-on-issues', 'true'],
        ['json', 'true'],
        ['max-cycles', '2'],
        ['max-implementers', '4'],
        ['stall-cycles', '0'],
        ['resume', 'latest'],
        ['until', 'a'],
        ['retries', '0'],
        ['timeout-ms', '1234'],
        ['test', 'npm test'],
      ],
      expected: {
        changed: true,
        fix: true,
        worktree: true,
        keepWorktree: true,
        allowDirty: true,
        failOnIssues: true,
        json: true,
        maxCycles: 2,
        maxImplementers: 4,
        stallCycles: 0,
        resume: 'latest',
        untilScore: 'A',
        providerRetries: 0,
        timeoutMs: 1234,
        testCommand: 'npm test',
      },
    },
  ];

  for (const item of cases) {
    assert.deepEqual(
      optionSubset(resolveCycleCommandOptions(flags(item.flags)), Object.keys(item.expected)),
      item.expected,
      item.name,
    );
  }
});

test('resolveCycleCommandOptions lets quality --until drive fix-loop defaults', () => {
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags([['until', 'a']])), ['fix', 'maxCycles', 'untilScore']),
    {
      fix: true,
      maxCycles: CYCLE_UNTIL_DEFAULTS.maxCycles,
      untilScore: 'A',
    },
  );
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags([
      ['until', 'A'],
      ['max-cycles', '5'],
    ])), ['fix', 'maxCycles', 'untilScore']),
    {
      fix: true,
      maxCycles: 5,
      untilScore: 'A',
    },
  );
  assert.throws(
    () => resolveCycleCommandOptions(flags([['until', 'pass']])),
    (error) => isUsageError(error, '--until must be one of A, B, C, D, F'),
  );
});

test('resolveCycleCommandOptions resolves max implementer flag', () => {
  const cases = [
    {
      name: 'default max implementers',
      flags: [],
      expected: CYCLE_REPORT_DEFAULTS.maxImplementers,
    },
    {
      name: 'canonical max implementers flag',
      flags: [['max-implementers', '4']],
      expected: 4,
    },
  ];

  for (const item of cases) {
    assert.equal(
      resolveCycleCommandOptions(flags(item.flags)).maxImplementers,
      item.expected,
      item.name,
    );
  }
});

test('resolveCycleCommandOptions uses active defaults for report and fix modes', () => {
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags()), ['fix', 'maxCycles', 'maxImplementers', 'untilScore']),
    {
      fix: false,
      maxCycles: CYCLE_REPORT_DEFAULTS.maxCycles,
      maxImplementers: CYCLE_REPORT_DEFAULTS.maxImplementers,
      untilScore: '',
    },
  );
  assert.deepEqual(
    optionSubset(resolveCycleCommandOptions(flags([['fix', 'true']])), ['fix', 'maxCycles', 'maxImplementers', 'untilScore']),
    {
      fix: true,
      maxCycles: CYCLE_FIX_DEFAULTS.maxCycles,
      maxImplementers: CYCLE_FIX_DEFAULTS.maxImplementers,
      untilScore: '',
    },
  );
});

test('resolveCycleCommandOptions centralizes serial and parallel behavior', () => {
  const cases = [
    {
      name: 'cycle fanout defaults to parallel',
      flags: [],
      expected: { serial: false, parallel: true },
    },
    {
      name: 'parallel flag keeps parallel enabled',
      flags: [['parallel', 'true']],
      expected: { serial: false, parallel: true },
    },
    {
      name: 'serial disables default parallel fanout',
      flags: [['serial', 'true']],
      expected: { serial: true, parallel: false },
    },
    {
      name: 'serial wins over parallel when both are present',
      flags: [['serial', 'true'], ['parallel', 'true']],
      expected: { serial: true, parallel: false },
    },
  ];

  for (const item of cases) {
    const options = resolveCycleCommandOptions(flags(item.flags));
    assert.deepEqual(
      { serial: options.serial, parallel: options.parallel },
      item.expected,
      item.name,
    );
  }
});

test('public command option resolvers apply fanout mode precedence', () => {
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
    'cycle serial should disable explicit and default parallel fanout',
  );
  assert.deepEqual(
    optionSubset(resolveRoomCommandOptions(flags([
      ['parallel', 'true'],
      ['serial', 'true'],
    ]), { participantCount: 2 }), ['parallel']),
    { parallel: true },
    'room fanout should ignore serial and still honor parallel',
  );
});

test('resolveRoomCommandOptions clamps participant limits and keeps synthesis explicit', () => {
  const cases = [
    {
      name: 'all room options use defaults',
      flags: [],
      participantCount: 3,
      resolverOptions: {},
      expected: {
        changed: false,
        json: false,
        parallel: false,
        synthesize: true,
        participantLimit: 3,
        providerRetries: CYCLE_REPORT_DEFAULTS.providerRetries,
        timeoutMs: CYCLE_REPORT_DEFAULTS.timeoutMs,
      },
    },
    {
      name: 'room shared flags and JSON mode are explicit',
      flags: [
        ['changed', 'true'],
        ['participants', '2'],
        ['no-synthesis', 'true'],
        ['parallel', 'true'],
        ['retries', '0'],
        ['timeout-ms', '250'],
      ],
      participantCount: 3,
      resolverOptions: { json: true },
      expected: {
        changed: true,
        json: true,
        parallel: true,
        synthesize: false,
        participantLimit: 2,
        providerRetries: 0,
        timeoutMs: 250,
      },
    },
    {
      name: 'explicit participant limit',
      flags: [['participants', '2']],
      participantCount: 3,
      expected: { participantLimit: 2 },
    },
    {
      name: 'oversized participant limit clamps to room size',
      flags: [['participants', '99']],
      participantCount: 3,
      expected: { participantLimit: 3 },
    },
    {
      name: 'empty room clamps participant limit to zero',
      flags: [['participants', '2']],
      participantCount: 0,
      expected: { participantLimit: 0 },
    },
    {
      name: 'parallel does not imply synthesis changes',
      flags: [['parallel', 'true']],
      participantCount: 3,
      expected: { parallel: true, synthesize: true },
    },
  ];

  for (const item of cases) {
    const options = resolveRoomCommandOptions(flags(item.flags), {
      participantCount: item.participantCount,
      ...item.resolverOptions,
    });
    assert.deepEqual(
      optionSubset(options, Object.keys(item.expected)),
      item.expected,
      item.name,
    );
  }

  assert.throws(
    () => resolveRoomCommandOptions(flags([['participants', '0']]), { participantCount: 3 }),
    (error) => isUsageError(error, '--participants expects a positive integer, got "0"'),
  );
});

test('runCycleWorkflow uses shared defaults after provider resolution', async () => {
  const cwd = await tempDir('commands-com-cycle-options-');
  try {
    const state = await runCycleWorkflow({
      positionals: [],
      flags: flags([
        ['provider', 'mock'],
        ['fix', 'true'],
        ['retries', '0'],
        ['timeout-ms', '1'],
      ]),
    }, {
      cwd,
      kind: 'review',
      label: 'cycle option defaults',
      logger: silentLogger,
      adapter: {},
      dependencies: { runAssessmentCycles: async () => {} },
    });

    assert.equal(state.options.primaryProvider.id, 'mock');
    assert.equal(state.options.maxCycles, CYCLE_FIX_DEFAULTS.maxCycles);
    assert.equal(state.options.providerRetries, 0);
    assert.equal(state.options.timeoutMs, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
