import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseArgs } from '../src/args.js';
import {
  ALL_FLAG_NAMES,
  COMMAND_OPTIONS,
  OPTION_SCOPES,
  VALUE_FLAG_NAMES,
} from '../src/command-option-schema.js';
import {
  formatScopedOptionsHelp,
  listOption,
  positiveIntegerOption,
  readCommandOptionValue,
  stringOption,
  validateFlagsForCommand,
} from '../src/command-options.js';

const COMMON_FLAG_NAMES = Object.freeze(['cwd', 'json']);

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function flagNamesIn(text) {
  return uniqueSorted([...String(text || '').matchAll(/--([a-z][a-z-]*)\b/g)].map((match) => match[1]));
}

function metadataFlagNamesForScope(scopeName, { includeAliases = true } = {}) {
  return COMMAND_OPTIONS
    .filter((option) => option.scopes.includes(scopeName))
    .flatMap((option) => (includeAliases ? [option.name, ...option.aliases] : [option.name]));
}

function expectedAllowedFlagNamesForCommand(command) {
  const allowed = new Set(metadataFlagNamesForScope('common'));
  if (['help', '--help', '-h'].includes(command)) allowed.add('help');
  if (OPTION_SCOPES.some((scope) => scope.name === command && scope.name !== 'common')) {
    for (const flag of metadataFlagNamesForScope(command)) allowed.add(flag);
  }
  return [...allowed];
}

function helpSection(title) {
  const helpText = formatScopedOptionsHelp();
  const marker = `${title}:\n`;
  const start = helpText.indexOf(marker);
  assert.notEqual(start, -1, `help is missing section ${title}`);
  const bodyStart = start + marker.length;
  const next = helpText.indexOf('\n\n', bodyStart);
  return helpText.slice(bodyStart, next === -1 ? helpText.length : next);
}

function readmeFlagSection(readme, scopeName) {
  const heading = `### ${scopeName[0].toUpperCase()}${scopeName.slice(1)} Flags\n`;
  const start = readme.indexOf(heading);
  assert.notEqual(start, -1, `README is missing section ${heading.trim()}`);
  const bodyStart = start + heading.length;
  const nextHeading = readme.indexOf('\n### ', bodyStart);
  const nextDivider = readme.indexOf('\n---', bodyStart);
  const endCandidates = [nextHeading, nextDivider].filter((index) => index !== -1);
  const end = endCandidates.length ? Math.min(...endCandidates) : readme.length;
  return readme.slice(bodyStart, end);
}

test('parseArgs extracts command, positionals, and flags', () => {
  const parsed = parseArgs(['node', 'cli', 'review', 'fix tests', '--provider', 'mock', '--json']);
  assert.equal(parsed.command, 'review');
  assert.deepEqual(parsed.positionals, ['fix tests']);
  assert.equal(parsed.flags.get('provider'), 'mock');
  assert.equal(parsed.flags.get('json'), true);
});

test('parseArgs supports --key=value', () => {
  const parsed = parseArgs(['node', 'cli', 'quality', '--area=tests,security']);
  assert.equal(parsed.flags.get('area'), 'tests,security');
});

test('parseArgs does not let boolean flags swallow later positionals', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--json', '--fix', 'fix tests']);
  assert.equal(parsed.command, 'review');
  assert.deepEqual(parsed.positionals, ['fix tests']);
  assert.equal(parsed.flags.get('json'), true);
  assert.equal(parsed.flags.get('fix'), true);
});

test('parseArgs consumes values only for known value flags', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--provider', 'mock', '--changed', 'review diff']);
  assert.equal(parsed.flags.get('provider'), 'mock');
  assert.equal(parsed.flags.get('changed'), true);
  assert.deepEqual(parsed.positionals, ['review diff']);
});

test('parseArgs treats a value flag immediately followed by another flag as missing its value', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--test', '--json']);
  assert.equal(parsed.flags.get('test'), true);
  assert.equal(parsed.flags.get('json'), true);
});

test('parseArgs treats --cwd as a value flag', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--cwd', '/tmp/foo', 'objective']);
  assert.equal(parsed.flags.get('cwd'), '/tmp/foo');
  assert.deepEqual(parsed.positionals, ['objective']);
});

test('parseArgs treats --providers as a value flag', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--providers', 'codex,claude', 'objective']);
  assert.equal(parsed.flags.get('providers'), 'codex,claude');
  assert.deepEqual(parsed.positionals, ['objective']);
});

test('parseArgs treats --max-implementers as a value flag', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--fix', '--max-implementers', '2', 'objective']);
  assert.equal(parsed.flags.get('max-implementers'), '2');
  assert.deepEqual(parsed.positionals, ['objective']);
});

test('parseArgs treats --retries as a value flag', () => {
  const parsed = parseArgs(['node', 'cli', 'quality', '--retries', '0', '--area', 'tests']);
  assert.equal(parsed.flags.get('retries'), '0');
  assert.equal(parsed.flags.get('area'), 'tests');
});

test('parseArgs consumes values for every declared value flag', () => {
  for (const flag of VALUE_FLAG_NAMES) {
    const parsed = parseArgs(['node', 'cli', 'review', `--${flag}`, 'value', 'objective']);
    assert.equal(parsed.flags.get(flag), 'value', `expected --${flag} to consume a value`);
    assert.deepEqual(parsed.positionals, ['objective'], `expected --${flag} not to leak its value as a positional`);
  }
});

test('command option metadata keeps flags unique and option records immutable', () => {
  const expectedAllFlags = [
    ...new Set(COMMAND_OPTIONS.flatMap((option) => [option.name, ...option.aliases])),
  ];

  assert.equal(Object.isFrozen(COMMAND_OPTIONS), true);
  assert.deepEqual(ALL_FLAG_NAMES, expectedAllFlags);

  for (const option of COMMAND_OPTIONS) {
    assert.equal(Object.isFrozen(option), true, `--${option.name} metadata should be frozen`);
    assert.equal(Object.isFrozen(option.aliases), true, `--${option.name} aliases should be frozen`);
    assert.equal(Object.isFrozen(option.scopes), true, `--${option.name} scopes should be frozen`);
  }

  assert.equal(new Set(ALL_FLAG_NAMES).size, ALL_FLAG_NAMES.length);
});

test('stringOption reads explicit string values and falls back for boolean-style flags', () => {
  const flags = new Map([
    ['model', 'gpt-5'],
    ['empty', ''],
    ['json', true],
  ]);

  assert.equal(stringOption(flags, 'model', 'fallback'), 'gpt-5');
  assert.equal(stringOption(flags, 'empty', 'fallback'), '');
  assert.equal(stringOption(flags, 'missing', 'fallback'), 'fallback');
  assert.equal(stringOption(flags, 'json', 'fallback'), 'fallback');
});

test('boolean option reader treats flag presence as truth', () => {
  const flags = new Map([
    ['json', 'true'],
    ['changed', 'false'],
  ]);

  assert.equal(readCommandOptionValue(flags, 'json', false), true);
  assert.equal(readCommandOptionValue(flags, 'changed', false), true);
  assert.equal(readCommandOptionValue(new Map(), 'json', false), false);
});

test('integer option helpers normalize valid values and fall back when absent', () => {
  const flags = new Map([
    ['max-cycles', '3'],
    ['retries', '0'],
  ]);

  assert.equal(positiveIntegerOption(flags, 'max-cycles', 1), 3);
  assert.equal(positiveIntegerOption(flags, 'missing', 5), 5);
  assert.equal(readCommandOptionValue(flags, 'retries', 1), 0);
});

test('listOption splits comma-separated values and falls back for empty input', () => {
  const flags = new Map([
    ['area', 'tests, maintainability,,security'],
    ['empty', ' , ,, '],
    ['json', true],
  ]);

  assert.deepEqual(listOption(flags, 'area', ['default']), ['tests', 'maintainability', 'security']);
  assert.deepEqual(listOption(flags, 'empty', ['default']), ['default']);
  assert.deepEqual(listOption(flags, 'json', ['default']), ['default']);
  assert.deepEqual(listOption(flags, 'missing', ['default']), ['default']);
});

test('command option metadata keeps command-specific flags out of common scope', () => {
  assert.deepEqual(metadataFlagNamesForScope('common', { includeAliases: false }), [...COMMON_FLAG_NAMES]);
  for (const flag of ['area', 'limit', 'max-implementers', 'no-synthesis', 'reviewers']) {
    assert.ok(!COMMON_FLAG_NAMES.includes(flag), `--${flag} should not be a common flag`);
  }
});

test('validateFlagsForCommand rejects unknown flags', () => {
  assert.throws(
    () => validateFlagsForCommand('review', new Map([['mystery', 'true']])),
    (error) => error.name === 'UsageError' && error.message === 'unknown option: --mystery',
  );
});

test('validateFlagsForCommand rejects flags from the wrong command scope', () => {
  assert.throws(
    () => validateFlagsForCommand('doctor', new Map([['area', 'maintainability']])),
    (error) => error.name === 'UsageError' && error.message === '--area is not valid for doctor command',
  );
  assert.throws(
    () => validateFlagsForCommand('quality', new Map([['reviewers', 'security']])),
    (error) => error.name === 'UsageError' && error.message === '--reviewers is not valid for quality command',
  );
  assert.throws(
    () => validateFlagsForCommand('room', new Map([['serial', 'true']])),
    (error) => error.name === 'UsageError' && error.message === '--serial is not valid for room command',
  );
});

test('validateFlagsForCommand accepts common flags for every command', () => {
  for (const command of ['review', 'quality', 'room', 'rooms', 'doctor', 'init', 'runs', 'help', '--help', '-h']) {
    assert.doesNotThrow(
      () => validateFlagsForCommand(command, new Map([['cwd', '/tmp'], ['json', 'true']])),
      `expected common flags to be valid for ${command}`,
    );
  }
});

test('validateFlagsForCommand accepts each command scope declared in option metadata', () => {
  for (const scope of OPTION_SCOPES.filter((item) => item.name !== 'common')) {
    const expected = uniqueSorted([...COMMON_FLAG_NAMES, ...metadataFlagNamesForScope(scope.name)]);
    assert.deepEqual(uniqueSorted(expectedAllowedFlagNamesForCommand(scope.name)), expected);
    for (const flag of expected) {
      assert.doesNotThrow(
        () => validateFlagsForCommand(scope.name, new Map([[flag, 'true']])),
        `expected --${flag} to be valid for ${scope.name}`,
      );
    }
  }
});

test('validateFlagsForCommand treats rooms as a common-only command scope', () => {
  assert.deepEqual(
    uniqueSorted(expectedAllowedFlagNamesForCommand('rooms')),
    uniqueSorted(COMMON_FLAG_NAMES),
  );
  assert.doesNotThrow(() => validateFlagsForCommand('rooms', new Map([
    ['cwd', '/tmp'],
    ['json', 'true'],
  ])));

  for (const [flag, value] of [['participants', '2'], ['provider', 'mock'], ['area', 'tests']]) {
    assert.throws(
      () => validateFlagsForCommand('rooms', new Map([[flag, value]])),
      (error) => error.name === 'UsageError' && error.message === `--${flag} is not valid for rooms command`,
      `expected --${flag} to be rejected for rooms`,
    );
  }
});

test('validateFlagsForCommand preserves help command behavior', () => {
  for (const command of ['help', '--help', '-h']) {
    assert.deepEqual(
      uniqueSorted(expectedAllowedFlagNamesForCommand(command)),
      uniqueSorted([...COMMON_FLAG_NAMES, 'help']),
      `expected ${command} to allow only common flags plus --help`,
    );
    assert.doesNotThrow(
      () => validateFlagsForCommand(command, new Map([
        ['help', 'true'],
        ['json', 'true'],
      ])),
      `expected --help and common flags to be valid for ${command}`,
    );
  }

  assert.throws(
    () => validateFlagsForCommand('help', new Map([['participants', '2']])),
    (error) => error.name === 'UsageError' && error.message === '--participants is not valid for help command',
  );
});

test('validateFlagsForCommand rejects scoped flags on unknown commands', () => {
  assert.doesNotThrow(() => validateFlagsForCommand('does-not-exist', new Map([
    ['json', 'true'],
  ])));

  assert.throws(
    () => validateFlagsForCommand('does-not-exist', new Map([['area', 'tests']])),
    (error) => error.name === 'UsageError' && error.message === '--area is not valid for unknown command does-not-exist',
  );

  assert.throws(
    () => validateFlagsForCommand('does-not-exist', new Map([['mystery', 'true']])),
    (error) => error.name === 'UsageError' && error.message === 'unknown option: --mystery',
  );
});

test('declared command flags use executable readers', () => {
  const allowedReaders = new Set([
    'booleanOption',
    'listOption',
    'nonNegativeIntegerOption',
    'positiveIntegerOption',
    'stringOption',
  ]);
  for (const option of COMMAND_OPTIONS) {
    assert.ok(
      allowedReaders.has(option.readWith),
      `--${option.name} should declare a known option reader (got ${option.readWith})`,
    );
  }
});

test('README and help document the flags for each metadata scope', async () => {
  const readme = (await fs.readFile(new URL('../README.md', import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
  const allMetadataFlags = new Set(ALL_FLAG_NAMES);
  const documentedHelpFlags = new Set();
  const documentedReadmeFlags = new Set();

  for (const scope of OPTION_SCOPES) {
    const expected = uniqueSorted(metadataFlagNamesForScope(scope.name));
    const helpFlags = flagNamesIn(helpSection(scope.title));
    const readmeFlags = flagNamesIn(readmeFlagSection(readme, scope.name));

    assert.deepEqual(helpFlags, expected, `help flags for ${scope.name} scope should match metadata`);
    assert.deepEqual(readmeFlags, expected, `README flags for ${scope.name} scope should match metadata`);

    for (const flag of helpFlags) documentedHelpFlags.add(flag);
    for (const flag of readmeFlags) documentedReadmeFlags.add(flag);
  }

  for (const flag of documentedHelpFlags) {
    assert.ok(allMetadataFlags.has(flag), `help documents --${flag}, but metadata does not declare it`);
  }
  for (const flag of documentedReadmeFlags) {
    assert.ok(allMetadataFlags.has(flag), `README documents --${flag}, but metadata does not declare it`);
  }

  assert.deepEqual(uniqueSorted(documentedHelpFlags), uniqueSorted(ALL_FLAG_NAMES));
  assert.deepEqual(uniqueSorted(documentedReadmeFlags), uniqueSorted(ALL_FLAG_NAMES));
});
