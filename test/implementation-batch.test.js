import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runOrchestratedImplementationPhase,
} from '../src/implementation.js';

function fileStore(root, runId = 'unit-implementation-batch-run') {
  return {
    runId,
    async write(file, text) {
      const target = path.join(root, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(text), 'utf8');
      return target;
    },
    async writeJson(file, value) {
      return this.write(file, `${JSON.stringify(value, null, 2)}\n`);
    },
  };
}

async function writeExecutable(file, lines) {
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
  await fs.chmod(file, 0o755);
}

function shSingleQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTaskStatus(storeRoot, taskId, cycle = 1) {
  return JSON.parse(await fs.readFile(
    path.join(storeRoot, `cycle-${cycle}`, 'tasks', taskId, 'status.json'),
    'utf8',
  ));
}

const BATCH = Object.freeze([
  Object.freeze({
    id: 'task-one',
    title: 'First task',
    files: ['src/one.js'],
    instructions: 'Fail first.',
    order: 1,
  }),
  Object.freeze({
    id: 'task-two',
    title: 'Second task',
    files: ['src/two.js'],
    instructions: 'Run second.',
    order: 2,
  }),
]);

function implementationPlanText(tasks = BATCH) {
  return [
    '```json',
    JSON.stringify({ tasks }),
    '```',
  ].join('\n');
}

test('runOrchestratedImplementationPhase serial mode does not schedule jobs after the first rejection', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-batch-serial-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const firstMarker = path.join(tmp, 'first-ran');
  const secondMarker = path.join(tmp, 'second-ran');

  await writeExecutable(bin, [
    '#!/bin/sh',
    'prompt=$(cat)',
    'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: implementationPlanText() },
    }))}`,
    '  exit 0',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'First task\'; then',
    `  printf 'first\\n' > ${shSingleQuote(firstMarker)}`,
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'error',
      message: 'first task failed',
    }))}`,
    '  exit 1',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'Second task\'; then',
    `  printf 'second\\n' > ${shSingleQuote(secondMarker)}`,
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'second task ran' },
    }))}`,
    '  exit 0',
    'fi',
    'exit 1',
  ]);

  try {
    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'codex', command: bin },
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info() {} },
        logPrefix: 'serial',
      },
      taskWorkspace: {
        store: fileStore(storeRoot, 'unit-implementation-batch-serial'),
        cycle: 1,
        context: {
          repoRoot: tmp,
          branch: 'main',
          head: 'abc123',
          status: '(clean)',
          diffStat: '(none)',
          diff: '',
        },
      },
      assignment: {
        objective: 'test implementation batch scheduling',
        findings: 'focused batch findings',
      },
      orchestration: { maxImplementers: 2, parallel: false },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /serial implementation batch 1 failed:.*first task failed/);

    assert.equal(await pathExists(firstMarker), true);
    assert.equal(await pathExists(secondMarker), false);
    const failedStatus = await readTaskStatus(storeRoot, 'task-one');
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.error, /first task failed/);
    assert.equal(
      await pathExists(path.join(storeRoot, 'cycle-1', 'tasks', 'task-two', 'status.json')),
      false,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase parallel mode settles all scheduled jobs after a rejection', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-batch-parallel-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const firstMarker = path.join(tmp, 'first-ran');
  const secondMarker = path.join(tmp, 'second-ran');

  await writeExecutable(bin, [
    '#!/bin/sh',
    'prompt=$(cat)',
    'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: implementationPlanText() },
    }))}`,
    '  exit 0',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'First task\'; then',
    `  printf 'first\\n' > ${shSingleQuote(firstMarker)}`,
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'error',
      message: 'first task failed',
    }))}`,
    '  exit 1',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'Second task\'; then',
    '  sleep 0.2',
    `  printf 'second\\n' > ${shSingleQuote(secondMarker)}`,
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'second task settled' },
    }))}`,
    '  exit 0',
    'fi',
    'exit 1',
  ]);

  try {
    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'codex', command: bin },
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info() {} },
        logPrefix: 'parallel',
      },
      taskWorkspace: {
        store: fileStore(storeRoot, 'unit-implementation-batch-parallel'),
        cycle: 1,
        context: {
          repoRoot: tmp,
          branch: 'main',
          head: 'abc123',
          status: '(clean)',
          diffStat: '(none)',
          diff: '',
        },
      },
      assignment: {
        objective: 'test implementation batch scheduling',
        findings: 'focused batch findings',
      },
      orchestration: { maxImplementers: 2, parallel: true },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /parallel implementation batch 1 failed:.*first task failed/);

    assert.equal(await pathExists(firstMarker), true);
    assert.equal(await pathExists(secondMarker), true);
    const failedStatus = await readTaskStatus(storeRoot, 'task-one');
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.error, /first task failed/);
    const settledStatus = await readTaskStatus(storeRoot, 'task-two');
    assert.equal(settledStatus.state, 'succeeded');
    assert.equal(settledStatus.error, '');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
