import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runRoomCommand } from '../src/rooms.js';
import { writeFakeClaudeRoomProvider, writeFakeProvider } from './support/fake-provider.js';
import {
  captureConsoleLogs,
  captureConsoleOutcome,
  prependPathEntry,
  readSingleWorkflowRun,
  withEnv,
} from './support/workflow-fixtures.js';
import {
  flagMap,
  readRoleCount,
  ROOM_COMPLETED_PAYLOAD_KEYS,
  withRoomRun,
  writeRoleCountingFakeClaude,
} from './support/room-fixtures.js';

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
      flags: flagMap({ provider: 'claude', participants: '1', retries: '1' }),
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
      flags: flagMap({ provider: 'claude', participants: '1', json: 'true' }),
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
      flags: flagMap({ provider: 'claude', participants: '2', json: 'true' }),
    }, { cwd })));

    assert.equal(outcome.error, null);
    assert.deepEqual(outcome.result, { failed: false, exitCode: 0 });
    assert.equal(outcome.logs.length, 1);
    const payload = JSON.parse(outcome.logs[0]);
    assert.deepEqual(Object.keys(payload), ROOM_COMPLETED_PAYLOAD_KEYS);
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
      flags: flagMap({ provider: 'claude', participants: '2', retries: '1' }),
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

// Inline timing-aware fake claude: appends start/end markers to ROOM_PROVIDER_LOG with a
// participant-only busy-wait so concurrent runs interleave (start, start, end, end) while
// strictly serial runs pair up (start, end, start, end). Synthesis runs without delay.
const PARTICIPANT_BUSY_WAIT_MS = 120;
const TIMING_FAKE_CLAUDE_SCRIPT = [
  "const fs = require('node:fs');",
  "const prompt = fs.readFileSync(0, 'utf8');",
  "const logPath = process.env.ROOM_PROVIDER_LOG;",
  "const isSynthesis = prompt.includes('You are synthesizing');",
  "const role = (prompt.match(/You are the ([\\s\\S]*?) in the Commands\\.com/) || [])[1] || 'participant';",
  "const label = isSynthesis ? 'synthesis' : role;",
  "const append = (line) => { if (logPath) fs.appendFileSync(logPath, line + '\\n'); };",
  "append(`start:${label}`);",
  "if (!isSynthesis) {",
  `  const until = Date.now() + ${PARTICIPANT_BUSY_WAIT_MS};`,
  "  while (Date.now() < until) {}",
  "}",
  "append(`end:${label}`);",
  "console.log(JSON.stringify({ text: `Fake ${label} output` }));",
];

for (const scenario of [
  { mode: 'parallel', extraFlags: { parallel: 'true' }, expectedMetadataParallel: true },
  { mode: 'serial', extraFlags: {}, expectedMetadataParallel: false },
]) {
  test(`runRoomCommand ${scenario.mode} fan-out ${scenario.mode === 'parallel' ? 'overlaps' : 'sequences'} participant runs`, { skip: process.platform === 'win32' }, async () => {
    await withRoomRun(async (cwd) => {
      const binDir = path.join(cwd, 'bin');
      const providerLog = path.join(cwd, 'provider.log');
      await writeFakeProvider(binDir, 'claude', TIMING_FAKE_CLAUDE_SCRIPT);

      const outcome = await withEnv({
        PATH: prependPathEntry(binDir),
        ROOM_PROVIDER_LOG: providerLog,
      }, () => captureConsoleOutcome(() => runRoomCommand({
        positionals: ['security', `${scenario.mode} fan-out`],
        flags: flagMap({
          provider: 'claude',
          participants: '2',
          'no-synthesis': 'true',
          json: 'true',
          ...scenario.extraFlags,
        }),
      }, { cwd })));

      assert.equal(outcome.error, null);
      assert.deepEqual(outcome.result, { failed: false, exitCode: 0 });
      assert.equal(outcome.logs.length, 1);
      const payload = JSON.parse(outcome.logs[0]);
      assert.deepEqual(Object.keys(payload), ROOM_COMPLETED_PAYLOAD_KEYS);
      assert.equal(payload.outputs.length, 2);

      const events = (await fs.readFile(providerLog, 'utf8')).trim().split('\n');
      assert.equal(events.length, 4, 'two participants must each emit a start and end marker');

      const firstEndIndex = events.findIndex((line) => line.startsWith('end:'));
      const startsBeforeFirstEnd = events
        .slice(0, firstEndIndex)
        .filter((line) => line.startsWith('start:')).length;

      if (scenario.mode === 'parallel') {
        assert.equal(
          startsBeforeFirstEnd,
          2,
          '--parallel must overlap participants: both starts must precede any end',
        );
      } else {
        assert.equal(
          startsBeforeFirstEnd,
          1,
          'serial mode must run participants strictly sequentially (one start per end)',
        );
      }

      const runDir = path.dirname(payload.reportPath);
      const metadata = JSON.parse(await fs.readFile(path.join(runDir, 'metadata.json'), 'utf8'));
      assert.equal(metadata.parallel, scenario.expectedMetadataParallel);
    });
  });
}

for (const scenario of [
  {
    mode: 'serial',
    parallel: false,
    objective: 'serial fail-fast',
    expectReviewerCount: 0,
    reviewerNote: 'second participant must not run after the first rejects in strict serial mode',
  },
  {
    mode: 'parallel',
    parallel: true,
    objective: 'parallel strict reject',
    expectReviewerCount: null,
    reviewerNote: null,
  },
]) {
  test(`runRoomCommand strict ${scenario.mode} fan-out rejects when a participant fails`, { skip: process.platform === 'win32' }, async () => {
    await withRoomRun(async (cwd) => {
      const binDir = path.join(cwd, 'bin');
      await writeRoleCountingFakeClaude(binDir);

      const flags = { provider: 'claude', participants: '2', retries: '0', 'no-synthesis': 'true' };
      if (scenario.parallel) flags.parallel = 'true';

      const outcome = await withEnv({
        PATH: prependPathEntry(binDir),
      }, () => captureConsoleOutcome(() => runRoomCommand({
        positionals: ['security', scenario.objective],
        flags: flagMap(flags),
      }, { cwd })));

      assert.ok(outcome.error, `${scenario.mode} strict fan-out must reject when a participant fails`);
      assert.match(outcome.error.message, /participant|claude exited with 7/);

      assert.equal(await readRoleCount(binDir, 'threat-modeler'), 1, 'first participant ran exactly once');
      if (scenario.expectReviewerCount !== null) {
        assert.equal(
          await readRoleCount(binDir, 'application-security-reviewer'),
          scenario.expectReviewerCount,
          scenario.reviewerNote,
        );
      }
    });
  });
}
