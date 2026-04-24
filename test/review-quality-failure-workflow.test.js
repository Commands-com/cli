import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runQualityCommand } from '../src/quality.js';
import { runReviewCommand } from '../src/review.js';
import {
  captureWorkflowCommand as captureCommand,
  captureWorkflowCommandFailure as captureCommandFailure,
} from './support/workflow-fixtures.js';

import {
  parsed,
  tempDir,
  initGitRepo,
  writeCountingCodex,
  writeRetryOnceCodex,
  writeSecondCycleFailureCodex,
  writePartialSecondCycleFailureCodex,
  commandPathFromLog,
} from './support/review-quality-workflow-fixtures.js';

test('runReviewCommand logs provider retry and keeps reviewer artifact path stable', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const reviewText = [
      '```yaml',
      'verdict: issues',
      'issue_count: 1',
      '```',
      '',
      'codex retry review finding',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeRetryOnceCodex(binDir, { successText: reviewText });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['retry logging'], { provider: 'codex', reviewers: 'correctness', retries: '1' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const reportPath = commandPathFromLog(result.stdout, 'review', 'report');

    assert.match(result.stdout, /\[review\] codex\/correctness: retry 1\/1 after transient provider failure/);
    assert.equal(
      await fs.readFile(path.join(path.dirname(reportPath), 'cycle-1/reviewers/codex/01-correctness.md'), 'utf8'),
      reviewText,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand falls back to reviewer summaries when synthesis fails', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const reviewText = [
      '```yaml',
      'verdict: issues',
      'issue_count: 2',
      '```',
      '',
      'codex fake review finding',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeCountingCodex(binDir, {
      firstText: reviewText,
      failureMessage: 'synthesis failed hard',
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['fallback'], { provider: 'codex', reviewers: 'correctness', json: 'true' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);

    assert.equal(output.cycles[0].issueCount, 2);
    assert.equal(output.cycles[0].reviewerIssueCount, 2);
    assert.equal(output.cycles[0].synthesis, '');
    assert.match(output.cycles[0].synthesisError, /codex exited with 1/);
    assert.match(output.cycles[0].synthesisError, /synthesis failed hard/);
    const report = await fs.readFile(output.reportPath, 'utf8');
    assert.match(report, /Synthesis Error/);
    assert.match(report, /codex fake review finding/);
    assert.match(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'cycle-1/synthesis-error.md'), 'utf8'),
      /synthesis failed hard/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand falls back to provider summaries when synthesis fails', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const auditText = [
      '```yaml',
      'score: B',
      'verdict: issues',
      'issue_count: 1',
      'summary: Codex found one maintainability issue.',
      '```',
      '',
      'codex fake quality finding',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeCountingCodex(binDir, {
      firstText: auditText,
      failureMessage: 'quality synthesis failed hard',
    });

    const result = await captureCommand(
      runQualityCommand,
      parsed([], { provider: 'codex', area: 'maintainability', json: 'true' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);

    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 1);
    assert.equal(output.cycles[0].providerIssueCount, 1);
    assert.equal(output.cycles[0].synthesis, '');
    assert.match(output.cycles[0].synthesisError, /quality synthesis failed hard/);
    const report = await fs.readFile(output.reportPath, 'utf8');
    assert.match(report, /Synthesis Error/);
    assert.match(report, /codex fake quality finding/);
    assert.match(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'cycle-1/synthesis-error.md'), 'utf8'),
      /quality synthesis failed hard/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand preserves completed cycle artifacts when a later fix cycle fails', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const reviewText = [
      '```yaml',
      'verdict: issues',
      'issue_count: 1',
      '```',
      '',
      'codex first cycle finding',
    ].join('\n');
    const implementationPlanText = [
      '```json',
      JSON.stringify({
        tasks: [
          {
            id: 'task-1',
            title: 'Apply safe fix',
            files: ['README.md'],
            instructions: 'Apply a safe fix.',
          },
        ],
      }, null, 2),
      '```',
    ].join('\n');
    const implementationText = 'Codex implementer completed the safe fix.';
    const binDir = path.join(cwd, 'bin');
    await writeSecondCycleFailureCodex(binDir, {
      reviewText,
      implementationPlanText,
      implementationText,
      failureMessage: 'cycle two fanout failed',
    });

    const result = await captureCommandFailure(
      runReviewCommand,
      parsed(['partial cycle'], {
        provider: 'codex',
        reviewers: 'correctness',
        fix: 'true',
        parallel: 'true',
        retries: '0',
        'max-cycles': '2',
        'max-implementers': '1',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const outputDir = commandPathFromLog(result.stdout, 'review', 'output');

    assert.match(result.error.message, /reviewer fan-out failed/);
    assert.match(result.error.message, /cycle two fanout failed/);
    assert.match(result.stdout, /\[review\] cycle 1: reviewers/);
    assert.match(result.stdout, /\[review\] cycle 2: reviewers/);
    assert.equal(
      await fs.readFile(path.join(outputDir, 'cycle-1/reviewers/codex/01-correctness.md'), 'utf8'),
      reviewText,
    );
    assert.equal(
      await fs.readFile(path.join(outputDir, 'cycle-1/implementation.md'), 'utf8'),
      [
        '## task-1: Apply safe fix',
        '',
        implementationText,
      ].join('\n'),
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand preserves successful parallel fan-out artifacts when a sibling reviewer fails', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const reviewText = [
      '```yaml',
      'verdict: issues',
      'issue_count: 1',
      '```',
      '',
      'codex first cycle finding',
    ].join('\n');
    const secondCycleSuccessText = [
      '```yaml',
      'verdict: clean',
      'issue_count: 0',
      '```',
      '',
      'codex second cycle correctness clean',
    ].join('\n');
    const implementationPlanText = [
      '```json',
      JSON.stringify({
        tasks: [
          {
            id: 'task-1',
            title: 'Apply safe fix',
            files: ['README.md'],
            instructions: 'Apply a safe fix.',
          },
        ],
      }, null, 2),
      '```',
    ].join('\n');
    const implementationText = 'Codex implementer completed the safe fix.';
    const binDir = path.join(cwd, 'bin');
    await writePartialSecondCycleFailureCodex(binDir, {
      reviewText,
      secondCycleSuccessText,
      implementationPlanText,
      implementationText,
      failureMessage: 'cycle two maintainability failed',
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['partial parallel cycle'], {
        provider: 'codex',
        reviewers: 'correctness,maintainability',
        fix: 'true',
        parallel: 'true',
        retries: '0',
        'max-cycles': '2',
        'max-implementers': '1',
        json: 'true',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );

    assert.equal(result.exitCode, 0);
    const payload = JSON.parse(result.stdout);
    const outputDir = path.dirname(payload.reportPath);

    const correctnessOutput = payload.cycles[1].reviewers.find((reviewer) => reviewer.role === 'correctness');
    assert.ok(correctnessOutput, 'expected the surviving correctness reviewer output in the payload');
    assert.match(correctnessOutput.text, /codex second cycle correctness clean/);

    const cycleTwoFailures = payload.cycles[1].fanoutFailures;
    assert.equal(cycleTwoFailures.length, 1);
    assert.equal(cycleTwoFailures[0].provider, 'codex');
    assert.equal(cycleTwoFailures[0].item, 'maintainability');
    assert.match(cycleTwoFailures[0].error, /cycle two maintainability failed/);

    assert.equal(
      await fs.readFile(path.join(outputDir, 'cycle-2/reviewers/codex/01-correctness.md'), 'utf8'),
      secondCycleSuccessText,
    );
    await assert.rejects(
      fs.readFile(path.join(outputDir, 'cycle-2/reviewers/codex/02-maintainability.md'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand and runQualityCommand block unsafe fix on dirty current worktrees', async () => {
  const cwd = await tempDir();
  try {
    await initGitRepo(cwd);
    await fs.writeFile(path.join(cwd, 'README.md'), '# Dirty\n', 'utf8');

    await assert.rejects(
      runReviewCommand(parsed(['dirty'], { provider: 'mock', fix: 'true', json: 'true' }), { cwd }),
      /--fix would edit a dirty working tree/,
    );
    await assert.rejects(
      runQualityCommand(parsed([], { provider: 'mock', area: 'maintainability', fix: 'true', json: 'true' }), { cwd }),
      /--fix would edit a dirty working tree/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand records test failure and fail-on-issues exitCode', async () => {
  const cwd = await tempDir();
  try {
    await initGitRepo(cwd);
    const result = await captureCommand(
      runReviewCommand,
      parsed(['failing validation'], {
        provider: 'mock',
        fix: 'true',
        'max-cycles': '1',
        test: 'node -e "process.exit(1)"',
        'fail-on-issues': 'true',
        json: 'true',
      }),
      cwd,
    );
    const output = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(output.unresolvedTestFailure, true);
    assert.equal(output.cycles[0].test.ok, false);
    assert.equal(output.cycles[0].test.exitCode, 1);
    assert.equal(output.cycles[0].issueCount, 1);
    assert.match(await fs.readFile(output.reportPath, 'utf8'), /Unresolved test failure: yes/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand records test failure, lowers score, and fail-on-issues exitCode', async () => {
  const cwd = await tempDir();
  try {
    await initGitRepo(cwd);
    const result = await captureCommand(
      runQualityCommand,
      parsed([], {
        provider: 'mock',
        area: 'maintainability',
        fix: 'true',
        'max-cycles': '1',
        test: 'node -e "process.exit(1)"',
        'fail-on-issues': 'true',
        json: 'true',
      }),
      cwd,
    );
    const output = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 1);
    assert.equal(output.score, 'F');
    assert.equal(output.unresolvedTestFailure, true);
    assert.equal(output.cycles[0].test.ok, false);
    assert.equal(output.cycles[0].test.exitCode, 1);
    assert.equal(output.cycles[0].score, 'F');
    assert.match(await fs.readFile(output.reportPath, 'utf8'), /### Test\n\nfailed with exit 1/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
