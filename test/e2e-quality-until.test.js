import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initGitRepo, runCli, tempDir } from './support/cli.js';

test('quality --until A implies fix and runs until the target score', async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd);
  const result = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability',
    '--until',
    'A',
    '--json',
  ], cwd);
  assert.equal(result.ok, true, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.cycles.length, 2);
  assert.equal(parsed.cycles[0].score, 'B');
  assert.match(parsed.cycles[0].implementation, /Mock implementer/);
  assert.equal(parsed.cycles[1].score, 'A');
  assert.equal(parsed.score, 'A');
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(parsed.reportPath), 'metadata.json'), 'utf8'));
  assert.equal(metadata.fix, true);
  assert.equal(metadata.untilScore, 'A');
  assert.equal(metadata.maxCycles, 30);
  const finalSummary = JSON.parse(await fs.readFile(path.join(path.dirname(parsed.reportPath), 'final-summary.json'), 'utf8'));
  assert.equal(finalSummary.final.score, 'A');
  assert.equal(finalSummary.status, 'passed');
  assert.match(
    await fs.readFile(path.join(path.dirname(parsed.reportPath), 'final-report.md'), 'utf8'),
    /Quality Final Report/,
  );
  await fs.rm(cwd, { recursive: true, force: true });
});

test('review --until A implies fix and runs until the target score', async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd);
  const result = await runCli([
    'review',
    'tighten review loop',
    '--provider',
    'mock',
    '--reviewers',
    'correctness',
    '--until',
    'A',
    '--json',
  ], cwd);
  assert.equal(result.ok, true, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.cycles.length, 2);
  assert.equal(parsed.cycles[0].score, 'B');
  assert.match(parsed.cycles[0].implementation, /Mock implementer/);
  assert.equal(parsed.cycles[1].score, 'A');
  assert.equal(parsed.score, 'A');
  const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(parsed.reportPath), 'metadata.json'), 'utf8'));
  assert.equal(metadata.fix, true);
  assert.equal(metadata.untilScore, 'A');
  assert.equal(metadata.maxCycles, 30);
  const finalSummary = JSON.parse(await fs.readFile(path.join(path.dirname(parsed.reportPath), 'final-summary.json'), 'utf8'));
  assert.equal(finalSummary.final.score, 'A');
  assert.equal(finalSummary.status, 'passed');
  assert.match(
    await fs.readFile(path.join(path.dirname(parsed.reportPath), 'final-report.md'), 'utf8'),
    /Review Final Report/,
  );
  await fs.rm(cwd, { recursive: true, force: true });
});

test('quality --until A fails when max cycles end before the target score', async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd);
  const result = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability',
    '--until',
    'A',
    '--max-cycles',
    '1',
    '--json',
  ], cwd);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.cycles.length, 1);
  assert.equal(parsed.score, 'B');
  assert.match(parsed.cycles[0].implementation, /Mock implementer/);
  await fs.rm(cwd, { recursive: true, force: true });
});

test('quality --resume continues an until run from stored state', async () => {
  const cwd = await tempDir();
  await initGitRepo(cwd);
  const first = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability',
    '--until',
    'A',
    '--max-cycles',
    '1',
    '--json',
  ], cwd);
  assert.equal(first.ok, false);
  const firstPayload = JSON.parse(first.stdout);
  const runDir = path.dirname(firstPayload.reportPath);
  const state = JSON.parse(await fs.readFile(path.join(runDir, 'run-state.json'), 'utf8'));
  assert.equal(state.status, 'completed');
  assert.equal(state.cycles.length, 1);

  const resumed = await runCli([
    'quality',
    '--resume',
    firstPayload.runId,
    '--max-cycles',
    '2',
    '--json',
  ], cwd, { env: { PATH: providerlessPath() } });
  assert.equal(resumed.ok, true, resumed.stderr);
  const resumedPayload = JSON.parse(resumed.stdout);
  assert.equal(resumedPayload.runId, firstPayload.runId);
  assert.equal(resumedPayload.cycles.length, 2);
  assert.equal(resumedPayload.cycles[1].score, 'A');
  assert.equal(resumedPayload.score, 'A');
  await fs.rm(cwd, { recursive: true, force: true });
});

function providerlessPath() {
  if (process.platform === 'win32') return process.env.PATH || '';
  return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
}
