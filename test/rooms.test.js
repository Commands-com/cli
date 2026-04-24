import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  runRoomCommand,
  runRoomsCommand,
} from '../src/rooms.js';
import { formatRoomReport } from '../src/room-report.js';
import { splitPromptIntent } from '../src/prompt-intent.js';
import { DEFAULT_TIMEOUT_MS } from '../src/provider-limits.js';
import { BUILT_IN_ROOMS } from '../src/rooms/catalog.js';
import { writeFakeClaudeRoomProvider, writeFakeProvider } from './support/fake-provider.js';
import {
  captureConsoleLogs,
  captureConsoleOutcome,
  prependPathEntry,
  readSingleWorkflowRun,
  withEnv,
  withTempRun,
} from './support/workflow-fixtures.js';

const ROOM_TEST_PREFIX = 'commands-com-room-test-';

async function withRoomRun(fn) {
  return withTempRun(fn, { prefix: ROOM_TEST_PREFIX });
}

function roomById(id) {
  const room = BUILT_IN_ROOMS.find((candidate) => candidate.id === id);
  assert.ok(room, `expected built-in room ${id}`);
  return room;
}

function promptIntent(prompt) {
  return splitPromptIntent(prompt).intent;
}

test('runRoomCommand writes participant prompt with objective, role, guidance, and repo context', async () => {
  await withRoomRun(async (cwd) => {
    const result = await runRoomCommand({
      positionals: ['security', 'audit this CLI'],
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '1'],
        ['no-synthesis', 'true'],
        ['json', 'true'],
      ]),
    }, {
      cwd,
      logger: {
        jsonMode: true,
        info() {},
        json() {},
      },
    });
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
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '2'],
        ['json', 'true'],
      ]),
    }, {
      cwd,
      logger: {
        jsonMode: true,
        info() {},
        json() {},
      },
    });
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
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '1'],
      ]),
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
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '1'],
      ]),
    }, {
      cwd,
      logger,
    });

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
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '1'],
      ]),
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
      'kind',
      'roomId',
      'title',
      'objective',
      'provider',
      'model',
      'changed',
      'parallel',
      'synthesize',
      'providerRetries',
      'timeoutMs',
      'participants',
      'createdAt',
    ]);
    const { createdAt, ...metadataWithoutCreatedAt } = metadata;
    assert.deepEqual(metadataWithoutCreatedAt, {
      kind: 'room',
      roomId: 'security',
      title: 'Security Room',
      objective: 'audit this CLI',
      provider: 'mock',
      model: '',
      changed: false,
      parallel: false,
      synthesize: true,
      providerRetries: 1,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      participants: ['threat modeler'],
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
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '2'],
      ]),
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
    assert.deepEqual(metadata.participants, [
      'threat modeler',
      'application security reviewer',
    ]);

    const report = await fs.readFile(reportPath, 'utf8');
    assert.match(report, /Mock room synthesis: participant outputs were combined into a final room report\./);
    assert.match(report, /## threat modeler[\s\S]*Mock room participant \(threat modeler\)/);
    assert.match(report, /## application security reviewer[\s\S]*Mock room participant \(application security reviewer\)/);
  });
});

test('runRoomCommand retries transient participant provider failures', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    const providerLog = path.join(cwd, 'provider.log');
    await writeFakeClaudeRoomProvider(binDir);

    const logs = await withEnv({
      PATH: prependPathEntry(binDir),
      ROOM_PROVIDER_LOG: providerLog,
      ROOM_FAIL: 'participant-once',
    }, () => captureConsoleLogs(() => runRoomCommand({
      positionals: ['security', 'retry participant'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '1'],
        ['retries', '1'],
      ]),
    }, { cwd })));

    assert.ok(logs.includes('[room] claude/threat modeler: retry 1/1 after transient provider failure'));
    assert.ok(logs.includes('[room] threat modeler: complete'));
    assert.deepEqual((await fs.readFile(providerLog, 'utf8')).trim().split('\n'), [
      'participant',
      'participant',
    ]);

    const { runDir } = await readSingleWorkflowRun(cwd);
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'claude-threat-modeler.md'), 'utf8'),
      /Room objective: retry participant/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'participants', 'claude', 'threat-modeler.md'), 'utf8'),
      /Fake threat modeler output/,
    );
  });
});

test('runRoomCommand keeps JSON stdout safe when participant provider fails', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    await writeFakeClaudeRoomProvider(binDir);

    const outcome = await withEnv({
      PATH: prependPathEntry(binDir),
      ROOM_FAIL: 'all',
    }, () => captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'json safe participant failure'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '1'],
        ['json', 'true'],
      ]),
    }, { cwd })));

    assert.ok(outcome.error);
    assert.match(outcome.error.message, /participant failure|claude exited with 7/);
    assert.deepEqual(outcome.logs, []);

    const { runDir } = await readSingleWorkflowRun(cwd);
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'claude-threat-modeler.md'), 'utf8'),
      /json safe participant failure/,
    );
    await assert.rejects(
      fs.stat(path.join(runDir, 'participants', 'claude', 'threat-modeler.md')),
      /ENOENT/,
    );
    await assert.rejects(
      fs.stat(path.join(runDir, 'participants', 'claude', 'threat-modeler.error.md')),
      /ENOENT/,
    );
  });
});

test('runRoomCommand keeps JSON stdout safe and writes synthesis error artifacts when synthesis provider fails', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    const providerLog = path.join(cwd, 'provider.log');
    await writeFakeClaudeRoomProvider(binDir);

    const outcome = await withEnv({
      PATH: prependPathEntry(binDir),
      ROOM_PROVIDER_LOG: providerLog,
      ROOM_FAIL: 'synthesis',
    }, () => captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'json safe synthesis failure'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '2'],
        ['json', 'true'],
      ]),
    }, { cwd })));

    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.result, { failed: false, exitCode: 0 });
    assert.equal(outcome.logs.length, 1);
    const payload = JSON.parse(outcome.logs[0]);
    assert.deepEqual(Object.keys(payload), [
      'type',
      'runId',
      'roomId',
      'reportPath',
      'outputs',
      'synthesis',
      'synthesisError',
    ]);
    assert.equal(payload.type, 'room.completed');
    assert.match(payload.runId, /^\d{8}-\d{6}-room-security-json-safe-synthesis-failure-[0-9a-f]{6}$/);
    assert.equal(payload.roomId, 'security');
    assert.equal(payload.synthesis, '');
    assert.match(payload.synthesisError, /synthesis failure|claude exited with 8/);
    assert.equal(payload.outputs.length, 2);
    assert.deepEqual(Object.keys(payload.outputs[0]), ['provider', 'role', 'text']);
    assert.deepEqual(payload.outputs.map((output) => [output.provider, output.role]), [
      ['claude', 'threat modeler'],
      ['claude', 'application security reviewer'],
    ]);
    assert.deepEqual((await fs.readFile(providerLog, 'utf8')).trim().split('\n'), [
      'participant',
      'participant',
      'synthesis',
    ]);

    const runDir = path.dirname(payload.reportPath);
    assert.equal(payload.reportPath, path.join(runDir, 'room.md'));
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'synthesis-claude.md'), 'utf8'),
      /Objective: json safe synthesis failure[\s\S]*claude \/ threat modeler/,
    );
    assert.match(await fs.readFile(path.join(runDir, 'synthesis-error.md'), 'utf8'), /synthesis failure|claude exited with 8/);
    assert.match(await fs.readFile(payload.reportPath, 'utf8'), /Synthesis failed:/);
    await assert.rejects(fs.stat(path.join(runDir, 'synthesis.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'prompts', 'synthesis.md')), /ENOENT/);
  });
});

test('runRoomCommand retries transient synthesis provider failures', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    const providerLog = path.join(cwd, 'provider.log');
    await writeFakeClaudeRoomProvider(binDir);

    const logs = await withEnv({
      PATH: prependPathEntry(binDir),
      ROOM_PROVIDER_LOG: providerLog,
      ROOM_FAIL: 'synthesis-once',
    }, () => captureConsoleLogs(() => runRoomCommand({
      positionals: ['security', 'retry synthesis'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '2'],
        ['retries', '1'],
      ]),
    }, { cwd })));

    assert.ok(logs.includes('[room] synthesis (claude)'));
    assert.ok(logs.includes('[room] synthesis retry 1/1 after transient claude failure'));
    assert.ok(logs.includes('[room] synthesis: complete'));
    assert.deepEqual((await fs.readFile(providerLog, 'utf8')).trim().split('\n'), [
      'participant',
      'participant',
      'synthesis',
      'synthesis',
    ]);

    const { runDir } = await readSingleWorkflowRun(cwd);
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'synthesis-claude.md'), 'utf8'),
      /claude \/ application security reviewer/,
    );
    assert.match(await fs.readFile(path.join(runDir, 'synthesis.md'), 'utf8'), /Fake synthesis output/);
    await assert.rejects(fs.stat(path.join(runDir, 'synthesis-error.md')), /ENOENT/);
  });
});

test('runRoomCommand records parallel room execution and writes synthesis output artifacts in JSON mode', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    const providerLog = path.join(cwd, 'provider.log');
    await writeFakeClaudeRoomProvider(binDir);

    const outcome = await withEnv({
      PATH: prependPathEntry(binDir),
      ROOM_PROVIDER_LOG: providerLog,
    }, () => captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'parallel room'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '2'],
        ['parallel', 'true'],
        ['json', 'true'],
      ]),
    }, { cwd })));

    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.result, { failed: false, exitCode: 0 });
    assert.equal(outcome.logs.length, 1);
    const payload = JSON.parse(outcome.logs[0]);
    assert.deepEqual(Object.keys(payload), [
      'type',
      'runId',
      'roomId',
      'reportPath',
      'outputs',
      'synthesis',
      'synthesisError',
    ]);
    assert.equal(payload.type, 'room.completed');
    assert.equal(payload.roomId, 'security');
    assert.equal(payload.outputs.length, 2);
    assert.deepEqual(payload.outputs.map((output) => [output.provider, output.role]), [
      ['claude', 'threat modeler'],
      ['claude', 'application security reviewer'],
    ]);
    assert.match(payload.synthesis, /Fake synthesis output/);
    assert.equal(payload.synthesisError, '');

    const runDir = path.dirname(payload.reportPath);
    const metadata = JSON.parse(await fs.readFile(path.join(runDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.parallel, true);
    assert.deepEqual((await fs.readFile(providerLog, 'utf8')).trim().split('\n'), [
      'participant',
      'participant',
      'synthesis',
    ]);
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'claude-threat-modeler.md'), 'utf8'),
      /commands-com-prompt-intent/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'participants', 'claude', 'threat-modeler.md'), 'utf8'),
      /Fake threat modeler output/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'claude-application-security-reviewer.md'), 'utf8'),
      /commands-com-prompt-intent/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'participants', 'claude', 'application-security-reviewer.md'), 'utf8'),
      /Fake application security reviewer output/,
    );
    assert.match(
      await fs.readFile(path.join(runDir, 'prompts', 'synthesis-claude.md'), 'utf8'),
      /claude \/ threat modeler/,
    );
    assert.match(await fs.readFile(path.join(runDir, 'synthesis.md'), 'utf8'), /Fake synthesis output/);
  });
});

async function writeRoleCountingFakeClaude(binDir) {
  return writeFakeProvider(binDir, 'claude', [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "const role = (prompt.match(/You are the ([\\s\\S]*?) in the Commands\\.com/) || [])[1] || 'participant';",
    "const safeRole = role.replace(/[^a-z0-9]+/gi, '-').toLowerCase();",
    "const countDir = path.dirname(process.argv[1]);",
    "const countPath = path.join(countDir, `count-${safeRole}.txt`);",
    'let count = 0;',
    "try { count = Number(fs.readFileSync(countPath, 'utf8')) || 0; } catch {}",
    'count += 1;',
    'fs.writeFileSync(countPath, String(count));',
    "if (role === 'threat modeler') {",
    "  console.error('threat modeler failure');",
    '  process.exit(7);',
    '}',
    "process.stdout.write(`${JSON.stringify({ result: `Fake ${role} output` })}\\n`);",
  ]);
}

async function readRoleCount(binDir, safeRole) {
  try {
    return Number(await fs.readFile(path.join(binDir, `count-${safeRole}.txt`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

test('runRoomCommand strict serial fan-out fails fast on the first rejecting participant without running later participants', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    await writeRoleCountingFakeClaude(binDir);

    const outcome = await withEnv({
      PATH: prependPathEntry(binDir),
    }, () => captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'serial fail-fast'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '2'],
        ['retries', '0'],
        ['no-synthesis', 'true'],
      ]),
    }, { cwd })));

    assert.ok(outcome.error, 'serial strict fan-out must reject when the first participant fails');
    assert.match(outcome.error.message, /participant|claude exited with 7/);

    const threatModelerCount = await readRoleCount(binDir, 'threat-modeler');
    const reviewerCount = await readRoleCount(binDir, 'application-security-reviewer');
    assert.equal(threatModelerCount, 1, 'first participant ran exactly once');
    assert.equal(reviewerCount, 0, 'second participant must not run after the first rejects in strict serial mode');
  });
});

test('runRoomCommand strict parallel fan-out rejects when any participant fails', { skip: process.platform === 'win32' }, async () => {
  await withRoomRun(async (cwd) => {
    const binDir = path.join(cwd, 'bin');
    await writeRoleCountingFakeClaude(binDir);

    const outcome = await withEnv({
      PATH: prependPathEntry(binDir),
    }, () => captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'parallel strict reject'],
      flags: new Map([
        ['provider', 'claude'],
        ['participants', '2'],
        ['parallel', 'true'],
        ['retries', '0'],
        ['no-synthesis', 'true'],
      ]),
    }, { cwd })));

    assert.ok(outcome.error, 'parallel strict fan-out must reject when any participant fails');
    assert.match(outcome.error.message, /participant|claude exited with 7/);

    const threatModelerCount = await readRoleCount(binDir, 'threat-modeler');
    assert.equal(threatModelerCount, 1, 'first participant ran exactly once');
  });
});
