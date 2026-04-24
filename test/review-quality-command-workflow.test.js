import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runQualityCommand } from '../src/quality.js';
import { runReviewCommand } from '../src/review.js';
import { createCycleRunContext } from '../src/cycle-state.js';
import {
  captureCommandResultLogs as captureLogs,
  captureWorkflowCommand as captureCommand,
} from './support/workflow-fixtures.js';

import {
  parsed,
  tempDir,
  writeOutputAndSynthesisCodex,
  normalizeReport,
} from './support/review-quality-workflow-fixtures.js';

test('runReviewCommand JSON contract includes report path and content', async () => {
  const cwd = await tempDir();
  try {
    const result = await captureCommand(
      runReviewCommand,
      parsed(['contract review'], { provider: 'mock', reviewers: 'correctness', json: 'true' }),
      cwd,
    );
    const output = JSON.parse(result.stdout);

    assert.equal(output.type, 'review.completed');
    assert.deepEqual(output.providers, ['mock']);
    assert.equal(output.synthesizerProvider, 'mock');
    assert.equal(output.implementerProvider, 'mock');
    assert.equal(output.unresolvedTestFailure, false);
    assert.equal(output.cycles[0].reviewers.length, 1);
    assert.equal(path.basename(output.reportPath), 'review-cycle.md');
    assert.equal(result.exitCode, 0);

    const report = await fs.readFile(output.reportPath, 'utf8');
    assert.match(report, /# Review Cycle: contract review/);
    assert.match(report, /Reviewer issue count: 1/);
    assert.match(report, /Mock synthesis/);
    assert.equal(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'prompts/cycle-1-mock-01-correctness.md'), 'utf8')
        .then((text) => text.includes('You are the correctness reviewer in a Commands.com review cycle.')),
      true,
    );
    assert.equal(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'cycle-1/reviewers/mock/01-correctness.md'), 'utf8'),
      output.cycles[0].reviewers[0].text,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand JSON contract includes final score and report content', async () => {
  const cwd = await tempDir();
  try {
    const result = await captureCommand(
      runQualityCommand,
      parsed([], { provider: 'mock', area: 'maintainability', json: 'true' }),
      cwd,
    );
    const output = JSON.parse(result.stdout);

    assert.equal(output.type, 'quality.completed');
    assert.equal(output.provider, 'mock');
    assert.deepEqual(output.providers, ['mock']);
    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 1);
    assert.equal(output.outputs[0].area, 'maintainability');
    assert.equal(path.basename(output.reportPath), 'code-quality.md');
    assert.equal(result.exitCode, 0);

    const report = await fs.readFile(output.reportPath, 'utf8');
    assert.match(report, /# Code Quality Report/);
    assert.match(report, /Score: B/);
    assert.match(report, /Mock quality synthesis/);
    assert.equal(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'prompts/cycle-1-mock-maintainability.md'), 'utf8')
        .then((text) => text.includes('You are running a Commands.com code quality audit for area: maintainability.')),
      true,
    );
    assert.equal(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'cycle-1/areas/mock/maintainability.md'), 'utf8'),
      output.outputs[0].text,
    );
    assert.equal(
      await fs.readFile(path.join(path.dirname(output.reportPath), 'areas/mock/maintainability.md'), 'utf8'),
      output.outputs[0].text,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand --fail-on-issues fails when final quality issues remain', async () => {
  const cwd = await tempDir();
  try {
    const result = await captureCommand(
      runQualityCommand,
      parsed([], {
        provider: 'mock',
        area: 'maintainability',
        json: 'true',
        'fail-on-issues': 'true',
      }),
      cwd,
    );
    const output = JSON.parse(result.stdout);
    const finalSummary = JSON.parse(await fs.readFile(output.finalSummaryPath, 'utf8'));

    assert.equal(result.exitCode, 1);
    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 1);
    assert.equal(output.final.status, 'issues');
    assert.equal(finalSummary.status, 'issues');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand --until B passes when target score is met with remaining issues', async () => {
  const cwd = await tempDir();
  try {
    const result = await captureCommand(
      runQualityCommand,
      parsed([], {
        provider: 'mock',
        area: 'maintainability',
        json: 'true',
        until: 'B',
        'max-cycles': '1',
      }),
      cwd,
    );
    const output = JSON.parse(result.stdout);
    const finalSummary = JSON.parse(await fs.readFile(output.finalSummaryPath, 'utf8'));

    assert.equal(result.exitCode, 0);
    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 1);
    assert.equal(output.final.status, 'passed');
    assert.equal(finalSummary.status, 'passed');
    assert.equal(finalSummary.targetScore, 'B');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand --until B passes at target score with zero issues', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const summaryText = scoreText('B', 0, 'Review synthesis reached target score B with no issues.');
    const binDir = path.join(cwd, 'bin');
    await writeAssessmentInvariantCodex(binDir, {
      synthesisKind: 'review-synthesis',
      summaryText,
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['until B clean target'], {
        provider: 'codex',
        reviewers: 'correctness',
        json: 'true',
        until: 'B',
        'max-cycles': '2',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);

    assert.equal(result.exitCode, 0);
    assert.equal(output.cycles.length, 1);
    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 0);
    assert.equal(output.final.status, 'passed');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand --until B passes at target score when issues remain', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const summaryText = unresolvedScoreBText('Review synthesis kept one issue at target score B.');
    const binDir = path.join(cwd, 'bin');
    await writeAssessmentInvariantCodex(binDir, {
      synthesisKind: 'review-synthesis',
      summaryText,
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['until B remaining issues'], {
        provider: 'codex',
        reviewers: 'correctness',
        json: 'true',
        until: 'B',
        'max-cycles': '2',
        'max-implementers': '1',
        retries: '0',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const finalSummary = JSON.parse(await fs.readFile(output.finalSummaryPath, 'utf8'));

    assert.equal(result.exitCode, 0);
    assert.equal(output.cycles.length, 1);
    assert.equal(output.cycles[0].score, 'B');
    assert.equal(output.cycles[0].issueCount, 1);
    assert.equal(output.cycles[0].implementation, undefined);
    assert.equal(output.final.status, 'passed');
    assert.equal(finalSummary.status, 'passed');
    assert.equal(finalSummary.targetScore, 'B');
    assert.equal(finalSummary.cycles, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand --until B passes at target score when issues remain', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const summaryText = unresolvedScoreBText('Quality synthesis kept one issue at target score B.');
    const binDir = path.join(cwd, 'bin');
    await writeAssessmentInvariantCodex(binDir, {
      synthesisKind: 'quality-synthesis',
      summaryText,
    });

    const result = await captureCommand(
      runQualityCommand,
      parsed([], {
        provider: 'codex',
        area: 'maintainability',
        json: 'true',
        until: 'B',
        'max-cycles': '2',
        'max-implementers': '1',
        retries: '0',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const finalSummary = JSON.parse(await fs.readFile(output.finalSummaryPath, 'utf8'));

    assert.equal(result.exitCode, 0);
    assert.equal(output.cycles.length, 1);
    assert.equal(output.cycles[0].score, 'B');
    assert.equal(output.cycles[0].issueCount, 1);
    assert.equal(output.cycles[0].implementation, undefined);
    assert.equal(output.final.status, 'passed');
    assert.equal(finalSummary.status, 'passed');
    assert.equal(finalSummary.targetScore, 'B');
    assert.equal(finalSummary.cycles, 1);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('unresolved validation failure keeps a clean quality cycle fixable', async () => {
  const cleanCycle = {
    score: 'A',
    issueCount: 0,
    providerIssueCount: 0,
    synopsis: 'Quality is clean but validation is still failing.',
    outputs: [],
  };
  let fixable = false;

  await captureLogs(() => runQualityCommand(parsed([], { area: 'maintainability', json: 'true' }), {
    cwd: '/unit/repo',
    dependencies: {
      runCycleWorkflow: async (_actualParsed, options) => {
        const state = {
          kind: 'quality',
          store: { runId: 'quality-validation-failure', async write(name) { return `/unit/${name}`; } },
          options: { providerIds: ['unit'], primaryProvider: { id: 'unit' }, model: '', json: true, fix: true },
          context: { repoRoot: '/unit/repo', branch: 'main', status: '', diffStat: '', diff: '' },
          workspace: { mode: 'current', cwd: '/unit/repo' },
          logger: options.logger,
          cycles: [],
          priorFindings: '',
          hasUnresolvedTestFailure: true,
          stopReason: '',
        };
        const runContext = createCycleRunContext(state);
        fixable = options.adapter.hasFixableIssues({
          runContext, cycle: 1, context: state.context, cycleRecord: cleanCycle,
        });
        state.cycles.push({ cycle: 1, ...cleanCycle });
        return state;
      },
    },
  }));

  assert.equal(fixable, true);
});

test('runReviewCommand summarize contract records synthesis summary and reviewer fallback count', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const reviewText = [
      '```yaml',
      'verdict: issues',
      'issue_count: 2',
      '```',
      '',
      'codex reviewer output found two candidate issues.',
    ].join('\n');
    const synthesisText = [
      '```yaml',
      'verdict: clean',
      'issue_count: 0',
      '```',
      '',
      'codex synthesis marked the reviewer candidates non-actionable.',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeOutputAndSynthesisCodex(binDir, {
      outputText: reviewText,
      synthesisText,
      synthesisKind: 'review-synthesis',
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['summary contract'], { provider: 'codex', reviewers: 'correctness', json: 'true' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const cycle = output.cycles[0];

    assert.equal(cycle.issueCount, 0);
    assert.equal(cycle.reviewerIssueCount, 2);
    assert.equal(cycle.synthesis, synthesisText);
    assert.equal(cycle.synthesisError, '');
    assert.equal(cycle.reviewers[0].text, reviewText);
    assert.match(await fs.readFile(output.reportPath, 'utf8'), /Reviewer issue count: 2/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand summarize contract records synthesis summary and provider fallback count', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const auditText = [
      '```yaml',
      'score: D',
      'verdict: issues',
      'issue_count: 4',
      'summary: Provider output found four maintainability issues.',
      '```',
      '',
      'codex quality output found four candidate maintainability issues.',
    ].join('\n');
    const synthesisText = [
      '```yaml',
      'score: A',
      'verdict: clean',
      'issue_count: 0',
      'summary: Synthesis marked provider findings non-actionable.',
      '```',
      '',
      'codex quality synthesis marked the provider candidates non-actionable.',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeOutputAndSynthesisCodex(binDir, {
      outputText: auditText,
      synthesisText,
      synthesisKind: 'quality-synthesis',
    });

    const result = await captureCommand(
      runQualityCommand,
      parsed([], { provider: 'codex', area: 'maintainability', json: 'true' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const cycle = output.cycles[0];

    assert.equal(output.score, 'A');
    assert.equal(output.issueCount, 0);
    assert.equal(output.synopsis, 'Synthesis marked provider findings non-actionable.');
    assert.equal(cycle.providerIssueCount, 4);
    assert.equal(cycle.outputs[0].score, 'D');
    assert.equal(cycle.outputs[0].issueCount, 4);
    assert.equal(cycle.synthesis, synthesisText);
    assert.equal(cycle.synthesisError, '');
    assert.match(await fs.readFile(output.reportPath, 'utf8'), /Provider issue count: 4/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand reuses reviewer summary when synthesis output is blank', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const reviewText = [
      '```yaml',
      'verdict: issues',
      'issue_count: 2',
      '```',
      '',
      'codex reviewer output found two actionable issues.',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeOutputAndSynthesisCodex(binDir, {
      outputText: reviewText,
      synthesisText: '   \n  ',
      synthesisKind: 'review-synthesis',
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['blank synthesis fallback'], { provider: 'codex', reviewers: 'correctness', json: 'true' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const cycle = output.cycles[0];

    assert.equal(cycle.issueCount, 2);
    assert.equal(cycle.reviewerIssueCount, 2);
    assert.equal(cycle.reviewers[0].text, reviewText);
    assert.equal(cycle.synthesis.trim(), '');
    assert.equal(cycle.synthesisError, '');
    assert.match(await fs.readFile(output.reportPath, 'utf8'), /Reviewer issue count: 2/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand reuses provider summary when synthesis output is blank', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const auditText = [
      '```yaml',
      'score: D',
      'verdict: issues',
      'issue_count: 4',
      'summary: Provider output found four maintainability issues.',
      '```',
      '',
      'codex quality output found four candidate maintainability issues.',
    ].join('\n');
    const binDir = path.join(cwd, 'bin');
    await writeOutputAndSynthesisCodex(binDir, {
      outputText: auditText,
      synthesisText: '   \n  ',
      synthesisKind: 'quality-synthesis',
    });

    const result = await captureCommand(
      runQualityCommand,
      parsed([], { provider: 'codex', area: 'maintainability', json: 'true' }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const cycle = output.cycles[0];

    assert.equal(output.score, 'D');
    assert.equal(output.issueCount, 4);
    assert.equal(output.synopsis, '4 issues across 1 area. maintainability: D, 4 issues - Provider output found four maintainability issues.');
    assert.equal(cycle.providerIssueCount, 4);
    assert.equal(cycle.outputs[0].issueCount, 4);
    assert.equal(cycle.synthesis.trim(), '');
    assert.equal(cycle.synthesisError, '');
    assert.match(await fs.readFile(output.reportPath, 'utf8'), /Provider issue count: 4/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand report output remains stable for a single mock area', async () => {
  const cwd = await tempDir();
  try {
    const result = await captureCommand(
      runQualityCommand,
      parsed([], { provider: 'mock', area: 'maintainability', json: 'true' }),
      cwd,
    );
    const output = JSON.parse(result.stdout);
    const report = normalizeReport(await fs.readFile(output.reportPath, 'utf8'), '<repo>');

    assert.equal(report, [
      '# Code Quality Report',
      '',
      'Run: <run>',
      'Providers: mock',
      'Synthesizer/implementer: mock',
      'Repository: <repo>',
      'Workspace mode: current',
      'Score: B',
      'Issue count: 1',
      'Synopsis: Mock quality synthesis found one actionable issue.',
      '',
      '',
      '',
      '',
      '',
      '## Cycle 1',
      'Score: B',
      'Issue count: 1',
      'Provider issue count: 1',
      'Synopsis: Mock quality synthesis found one actionable issue.',
      '### Synthesis (mock)',
      '',
      '```yaml',
      'score: B',
      'verdict: issues',
      'issue_count: 1',
      'summary: Mock quality synthesis found one actionable issue.',
      '```',
      '',
      'Mock quality synthesis: provider outputs agree there is one actionable quality issue.',
      '### mock / maintainability',
      '',
      '```yaml',
      'score: B',
      'verdict: issues',
      'issue_count: 1',
      'summary: One mock quality issue was found in this area.',
      '```',
      '',
      'Mock provider finding: this quality run path is wired correctly. Replace --provider mock with codex, claude, or gemini for real output.',
      '',
    ].join('\n'));
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runReviewCommand --until A fails when synthesis reports score A with issues', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const summaryText = unresolvedScoreAText('Review synthesis kept an issue with score A.');
    const binDir = path.join(cwd, 'bin');
    await writeAssessmentInvariantCodex(binDir, {
      synthesisKind: 'review-synthesis',
      summaryText,
    });

    const result = await captureCommand(
      runReviewCommand,
      parsed(['until invariant'], {
        provider: 'codex',
        reviewers: 'correctness',
        json: 'true',
        until: 'A',
        'max-cycles': '1',
        'max-implementers': '1',
        retries: '0',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const finalSummary = JSON.parse(await fs.readFile(output.finalSummaryPath, 'utf8'));

    assert.equal(result.exitCode, 1);
    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 1);
    assert.equal(output.final.status, 'issues');
    assert.equal(finalSummary.status, 'issues');
    assert.equal(finalSummary.final.score, 'B');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('runQualityCommand --until A fails when synthesis reports score A with issues', { skip: process.platform === 'win32' }, async () => {
  const cwd = await tempDir();
  try {
    const summaryText = unresolvedScoreAText('Quality synthesis kept an issue with score A.');
    const binDir = path.join(cwd, 'bin');
    await writeAssessmentInvariantCodex(binDir, {
      synthesisKind: 'quality-synthesis',
      summaryText,
    });

    const result = await captureCommand(
      runQualityCommand,
      parsed([], {
        provider: 'codex',
        area: 'maintainability',
        json: 'true',
        until: 'A',
        'max-cycles': '1',
        'max-implementers': '1',
        retries: '0',
      }),
      cwd,
      { env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` } },
    );
    const output = JSON.parse(result.stdout);
    const finalSummary = JSON.parse(await fs.readFile(output.finalSummaryPath, 'utf8'));

    assert.equal(result.exitCode, 1);
    assert.equal(output.score, 'B');
    assert.equal(output.issueCount, 1);
    assert.equal(output.final.status, 'issues');
    assert.equal(finalSummary.status, 'issues');
    assert.equal(finalSummary.final.score, 'B');
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

function scoreText(score, issueCount, summary) {
  return [
    '```yaml',
    `score: ${score}`,
    `verdict: ${issueCount > 0 ? 'issues' : 'clean'}`,
    `issue_count: ${issueCount}`,
    `summary: ${summary}`,
    '```',
    '',
    issueCount > 0
      ? 'The body still describes one actionable issue.'
      : 'The body confirms there are no actionable issues.',
  ].join('\n');
}

function unresolvedScoreAText(summary) { return unresolvedScoreText('A', summary); }

function unresolvedScoreBText(summary) { return unresolvedScoreText('B', summary); }

function unresolvedScoreText(score, summary) {
  return scoreText(score, 1, summary);
}

async function writeAssessmentInvariantCodex(binDir, {
  synthesisKind,
  summaryText,
}) {
  await fs.mkdir(binDir, { recursive: true });
  const provider = path.join(binDir, 'codex');
  const implementationPlan = [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'No-op invariant task',
          files: [],
          instructions: 'Do not change files for this invariant regression.',
        },
      ],
    }, null, 2),
    '```',
  ].join('\n');
  await fs.writeFile(
    provider,
    [
      '#!/bin/sh',
      'prompt=$(cat)',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-plan"\'; then',
      `  printf '%s\\n' '${providerMessage(implementationPlan)}'`,
      '  exit 0',
      'fi',
      'if printf \'%s\\n\' "$prompt" | grep -q \'"kind":"implementation-task"\'; then',
      `  printf '%s\\n' '${providerMessage('No-op implementation for invariant regression.')}'`,
      '  exit 0',
      'fi',
      `if printf '%s\\n' "$prompt" | grep -q '"kind":"${synthesisKind}"'; then`,
      `  printf '%s\\n' '${providerMessage(summaryText)}'`,
      '  exit 0',
      'fi',
      `printf '%s\\n' '${providerMessage(summaryText)}'`,
      '',
    ].join('\n'),
    'utf8',
  );
  await fs.chmod(provider, 0o755);
}

function providerMessage(text) {
  return JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });
}
