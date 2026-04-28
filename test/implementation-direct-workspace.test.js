import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runOrchestratedImplementationPhase,
} from '../src/implementation.js';
import { runImplementationAndValidationPhase } from '../src/cycle-implementation.js';
import {
  createCycleRecorder,
  createCycleState,
} from '../src/cycle-state.js';

function fileStore(root, runId = 'unit-direct-workspace-run') {
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

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeConcurrencyProvider(filePath, stateDir) {
  const plan = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-one',
          title: 'First direct task',
          files: ['src/direct-one.txt'],
          instructions: 'Run the first direct workspace task.',
        },
        {
          id: 'task-two',
          title: 'Second direct task',
          files: ['src/direct-two.txt'],
          instructions: 'Run the second direct workspace task.',
        },
      ],
    }),
    '```',
  ].join('\n');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const stateDir = ${JSON.stringify(stateDir)};
const lockDir = path.join(stateDir, 'active-task.lock');
const overlapMarker = path.join(stateDir, 'overlap.txt');

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
  });
}

function complete(text) {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const prompt = await readStdin();
  if (prompt.includes('"kind":"implementation-plan"')) {
    complete(${JSON.stringify(plan)});
  } else {
    fs.mkdirSync(stateDir, { recursive: true });
    let ownsLock = false;
    try {
      fs.mkdirSync(lockDir);
      ownsLock = true;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        fs.writeFileSync(overlapMarker, 'parallel direct workspace task detected\\n');
      } else {
        throw error;
      }
    }
    await sleep(250);
    if (ownsLock) fs.rmSync(lockDir, { recursive: true, force: true });
    complete(prompt.includes('task-one') ? 'implemented task one' : 'implemented task two');
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  await fs.writeFile(filePath, script, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeFailingAfterEditProvider(filePath, stateDir) {
  const plan = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-one',
          title: 'First direct task',
          files: ['src/direct-one.txt'],
          instructions: 'Fail after editing the direct workspace.',
        },
        {
          id: 'task-two',
          title: 'Second direct task',
          files: ['src/direct-two.txt'],
          instructions: 'Must not run after task one fails.',
        },
      ],
    }),
    '```',
  ].join('\n');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const stateDir = ${JSON.stringify(stateDir)};

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
  });
}

function complete(text) {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }));
}

async function main() {
  const prompt = await readStdin();
  if (prompt.includes('"kind":"implementation-plan"')) {
    complete(${JSON.stringify(plan)});
    return;
  }

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
  if (prompt.includes('task-one')) {
    fs.writeFileSync(path.join(process.cwd(), 'src', 'direct-one.txt'), 'partial edit before failure\\n');
    fs.writeFileSync(path.join(stateDir, 'task-one.txt'), 'ran\\n');
    console.error('task-one failed after editing');
    process.exit(7);
  }
  if (prompt.includes('task-two')) {
    fs.writeFileSync(path.join(process.cwd(), 'src', 'direct-two.txt'), 'task two edit\\n');
    fs.writeFileSync(path.join(stateDir, 'task-two.txt'), 'ran\\n');
    complete('implemented task two');
    return;
  }
  throw new Error('unexpected implementation task prompt');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  await fs.writeFile(filePath, script, 'utf8');
  await fs.chmod(filePath, 0o755);
}

async function writeSecondBatchFailureProvider(filePath, stateDir) {
  const plan = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-one',
          title: 'First completed batch',
          files: ['src/shared.txt'],
          instructions: 'Complete the first batch.',
        },
        {
          id: 'task-two',
          title: 'Second failing batch',
          files: ['src/shared.txt'],
          instructions: 'Fail the second batch.',
        },
      ],
    }),
    '```',
  ].join('\n');
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const stateDir = ${JSON.stringify(stateDir)};

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
  });
}

function complete(text) {
  console.log(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }));
}

async function main() {
  const prompt = await readStdin();
  if (prompt.includes('"kind":"implementation-plan"')) {
    complete(${JSON.stringify(plan)});
    return;
  }

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(process.cwd(), 'src'), { recursive: true });
  if (prompt.includes('First completed batch')) {
    fs.writeFileSync(path.join(process.cwd(), 'src', 'shared.txt'), 'batch one edit\\n');
    fs.writeFileSync(path.join(stateDir, 'task-one.txt'), 'ran\\n');
    complete('batch one implementation complete');
    return;
  }
  if (prompt.includes('Second failing batch')) {
    fs.writeFileSync(path.join(stateDir, 'task-two.txt'), 'ran\\n');
    console.error('batch two failed intentionally');
    process.exit(9);
  }
  throw new Error('unexpected implementation task prompt');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  await fs.writeFile(filePath, script, 'utf8');
  await fs.chmod(filePath, 0o755);
}

test('runOrchestratedImplementationPhase serializes non-git direct-workspace tasks when parallel is requested', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-direct-workspace-guard-'));
  const storeRoot = path.join(tmp, 'store');
  const providerBin = path.join(tmp, 'codex');
  const providerState = path.join(tmp, 'provider-state');
  const loggerMessages = [];

  try {
    await writeConcurrencyProvider(providerBin, providerState);

    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'codex', command: providerBin },
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info(message) { loggerMessages.push(message); } },
        logPrefix: 'direct-guard',
      },
      taskWorkspace: {
        store: fileStore(storeRoot),
        cycle: 1,
        context: {
          repoRoot: tmp,
          branch: 'main',
          head: 'abc123',
          status: '(not a git repository)',
          diffStat: '(none)',
          diff: '',
        },
        workspace: { mode: 'current', cwd: tmp },
      },
      assignment: {
        objective: 'guard direct workspace implementation',
        findings: 'two disjoint direct-workspace tasks',
      },
      orchestration: { maxImplementers: 2, parallel: true },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    const result = phase.result;
    assert.deepEqual(result.batches, [['task-one', 'task-two']]);
    assert.deepEqual(result.implementations.map((item) => item.task.id), ['task-one', 'task-two']);
    assert.equal(
      await pathExists(path.join(providerState, 'overlap.txt')),
      false,
    );
    assert.ok(loggerMessages.includes(
      'cycle 1: task worktrees unavailable; running implementers serially in direct workspace',
    ));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase flushes completed batches before reporting a later batch failure', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-direct-workspace-partial-'));
  const storeRoot = path.join(tmp, 'store');
  const providerBin = path.join(tmp, 'codex');
  const providerState = path.join(tmp, 'provider-state');

  try {
    await writeSecondBatchFailureProvider(providerBin, providerState);

    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'codex', command: providerBin },
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info() {} },
        logPrefix: 'partial-direct',
      },
      taskWorkspace: {
        store: fileStore(storeRoot),
        cycle: 1,
        context: {
          repoRoot: tmp,
          branch: 'main',
          head: 'abc123',
          status: '(not a git repository)',
          diffStat: '(none)',
          diff: '',
        },
        workspace: { mode: 'current', cwd: tmp },
      },
      assignment: {
        objective: 'preserve completed implementation batches',
        findings: 'batch one should be preserved when batch two fails',
      },
      orchestration: { maxImplementers: 2, parallel: true },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /partial-direct implementation batch 2 failed:.*batch two failed intentionally/);
    const implementation = phase.result;
    assert.ok(implementation);
    assert.deepEqual(implementation.batches, [['task-one'], ['task-two']]);
    assert.deepEqual(implementation.implementations.map((item) => item.task.id), ['task-one']);
    assert.match(implementation.text, /## task-one: First completed batch/);
    assert.match(implementation.text, /batch one implementation complete/);
    assert.doesNotMatch(implementation.text, /Second failing batch/);

    const artifact = await fs.readFile(path.join(storeRoot, 'cycle-1', 'implementation.md'), 'utf8');
    assert.equal(artifact, implementation.text);
    assert.match(artifact, /## task-one: First completed batch/);
    assert.doesNotMatch(artifact, /Second failing batch/);
    assert.equal(await fs.readFile(path.join(tmp, 'src', 'shared.txt'), 'utf8'), 'batch one edit\n');
    assert.equal(await pathExists(path.join(providerState, 'task-one.txt')), true);
    assert.equal(await pathExists(path.join(providerState, 'task-two.txt')), true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runImplementationAndValidationPhase exposes partial results for cycle state after a later batch failure', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-cycle-partial-'));
  const storeRoot = path.join(tmp, 'store');
  const providerBin = path.join(tmp, 'codex');
  const providerState = path.join(tmp, 'provider-state');

  try {
    await writeSecondBatchFailureProvider(providerBin, providerState);

    const provider = { id: 'codex', command: providerBin };
    const state = createCycleState({
      kind: 'quality',
      store: fileStore(storeRoot, 'unit-cycle-partial-run'),
      workspace: { mode: 'current', cwd: tmp },
      context: {
        repoRoot: tmp,
        branch: 'main',
        head: 'abc123',
        status: '(not a git repository)',
        diffStat: '(none)',
        diff: '',
      },
      options: {
        providers: [provider],
        primaryProvider: provider,
        providerIds: [provider.id],
        model: '',
        serial: false,
        parallel: true,
        json: true,
        timeoutMs: 5_000,
        maxImplementers: 2,
        providerRetries: 0,
        testCommand: 'node -e "process.stdout.write(\'partial validation failed\'); process.exit(5)"',
      },
      logger: { jsonMode: true, info() {} },
    });
    const recorder = createCycleRecorder(state);
    const cycleRecord = recorder.beginCycle(1, { issueCount: 1, score: 'B' });

    const phase = await runImplementationAndValidationPhase(state, {
      cycle: 1,
      objective: 'preserve partial cycle implementation',
      findings: 'batch one should be recorded even when batch two fails',
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /quality implementation batch 2 failed:.*batch two failed intentionally/);
    const partialResult = phase.result;
    assert.ok(partialResult);
    assert.equal(partialResult.testResult.exitCode, 5);
    assert.equal(partialResult.nextContext.repoRoot, await fs.realpath(tmp));
    assert.match(partialResult.nextFindings, /batch one should be recorded even when batch two fails/);
    assert.match(partialResult.nextFindings, /## Validation failure/);
    assert.match(partialResult.nextFindings, /partial validation failed/);
    recorder.applyImplementationResult(cycleRecord, partialResult);

    assert.deepEqual(cycleRecord.implementationBatches, [['task-one'], ['task-two']]);
    assert.deepEqual(cycleRecord.implementations.map((item) => item.task.id), ['task-one']);
    assert.match(cycleRecord.implementation, /## task-one: First completed batch/);
    assert.match(cycleRecord.implementation, /batch one implementation complete/);
    assert.doesNotMatch(cycleRecord.implementation, /Second failing batch/);
    assert.deepEqual(cycleRecord.test, { ok: false, exitCode: 5 });
    assert.equal(state.hasUnresolvedTestFailure, true);
    assert.equal(state.context.repoRoot, await fs.realpath(tmp));
    assert.match(state.priorFindings, /partial validation failed/);

    const artifact = await fs.readFile(path.join(storeRoot, 'cycle-1', 'implementation.md'), 'utf8');
    assert.equal(artifact, cycleRecord.implementation);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase stops direct-workspace tasks after the first failure', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-direct-workspace-failure-'));
  const storeRoot = path.join(tmp, 'store');
  const providerBin = path.join(tmp, 'codex');
  const providerState = path.join(tmp, 'provider-state');

  try {
    await writeFailingAfterEditProvider(providerBin, providerState);

    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'codex', command: providerBin },
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info() {} },
        logPrefix: 'direct-guard',
      },
      taskWorkspace: {
        store: fileStore(storeRoot),
        cycle: 1,
        context: {
          repoRoot: tmp,
          branch: 'main',
          head: 'abc123',
          status: '(not a git repository)',
          diffStat: '(none)',
          diff: '',
        },
        workspace: { mode: 'current', cwd: tmp },
      },
      assignment: {
        objective: 'guard direct workspace implementation failures',
        findings: 'first task fails after editing; second task must not run',
      },
      orchestration: { maxImplementers: 2, parallel: true },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /task-one failed after editing/);

    assert.equal(await pathExists(path.join(providerState, 'task-one.txt')), true);
    assert.equal(await pathExists(path.join(tmp, 'src', 'direct-one.txt')), true);
    assert.equal(await pathExists(path.join(providerState, 'task-two.txt')), false);
    assert.equal(await pathExists(path.join(tmp, 'src', 'direct-two.txt')), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
