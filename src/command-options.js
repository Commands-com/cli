import {
  ALL_FLAG_NAMES,
  COMMAND_OPTIONS,
  COMMON,
  HELP_COMMANDS,
  OPTION_SCOPES,
  SCOPED_OPTION_COMMANDS,
} from './command-option-schema.js';
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

export function stringOption(flags, name, fallback = '') {
  const value = normalizeFlags(flags).get(name);
  if (!isReadableOptionValue(value)) return fallback;
  return String(value);
}

function booleanOption(flags, name) {
  return normalizeFlags(flags).has(name);
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
  const source = stringOption(flags, name, '').trim();
  if (!source) return fallback;
  const items = source.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length ? items : fallback;
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

function flagNamesForScope(scopeName) {
  return optionsForScope(scopeName).flatMap((option) => [option.name, ...option.aliases]);
}

function optionForFlagName(flagName) {
  return COMMAND_OPTIONS.find((option) => (
    option.name === flagName || option.aliases.includes(flagName)
  )) || null;
}

const OPTION_READERS = Object.freeze({
  stringOption,
  booleanOption: (flags, name, fallback) => booleanOption(flags, name) || Boolean(fallback),
  positiveIntegerOption,
  nonNegativeIntegerOption,
  listOption,
});

export function readCommandOptionValue(flags, nameOrAlias, fallback) {
  const option = optionForFlagName(nameOrAlias);
  if (!option) {
    throw new Error(`unknown command option: --${nameOrAlias}`);
  }
  const reader = OPTION_READERS[option.readWith];
  const normalizedFlags = normalizeFlags(flags);
  const readName = firstReadableOptionName(normalizedFlags, option, nameOrAlias);
  return reader(normalizedFlags, readName, fallback, { max: option.max });
}

export function normalizeFlags(flags) {
  if (flags instanceof Map) return flags;
  return new Map(Object.entries(flags || {}));
}

function firstReadableOptionName(flags, option, preferredName) {
  const names = [...new Set([preferredName, option.name, ...option.aliases].filter(Boolean))];
  const fallback = names.find((name) => flags.has(name)) || names[0];
  if (!option.value) return fallback;
  return names.find((name) => isReadableOptionValue(flags.get(name))) || fallback;
}

function isReadableOptionValue(value) {
  return value !== undefined && value !== null && value !== true;
}

function isCommonOrHelpFlag(flagName) {
  const option = optionForFlagName(flagName);
  return HELP_FLAGS.has(flagName) || Boolean(option?.scopes.includes(COMMON));
}

function allowedFlagNamesForCommand(command) {
  const allowed = new Set(flagNamesForScope(COMMON));
  if (HELP_COMMAND_SET.has(command)) {
    for (const flag of HELP_FLAG_NAMES) allowed.add(flag);
  }
  if (SCOPED_OPTION_COMMAND_SET.has(command)) {
    for (const flag of flagNamesForScope(command)) allowed.add(flag);
  }
  return allowed;
}

export function validateFlagsForCommand(command, flags) {
  const normalizedFlags = normalizeFlags(flags);
  const flagNames = [...normalizedFlags.keys()];
  const isKnown = KNOWN_COMMAND_SET.has(command);
  const allowed = allowedFlagNamesForCommand(command);

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
    const option = optionForFlagName(flag);
    if (
      option
      && option.readWith === 'stringOption'
      && !option.allowMissingValue
      && normalizedFlags.get(flag) === true
    ) {
      throw new UsageError(`--${flag} requires a value`);
    }
  }
}

export function formatScopedOptionsHelp(scopes = OPTION_SCOPES) {
  return scopes.map((scope) => {
    const options = optionsForScope(scope.name);
    if (!options.length) return `${scope.title}:\n`;
    const rows = options.map((option) => [
      `--${option.name}${option.value ? ` ${option.value}` : ''}`,
      option.description,
    ]);
    const width = Math.max(...rows.map(([usage]) => usage.length));
    const body = rows
      .map(([usage, description]) => `  ${usage.padEnd(width)} ${description}`)
      .join('\n');
    return `${scope.title}:\n${body}`;
  }).join('\n\n');
}

const CYCLE_SHARED_WORKFLOW_OPTION_FIELDS = fieldsFor('cycle', 'sharedWorkflow');
const ROOM_SHARED_WORKFLOW_OPTION_FIELDS = fieldsFor('room', 'sharedWorkflow');
const CYCLE_COMMAND_OPTION_FIELDS = fieldsFor('cycle', 'cycleCommand');
const ROOM_COMMAND_OPTION_FIELDS = fieldsFor('room', 'roomCommand');
const CYCLE_FANOUT_MODE_OPTION_FIELDS = fieldsFor('cycle', 'fanoutMode');
const ROOM_FANOUT_MODE_OPTION_FIELDS = fieldsFor('room', 'fanoutMode');

const CYCLE_FIELD_NAMES = Object.freeze([...new Set(
  COMMAND_OPTIONS.flatMap((option) => option.resolve
    .filter((entry) => entry.resolver === 'cycle')
    .map((entry) => entry.field)),
)]);

// Fields a stored cycle run is allowed to carry into a resume merge: the cycle
// resolver's own fields plus any field that any option declares as a
// resume-override target (covers `model` and provider fields not bound to a
// cycle resolver). Anything else is dropped by `filterKnownStoredCycleOptions`
// with a one-line warn so stale stored runs don't silently leak through.
const KNOWN_STORED_CYCLE_FIELDS = Object.freeze(new Set([
  ...CYCLE_FIELD_NAMES,
  ...COMMAND_OPTIONS.flatMap((option) => option.resumeOverrideFields ?? []),
]));

/** @returns {Record<string, any>} */
export function resolveCycleCommandOptions(flags) {
  const cycleOptions = resolveOptionFields(flags, CYCLE_COMMAND_OPTION_FIELDS);
  const mode = resolveFanoutMode(flags, CYCLE_FANOUT_MODE_OPTION_FIELDS, { defaultParallel: true });

  return {
    ...resolveOptionFields(flags, CYCLE_SHARED_WORKFLOW_OPTION_FIELDS),
    ...cycleOptions,
    ...mode,
    untilScore: normalizeUntilScore(cycleOptions.untilScore),
  };
}

/** @returns {Record<string, any>} */
export function resolveRoomCommandOptions(flags, {
  participantCount = 0,
  json = false,
} = {}) {
  const participantFallback = Math.max(0, participantCount);
  const roomOptions = resolveOptionFields(flags, ROOM_COMMAND_OPTION_FIELDS, { participantFallback });
  const participantLimit = Math.min(roomOptions.requestedParticipantLimit, participantFallback);
  const mode = resolveFanoutMode(flags, ROOM_FANOUT_MODE_OPTION_FIELDS, { defaultParallel: false });

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

function resolveFanoutMode(flags, fields, { defaultParallel }) {
  const { serial = false, parallel = false } = resolveOptionFields(flags, fields);
  return {
    serial,
    parallel: !serial && (parallel || Boolean(defaultParallel)),
  };
}

function resolveOptionFields(flags, fields, context = {}) {
  const options = {};
  for (const field of fields) {
    const fallback = typeof field.fallback === 'function'
      ? field.fallback({ ...context, options })
      : field.fallback;
    options[field.field] = readCommandOptionValue(flags, field.option, fallback);
  }
  return options;
}

function fieldsFor(resolver, group) {
  return Object.freeze(COMMAND_OPTIONS.flatMap((option) => option.resolve
    .filter((entry) => entry.resolver === resolver && entry.group === group)
    .map((entry) => Object.freeze({
      option: option.name,
      field: entry.field,
      fallback: entry.fallback,
    }))));
}

function normalizeUntilScore(value) {
  const score = String(value || '').trim().toUpperCase();
  if (!score) return '';
  if (!SCORE_ORDER.includes(score)) {
    throw new UsageError(`--until must be one of ${SCORE_ORDER.join(', ')}`);
  }
  return score;
}
