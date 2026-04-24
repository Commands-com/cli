import {
  COMMAND_NAME,
  COMMAND_REGISTRY,
  COMMON_OPTION_SCOPE,
} from './command-registry.js';
import { DEFAULT_TIMEOUT_MS } from './provider-limits.js';

const DEFAULT_MAX_IMPLEMENTERS = 15;
export const MAX_IMPLEMENTERS = 32;

const COMMAND_OPTION_DEFAULTS = Object.freeze({
  maxCycles: Object.freeze({
    report: 1,
    fix: 3,
    until: 30,
  }),
  maxImplementers: DEFAULT_MAX_IMPLEMENTERS,
  providerRetries: 1,
  stallCycles: 5,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

export const OPTION_READER_NAMES = Object.freeze([
  'stringOption',
  'booleanOption',
  'positiveIntegerOption',
  'nonNegativeIntegerOption',
  'listOption',
]);

const OPTION_READERS = new Set(OPTION_READER_NAMES);

export const OPTION_RESOLVER = Object.freeze({
  CYCLE: 'cycle',
  ROOM: 'room',
});

export const OPTION_RESOLVER_FIELD_GROUP = Object.freeze({
  SHARED_WORKFLOW: 'sharedWorkflow',
  CYCLE_COMMAND: 'cycleCommand',
  FANOUT_MODE: 'fanoutMode',
  ROOM_COMMAND: 'roomCommand',
});

const {
  CYCLE: CYCLE_RESOLVER,
  ROOM: ROOM_RESOLVER,
} = OPTION_RESOLVER;

const {
  SHARED_WORKFLOW,
  CYCLE_COMMAND,
  FANOUT_MODE,
  ROOM_COMMAND: ROOM_COMMAND_GROUP,
} = OPTION_RESOLVER_FIELD_GROUP;

const OPTION_RESOLVERS = new Set(Object.values(OPTION_RESOLVER));
const OPTION_RESOLVER_GROUPS = new Set(Object.values(OPTION_RESOLVER_FIELD_GROUP));

function optionReader(option) {
  return option.value ? 'stringOption' : 'booleanOption';
}

function resolverField(resolver, field, fallback, group) {
  return Object.freeze({ resolver, field, fallback, group });
}

function cycleField(field, fallback, group) {
  return resolverField(CYCLE_RESOLVER, field, fallback, group);
}

function roomField(field, fallback, group) {
  return resolverField(ROOM_RESOLVER, field, fallback, group);
}

function cycleFixFallback({ options }) {
  return Boolean(options.untilScore);
}

function cycleMaxCyclesFallback({ options }) {
  if (options.untilScore) return COMMAND_OPTION_DEFAULTS.maxCycles.until;
  return options.fix
    ? COMMAND_OPTION_DEFAULTS.maxCycles.fix
    : COMMAND_OPTION_DEFAULTS.maxCycles.report;
}

function normalizeOptionResolver(optionName, resolver) {
  if (!resolver || typeof resolver !== 'object') {
    throw new Error(`malformed option resolver for --${optionName}: expected object`);
  }
  const target = typeof resolver.resolver === 'string' ? resolver.resolver.trim() : '';
  const field = typeof resolver.field === 'string' ? resolver.field.trim() : '';
  const group = typeof resolver.group === 'string' ? resolver.group.trim() : '';

  if (!OPTION_RESOLVERS.has(target)) {
    throw new Error(`unknown option resolver for --${optionName}: ${target}`);
  }
  if (!field) {
    throw new Error(`malformed option resolver for --${optionName}: expected field`);
  }
  if (!OPTION_RESOLVER_GROUPS.has(group)) {
    throw new Error(`unknown option resolver group for --${optionName}: ${group}`);
  }

  return Object.freeze({
    resolver: target,
    field,
    fallback: resolver.fallback,
    group,
  });
}

function normalizeOptionResolvers(option) {
  const resolvers = option.resolve === undefined
    ? []
    : Array.isArray(option.resolve) ? option.resolve : [option.resolve];
  return Object.freeze(resolvers.map((resolver) => normalizeOptionResolver(option.name, resolver)));
}

function defineOption(option) {
  const readWith = option.readWith || optionReader(option);
  if (!OPTION_READERS.has(readWith)) {
    throw new Error(`unknown option reader for --${option.name}: ${readWith}`);
  }

  return Object.freeze({
    ...option,
    readWith,
    aliases: Object.freeze(option.aliases || []),
    scopes: Object.freeze(option.scopes || []),
    resumeOverrideFields: Object.freeze(Array.isArray(option.resumeOverrideFields) ? option.resumeOverrideFields : []),
    resolve: normalizeOptionResolvers(option),
  });
}

export const COMMON = COMMON_OPTION_SCOPE;
const REVIEW = COMMAND_NAME.REVIEW;
const QUALITY = COMMAND_NAME.QUALITY;
const ROOM = COMMAND_NAME.ROOM;
const ROOMS = COMMAND_NAME.ROOMS;
const DOCTOR = COMMAND_NAME.DOCTOR;
const INIT = COMMAND_NAME.INIT;
const RUNS = COMMAND_NAME.RUNS;

const CYCLE_COMMANDS = Object.freeze([REVIEW, QUALITY]);
const PROVIDER_FANOUT_COMMANDS = Object.freeze([REVIEW, QUALITY, DOCTOR, INIT]);
const PROVIDER_RESUME_FIELDS = Object.freeze(['providers', 'providerIds', 'primaryProvider']);

export const HELP_COMMANDS = Object.freeze(
  COMMAND_REGISTRY
    .filter((command) => command.help)
    .flatMap((command) => [command.name, ...command.aliases]),
);

export const OPTION_SCOPES = Object.freeze([
  Object.freeze({ name: COMMON, title: 'Common options' }),
  Object.freeze({ name: REVIEW, title: 'Review options' }),
  Object.freeze({ name: QUALITY, title: 'Quality options' }),
  Object.freeze({ name: ROOM, title: 'Room options' }),
  Object.freeze({ name: DOCTOR, title: 'Doctor options' }),
  Object.freeze({ name: INIT, title: 'Init options' }),
  Object.freeze({ name: RUNS, title: 'Runs options' }),
]);

export const SCOPED_OPTION_COMMANDS = Object.freeze(
  COMMAND_REGISTRY
    .filter((command) => command.optionScope)
    .map((command) => command.name),
);

export const COMMAND_OPTIONS = Object.freeze([
  {
    name: 'cwd',
    value: '<path>',
    description: 'Run as if invoked from <path> (default: current dir)',
    scopes: [COMMON],
  },
  {
    name: 'providers',
    value: '<all|codex,claude,gemini|mock>',
    description: 'Provider set: all, codex,claude,gemini, or mock',
    scopes: PROVIDER_FANOUT_COMMANDS,
    resumeOverrideFields: PROVIDER_RESUME_FIELDS,
  },
  {
    name: 'provider',
    value: '<auto|codex|claude|gemini|mock>',
    description: 'Single-provider override',
    scopes: [REVIEW, QUALITY, ROOM, DOCTOR, INIT],
    resumeOverrideFields: PROVIDER_RESUME_FIELDS,
  },
  {
    name: 'model',
    value: '<name>',
    description: 'Provider model name',
    scopes: [REVIEW, QUALITY, ROOM, DOCTOR, INIT],
    resumeOverrideFields: Object.freeze(['model']),
  },
  {
    name: 'changed',
    description: 'Scope prompts to the current git diff',
    scopes: [REVIEW, QUALITY, ROOM],
    resolve: [
      cycleField('changed', false, SHARED_WORKFLOW),
      roomField('changed', false, SHARED_WORKFLOW),
    ],
  },
  {
    name: 'until',
    value: '<score>',
    description: `Keep fixing review/quality until score A-F is reached (default cap: ${COMMAND_OPTION_DEFAULTS.maxCycles.until} cycles)`,
    scopes: CYCLE_COMMANDS,
    resumeOverrideFields: Object.freeze(['untilScore', 'fix', 'maxCycles']),
    resolve: cycleField('untilScore', '', CYCLE_COMMAND),
  },
  {
    name: 'fix',
    description: 'Allow implementation passes to edit files',
    scopes: CYCLE_COMMANDS,
    resumeOverrideFields: Object.freeze(['fix', 'maxCycles']),
    resolve: cycleField('fix', cycleFixFallback, CYCLE_COMMAND),
  },
  {
    name: 'resume',
    value: '<run-id|path|latest>',
    description: 'Resume a previous review/quality run',
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('resume', '', CYCLE_COMMAND),
  },
  {
    name: 'worktree',
    description: 'Run edits in an isolated git worktree',
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('worktree', false, CYCLE_COMMAND),
  },
  {
    name: 'base-ref',
    value: '<ref>',
    description: 'Base ref for --worktree creation (default: HEAD)',
    scopes: CYCLE_COMMANDS,
  },
  {
    name: 'allow-dirty',
    description: 'Permit --fix on a dirty working tree',
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('allowDirty', false, CYCLE_COMMAND),
  },
  {
    name: 'keep-worktree',
    description: 'Keep isolated worktrees after the run',
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('keepWorktree', false, CYCLE_COMMAND),
  },
  {
    name: 'max-cycles',
    value: '<n>',
    readWith: 'positiveIntegerOption',
    description: `Cap review/quality fix loops (default: 1 report, 3 fix, ${COMMAND_OPTION_DEFAULTS.maxCycles.until} until)`,
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('maxCycles', cycleMaxCyclesFallback, CYCLE_COMMAND),
  },
  {
    name: 'max-implementers',
    value: '<n>',
    readWith: 'positiveIntegerOption',
    description: `Cap parallel implementation CLIs (default: ${DEFAULT_MAX_IMPLEMENTERS}, max: ${MAX_IMPLEMENTERS})`,
    scopes: CYCLE_COMMANDS,
    max: MAX_IMPLEMENTERS,
    resolve: cycleField(
      'maxImplementers',
      () => COMMAND_OPTION_DEFAULTS.maxImplementers,
      CYCLE_COMMAND,
    ),
  },
  {
    name: 'stall-cycles',
    value: '<n>',
    readWith: 'nonNegativeIntegerOption',
    description: `Stop fix loops after unchanged progress repeats (default: ${COMMAND_OPTION_DEFAULTS.stallCycles}, 0 disables)`,
    scopes: CYCLE_COMMANDS,
    resolve: cycleField(
      'stallCycles',
      () => COMMAND_OPTION_DEFAULTS.stallCycles,
      CYCLE_COMMAND,
    ),
  },
  {
    name: 'reviewers',
    value: '<roles>',
    readWith: 'listOption',
    description: 'Comma-separated review roles',
    scopes: [REVIEW],
  },
  {
    name: 'area',
    value: '<areas>',
    readWith: 'listOption',
    description: 'Comma-separated quality areas',
    scopes: [QUALITY],
  },
  {
    name: 'participants',
    value: '<n>',
    readWith: 'positiveIntegerOption',
    description: 'Limit room participants',
    scopes: [ROOM],
    resolve: roomField(
      'requestedParticipantLimit',
      ({ participantFallback }) => participantFallback,
      ROOM_COMMAND_GROUP,
    ),
  },
  {
    name: 'parallel',
    description: 'Run fan-out in parallel (default for review/quality)',
    scopes: [REVIEW, QUALITY, ROOM],
    resumeOverrideFields: Object.freeze(['parallel', 'serial']),
    resolve: [
      cycleField('parallel', false, FANOUT_MODE),
      roomField('parallel', false, FANOUT_MODE),
    ],
  },
  {
    name: 'serial',
    description: 'Run fan-out and implementation tasks one at a time',
    scopes: CYCLE_COMMANDS,
    resumeOverrideFields: Object.freeze(['serial', 'parallel']),
    resolve: cycleField('serial', false, FANOUT_MODE),
  },
  {
    name: 'no-synthesis',
    description: 'Skip the final room synthesis pass',
    scopes: [ROOM],
    resolve: roomField('noSynthesis', false, ROOM_COMMAND_GROUP),
  },
  {
    name: 'ping',
    description: 'Send a tiny response test to selected providers',
    scopes: [DOCTOR],
  },
  {
    name: 'retries',
    value: '<n>',
    readWith: 'nonNegativeIntegerOption',
    description: 'Provider-call retries for transient failures (default: 1)',
    scopes: [...CYCLE_COMMANDS, ROOM],
    resolve: [
      cycleField(
        'providerRetries',
        () => COMMAND_OPTION_DEFAULTS.providerRetries,
        SHARED_WORKFLOW,
      ),
      roomField(
        'providerRetries',
        () => COMMAND_OPTION_DEFAULTS.providerRetries,
        SHARED_WORKFLOW,
      ),
    ],
  },
  {
    name: 'test',
    value: '<cmd>',
    description: 'Shell command to run after implementation',
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('testCommand', '', CYCLE_COMMAND),
  },
  {
    name: 'timeout-ms',
    value: '<ms>',
    readWith: 'positiveIntegerOption',
    description: 'Per-provider-call timeout',
    scopes: [REVIEW, QUALITY, ROOM, DOCTOR],
    resolve: [
      cycleField(
        'timeoutMs',
        () => COMMAND_OPTION_DEFAULTS.timeoutMs,
        SHARED_WORKFLOW,
      ),
      roomField(
        'timeoutMs',
        () => COMMAND_OPTION_DEFAULTS.timeoutMs,
        SHARED_WORKFLOW,
      ),
    ],
  },
  {
    name: 'limit',
    value: '<n>',
    readWith: 'positiveIntegerOption',
    description: 'Runs list limit (default: 20)',
    scopes: [RUNS],
  },
  {
    name: 'json',
    description: 'Write machine-readable output on stdout',
    scopes: [COMMON],
    resolve: cycleField('json', false, CYCLE_COMMAND),
  },
  {
    name: 'fail-on-issues',
    description: 'Exit non-zero when final issues or test failures remain',
    scopes: CYCLE_COMMANDS,
    resolve: cycleField('failOnIssues', false, CYCLE_COMMAND),
  },
].map(defineOption));

export const VALUE_FLAG_NAMES = Object.freeze(
  [...new Set(COMMAND_OPTIONS.flatMap((option) => (
    option.value ? [option.name, ...option.aliases] : []
  )))],
);

export const ALL_FLAG_NAMES = Object.freeze(
  [...new Set(COMMAND_OPTIONS.flatMap((option) => [option.name, ...option.aliases]))],
);
