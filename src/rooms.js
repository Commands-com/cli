import { markdownArtifactPath } from './artifact-paths.js';
import { commandResult, completeCommandRun } from './command-result.js';
import { resolveRoomCommandOptions } from './command-options.js';
import { resolveRuntimeOptions } from './config.js';
import {
  createRoomSynthesisArtifacts,
  runProviderSynthesisWithFallback,
} from './cycle-synthesis.js';
import {
  createAssessmentFanoutItems,
  runAssessmentProviderFanout,
} from './cycle-fanout.js';
import { UsageError } from './errors.js';
import { createCommandLogger } from './logger.js';
import { compactPrompt } from './prompt-intent.js';
import { resolveProvider } from './providers.js';
import { formatRepoContext } from './repo-context-prompt.js';
import { prepareRun } from './run-store.js';
import { formatRoomReport } from './room-report.js';
import { BUILT_IN_ROOMS } from './rooms/catalog.js';

const ROOM_BY_ID = new Map();
for (const room of BUILT_IN_ROOMS) {
  ROOM_BY_ID.set(room.id, room);
  for (const alias of room.aliases || []) ROOM_BY_ID.set(alias, room);
}

function listBuiltInRooms() {
  return BUILT_IN_ROOMS.map((room) => ({
    id: room.id,
    title: room.title,
    description: room.description,
    aliases: room.aliases || [],
    participantCount: room.participants.length,
  }));
}

function resolveRoom(id) {
  const key = String(id || '').trim().toLowerCase();
  return ROOM_BY_ID.get(key) || null;
}

function buildRoomParticipantPrompt({ room, participant, objective, context, priorOutputs = '' }) {
  const { role, guidance } = participant;
  return compactPrompt([
    `You are the ${role} in the Commands.com ${room.title}.`,
    guidance,
    '',
    `Room objective: ${objective}`,
    '',
    'Repository context:',
    formatRepoContext(context),
    priorOutputs ? ['', 'Prior room outputs to consider:', priorOutputs].join('\n') : '',
    '',
    'Return concise Markdown with:',
    '- Key findings or recommendations',
    '- Concrete next steps',
    '- Risks, assumptions, or open questions',
    '',
    'Be direct and practical. Do not invent files or behavior that are not supported by the context.',
  ], {
    kind: 'room-participant',
    roomId: room.id,
    role,
  });
}

function buildRoomSynthesisPrompt({ room, objective, outputs }) {
  return compactPrompt([
    `You are synthesizing the Commands.com ${room.title}.`,
    `Objective: ${objective}`,
    '',
    'Participant outputs:',
    outputs.map((output) => `## ${output.provider} / ${output.role}\n\n${output.text}`).join('\n\n'),
    '',
    'Write a final concise Markdown report with prioritized recommendations and next steps.',
  ], {
    kind: 'room-synthesis',
    roomId: room.id,
    participantCount: outputs.length,
  });
}

/**
 * @typedef {Object} ParsedCommand
 * @property {string} [command]
 * @property {string[]} positionals
 * @property {Map<string, string|boolean>|Object<string, string|boolean|Array<string>>} flags
 * @typedef {{ jsonMode?: boolean, line?: (message: string) => void, info?: (message: string) => void, json?: (payload: *) => void, error?: (message: string) => void }} RoomLogger
 * @typedef {{ cwd?: string, logger?: RoomLogger, helpText?: string }} RoomCommandContext
 */

/**
 * @param {ParsedCommand} parsed
 * @param {RoomCommandContext} [context]
 */
export async function runRoomsCommand(parsed, { logger = createCommandLogger(parsed) } = {}) {
  const subcommand = parsed.positionals[0] || 'list';
  if (subcommand !== 'list') {
    throw new UsageError(`unknown rooms subcommand: ${subcommand}`);
  }
  const rooms = listBuiltInRooms();
  if (logger.jsonMode) {
    logger.json({ type: 'rooms.list', rooms });
    return commandResult();
  }
  for (const room of rooms) {
    const aliases = room.aliases.length ? ` (${room.aliases.join(', ')})` : '';
    logger.line(`${room.id}${aliases} - ${room.description}`);
  }
  return commandResult();
}

/**
 * @param {ParsedCommand} parsed
 * @param {RoomCommandContext} [context]
 */
export async function runRoomCommand(parsed, { cwd, logger = createCommandLogger(parsed, { kind: 'room' }) } = {}) {
  const roomRun = await resolveRoomRunOptions(parsed, { cwd, logger });
  const run = await setupRoomRun({ cwd, logger, roomRun });
  const outputs = await runRoomParticipantFanout({ logger, roomRun, run });
  const synthesisResult = await runRoomSynthesis({ logger, roomRun, run, outputs });
  const reportPath = await writeRoomReport({ roomRun, run, outputs, synthesisResult });
  return completeRoomRun({ logger, roomRun, run, outputs, synthesisResult, reportPath });
}

async function resolveRoomRunOptions(parsed, { cwd, logger }) {
  const roomId = parsed.positionals.shift();
  if (!roomId) {
    throw new UsageError('room type is required; run `commands-com rooms list`');
  }
  const room = resolveRoom(roomId);
  if (!room) {
    throw new UsageError(`unknown room '${roomId}'; run \`commands-com rooms list\``);
  }

  const objective = parsed.positionals.join(' ').trim() || `Run the ${room.title}.`;
  const runtimeOptions = await resolveRuntimeOptions(cwd, parsed.flags);
  const provider = await resolveProvider(runtimeOptions.provider);
  const model = runtimeOptions.model;
  const {
    changed,
    parallel,
    synthesize,
    timeoutMs,
    providerRetries,
    participantLimit,
  } = /** @type {{
    changed: boolean,
    parallel: boolean,
    synthesize: boolean,
    timeoutMs: number,
    providerRetries: number,
    participantLimit: number,
    json: boolean,
  }} */ (resolveRoomCommandOptions(parsed.flags, {
    participantCount: room.participants.length,
    json: logger.jsonMode,
  }));
  const participants = room.participants.slice(0, participantLimit);

  return {
    room,
    objective,
    provider,
    model,
    participants,
    changed,
    parallel,
    synthesize,
    timeoutMs,
    providerRetries,
  };
}

async function setupRoomRun({ cwd, logger, roomRun }) {
  const {
    room,
    objective,
    provider,
    model,
    participants,
    changed,
    parallel,
    synthesize,
    timeoutMs,
    providerRetries,
  } = roomRun;
  const { store, context } = await prepareRun(cwd, {
    kind: `room-${room.id}`,
    label: objective,
    changed,
    metadata: {
      kind: 'room',
      roomId: room.id,
      title: room.title,
      objective,
      provider: provider.id,
      model,
      changed,
      parallel,
      synthesize,
      providerRetries,
      timeoutMs,
      participants: participants.map((participant) => participant.role),
    },
  });

  logger.info(room.title);
  logger.info(`run: ${store.runId}`);
  logger.info(`provider: ${provider.id}`);
  logger.info(`output: ${store.dir}`);

  return { store, context };
}

async function runRoomParticipantFanout({ logger, roomRun, run }) {
  const {
    room,
    objective,
    provider,
    model,
    participants,
    parallel,
    timeoutMs,
    providerRetries,
  } = roomRun;

  const { outputs } = await runAssessmentProviderFanout({
    context: run.context,
    store: run.store,
    logger,
    fanoutParallel: parallel,
    options: {
      providers: [provider],
      model,
      timeoutMs,
      providerRetries,
    },
  }, {
    items: createAssessmentFanoutItems(participants, {
      getLabel: ({ value: participant }) => participant.role,
      pathFallback: 'participant',
    }),
    label: 'room participant fan-out',
    adapter: {
      artifactRoot: 'participants',
      buildPrompt: ({ item: participant, context: fanoutContext }) => (
        buildRoomParticipantPrompt({ room, participant, objective, context: fanoutContext })
      ),
      buildOutput: ({ provider: outputProvider, item: participant, text }) => ({
        provider: outputProvider.id,
        role: participant.role,
        text,
      }),
      logOutput: ({ item: participant }) => {
        logger.info(`${participant.role}: complete`);
      },
    },
  });
  return outputs;
}

async function writeRoomReport({ roomRun, run, outputs, synthesisResult }) {
  const {
    room,
    objective,
    provider,
    model,
  } = roomRun;
  const report = formatRoomReport({
    room,
    objective,
    runId: run.store.runId,
    providerId: provider.id,
    model,
    repoRoot: run.context.repoRoot,
    outputs,
    synthesis: synthesisResult.synthesis,
    synthesisError: synthesisResult.synthesisError,
  });

  return run.store.write(markdownArtifactPath('room'), report);
}

function completeRoomRun({ logger, roomRun, run, outputs, synthesisResult, reportPath }) {
  const { store } = run;

  return completeCommandRun({
    logger,
    payload: {
      type: 'room.completed',
      runId: store.runId,
      roomId: roomRun.room.id,
      reportPath,
      outputs,
      synthesis: synthesisResult.synthesis,
      synthesisError: synthesisResult.synthesisError,
    },
    failOnIssues: false,
    hasFinalIssues: false,
    onText: (textLogger) => textLogger.info(`report: ${reportPath}`),
  });
}

async function runRoomSynthesis({ logger, roomRun, run, outputs }) {
  const {
    room,
    objective,
    provider,
    model,
    synthesize,
    timeoutMs,
    providerRetries,
  } = roomRun;

  if (!synthesize || outputs.length <= 1) {
    return { synthesis: '', synthesisError: '' };
  }

  const synthesisPrompt = buildRoomSynthesisPrompt({ room, objective, outputs });
  const result = await runProviderSynthesisWithFallback({
    providerCall: {
      provider,
      model,
      timeoutMs,
      providerRetries,
      cwd: run.context.repoRoot,
    },
    artifacts: createRoomSynthesisArtifacts({ store: run.store, provider }),
    logging: {
      logger,
      complete: 'synthesis: complete',
    },
    prompt: synthesisPrompt,
    fallbackDescription: 'participant outputs',
  });
  return {
    synthesis: result.synthesisText,
    synthesisError: result.synthesisError,
  };
}
