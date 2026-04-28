/** @typedef {'cycle'|'room'} OptionResolverKind */
/** @typedef {'sharedWorkflow'|'cycleCommand'|'fanoutMode'|'roomCommand'} OptionResolverGroup */
/** @typedef {'stringOption'|'booleanOption'|'positiveIntegerOption'|'nonNegativeIntegerOption'|'listOption'} OptionReader */
/** @typedef {{resolver: OptionResolverKind, field: string, fallback: string|boolean|number|((context: {options?: Record<string, any>, participantFallback?: any}) => any), group: OptionResolverGroup}} OptionResolver */

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

export const {
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

export function cycleField(field, fallback, group) {
  return resolverField(CYCLE_RESOLVER, field, fallback, group);
}

export function roomField(field, fallback, group) {
  return resolverField(ROOM_RESOLVER, field, fallback, group);
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

export function defineOption(option) {
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
