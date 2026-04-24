import { readCommandOptionValue } from './command-options.js';
import {
  COMMAND_OPTIONS,
  OPTION_RESOLVER,
  OPTION_RESOLVER_FIELD_GROUP,
} from './command-option-schema.js';
import { UsageError } from './errors.js';
import { SCORE_ORDER } from './summary-contract.js';

const {
  CYCLE,
  ROOM,
} = OPTION_RESOLVER;

const {
  SHARED_WORKFLOW,
  CYCLE_COMMAND,
  FANOUT_MODE,
  ROOM_COMMAND,
} = OPTION_RESOLVER_FIELD_GROUP;

const CYCLE_OPTION_FIELDS = fieldsForResolver(CYCLE);
const ROOM_OPTION_FIELDS = fieldsForResolver(ROOM);

const CYCLE_SHARED_WORKFLOW_OPTION_FIELDS = fieldsForGroup(CYCLE_OPTION_FIELDS, SHARED_WORKFLOW);
const ROOM_SHARED_WORKFLOW_OPTION_FIELDS = fieldsForGroup(ROOM_OPTION_FIELDS, SHARED_WORKFLOW);
const CYCLE_COMMAND_OPTION_FIELDS = fieldsForGroup(CYCLE_OPTION_FIELDS, CYCLE_COMMAND);
const ROOM_COMMAND_OPTION_FIELDS = fieldsForGroup(ROOM_OPTION_FIELDS, ROOM_COMMAND);
const CYCLE_FANOUT_MODE_OPTION_FIELDS = fieldsForGroup(CYCLE_OPTION_FIELDS, FANOUT_MODE);
const ROOM_FANOUT_MODE_OPTION_FIELDS = fieldsForGroup(ROOM_OPTION_FIELDS, FANOUT_MODE);

export function projectCycleCommandOptions(options) {
  return projectOptionFields(options, CYCLE_OPTION_FIELDS);
}

function resolveSharedWorkflowOptions(flags) {
  return resolveOptionFields(flags, CYCLE_SHARED_WORKFLOW_OPTION_FIELDS);
}

function resolveFanoutMode(flags, { defaultParallel = false, allowSerial = true } = {}) {
  const fields = allowSerial ? CYCLE_FANOUT_MODE_OPTION_FIELDS : ROOM_FANOUT_MODE_OPTION_FIELDS;
  const { serial = false, parallel = false } = resolveOptionFields(flags, fields);
  return {
    serial,
    parallel: !serial && (parallel || Boolean(defaultParallel)),
  };
}

export function resolveCycleCommandOptions(flags) {
  const cycleOptions = resolveOptionFields(flags, CYCLE_COMMAND_OPTION_FIELDS);
  const mode = resolveFanoutMode(flags, {
    defaultParallel: true,
    allowSerial: true,
  });

  return normalizeCycleCommandOptions({
    ...resolveSharedWorkflowOptions(flags),
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

function projectOptionFields(options, fields) {
  const source = options && typeof options === 'object' ? options : {};
  return Object.fromEntries(fieldNames(fields).map((field) => [field, source[field]]));
}

function fieldNames(fields) {
  return [...new Set(fields.map((field) => field.field))];
}
