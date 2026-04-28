import {
  ALL_FLAG_NAMES,
  COMMAND_OPTIONS,
  COMMON,
  HELP_COMMANDS,
  OPTION_SCOPES,
  SCOPED_OPTION_COMMANDS,
} from './command-option-schema.js';
import {
  OPTION_READER_NAMES,
  OPTION_RESOLVER,
  OPTION_RESOLVER_FIELD_GROUP,
} from './command-option-resolvers.js';
import { REGISTERED_DISPATCH_NAMES } from './command-registry.js';
import { UsageError } from './errors.js';
import { SCORE_ORDER } from './summary-contract.js';

const ALL_FLAGS = new Set(ALL_FLAG_NAMES);
const HELP_FLAG_NAMES = Object.freeze(['help']);
const HELP_FLAGS = new Set(HELP_FLAG_NAMES);
const HELP_COMMAND_SET = new Set(HELP_COMMANDS);
const SCOPED_OPTION_COMMAND_SET = new Set(SCOPED_OPTION_COMMANDS);
const KNOWN_COMMAND_SET = new Set(REGISTERED_DISPATCH_NAMES);

function optionsForScope(scopeName) {
  return COMMAND_OPTIONS.filter((option) => option.scopes.includes(scopeName));
}

function optionValue(flags, name, fallback = '') {
  const value = normalizeFlags(flags).get(name);
  if (!isReadableOptionValue(value)) return fallback;
  return String(value);
}

export function stringOption(flags, name, fallback = '') {
  return optionValue(flags, name, fallback);
}

function booleanOption(flags, name) {
  return normalizeFlags(flags).has(name);
}

function splitList(value, fallback = []) {
  const source = String(value || '').trim();
  if (!source) return fallback;
  const items = source
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
}

function readNumericFlagState(flags, name) {
  const normalizedFlags = normalizeFlags(flags);
  if (!normalizedFlags.has(name)) return { state: 'absent' };
  const raw = normalizedFlags.get(name);
  if (!isReadableOptionValue(raw)) return { state: 'missing-value' };
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') {
    return { state: 'missing-value' };
  }
  return { state: 'present', raw: String(raw) };
}

function readStrictNumericOption(flags, name, fallback, { kind, qualifier, validate, max }) {
  const result = readNumericFlagState(flags, name);
  if (result.state === 'absent') return fallback;
  if (result.state === 'missing-value') {
    throw new UsageError(`--${name} requires ${qualifier} integer value`);
  }
  const parsed = strictInteger(result.raw);
  if (parsed === undefined || (validate && !validate(parsed))) {
    throw new UsageError(`--${name} expects ${kind}, got "${result.raw}"`);
  }
  if (max !== undefined && parsed > max) {
    throw new UsageError(`--${name} must be at most ${max}, got ${parsed}`);
  }
  return parsed;
}

export function positiveIntegerOption(flags, name, fallback, opts) {
  return readStrictNumericOption(flags, name, fallback, {
    kind: 'a positive integer',
    qualifier: 'a positive',
    validate: (value) => value >= 1,
    max: opts?.max,
  });
}

function nonNegativeIntegerOption(flags, name, fallback, opts) {
  return readStrictNumericOption(flags, name, fallback, {
    kind: 'a non-negative integer',
    qualifier: 'a non-negative',
    validate: undefined,
    max: opts?.max,
  });
}

export function listOption(flags, name, fallback = []) {
  return splitList(stringOption(flags, name, ''), fallback);
}

export function hasFlag(flags, name) {
  return hasAnyFlag(flags, [name]);
}

export function hasAnyFlag(flags, names) {
  const normalizedFlags = normalizeFlags(flags);
  return names.some((name) => normalizedFlags.has(name));
}

function strictInteger(value) {
  const source = String(value ?? '').trim();
  if (!/^\d+$/.test(source)) return undefined;
  const parsed = Number(source);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function flagNamesForScope(scopeName, { includeAliases = true } = {}) {
  return optionsForScope(scopeName).flatMap((option) => (
    includeAliases ? [option.name, ...option.aliases] : [option.name]
  ));
}

function isKnownCommand(command) {
  return KNOWN_COMMAND_SET.has(command);
}

function optionForFlagName(flagName) {
  return COMMAND_OPTIONS.find((option) => (
    option.name === flagName || option.aliases.includes(flagName)
  )) || null;
}

export function readCommandOptionValue(flags, nameOrAlias, fallback) {
  const option = optionForFlagName(nameOrAlias);
  if (!option) {
    throw new Error(`unknown command option: --${nameOrAlias}`);
  }
  const reader = COMMAND_OPTION_READER_FUNCTIONS[option.readWith];
  if (!reader) {
    throw new Error(`unknown option reader for --${option.name}: ${option.readWith}`);
  }
  const normalizedFlags = normalizeFlags(flags);
  const readName = firstReadableOptionName(normalizedFlags, option, nameOrAlias);
  return reader(normalizedFlags, readName, fallback, { max: option.max });
}

function optionReadNames(option, preferredName) {
  return [...new Set([preferredName, option.name, ...option.aliases].filter(Boolean))];
}

const COMMAND_OPTION_READER_FUNCTIONS = Object.freeze({
  stringOption,
  booleanOption: (flags, name, fallback) => booleanOption(flags, name) || Boolean(fallback),
  positiveIntegerOption,
  nonNegativeIntegerOption,
  listOption,
});
assertOptionReadersRegistered(COMMAND_OPTION_READER_FUNCTIONS);

function assertOptionReadersRegistered(readers) {
  for (const name of OPTION_READER_NAMES) {
    if (typeof readers[name] !== 'function') {
      throw new Error(`missing command option reader: ${name}`);
    }
  }
}

export function normalizeFlags(flags) {
  if (flags instanceof Map) return flags;
  return new Map(Object.entries(flags || {}));
}

function firstPresentOptionName(flags, names) {
  return names.find((name) => flags.has(name)) || names[0];
}

function firstReadableOptionName(flags, option, preferredName) {
  const names = optionReadNames(option, preferredName);
  if (!option.value) return firstPresentOptionName(flags, names);
  return names.find((name) => isReadableOptionValue(flags.get(name))) || firstPresentOptionName(flags, names);
}

function isReadableOptionValue(value) {
  return value !== undefined && value !== null && value !== true;
}

function isCommonOrHelpFlag(flagName) {
  const option = optionForFlagName(flagName);
  return HELP_FLAGS.has(flagName) || Boolean(option?.scopes.includes(COMMON));
}

function allowedFlagNamesForCommand(command, { includeAliases = true } = {}) {
  const allowed = new Set(flagNamesForScope(COMMON, { includeAliases }));
  if (HELP_COMMAND_SET.has(command)) {
    for (const flag of HELP_FLAG_NAMES) allowed.add(flag);
  }
  if (SCOPED_OPTION_COMMAND_SET.has(command)) {
    for (const flag of flagNamesForScope(command, { includeAliases })) {
      allowed.add(flag);
    }
  }
  return [...allowed];
}

export function validateFlagsForCommand(command, flags) {
  const flagNames = [...normalizeFlags(flags).keys()];
  const isKnown = isKnownCommand(command);
  const allowed = new Set(allowedFlagNamesForCommand(command));

  for (const flag of flagNames) {
    if (!ALL_FLAGS.has(flag) && !HELP_FLAGS.has(flag)) {
      throw new UsageError(`unknown option: --${flag}`);
    }
    if (!isKnown && !isCommonOrHelpFlag(flag)) {
      throw new UsageError(`--${flag} is not valid for unknown command ${command}`);
    }
    if (isKnown && !allowed.has(flag)) {
      const displayCommand = HELP_COMMAND_SET.has(command) ? 'help' : command;
      throw new UsageError(`--${flag} is not valid for ${displayCommand} command`);
    }
  }
}

function formatOptionUsage(option) {
  return `--${option.name}${option.value ? ` ${option.value}` : ''}`;
}

function formatOptionsHelp(options) {
  if (!options.length) return '';
  const rows = options.map((option) => [formatOptionUsage(option), option.description]);
  const width = Math.max(...rows.map(([usage]) => usage.length));
  return rows
    .map(([usage, description]) => `  ${usage.padEnd(width)} ${description}`)
    .join('\n');
}

function formatOptionsHelpForScope(scopeName) {
  return formatOptionsHelp(optionsForScope(scopeName));
}

export function formatScopedOptionsHelp(scopes = OPTION_SCOPES) {
  return scopes
    .map((scope) => `${scope.title}:\n${formatOptionsHelpForScope(scope.name)}`)
    .join('\n\n');
}

const {
  CYCLE: CYCLE_RESOLVER,
  ROOM: ROOM_RESOLVER,
} = OPTION_RESOLVER;

const {
  SHARED_WORKFLOW,
  CYCLE_COMMAND,
  FANOUT_MODE,
  ROOM_COMMAND,
} = OPTION_RESOLVER_FIELD_GROUP;

const CYCLE_OPTION_FIELDS = fieldsForResolver(CYCLE_RESOLVER);
const ROOM_OPTION_FIELDS = fieldsForResolver(ROOM_RESOLVER);

const CYCLE_SHARED_WORKFLOW_OPTION_FIELDS = fieldsForGroup(CYCLE_OPTION_FIELDS, SHARED_WORKFLOW);
const ROOM_SHARED_WORKFLOW_OPTION_FIELDS = fieldsForGroup(ROOM_OPTION_FIELDS, SHARED_WORKFLOW);
const CYCLE_COMMAND_OPTION_FIELDS = fieldsForGroup(CYCLE_OPTION_FIELDS, CYCLE_COMMAND);
const ROOM_COMMAND_OPTION_FIELDS = fieldsForGroup(ROOM_OPTION_FIELDS, ROOM_COMMAND);
const CYCLE_FANOUT_MODE_OPTION_FIELDS = fieldsForGroup(CYCLE_OPTION_FIELDS, FANOUT_MODE);
const ROOM_FANOUT_MODE_OPTION_FIELDS = fieldsForGroup(ROOM_OPTION_FIELDS, FANOUT_MODE);

const CYCLE_FIELD_NAMES = Object.freeze([...new Set(CYCLE_OPTION_FIELDS.map((field) => field.field))]);

// Fields a stored cycle run is allowed to carry into a resume merge: the cycle
// resolver's own fields plus any field that any option declares as a
// resume-override target (covers `model` and provider fields not bound to a
// cycle resolver). Anything else is dropped by `filterKnownStoredCycleOptions`
// with a one-line warn so stale stored runs don't silently leak through.
const KNOWN_STORED_CYCLE_FIELDS = Object.freeze(new Set([
  ...CYCLE_FIELD_NAMES,
  ...COMMAND_OPTIONS.flatMap((option) => option.resumeOverrideFields ?? []),
]));

export function resolveCycleCommandOptions(flags) {
  const cycleOptions = resolveOptionFields(flags, CYCLE_COMMAND_OPTION_FIELDS);
  const mode = resolveFanoutMode(flags, {
    defaultParallel: true,
    allowSerial: true,
  });

  return normalizeCycleCommandOptions({
    ...resolveOptionFields(flags, CYCLE_SHARED_WORKFLOW_OPTION_FIELDS),
    ...cycleOptions,
    ...mode,
  });
}

export function resolveRoomCommandOptions(flags, {
  participantCount = 0,
  json = false,
} = {}) {
  const participantFallback = Math.max(0, participantCount);
  const roomOptions = resolveOptionFields(flags, ROOM_COMMAND_OPTION_FIELDS, { participantFallback });
  const requestedLimit = roomOptions.requestedParticipantLimit;
  const participantLimit = Math.min(requestedLimit, participantFallback);
  const mode = resolveFanoutMode(flags, {
    defaultParallel: false,
    allowSerial: false,
  });

  return {
    ...resolveOptionFields(flags, ROOM_SHARED_WORKFLOW_OPTION_FIELDS),
    json,
    parallel: mode.parallel,
    synthesize: !roomOptions.noSynthesis,
    participantLimit,
  };
}

export function projectCycleCommandOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  return Object.fromEntries(CYCLE_FIELD_NAMES.map((field) => [field, source[field]]));
}

/**
 * Drop unknown fields from a stored resume payload before merging it back in.
 * Recognized fields layer per the precedence rule (explicit CLI flag > stored
 * resume > env > config > schema default); unrecognized fields are dropped
 * with a single one-line `logger.warn` per stored run so older run-state
 * payloads can't silently leak removed fields through the resume merge.
 *
 * @param {Object|null|undefined} storedOptions
 * @param {{ logger?: { info?: (message: string) => void, warn?: (message: string) => void } }} [options]
 */
export function filterKnownStoredCycleOptions(storedOptions, { logger } = {}) {
  if (!storedOptions || typeof storedOptions !== 'object') return {};
  const known = {};
  const unknown = [];
  for (const [key, value] of Object.entries(storedOptions)) {
    if (KNOWN_STORED_CYCLE_FIELDS.has(key)) known[key] = value;
    else unknown.push(key);
  }
  if (unknown.length && typeof logger?.warn === 'function') {
    logger.warn(`resume: ignoring stored field${unknown.length === 1 ? '' : 's'} ${unknown.map((name) => `'${name}'`).join(', ')} (no longer in schema)`);
  }
  return known;
}

function resolveFanoutMode(flags, { defaultParallel = false, allowSerial = true } = {}) {
  const fields = allowSerial ? CYCLE_FANOUT_MODE_OPTION_FIELDS : ROOM_FANOUT_MODE_OPTION_FIELDS;
  const { serial = false, parallel = false } = resolveOptionFields(flags, fields);
  return {
    serial,
    parallel: !serial && (parallel || Boolean(defaultParallel)),
  };
}

function resolveOptionFields(flags, fields, context = {}) {
  const options = {};
  for (const field of fields) {
    const fallback = resolveOptionFallback(field.fallback, { ...context, options });
    options[field.field] = readCommandOptionValue(flags, field.option, fallback);
  }
  return options;
}

function resolveOptionFallback(fallback, context) {
  return typeof fallback === 'function' ? fallback(context) : fallback;
}

function fieldsForResolver(resolver) {
  return Object.freeze(COMMAND_OPTIONS.flatMap((option) => (
    option.resolve
      .filter((field) => field.resolver === resolver)
      .map((field) => Object.freeze({
        option: option.name,
        field: field.field,
        fallback: field.fallback,
        group: field.group,
      }))
  )));
}

function fieldsForGroup(fields, group) {
  return Object.freeze(fields.filter((field) => field.group === group));
}

function normalizeCycleCommandOptions(options) {
  return {
    ...options,
    untilScore: normalizeUntilScore(options.untilScore),
  };
}

function normalizeUntilScore(value) {
  const score = String(value || '').trim().toUpperCase();
  if (!score) return '';
  if (!SCORE_ORDER.includes(score)) {
    throw new UsageError(`--until must be one of ${SCORE_ORDER.join(', ')}`);
  }
  return score;
}
