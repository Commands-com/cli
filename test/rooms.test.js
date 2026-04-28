import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runRoomCommand,
  runRoomsCommand,
} from '../src/rooms.js';
import { formatRoomReport } from '../src/room-report.js';
import { DEFAULT_TIMEOUT_MS } from '../src/provider-limits.js';
import {
  captureConsoleLogs,
  captureConsoleOutcome,
  readSingleWorkflowRun,
} from './support/workflow-fixtures.js';
import {
  flagMap,
  promptIntent,
  roomById,
  silentJsonLogger,
  withRoomRun,
} from './support/room-fixtures.js';

test('runRoomCommand writes participant prompt with objective, role, guidance, and repo context', async () => {
  await withRoomRun(async (cwd) => {
    const result = await runRoomCommand({
      positionals: ['security', 'audit this CLI'],
      flags: flagMap({ provider: 'mock', participants: '1', 'no-synthesis': 'true', json: 'true' }),
    }, { cwd, logger: silentJsonLogger() });
    const run = await readSingleWorkflowRun(cwd);
    const prompt = await fs.readFile(
      path.join(run.runDir, 'prompts', 'mock-threat-modeler.md'),
      'utf8',
    );

    assert.equal(result.failed, false);
    assert.match(prompt, /audit this CLI/);
    assert.match(prompt, /threat modeler/);
    assert.match(prompt, /Identify assets, attackers, trust boundaries, and abuse paths\./);
    assert.match(prompt, /Repository: .*commands-com-room-test-/);
    assert.deepEqual(promptIntent(prompt), {
      kind: 'room-participant',
      roomId: 'security',
      role: 'threat modeler',
    });
    assert.doesNotMatch(prompt, /undefined/);
  });
});

test('runRoomCommand writes synthesis prompt with providers, participant roles, and intent metadata', async () => {
  await withRoomRun(async (cwd) => {
    await runRoomCommand({
      positionals: ['security', 'audit this CLI'],
      flags: flagMap({ provider: 'mock', participants: '2', json: 'true' }),
    }, { cwd, logger: silentJsonLogger() });
    const run = await readSingleWorkflowRun(cwd);
    const prompt = await fs.readFile(path.join(run.runDir, 'prompts', 'synthesis-mock.md'), 'utf8');

    assert.match(prompt, /mock \/ threat modeler/);
    assert.match(prompt, /mock \/ application security reviewer/);
    assert.deepEqual(promptIntent(prompt), {
      kind: 'room-synthesis',
      roomId: 'security',
      participantCount: 2,
    });
  });
});

test('formatRoomReport formats metadata, synthesis, and participant sections', () => {
  const room = roomById('security');

  assert.equal(formatRoomReport({
    room,
    objective: 'audit this CLI',
    runId: 'run-room',
    providerId: 'mock',
    model: 'test-model',
    repoRoot: '/tmp/repo',
    synthesis: 'Prioritize dependency hygiene.',
    outputs: [
      { role: 'threat modeler', text: 'Threat output.' },
      { role: 'application security reviewer', text: 'Security output.' },
    ],
  }), [
    '# Security Room: audit this CLI',
    '',
    'Run: run-room',
    '',
    'Room: security',
    '',
    'Provider: mock (test-model)',
    '',
    'Repository: /tmp/repo',
    '',
    '## Synthesis',
    '',
    'Prioritize dependency hygiene.',
    '',
    '## threat modeler',
    '',
    'Threat output.',
    '',
    '## application security reviewer',
    '',
    'Security output.',
  ].join('\n'));
});

test('formatRoomReport omits empty synthesis output and preserves synthesis failures', () => {
  const room = roomById('security');

  assert.equal(formatRoomReport({
    room,
    objective: 'audit failed synthesis',
    runId: 'run-room',
    providerId: 'mock',
    repoRoot: '/tmp/repo',
    synthesisError: 'provider unavailable',
    outputs: [
      { role: 'threat modeler', text: 'Threat output.' },
    ],
  }), [
    '# Security Room: audit failed synthesis',
    '',
    'Run: run-room',
    '',
    'Room: security',
    '',
    'Provider: mock',
    '',
    'Repository: /tmp/repo',
    '',
    '## Synthesis',
    '',
    'Synthesis failed: provider unavailable',
    '',
    '## threat modeler',
    '',
    'Threat output.',
  ].join('\n'));
});

test('room commands honor injected loggers', async () => {
  await withRoomRun(async (cwd) => {
    const listLines = [];
    await runRoomsCommand({
      positionals: ['list'],
      flags: new Map(),
    }, {
      logger: {
        jsonMode: false,
        line(message) {
          listLines.push(message);
        },
      },
    });
    assert.ok(listLines.some((line) => line.startsWith('security (sec) - ')));

    const roomMessages = [];
    const consoleOutcome = await captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'injected logger room'],
      flags: flagMap({ provider: 'mock', participants: '1' }),
    }, {
      cwd,
      logger: {
        jsonMode: false,
        info(message) {
          roomMessages.push(message);
        },
      },
    }));

    assert.equal(consoleOutcome.error, null);
    assert.deepEqual(consoleOutcome.logs, []);
    assert.equal(roomMessages[0], 'Security Room');
    assert.equal(roomMessages[2], 'provider: mock');
    assert.equal(roomMessages[4], 'threat modeler: complete');
    assert.match(roomMessages[5], /room\.md$/);
  });
});

test('runRoomCommand completion trusts the logger jsonMode without overriding it', async () => {
  await withRoomRun(async (cwd) => {
    const messages = [];
    const jsonPayloads = [];
    const logger = {
      jsonMode: true,
      info(message) {
        messages.push(message);
        this.jsonMode = false;
      },
      json(payload) {
        jsonPayloads.push(payload);
      },
    };

    const result = await runRoomCommand({
      positionals: ['security', 'mutable logger mode'],
      flags: flagMap({ provider: 'mock', participants: '1' }),
    }, { cwd, logger });

    assert.deepEqual(result, { failed: false, exitCode: 0 });
    assert.equal(logger.jsonMode, false);
    assert.deepEqual(jsonPayloads, []);
    assert.ok(messages.some((message) => String(message).startsWith('report: ')));
  });
});

test('runRoomCommand keeps room artifacts, metadata, and terminal output stable', async () => {
  await withRoomRun(async (cwd) => {
    const logs = await captureConsoleLogs(() => runRoomCommand({
      positionals: ['security', 'audit this CLI'],
      flags: flagMap({ provider: 'mock', participants: '1' }),
    }, { cwd }));

    const { runIds, runId, runDir } = await readSingleWorkflowRun(cwd);
    assert.equal(runIds.length, 1);
    const reportPath = path.join(runDir, 'room.md');

    assert.deepEqual(logs, [
      '[room] Security Room',
      `[room] run: ${runId}`,
      '[room] provider: mock',
      `[room] output: ${runDir}`,
      '[room] threat modeler: complete',
      `[room] report: ${reportPath}`,
    ]);
    assert.match(runId, /^\d{8}-\d{6}-room-security-audit-this-cli-[0-9a-f]{6}$/);

    const metadata = JSON.parse(await fs.readFile(path.join(runDir, 'metadata.json'), 'utf8'));
    assert.deepEqual(Object.keys(metadata), [
      'kind', 'roomId', 'title', 'objective', 'provider', 'model', 'changed', 'parallel',
      'synthesize', 'providerRetries', 'timeoutMs', 'participants', 'createdAt',
    ]);
    const { createdAt, ...metadataWithoutCreatedAt } = metadata;
    assert.deepEqual(metadataWithoutCreatedAt, {
      kind: 'room', roomId: 'security', title: 'Security Room', objective: 'audit this CLI',
      provider: 'mock', model: '', changed: false, parallel: false, synthesize: true,
      providerRetries: 1, timeoutMs: DEFAULT_TIMEOUT_MS, participants: ['threat modeler'],
    });
    assert.equal(Number.isNaN(Date.parse(createdAt)), false);

    const realCwd = await fs.realpath(cwd);
    const contextText = await fs.readFile(path.join(runDir, 'context.md'), 'utf8');
    assert.match(contextText, new RegExp(`Repository: ${realCwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    const prompt = await fs.readFile(path.join(runDir, 'prompts', 'mock-threat-modeler.md'), 'utf8');
    assert.match(prompt, /Room objective: audit this CLI/);
    assert.match(await fs.readFile(path.join(runDir, 'participants', 'mock', 'threat-modeler.md'), 'utf8'), /Mock room participant/);
    assert.match(await fs.readFile(reportPath, 'utf8'), /# Security Room: audit this CLI/);
    await assert.rejects(fs.stat(path.join(runDir, 'prompts', 'threat-modeler.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'participants', 'threat-modeler.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'synthesis.md')), /ENOENT/);
  });
});

test('runRoomCommand keeps room phase boundaries observable in order', async () => {
  await withRoomRun(async (cwd) => {
    const logs = await captureConsoleLogs(() => runRoomCommand({
      positionals: ['security', 'phase boundary room'],
      flags: flagMap({ provider: 'mock', participants: '2' }),
    }, { cwd }));

    const { runId, runDir } = await readSingleWorkflowRun(cwd);
    const reportPath = path.join(runDir, 'room.md');

    assert.deepEqual(logs, [
      '[room] Security Room',
      `[room] run: ${runId}`,
      '[room] provider: mock',
      `[room] output: ${runDir}`,
      '[room] threat modeler: complete',
      '[room] application security reviewer: complete',
      '[room] synthesis (mock)',
      '[room] synthesis: complete',
      `[room] report: ${reportPath}`,
    ]);

    const metadata = JSON.parse(await fs.readFile(path.join(runDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.synthesize, true);
    assert.deepEqual(metadata.participants, ['threat modeler', 'application security reviewer']);

    const report = await fs.readFile(reportPath, 'utf8');
    assert.match(report, /Mock room synthesis: participant outputs were combined into a final room report\./);
    assert.match(report, /## threat modeler[\s\S]*Mock room participant \(threat modeler\)/);
    assert.match(report, /## application security reviewer[\s\S]*Mock room participant \(application security reviewer\)/);
  });
});
