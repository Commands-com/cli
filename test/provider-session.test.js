import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCyclePhaseView, createCycleState } from '../src/cycle-state.js';
import { runAssessmentProviderFanout } from '../src/cycle-fanout.js';
import { memoryStore } from './support/memory-store.js';

function shSingleQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function writeFakeCodexCommand(tmp, script) {
  const scriptPath = path.join(tmp, 'fake-codex.mjs');
  await fs.writeFile(scriptPath, script, 'utf8');

  if (process.platform === 'win32') {
    const command = path.join(tmp, 'codex.cmd');
    await fs.writeFile(command, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`, 'utf8');
    return command;
  }

  const command = path.join(tmp, 'codex');
  await fs.writeFile(command, [
    '#!/bin/sh',
    `exec ${shSingleQuote(process.execPath)} ${shSingleQuote(scriptPath)} "$@"`,
    '',
  ].join('\n'), 'utf8');
  await fs.chmod(command, 0o755);
  return command;
}

function stdinDrainedSnippet() {
  return [
    'await new Promise((resolve) => {',
    '  process.stdin.on("end", resolve);',
    '  process.stdin.resume();',
    '});',
  ].join('\n');
}

function testState({ cwd, provider, store = memoryStore() }) {
  return createCycleState({
    kind: 'quality',
    store,
    workspace: { mode: 'current', cwd },
    context: { repoRoot: cwd, gitRoot: cwd, branch: 'main', status: '', diffStat: '', diff: '' },
    options: {
      providers: [provider],
      primaryProvider: provider,
      providerIds: [provider.id],
      parallel: false,
      providerRetries: 0,
      timeoutMs: 5_000,
    },
    logger: {
      jsonMode: true,
      info() {},
    },
  });
}

function fanoutOptions() {
  return {
    cycle: 1,
    items: [
      { value: ['architecture', 'tests'], label: 'architecture, tests', pathSegment: 'all-areas' },
    ],
    label: 'quality fan-out',
    partial: true,
    adapter: {
      artifactRoot: 'areas',
      buildPrompt: () => 'quality prompt',
      buildOutput: ({ provider, text }) => ({ provider: provider.id, area: 'all', text }),
    },
  };
}

test('assessment fan-out resumes provider sessions across cycles by provider and item', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-session-'));
  const argsLog = path.join(tmp, 'args.log');
  const seen = path.join(tmp, 'seen');
  const bin = await writeFakeCodexCommand(tmp, [
    'import fs from "node:fs";',
    `const argsLog = ${JSON.stringify(argsLog)};`,
    `const seen = ${JSON.stringify(seen)};`,
    'const args = process.argv.slice(2).join(" ");',
    'fs.appendFileSync(argsLog, `${args}\\n`);',
    'if (!args.includes("resume thread-one -")) {',
    '  if (fs.existsSync(seen)) {',
    '    console.error("missing resume session");',
    '    process.exit(7);',
    '  }',
    '  fs.writeFileSync(seen, "seen\\n");',
    '}',
    stdinDrainedSnippet(),
    `console.log(${JSON.stringify(JSON.stringify({ type: 'thread.started', thread_id: 'thread-one' }))});`,
    `console.log(${JSON.stringify(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'quality ok' } }))});`,
    '',
  ].join('\n'));

  try {
    const provider = { id: 'codex', command: bin };
    const state = testState({ cwd: tmp, provider });

    await runAssessmentProviderFanout(createCyclePhaseView(state), fanoutOptions());
    await runAssessmentProviderFanout(createCyclePhaseView(state), { ...fanoutOptions(), cycle: 2 });

    assert.deepEqual(state.providerSessions, {
      'codex/areas/all-areas': 'thread-one',
    });
    assert.deepEqual((await fs.readFile(argsLog, 'utf8')).trim().split('\n').map((line) => line.includes('resume thread-one -')), [
      false,
      true,
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('assessment fan-out clears an invalid provider session and retries fresh once', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-provider-session-reset-'));
  const argsLog = path.join(tmp, 'args.log');
  const countFile = path.join(tmp, 'count');
  const bin = await writeFakeCodexCommand(tmp, [
    'import fs from "node:fs";',
    `const argsLog = ${JSON.stringify(argsLog)};`,
    `const countFile = ${JSON.stringify(countFile)};`,
    'const args = process.argv.slice(2).join(" ");',
    'const previous = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;',
    'const n = previous + 1;',
    'fs.writeFileSync(countFile, `${n}\\n`);',
    'fs.appendFileSync(argsLog, `${args}\\n`);',
    'if (n === 2 && args.includes("resume stale-thread -")) {',
    '  console.error("provider session invalid");',
    '  process.exit(9);',
    '}',
    stdinDrainedSnippet(),
    'const thread = n === 1 ? "stale-thread" : "fresh-thread";',
    'console.log(JSON.stringify({ type: "thread.started", thread_id: thread }));',
    `console.log(${JSON.stringify(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'quality ok' } }))});`,
    '',
  ].join('\n'));

  try {
    const provider = { id: 'codex', command: bin };
    const state = testState({ cwd: tmp, provider });

    await runAssessmentProviderFanout(createCyclePhaseView(state), fanoutOptions());
    await runAssessmentProviderFanout(createCyclePhaseView(state), { ...fanoutOptions(), cycle: 2 });

    assert.deepEqual(state.providerSessions, {
      'codex/areas/all-areas': 'fresh-thread',
    });
    assert.deepEqual((await fs.readFile(argsLog, 'utf8')).trim().split('\n').map((line) => line.includes('resume stale-thread -')), [
      false,
      true,
      false,
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
