import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCycleState } from '../../src/cycle-state.js';
import { tempDir as cliTempDir } from './cli.js';

export { initGitRepo } from './git.js';
export { run } from './cli.js';

export async function tempDir() {
  return cliTempDir('commands-com-workflow-');
}

export function parsed(positionals = [], flags = {}) {
  return {
    positionals,
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

export async function writeCountingCodex(binDir, { firstText, failureMessage }) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, 'codex');
  await fs.writeFile(
    provider,
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
      'if [ "$n" -gt 1 ]; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: failureMessage })}'`,
      '  exit 1',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: firstText } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
}

export async function writeRetryOnceCodex(binDir, { successText }) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, 'codex');
  await fs.writeFile(
    provider,
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
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: 'temporarily unavailable' })}'`,
      '  exit 1',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: successText } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
}

export async function writeOutputAndSynthesisCodex(binDir, { outputText, synthesisText, synthesisKind }) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, 'codex');
  await fs.writeFile(
    provider,
    [
      '#!/bin/sh',
      'prompt=$(cat)',
      `if printf '%s\\n' "$prompt" | grep -q '"kind":"${synthesisKind}"'; then`,
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: synthesisText } })}'`,
      '  exit 0',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: outputText } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
}

export async function writeSecondCycleFailureCodex(binDir, {
  reviewText,
  implementationPlanText,
  implementationText,
  failureMessage,
}) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, 'codex');
  await fs.writeFile(
    provider,
    [
      '#!/bin/sh',
      'prompt=$(cat)',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: implementationPlanText } })}'`,
      '  exit 0',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-task"\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: implementationText } })}'`,
      '  exit 0',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"hasPriorFindings":true\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: failureMessage })}'`,
      '  exit 1',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reviewText } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
}

export async function writePartialSecondCycleFailureCodex(binDir, {
  reviewText,
  secondCycleSuccessText,
  implementationPlanText,
  implementationText,
  failureMessage,
}) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, 'codex');
  await fs.writeFile(
    provider,
    [
      '#!/bin/sh',
      'prompt=$(cat)',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: implementationPlanText } })}'`,
      '  exit 0',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-task"\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: implementationText } })}'`,
      '  exit 0',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"hasPriorFindings":true\' && printf \'%s\\n\' "$prompt" | grep -q \'"role":"maintainability"\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'error', message: failureMessage })}'`,
      '  exit 1',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"hasPriorFindings":true\'; then',
      `  printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: secondCycleSuccessText } })}'`,
      '  exit 0',
      'fi',
      `printf '%s\\n' '${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reviewText } })}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
}

export function localStore(dir) {
  return {
    dir,
    async write(name, content) {
      const filePath = path.join(dir, name);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, String(content || ''), 'utf8');
      return filePath;
    },
  };
}

export function localCycleState(cwd, {
  dir = path.join(cwd, 'store'),
  kind = 'review',
  providers = [{ id: 'mock' }],
  parallel = false,
  json = true,
  options = {},
} = {}) {
  return createCycleState({
    kind,
    store: localStore(dir),
    workspace: { mode: 'current', cwd },
    context: { repoRoot: cwd, branch: '', status: '', diffStat: '', diff: '' },
    options: {
      providers,
      primaryProvider: providers[0],
      providerIds: providers.map((provider) => provider.id),
      model: '',
      changed: false,
      fix: false,
      worktree: false,
      keepWorktree: false,
      allowDirty: false,
      serial: !parallel,
      parallel,
      failOnIssues: false,
      json,
      timeoutMs: 30_000,
      maxCycles: 1,
      maxImplementers: 1,
      providerRetries: 0,
      testCommand: '',
      ...options,
    },
  });
}

export function commandPathFromLog(stdout, label, kind) {
  const match = stdout.match(new RegExp(`\\[${label}\\] ${kind}: (.+)`));
  assert.ok(match, `missing ${label} ${kind} path in output:\n${stdout}`);
  return match[1];
}

export function normalizeReport(report, repoRoot) {
  return report
    .replace(/^Run: .+$/m, 'Run: <run>')
    .replace(/^Repository: .+$/m, `Repository: ${repoRoot}`);
}
