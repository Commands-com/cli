import { commandResult } from './command-result.js';

export const COMMON_OPTION_SCOPE = 'common';

export const COMMAND_NAME = Object.freeze({
  REVIEW: 'review',
  QUALITY: 'quality',
  ROOM: 'room',
  ROOMS: 'rooms',
  DOCTOR: 'doctor',
  INIT: 'init',
  RUNS: 'runs',
  HELP: 'help',
});

const COMMAND_HELP_USAGE_WIDTH = 22;

function defineCommand(command) {
  if (typeof command.run !== 'function') {
    throw new Error(`missing command runner for ${command.name}`);
  }
  return Object.freeze({
    ...command,
    aliases: Object.freeze(command.aliases || []),
  });
}

function lazyCommand(modulePath, exportName) {
  return async function runLazyCommand(parsed, context) {
    const commandModule = await import(modulePath);
    return commandModule[exportName](parsed, context);
  };
}

async function runHelpCommand(_parsed, context) {
  context.logger.line(context.helpText);
  return commandResult();
}

export const COMMAND_REGISTRY = Object.freeze([
  defineCommand({
    name: COMMAND_NAME.REVIEW,
    helpUsage: 'review <objective>',
    helpDescription: 'Fan out review across providers, synthesize, and optionally fix',
    optionScope: COMMAND_NAME.REVIEW,
    loggerChild: 'review',
    run: lazyCommand('./review.js', 'runReviewCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.QUALITY,
    helpUsage: 'quality',
    helpDescription: 'Run a code-quality audit over the current repo',
    optionScope: COMMAND_NAME.QUALITY,
    loggerChild: 'quality',
    run: lazyCommand('./quality.js', 'runQualityCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.ROOM,
    helpUsage: 'room <type> <objective>',
    helpDescription: 'Run a built-in multi-perspective room',
    optionScope: COMMAND_NAME.ROOM,
    loggerChild: 'room',
    run: lazyCommand('./rooms.js', 'runRoomCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.ROOMS,
    helpUsage: 'rooms',
    helpDescription: 'List built-in rooms',
    commonOnly: true,
    run: lazyCommand('./rooms.js', 'runRoomsCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.DOCTOR,
    helpUsage: 'doctor',
    helpDescription: 'Check available provider CLIs; add --ping to test responses',
    optionScope: COMMAND_NAME.DOCTOR,
    run: lazyCommand('./doctor.js', 'runDoctorCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.INIT,
    helpUsage: 'init',
    helpDescription: 'Write .commands-com/config.json',
    optionScope: COMMAND_NAME.INIT,
    run: lazyCommand('./init.js', 'runInitCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.RUNS,
    helpUsage: 'runs',
    helpDescription: 'List or inspect prior local runs',
    optionScope: COMMAND_NAME.RUNS,
    run: lazyCommand('./runs.js', 'runRunsCommand'),
  }),
  defineCommand({
    name: COMMAND_NAME.HELP,
    aliases: ['--help', '-h'],
    helpUsage: 'help',
    helpDescription: 'Show this help',
    help: true,
    run: runHelpCommand,
  }),
]);

const COMMAND_BY_NAME = new Map();
for (const command of COMMAND_REGISTRY) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) COMMAND_BY_NAME.set(alias, command);
}

const REGISTERED_COMMAND_NAMES = Object.freeze(
  COMMAND_REGISTRY.map((command) => command.name),
);

export const REGISTERED_DISPATCH_NAMES = Object.freeze(
  COMMAND_REGISTRY.flatMap((command) => [command.name, ...command.aliases]),
);

export function commandForName(name) {
  return COMMAND_BY_NAME.get(name) || null;
}

export function formatCommandHelpRows(commands = COMMAND_REGISTRY) {
  return commands
    .map((command) => (
      `  ${command.helpUsage.padEnd(COMMAND_HELP_USAGE_WIDTH)} ${command.helpDescription}`
    ))
    .join('\n');
}
