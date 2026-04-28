import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCycleCommandOptions } from '../src/command-options.js';
import {
  ALL_FLAG_NAMES,
  COMMAND_OPTIONS,
  HELP_COMMANDS,
  MAX_IMPLEMENTERS,
  OPTION_SCOPES,
  SCOPED_OPTION_COMMANDS,
  VALUE_FLAG_NAMES,
} from '../src/command-option-schema.js';
import { readCommandOptionValue } from '../src/command-options.js';
import {
  COMMAND_REGISTRY,
} from '../src/command-registry.js';

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function flags(entries = []) {
  return new Map(entries);
}

test('command option schema uses known readers', () => {
  const optionReaderNames = [
    'stringOption',
    'booleanOption',
    'positiveIntegerOption',
    'nonNegativeIntegerOption',
    'listOption',
  ];

  const readers = new Set(optionReaderNames);

  for (const option of COMMAND_OPTIONS) {
    assert.ok(readers.has(option.readWith), `--${option.name} uses unknown reader ${option.readWith}`);
  }
});

test('command option names and aliases are globally unique', () => {
  const optionNames = COMMAND_OPTIONS.map((option) => option.name);
  const aliases = COMMAND_OPTIONS.flatMap((option) => option.aliases);
  const allFlagNames = COMMAND_OPTIONS.flatMap((option) => [option.name, ...option.aliases]);

  assert.deepEqual(duplicateValues(optionNames), [], 'option names should be unique');
  assert.deepEqual(duplicateValues(aliases), [], 'option aliases should be unique');
  assert.deepEqual(duplicateValues(allFlagNames), [], 'option names and aliases should not overlap');
  assert.deepEqual(ALL_FLAG_NAMES, [...new Set(allFlagNames)]);
});

test('value flag names stay within all flag names', () => {
  const allFlagNames = new Set(ALL_FLAG_NAMES);
  const expectedValueFlags = [
    ...new Set(COMMAND_OPTIONS.flatMap((option) => (
      option.value ? [option.name, ...option.aliases] : []
    ))),
  ];

  assert.deepEqual(VALUE_FLAG_NAMES, expectedValueFlags);
  assert.equal(new Set(VALUE_FLAG_NAMES).size, VALUE_FLAG_NAMES.length);
  for (const flagName of VALUE_FLAG_NAMES) {
    assert.ok(allFlagNames.has(flagName), `--${flagName} is a value flag but not a declared flag`);
  }
});

test('command option schema uses declared scopes', () => {
  const scopeNames = new Set(OPTION_SCOPES.map((scope) => scope.name));

  for (const option of COMMAND_OPTIONS) {
    assert.notEqual(option.scopes.length, 0, `--${option.name} should declare at least one scope`);
    for (const scope of option.scopes) {
      assert.ok(scopeNames.has(scope), `--${option.name} uses unknown scope ${scope}`);
    }
  }
});

test('command option command sets stay aligned with command registry', () => {
  const helpCommands = COMMAND_REGISTRY
    .filter((command) => command.help)
    .flatMap((command) => [command.name, ...command.aliases]);
  const scopedOptionCommands = COMMAND_REGISTRY
    .filter((command) => command.optionScope)
    .map((command) => command.name);

  assert.deepEqual(HELP_COMMANDS, helpCommands);
  assert.deepEqual(SCOPED_OPTION_COMMANDS, scopedOptionCommands);
  assert.deepEqual(
    OPTION_SCOPES.map((scope) => scope.name),
    ['common', ...scopedOptionCommands],
  );

  for (const command of COMMAND_REGISTRY) {
    if (command.optionScope) {
      assert.ok(SCOPED_OPTION_COMMANDS.includes(command.name), `${command.name} should have scoped options`);
    } else if (command.help) {
      assert.ok(HELP_COMMANDS.includes(command.name), `${command.name} should be a help command`);
    } else if (command.commonOnly) {
      assert.equal(command.commonOnly, true, `${command.name} should be common-only`);
    } else {
      assert.fail(`${command.name} should declare an option policy`);
    }
  }
});

test('help aliases stay aligned with command registry', () => {
  const helpCommand = COMMAND_REGISTRY.find((command) => command.help);

  assert.ok(helpCommand, 'registry should define a help command');
  assert.deepEqual(HELP_COMMANDS, [helpCommand.name, ...helpCommand.aliases]);
  assert.equal(new Set(HELP_COMMANDS).size, HELP_COMMANDS.length);
});

test('option metadata is immutable and no longer carries handler ownership strings', () => {
  assert.equal(Object.isFrozen(COMMAND_OPTIONS), true);

  for (const option of COMMAND_OPTIONS) {
    assert.equal(Object.isFrozen(option), true, `--${option.name} metadata should be frozen`);
    assert.equal(Object.isFrozen(option.aliases), true, `--${option.name} aliases should be frozen`);
    assert.equal(Object.isFrozen(option.scopes), true, `--${option.name} scopes should be frozen`);
    assert.equal(Object.isFrozen(option.resolve), true, `--${option.name} resolver metadata should be frozen`);
    assert.equal(Object.hasOwn(option, 'handledBy'), false, `--${option.name} should not carry handler ownership`);
    assert.equal(Object.hasOwn(option, 'handlerReference'), false, `--${option.name} should not carry handler references`);
    assert.equal(Object.hasOwn(option, 'resolverFields'), false, `--${option.name} should not carry projected fields`);
  }
});

test('max implementers documented default matches resolver default', () => {
  const option = COMMAND_OPTIONS.find(({ name }) => name === 'max-implementers');
  const defaultOptions = resolveCycleCommandOptions(flags());

  assert.ok(option, 'schema should declare --max-implementers');
  assert.equal(
    defaultOptions.maxImplementers,
    15,
  );
  assert.equal(
    option.description,
    `Cap parallel implementation CLIs (default: ${defaultOptions.maxImplementers}, max: ${MAX_IMPLEMENTERS})`,
  );
});

test('--max-implementers rejects values above MAX_IMPLEMENTERS at parse time', () => {
  assert.equal(MAX_IMPLEMENTERS, 32);
  assert.throws(
    () => resolveCycleCommandOptions(flags([['max-implementers', '9999']])),
    (error) => error.name === 'UsageError'
      && error.message === '--max-implementers must be at most 32, got 9999',
  );
});

test('--max-implementers accepts the boundary value exactly equal to MAX_IMPLEMENTERS', () => {
  const options = resolveCycleCommandOptions(flags([['max-implementers', String(MAX_IMPLEMENTERS)]]));
  assert.equal(options.maxImplementers, MAX_IMPLEMENTERS);
});

test('readCommandOptionValue uses the requested value-bearing option name', () => {
  const fallback = 15;

  assert.equal(
    readCommandOptionValue(flags([
      ['max-implementers', '4'],
    ]), 'max-implementers', fallback),
    4,
    'canonical value should be read for the canonical option',
  );
  assert.throws(
    () => readCommandOptionValue(flags([
      ['max-implementers', 'true'],
    ]), 'max-implementers', fallback),
    /--max-implementers requires a positive integer value/,
    'boolean-style canonical value should be rejected by the strict reader',
  );
  assert.throws(
    () => readCommandOptionValue({
      'max-implementers': true,
    }, 'max-implementers', fallback),
    /--max-implementers requires a positive integer value/,
    'boolean true object flags should be rejected by the strict reader',
  );
});
