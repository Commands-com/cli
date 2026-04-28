import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { splitPromptIntent } from '../../src/prompt-intent.js';
import { BUILT_IN_ROOMS } from '../../src/rooms/catalog.js';
import { writeFakeProvider } from './fake-provider.js';
import { withTempRun } from './workflow-fixtures.js';

const ROOM_TEST_PREFIX = 'commands-com-room-test-';

export const ROOM_COMPLETED_PAYLOAD_KEYS = [
  'type', 'runId', 'roomId', 'reportPath', 'outputs', 'synthesis', 'synthesisError',
];

export async function withRoomRun(fn) {
  return withTempRun(fn, { prefix: ROOM_TEST_PREFIX });
}

export function roomById(id) {
  const room = BUILT_IN_ROOMS.find((candidate) => candidate.id === id);
  assert.ok(room, `expected built-in room ${id}`);
  return room;
}

export function promptIntent(prompt) {
  return splitPromptIntent(prompt).intent;
}

export function flagMap(flags) {
  return new Map(Object.entries(flags));
}

export function silentJsonLogger() {
  return { jsonMode: true, info() {}, json() {} };
}

export async function writeRoleCountingFakeClaude(binDir) {
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

export async function readRoleCount(binDir, safeRole) {
  try {
    return Number(await fs.readFile(path.join(binDir, `count-${safeRole}.txt`), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}
