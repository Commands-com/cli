import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';
import { COMMAND_OPTIONS } from '../src/command-option-schema.js';
import {
  filterKnownStoredCycleOptions,
  hasAnyFlag,
  hasFlag,
  normalizeFlags,
  positiveIntegerOption,
  readCommandOptionValue,
  stringOption,
} from '../src/command-options.js';
import { isUsageError } from './support/assertions.js';

function optionByName(name) {
  const option = COMMAND_OPTIONS.find((item) => item.name === name);
  assert.ok(option, `expected --${name} to be declared`);
  return option;
}

function readableSample(option) {
  if (option.readWith === 'booleanOption') return { raw: 'true', expected: true };
  if (option.readWith === 'listOption') return { raw: 'configured', expected: ['configured'] };
  if (['positiveIntegerOption', 'nonNegativeIntegerOption'].includes(option.readWith)) {
    return { raw: '7', expected: 7 };
  }
  return { raw: 'configured', expected: 'configured' };
}

test('readCommandOptionValue reads non-resolver flags through the shared option schema', () => {
  assert.deepEqual(optionByName('providers').resolve, []);
  assert.deepEqual(optionByName('base-ref').resolve, []);

  assert.equal(
    readCommandOptionValue(new Map([['providers', 'mock']]), 'providers', ''),
    'mock',
  );
  assert.equal(
    readCommandOptionValue(new Map([['base-ref', 'main']]), 'base-ref', 'HEAD'),
    'main',
  );
});

test('readCommandOptionValue normalizes object flags and boolean-style value flags', () => {
  assert.equal(
    readCommandOptionValue({ model: 'gpt-5' }, 'model', ''),
    'gpt-5',
  );
  assert.equal(
    readCommandOptionValue({ model: true }, 'model', 'fallback'),
    'fallback',
  );
});

test('readCommandOptionValue treats the literal string "true" as a real value, not a missing sentinel', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--test=true']);
  assert.equal(parsed.flags.get('test'), 'true');
  assert.equal(
    readCommandOptionValue(parsed.flags, 'test', 'default-cmd'),
    'true',
  );
  assert.equal(
    readCommandOptionValue(new Map([['model', 'true']]), 'model', 'fallback'),
    'true',
  );
});

test('readCommandOptionValue treats boolean true as the missing-value sentinel', () => {
  const parsed = parseArgs(['node', 'cli', 'review', '--test', '--json']);
  assert.equal(parsed.flags.get('test'), true);
  assert.equal(
    readCommandOptionValue(parsed.flags, 'test', 'default-cmd'),
    'default-cmd',
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['timeout-ms', true]]), 'timeout-ms', 30_000),
    (error) => isUsageError(error, '--timeout-ms requires a positive integer value'),
  );
});

test('readCommandOptionValue resolves canonical names and aliases', () => {
  for (const option of COMMAND_OPTIONS) {
    const { raw, expected } = readableSample(option);
    assert.deepEqual(
      readCommandOptionValue(new Map([[option.name, raw]]), option.name, 'fallback'),
      expected,
    );
    for (const alias of option.aliases) {
      assert.deepEqual(
        readCommandOptionValue(new Map([[alias, raw]]), alias, 'fallback'),
        expected,
      );
    }
  }
});

test('readCommandOptionValue rejects unknown flags clearly', () => {
  assert.throws(
    () => readCommandOptionValue(new Map(), 'missing', ''),
    /unknown command option: --missing/,
  );
});

test('numeric option readers reject invalid numeric prefixes', () => {
  assert.throws(
    () => readCommandOptionValue(new Map([['max-cycles', '10abc']]), 'max-cycles', 3),
    (error) => isUsageError(error, /--max-cycles expects a positive integer/),
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['retries', '2ms']]), 'retries', 1),
    (error) => isUsageError(error, /--retries expects a non-negative integer/),
  );
  assert.equal(
    readCommandOptionValue(new Map([['timeout-ms', '0010']]), 'timeout-ms', 1),
    10,
  );
});

test('positiveIntegerOption throws UsageError for non-numeric input', () => {
  assert.throws(
    () => positiveIntegerOption(new Map([['timeout-ms', 'nope']]), 'timeout-ms', 30_000),
    (error) => isUsageError(error, '--timeout-ms expects a positive integer, got "nope"'),
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['timeout-ms', 'nope']]), 'timeout-ms', 30_000),
    (error) => isUsageError(error, '--timeout-ms expects a positive integer, got "nope"'),
  );
});

test('positiveIntegerOption throws UsageError for zero or negative values', () => {
  assert.throws(
    () => positiveIntegerOption(new Map([['max-cycles', '0']]), 'max-cycles', 3),
    (error) => isUsageError(error, '--max-cycles expects a positive integer, got "0"'),
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['max-cycles', '0']]), 'max-cycles', 3),
    (error) => isUsageError(error, /--max-cycles expects a positive integer/),
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['retries', '-1']]), 'retries', 1),
    (error) => isUsageError(error, /--retries expects a non-negative integer/),
  );
});

test('numeric option readers throw UsageError when a value flag is missing its value', () => {
  assert.throws(
    () => positiveIntegerOption(new Map([['timeout-ms', true]]), 'timeout-ms', 30_000),
    (error) => isUsageError(error, '--timeout-ms requires a positive integer value'),
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['max-cycles', true]]), 'max-cycles', 3),
    (error) => isUsageError(error, '--max-cycles requires a positive integer value'),
  );
  assert.throws(
    () => readCommandOptionValue(new Map([['retries', true]]), 'retries', 1),
    (error) => isUsageError(error, '--retries requires a non-negative integer value'),
  );
});

test('positiveIntegerOption enforces an optional max bound', () => {
  assert.equal(positiveIntegerOption(new Map([['max-implementers', '32']]), 'max-implementers', 15, { max: 32 }), 32);
  assert.throws(
    () => positiveIntegerOption(new Map([['max-implementers', '33']]), 'max-implementers', 15, { max: 32 }),
    (error) => isUsageError(error, '--max-implementers must be at most 32, got 33'),
  );
});

test('numeric option readers fall back to defaults only when the flag is absent', () => {
  assert.equal(positiveIntegerOption(new Map(), 'timeout-ms', 30_000), 30_000);
  assert.equal(readCommandOptionValue(new Map(), 'max-cycles', 3), 3);
  assert.equal(readCommandOptionValue(new Map(), 'retries', 1), 1);
});

test('hasFlag normalizes map and object flag shapes', () => {
  assert.equal(hasFlag(new Map([['json', 'true']]), 'json'), true);
  assert.equal(hasFlag(new Map([['json', false]]), 'json'), true);
  assert.equal(hasFlag(new Map([['json', '']]), 'json'), true);
  assert.equal(hasFlag({ json: 'true' }, 'json'), true);
  assert.equal(hasFlag({ json: false }, 'json'), true);
  assert.equal(hasFlag({ json: '' }, 'json'), true);
  assert.equal(hasFlag({}, 'json'), false);
});

test('filterKnownStoredCycleOptions drops unknown stored fields and warns once', () => {
  const warnCalls = [];
  const logger = { warn: (...args) => warnCalls.push(args) };
  const stored = {
    fix: true,
    maxCycles: 5,
    untilScore: 'A',
    model: 'gpt-5',
    bogusField: 'x',
    anotherStale: 42,
  };

  const filtered = filterKnownStoredCycleOptions(stored, { logger });

  assert.deepEqual(filtered, {
    fix: true,
    maxCycles: 5,
    untilScore: 'A',
    model: 'gpt-5',
  });
  assert.equal(Object.hasOwn(filtered, 'bogusField'), false);
  assert.equal(Object.hasOwn(filtered, 'anotherStale'), false);
  assert.equal(warnCalls.length, 1);
  const message = warnCalls[0].map(String).join(' ');
  assert.match(message, /bogusField/);
  assert.match(message, /anotherStale/);
});

test('shared flag helpers centralize presence checks and direct option reads', () => {
  const mapFlags = new Map([['json', 'false'], ['model', 'gpt-5']]);
  const objectFlags = { json: false, model: 'gpt-5' };

  assert.equal(normalizeFlags(mapFlags), mapFlags);
  assert.deepEqual([...normalizeFlags(objectFlags)], [['json', false], ['model', 'gpt-5']]);
  assert.equal(hasAnyFlag(mapFlags, ['missing', 'json']), true);
  assert.equal(hasAnyFlag(objectFlags, ['missing', 'json']), true);
  assert.equal(hasAnyFlag(objectFlags, ['missing']), false);
  assert.equal(stringOption(objectFlags, 'model', ''), 'gpt-5');
});
