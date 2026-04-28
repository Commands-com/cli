import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { localRunsPath } from '../src/config.js';
import { initGitRepo, run, runCli, tempDir } from './support/cli.js';
import {
  countedCodexProviderScript,
  emitClaudeResult,
  emitCodexError,
  emitCodexMessage,
  writeFakeProvider,
} from './support/fake-provider.js';

async function withTempDir(callback) {
  const cwd = await tempDir();
  try {
    return await callback(cwd);
  } finally {
    await removeTree(cwd);
  }
}

async function withGitTempDir(callback) {
  return withTempDir(async (cwd) => {
    await initGitRepo(cwd);
    return callback(cwd);
  });
}

async function removeTree(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readRunMetadata(reportPath) {
  return readJson(path.join(path.dirname(reportPath), 'metadata.json'));
}

function parseStdoutJson(result) {
  return JSON.parse(result.stdout);
}

function assertCliOk(result) {
  assert.equal(result.ok, true, result.stderr);
  return parseStdoutJson(result);
}

function qualityProviderText({ score = 'B', issueCount = 1, summary }, body) {
  return [
    '```yaml',
    `score: ${score}`,
    'verdict: issues',
    `major_issue_count: ${issueCount}`,
    `summary: ${summary}`,
    '```',
    '',
    body,
  ].join('\n');
}

function reviewProviderText({ issueCount }, body) {
  return [
    '```yaml',
    'verdict: issues',
    `major_issue_count: ${issueCount}`,
    '```',
    '',
    body,
  ].join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('review e2e supports boolean flags before objective and writes artifacts', () => withTempDir(async (cwd) => {
  const result = await runCli(['review', '--json', 'fix tests', '--provider', 'mock'], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.type, 'review.completed');
  assert.deepEqual(parsed.providers, ['mock']);
  assert.equal(parsed.cycles[0].reviewerIssueCount, 3);
  assert.equal(parsed.cycles[0].issueCount, 1);
  assert.match(parsed.cycles[0].synthesis, /Mock synthesis/);

  const metadata = await readRunMetadata(parsed.reportPath);
  assert.equal(metadata.objective, 'fix tests');
  assert.equal(metadata.provider, 'mock');
  assert.deepEqual(metadata.providers, ['mock']);
  assert.equal(metadata.parallel, true);
  assert.equal(metadata.serial, false);
  assert.match(await fs.readFile(parsed.reportPath, 'utf8'), /Review Cycle: fix tests/);
}));

test('review e2e sanitizes reviewer names before writing files', () => withTempDir(async (cwd) => {
  const result = await runCli(['review', 'path traversal', '--provider', 'mock', '--reviewers', '../../outside'], cwd);
  assert.equal(result.ok, true, result.stderr);
  const runsRoot = localRunsPath(cwd);
  const outside = path.join(runsRoot, 'outside.md');
  await assert.rejects(fs.stat(outside), /ENOENT/);

  const runIds = await fs.readdir(runsRoot);
  assert.equal(runIds.length, 1);
  const safeFile = path.join(runsRoot, runIds[0], 'cycle-1', 'reviewers', 'mock', '01-outside.md');
  assert.equal((await fs.stat(safeFile)).isFile(), true);
}));

test('review e2e keeps duplicate reviewer artifact paths distinct', () => withTempDir(async (cwd) => {
  const result = await runCli(['review', 'duplicates', '--provider', 'mock', '--reviewers', 'tests,tests', '--json'], cwd);
  const parsed = assertCliOk(result);
  const reviewerDir = path.join(path.dirname(parsed.reportPath), 'cycle-1', 'reviewers', 'mock');
  assert.equal((await fs.stat(path.join(reviewerDir, '01-tests.md'))).isFile(), true);
  assert.equal((await fs.stat(path.join(reviewerDir, '02-tests.md'))).isFile(), true);
}));

test('quality terminal output renders human-readable progress', () => withTempDir(async (cwd) => {
  const result = await runCli(['quality', '--provider', 'mock', '--area', 'maintainability'], cwd);
  assert.equal(result.ok, true, result.stderr);
  // Structural data assertions live in the --json sibling test below; this
  // smoke check only verifies the human-readable renderer wrote a [quality]
  // log line so the no-JSON branch is exercised in CI.
  assert.match(result.stdout, /\[quality\] /);
}));

test('quality json includes score, synopsis, and final outputs', () => withTempDir(async (cwd) => {
  const result = await runCli(['quality', '--provider', 'mock', '--area', 'maintainability', '--json'], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.type, 'quality.completed');
  assert.deepEqual(parsed.providers, ['mock']);
  assert.equal(parsed.synthesizerProvider, 'mock');
  assert.equal(parsed.score, 'B');
  assert.equal(parsed.issueCount, 1);
  assert.match(parsed.synopsis, /One mock quality issue/);
  assert.equal(parsed.cycles[0].synthesis, '');
  assert.equal(parsed.outputs[0].area, 'maintainability');
  assert.equal(parsed.outputs[0].provider, 'mock');
  assert.equal(parsed.outputs[0].score, 'B');
  const metadata = await readRunMetadata(parsed.reportPath);
  assert.equal(metadata.parallel, true);
  assert.equal(metadata.serial, false);
  assert.match(await fs.readFile(parsed.reportPath, 'utf8'), /Score: B/);
}));

test('quality --providers all fans out and synthesizes scores', () => withTempDir(async (cwd) => {
  const binDir = path.join(cwd, 'bin');
  const codexText = qualityProviderText({
    summary: 'Codex found one maintainability issue.',
  }, 'codex fake quality finding');
  const codexSynthesisText = qualityProviderText({
    score: 'C',
    issueCount: 2,
    summary: 'Synthesis chose C because providers found overlapping maintainability risk.',
  }, 'Synthesis fake quality finding');
  const claudeText = qualityProviderText({
    score: 'C',
    issueCount: 2,
    summary: 'Claude found two maintainability issues.',
  }, 'claude fake quality finding');
  await writeFakeProvider(binDir, 'codex', countedCodexProviderScript({
    first: emitCodexMessage(codexText),
    retry: emitCodexMessage(codexSynthesisText),
  }));
  await writeFakeProvider(binDir, 'claude', emitClaudeResult(claudeText));

  const result = await runCli(['quality', '--providers', 'all', '--area', 'maintainability', '--json'], cwd, {
    env: { PATH: binDir },
  });
  const parsed = assertCliOk(result);
  assert.deepEqual(parsed.providers, ['codex', 'claude']);
  assert.equal(parsed.synthesizerProvider, 'codex');
  assert.equal(parsed.implementerProvider, 'codex');
  assert.equal(parsed.score, 'C');
  assert.equal(parsed.issueCount, 2);
  assert.equal(parsed.cycles[0].providerIssueCount, 3);
  assert.deepEqual(parsed.cycles[0].outputs.map((output) => output.provider), ['codex', 'claude']);
  assert.match(parsed.cycles[0].synthesis, /Synthesis fake quality finding/);
}));

test('quality falls back to provider summaries when synthesis fails', () => withTempDir(async (cwd) => {
  const binDir = path.join(cwd, 'bin');
  const auditText = qualityProviderText({
    summary: 'Codex found one maintainability issue.',
  }, 'codex fake quality finding');
  const cleanText = [
    '```yaml',
    'score: A',
    'verdict: clean',
    'major_issue_count: 0',
    'summary: Claude found no maintainability issues.',
    '```',
    '',
    'claude fake quality finding',
  ].join('\n');
  await writeFakeProvider(binDir, 'codex', [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "if (prompt.includes('\"kind\":\"quality-synthesis\"')) {",
    `  ${emitCodexError('model overloaded during synthesis')}`,
    '  process.exit(1);',
    '}',
    emitCodexMessage(auditText),
  ]);
  await writeFakeProvider(binDir, 'claude', [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "if (prompt.includes('\"kind\":\"quality-synthesis\"')) {",
    "  console.error('claude synthesis unavailable');",
    '  process.exit(1);',
    '}',
    emitClaudeResult(cleanText),
  ]);

  const result = await runCli(['quality', '--providers', 'all', '--area', 'maintainability', '--json'], cwd, {
    env: { PATH: binDir },
  });
  const parsed = assertCliOk(result);
  assert.equal(parsed.score, 'B');
  assert.equal(parsed.issueCount, 1);
  assert.equal(parsed.cycles[0].synthesis, '');
  assert.match(parsed.cycles[0].synthesisError, /claude exited with 1/);
  assert.match(parsed.cycles[0].synthesisError, /claude synthesis unavailable/);
  const runDir = path.dirname(parsed.reportPath);
  assert.match(await fs.readFile(path.join(runDir, 'cycle-1', 'synthesis-error.md'), 'utf8'), /claude synthesis unavailable/);
  assert.match(await fs.readFile(parsed.reportPath, 'utf8'), /Synthesis Error/);
}));

test('quality --fix implements then re-reviews', () => withGitTempDir(async (cwd) => {
  const result = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability',
    '--fix',
    '--max-cycles',
    '2',
    '--json',
  ], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.cycles.length, 2);
  assert.equal(parsed.cycles[0].score, 'B');
  assert.equal(parsed.cycles[0].synthesis, '');
  assert.deepEqual(parsed.cycles[0].implementationBatches, [['task-1', 'task-2']]);
  assert.equal(parsed.cycles[0].implementations.length, 2);
  assert.match(parsed.cycles[0].implementation, /Mock implementer/);
  assert.equal(parsed.cycles[1].score, 'A');
  assert.equal(parsed.cycles[1].issueCount, 0);
  assert.equal(parsed.score, 'A');
}));

test('quality --fix defaults to three max cycles', () => withGitTempDir(async (cwd) => {
  const result = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability',
    '--fix',
    '--json',
  ], cwd);
  const parsed = assertCliOk(result);
  const metadata = await readRunMetadata(parsed.reportPath);
  assert.equal(metadata.maxCycles, 3);
  assert.equal(metadata.maxImplementers, 15);
}));

test('quality --fix treats --max-implementers as the orchestrator cap', () => withGitTempDir(async (cwd) => {
  const result = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability',
    '--fix',
    '--max-cycles',
    '1',
    '--max-implementers',
    '1',
    '--json',
  ], cwd);
  const parsed = assertCliOk(result);
  assert.deepEqual(parsed.cycles[0].implementationBatches, [['task-1']]);
  assert.equal(parsed.cycles[0].implementations.length, 1);
  const metadata = await readRunMetadata(parsed.reportPath);
  assert.equal(metadata.maxImplementers, 1);
}));

test('review --providers all fans out across available provider CLIs and synthesizes', () => withTempDir(async (cwd) => {
  const binDir = path.join(cwd, 'bin');
  const codexText = reviewProviderText({ issueCount: 1 }, 'codex fake finding');
  const claudeText = reviewProviderText({ issueCount: 1 }, 'claude fake finding');
  await writeFakeProvider(binDir, 'codex', emitCodexMessage(codexText));
  await writeFakeProvider(binDir, 'claude', emitClaudeResult(claudeText));

  const result = await runCli(['review', 'fanout', '--providers', 'all', '--json'], cwd, {
    env: { PATH: binDir },
  });
  const parsed = assertCliOk(result);
  assert.deepEqual(parsed.providers, ['codex', 'claude']);
  assert.equal(parsed.synthesizerProvider, 'codex');
  const metadata = await readRunMetadata(parsed.reportPath);
  assert.equal(metadata.parallel, true);
  assert.equal(metadata.serial, false);
  assert.equal(parsed.cycles[0].reviewers.length, 6);
  assert.equal(parsed.cycles[0].reviewerIssueCount, 6);
  assert.match(parsed.cycles[0].synthesis, /codex fake finding/);
}));

test('review falls back to reviewer summaries when synthesis fails', () => withTempDir(async (cwd) => {
  const binDir = path.join(cwd, 'bin');
  const reviewText = reviewProviderText({ issueCount: 2 }, 'codex fake review finding');
  await writeFakeProvider(binDir, 'codex', [
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    "if (prompt.includes('\"kind\":\"review-synthesis\"')) {",
    `  ${emitCodexError('synthesis quota exhausted')}`,
    '  process.exit(1);',
    '}',
    emitCodexMessage(reviewText),
  ]);

  const result = await runCli(['review', 'synthesis fallback', '--provider', 'codex', '--reviewers', 'correctness,tests', '--json'], cwd, {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  const parsed = assertCliOk(result);
  assert.equal(parsed.cycles[0].issueCount, 4);
  assert.equal(parsed.cycles[0].reviewerIssueCount, 4);
  assert.equal(parsed.cycles[0].synthesis, '');
  assert.match(parsed.cycles[0].synthesisError, /codex exited with 1/);
  assert.match(parsed.cycles[0].synthesisError, /synthesis quota exhausted/);
  assert.match(await fs.readFile(parsed.reportPath, 'utf8'), /Synthesis Error/);
}));

test('review --fix --worktree prunes an unchanged mock worktree', () => withGitTempDir(async (cwd) => {
  const result = await runCli([
    'review',
    'mock fix',
    '--provider',
    'mock',
    '--fix',
    '--worktree',
    '--max-cycles',
    '2',
    '--json',
  ], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.cycles.at(-1).issueCount, 0);
  assert.equal(parsed.workspace.prune.ok, true);
  await assert.rejects(fs.stat(parsed.workspace.cwd), /ENOENT/);
}));

test('review --fix --max-cycles=1 still runs one implementer pass', () => withGitTempDir(async (cwd) => {
  const result = await runCli([
    'review',
    'single implementer',
    '--provider',
    'mock',
    '--fix',
    '--max-cycles',
    '1',
    '--json',
  ], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.cycles.length, 1);
  assert.deepEqual(parsed.cycles[0].implementationBatches, [['task-1', 'task-2']]);
  assert.match(parsed.cycles[0].implementation, /Mock implementer/);
}));

test('review --fix test failures are visible to JSON and --fail-on-issues', () => withGitTempDir(async (cwd) => {
  const result = await runCli([
    'review',
    'failing validation',
    '--provider',
    'mock',
    '--fix',
    '--max-cycles',
    '1',
    '--test',
    'node -e "process.exit(1)"',
    '--fail-on-issues',
    '--json',
  ], cwd);
  assert.equal(result.ok, false);
  const parsed = parseStdoutJson(result);
  assert.equal(parsed.unresolvedTestFailure, true);
  assert.equal(parsed.cycles[0].test.ok, false);
  assert.equal(parsed.cycles[0].issueCount, 1);
}));

test('review --fix does not treat CLI-owned .commands-com/ artifacts as a dirty tree', () => withGitTempDir(async (cwd) => {
  // Simulate prior CLI state in a clean repo (what `init` or a prior report-only
  // run would leave behind).
  const runDir = localRunsPath(cwd, 'prior-run');
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(path.join(runDir, 'report.md'), 'stale\n', 'utf8');

  const result = await runCli(['review', 'second pass', '--provider', 'mock', '--fix', '--json'], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.type, 'review.completed');
  const metadata = await readRunMetadata(parsed.reportPath);
  assert.equal(metadata.maxCycles, 3);
  assert.equal(metadata.maxImplementers, 15);
}));

test('--cwd targets a different directory and writes runs there', async () => {
  const target = await tempDir();
  const elsewhere = await tempDir();
  try {
    const canonicalTarget = await fs.realpath(target);
    const result = await runCli(['review', 'cwd test', '--provider', 'mock', '--cwd', target, '--json'], elsewhere);
    const parsed = assertCliOk(result);
    const canonicalReportPath = await fs.realpath(parsed.reportPath);
    const relativeReportPath = path.relative(canonicalTarget, canonicalReportPath);
    assert.equal(
      Boolean(relativeReportPath && !relativeReportPath.startsWith('..') && !path.isAbsolute(relativeReportPath)),
      true,
      `reportPath should be under ${canonicalTarget}, got ${canonicalReportPath}`,
    );
    const runsRoot = localRunsPath(canonicalTarget);
    const runIds = await fs.readdir(runsRoot);
    assert.equal(runIds.length, 1);
    await assert.rejects(fs.stat(path.join(elsewhere, '.commands-com')), /ENOENT/);
  } finally {
    await removeTree(target);
    await removeTree(elsewhere);
  }
});

test('--cwd scopes provider workspace and repo context to the requested directory', async () => {
  const target = await tempDir();
  const elsewhere = await tempDir();
  try {
    await initGitRepo(target);
    const appDir = path.join(target, 'packages', 'app');
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, 'index.js'), 'console.log("app");\n', 'utf8');
    await run('git', ['add', 'packages/app/index.js'], target);
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test User', 'commit', '-m', 'app'], target);

    const result = await runCli(['review', 'cwd scope', '--provider', 'mock', '--cwd', appDir, '--json'], elsewhere);
    const parsed = assertCliOk(result);
    const realAppDir = await fs.realpath(appDir);
    const realTarget = await fs.realpath(target);
    assert.equal(parsed.workspace.cwd, realAppDir);
    const context = await fs.readFile(path.join(path.dirname(parsed.reportPath), 'context.md'), 'utf8');
    assert.match(context, new RegExp(`Repository: ${escapeRegExp(realAppDir)}`));
    assert.match(context, new RegExp(`Git root: ${escapeRegExp(realTarget)}`));
  } finally {
    await removeTree(target);
    await removeTree(elsewhere);
  }
});

test('--cwd rejects a missing directory with a usage error', async () => {
  const result = await runCli(['review', 'bad cwd', '--provider', 'mock', '--cwd', '/nonexistent/nope/never'], process.cwd());
  assert.equal(result.ok, false);
  assert.match(result.stderr, /--cwd path does not exist/);
});

test('CLI rejects unknown flags before command dispatch', () => withTempDir(async (cwd) => {
  const result = await runCli(['review', 'unknown flag', '--provider', 'mock', '--mystery'], cwd);
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /unknown option: --mystery/);
}));

test('CLI rejects flags used on the wrong command', () => withTempDir(async (cwd) => {
  const cases = [
    {
      args: ['doctor', '--area', 'maintainability', '--provider', 'mock'],
      message: /--area is not valid for doctor command/,
    },
    {
      args: ['quality', '--reviewers', 'tests', '--provider', 'mock'],
      message: /--reviewers is not valid for quality command/,
    },
    {
      args: ['review', 'wrong option', '--area', 'maintainability', '--provider', 'mock'],
      message: /--area is not valid for review command/,
    },
  ];

  for (const { args, message } of cases) {
    const result = await runCli(args, cwd);
    assert.equal(result.ok, false, args.join(' '));
    assert.equal(result.code, 2, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
}));

test('CLI rejects scoped flags on unknown commands before they can be ignored', () => withTempDir(async (cwd) => {
  const result = await runCli(['revieww', '--fix', '--json'], cwd);
  assert.equal(result.ok, false);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--fix is not valid for unknown command revieww/);
  assert.equal(result.stdout, '');
}));

test('CLI reports unknown commands when only common flags are present', () => withTempDir(async (cwd) => {
  const result = await runCli(['revieww', '--json'], cwd);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command: revieww/);
}));

test('review --fail-on-issues exits non-zero when final findings remain', () => withTempDir(async (cwd) => {
  const result = await runCli([
    'review',
    'final issue policy',
    '--provider',
    'mock',
    '--reviewers',
    'correctness',
    '--fail-on-issues',
    '--json',
  ], cwd);
  assert.equal(result.ok, false);
  assert.equal(result.code, 1);
  assert.equal(result.stderr, '');
  const parsed = parseStdoutJson(result);
  assert.equal(parsed.type, 'review.completed');
  assert.equal(parsed.unresolvedTestFailure, false);
  assert.equal(parsed.cycles[0].issueCount, 1);
  assert.equal(parsed.cycles[0].reviewerIssueCount, 1);
}));

test('quality records representative parsed options in run metadata', () => withTempDir(async (cwd) => {
  const testCommand = 'node -e "process.exit(0)"';
  const result = await runCli([
    'quality',
    '--provider',
    'mock',
    '--area',
    'maintainability,tests',
    '--changed',
    '--serial',
    '--retries',
    '0',
    '--timeout-ms',
    '1234',
    '--max-cycles',
    '2',
    '--max-implementers',
    '4',
    '--test',
    testCommand,
    '--json',
  ], cwd);
  const parsed = assertCliOk(result);
  const metadata = await readRunMetadata(parsed.reportPath);
  assert.deepEqual(metadata.areas, ['maintainability', 'tests']);
  assert.equal(metadata.changed, true);
  assert.equal(metadata.serial, true);
  assert.equal(metadata.parallel, false);
  assert.equal(metadata.providerRetries, 0);
  assert.equal(metadata.timeoutMs, 1234);
  assert.equal(metadata.maxCycles, 2);
  assert.equal(metadata.maxImplementers, 4);
  assert.equal(metadata.testCommand, testCommand);
}));

test('provider selection flags override saved runtime config', () => withTempDir(async (cwd) => {
  const configDir = path.join(cwd, '.commands-com');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'config.json'), JSON.stringify({
    providers: 'codex,claude',
    provider: 'codex',
    model: 'configured-model',
  }, null, 2), 'utf8');

  const result = await runCli(['review', 'metadata provider read', '--providers', 'mock', '--json'], cwd);
  const parsed = assertCliOk(result);
  assert.deepEqual(parsed.providers, ['mock']);

  const metadata = await readRunMetadata(parsed.reportPath);
  assert.deepEqual(metadata.providers, ['mock']);
}));

test('doctor --ping checks provider responses', () => withTempDir(async (cwd) => {
  const result = await runCli(['doctor', '--ping', '--provider', 'mock', '--json'], cwd);
  const parsed = assertCliOk(result);
  assert.equal(parsed.type, 'doctor');
  assert.equal(parsed.pings.length, 1);
  assert.equal(parsed.pings[0].id, 'mock');
  assert.equal(parsed.pings[0].ok, true);
  assert.match(parsed.pings[0].text, /commands-com-provider-ok/);
}));

test('review --worktree prunes an unchanged worktree when provider fails', () => withGitTempDir(async (cwd) => {
  const binDir = path.join(cwd, 'bin');
  await writeFakeProvider(binDir, 'failing-provider', 'process.exit(1);');
  const result = await runCli([
    'review',
    'provider fails',
    '--provider',
    'failing-provider',
    '--worktree',
    '--json',
  ], cwd, { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } });
  assert.equal(result.ok, false);
  assert.match(result.stderr, /unsupported provider|failing-provider/);
  const listed = await run('git', ['worktree', 'list', '--porcelain'], cwd);
  assert.doesNotMatch(listed.stdout, /\.commands-com\/worktrees/);
}));
