import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  IMPLEMENTATION_PHASE_STATUS,
  runOrchestratedImplementationPhase,
} from '../src/implementation.js';
import {
  fileStore,
  implementationPlanText,
  pathExists,
  readTaskStatus,
  shSingleQuote,
  writeExecutable,
} from './support/implementation-fixtures.js';

test('runOrchestratedImplementationPhase returns direct-workspace results in batch order', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-batch-success-'));
  const storeRoot = path.join(tmp, 'store');

  try {
    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'mock' },
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info() {} },
        logPrefix: 'implementation-batch',
      },
      taskWorkspace: {
        store: fileStore(storeRoot),
        cycle: 2,
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
        objective: 'test implementation batch behavior',
        findings: 'focused batch findings',
      },
      orchestration: { maxImplementers: 2, parallel: true },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    const results = phase.result.implementations;
    assert.deepEqual(results.map((result) => result.task.id), ['task-1', 'task-2']);
    assert.deepEqual(results.map((result) => result.state), ['succeeded', 'succeeded']);
    assert.deepEqual(results.map((result) => result.changedFiles), [[], []]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase falls back from transient planner capacity', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-fallback-'));
  const storeRoot = path.join(tmp, 'store');
  const claude = path.join(tmp, 'claude');
  const messages = [];

  try {
    await writeExecutable(claude, [
      '#!/bin/sh',
      'printf "%s\\n" "Selected model is at capacity" >&2',
      'exit 1',
    ]);

    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'claude', command: claude },
        providers: [{ id: 'claude', command: claude }, { id: 'mock' }],
        timeoutMs: 5_000,
        retries: 0,
        retryDelayMs: 0,
        logger: { info(message) { messages.push(message); } },
        logPrefix: 'implementation-fallback',
      },
      taskWorkspace: {
        store: fileStore(storeRoot),
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
        objective: 'test implementation fallback',
        findings: 'focused findings',
      },
      orchestration: { maxImplementers: 1, parallel: false },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    assert.deepEqual(phase.result.implementations.map((item) => item.provider), ['mock']);
    assert.ok(messages.includes('cycle 1: implementation plan fallback claude -> mock'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase serial mode stops after the first failed task', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-batch-serial-failure-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const promptLog = `${bin}.prompts`;
  const batch = [
    {
      id: 'task-one',
      title: 'First task',
      files: ['src/one.js'],
      instructions: 'Fail first.',
      order: 1,
    },
    {
      id: 'task-two',
      title: 'Second task',
      files: ['src/two.js'],
      instructions: 'Should not run.',
      order: 2,
    },
  ];

  await writeExecutable(bin, [
    '#!/bin/sh',
    'prompt=$(cat)',
    `printf '%s\\n---prompt---\\n' "$prompt" >> ${shSingleQuote(promptLog)}`,
    'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: implementationPlanText(batch) },
    }))}`,
    '  exit 0',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'First task\'; then',
    `  printf '%s\\n' ${shSingleQuote(JSON.stringify({
      type: 'error',
      message: 'first task failed',
    }))}`,
    '  exit 1',
    'fi',
    'if printf \'%s\\n\' "$prompt" | grep -q \'Second task\'; then',
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
        store: fileStore(storeRoot, 'unit-implementation-batch-serial-run'),
        cycle: 3,
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
        objective: 'test implementation batch behavior',
        findings: 'focused batch findings',
      },
      orchestration: { maxImplementers: 2, parallel: false },
    });

    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.PARTIAL);
    assert.match(phase.error.message, /serial implementation batch 1 failed:.*first task failed/);

    const prompts = await fs.readFile(promptLog, 'utf8');
    assert.match(prompts, /First task/);
    assert.doesNotMatch(prompts, /Second task/);

    const failedStatus = await readTaskStatus(storeRoot, 'task-one', 3);
    assert.equal(failedStatus.state, 'failed');
    assert.match(failedStatus.error, /first task failed/);
    assert.equal(
      await pathExists(path.join(storeRoot, 'cycle-3', 'tasks', 'task-two', 'status.json')),
      false,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('runOrchestratedImplementationPhase retries transient implementer failures and records attempts', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-implementation-retry-'));
  const storeRoot = path.join(tmp, 'store');
  const bin = path.join(tmp, 'codex');
  const planText = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'Retry task',
          files: ['src/retry.js'],
          instructions: 'Retry this task.',
        },
      ],
    }),
    '```',
  ].join('\n');
  await fs.writeFile(
    bin,
    [
      '#!/bin/sh',
      'count_file="$0.count"',
      'if [ -f "$count_file" ]; then',
      '  read n < "$count_file"',
      'else',
      '  n=0',
      'fi',
      'n=$((n + 1))',
      'printf \'%s\\n\' "$n" > "$count_file"',
      'if [ "$n" -eq 1 ]; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: planText } })}'`,
      'elif [ "$n" -eq 2 ]; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: 'stream disconnected before completion' })}'`,
      '  exit 1',
      'else',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'implemented after retry' } })}'`,
      'fi',
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(bin, 0o755);
  const store = {
    async write(file, text) {
      const target = path.join(storeRoot, file);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, String(text), 'utf8');
      return target;
    },
  };
  try {
    const phase = await runOrchestratedImplementationPhase({
      execution: {
        provider: { id: 'codex', command: bin },
        timeoutMs: 5_000,
        retries: 1,
        retryDelayMs: 0,
      },
      taskWorkspace: {
        store,
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
        objective: 'retry implementation',
        findings: 'fix retry behavior',
      },
      orchestration: { maxImplementers: 1 },
    });
    assert.equal(phase.status, IMPLEMENTATION_PHASE_STATUS.COMPLETED);
    const result = phase.result;
    assert.equal(result.implementations[0].text, 'implemented after retry');
    assert.match(result.text, /## task-1: Retry task/);
    assert.match(result.text, /implemented after retry/);
    assert.match(
      await fs.readFile(path.join(storeRoot, 'cycle-1', 'tasks', 'task-1', 'attempts', '1', 'error.md'), 'utf8'),
      /stream disconnected/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
