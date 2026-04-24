import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runRoomCommand } from '../src/rooms.js';
import { BUILT_IN_ROOMS } from '../src/rooms/catalog.js';
import {
  captureConsoleOutcome,
  withTempRun,
} from './support/workflow-fixtures.js';

const ROOM_SELECTION_TEST_PREFIX = 'commands-com-room-selection-test-';

async function withRoomSelectionRun(fn) {
  return withTempRun(fn, { prefix: ROOM_SELECTION_TEST_PREFIX });
}

test('built-in rooms include a broad useful set', () => {
  assert.ok(BUILT_IN_ROOMS.length >= 10);
  assert.ok(BUILT_IN_ROOMS.some((room) => room.id === 'security'));
  assert.ok(BUILT_IN_ROOMS.some((room) => room.id === 'implementation-plan'));
  assert.ok(BUILT_IN_ROOMS.some((room) => room.id === 'release-readiness'));
});

test('runRoomCommand supports room aliases', async () => {
  await withRoomSelectionRun(async (cwd) => {
    for (const alias of ['sec', 'plan', 'quality']) {
      await runRoomCommand({
        positionals: [alias, `alias ${alias}`],
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
    }
  });
});

test('built-in room participants use explicit role and guidance objects', () => {
  const room = BUILT_IN_ROOMS.find((candidate) => candidate.id === 'security');

  assert.ok(room);
  assert.deepEqual(room.participants[0], {
    role: 'threat modeler',
    guidance: 'Identify assets, attackers, trust boundaries, and abuse paths.',
  });
  assert.ok(room.participants.every((participant) => !Array.isArray(participant)));
  assert.ok(room.participants.every((participant) => participant.role && participant.guidance));
});

test('runRoomCommand honors participant limits and --no-synthesis edges in JSON mode', async () => {
  await withRoomSelectionRun(async (cwd) => {
    const outcome = await captureConsoleOutcome(() => runRoomCommand({
      positionals: ['security', 'skip synthesis for two participants'],
      flags: new Map([
        ['provider', 'mock'],
        ['participants', '2'],
        ['no-synthesis', 'true'],
        ['json', 'true'],
      ]),
    }, { cwd }));

    assert.equal(outcome.error, null);
    assert.equal(outcome.logs.length, 1);
    const payload = JSON.parse(outcome.logs[0]);
    assert.equal(payload.synthesis, '');
    assert.equal(payload.synthesisError, '');
    assert.deepEqual(payload.outputs.map((output) => output.role), [
      'threat modeler',
      'application security reviewer',
    ]);

    const runDir = path.dirname(payload.reportPath);
    const metadata = JSON.parse(await fs.readFile(path.join(runDir, 'metadata.json'), 'utf8'));
    assert.equal(metadata.synthesize, false);
    assert.deepEqual(metadata.participants, [
      'threat modeler',
      'application security reviewer',
    ]);
    await assert.rejects(fs.stat(path.join(runDir, 'prompts', 'synthesis-mock.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'synthesis.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runDir, 'synthesis-error.md')), /ENOENT/);
  });
});
