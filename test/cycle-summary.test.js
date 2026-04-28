import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countReviewIssues,
  formatIssueCount,
  parseQualitySummary,
  parseReviewSummary,
  scoreIsWorseThanTarget,
  summarizeScoredOutputs,
  worstScore,
} from '../src/cycle-summary.js';

function summarizeQualityAreas(outputs) {
  return summarizeScoredOutputs(outputs, {
    noun: 'quality issue',
    itemName: 'area',
    label: (output) => output.area,
  });
}

function summarizeReviewRoles(outputs) {
  return summarizeScoredOutputs(outputs, {
    noun: 'review issue',
    itemName: 'role',
    label: (output) => output.role,
  });
}
import {
  SCORE_ORDER,
  gradeFromIssueCount,
} from '../src/summary-contract.js';

const QUALITY_SCORE_REPRESENTATIVE_COUNTS = Object.freeze({
  A: 0,
  B: 1,
  C: 2,
  D: 4,
  F: 7,
});

test('countReviewIssues honors only top review summary blocks for clean counts', () => {
  assert.equal(countReviewIssues('```yaml\nverdict: clean\nissue_count: 0\n```'), 0);
  assert.equal(countReviewIssues('```yaml\nverdict: issues\nissue_count: 4\n```'), 4);
  assert.equal(countReviewIssues('```yaml\nverdict: clean\n```\nNo issues.'), 1);
  assert.equal(countReviewIssues('```yaml\nverdict: clean\nissue_count: many\n```'), 1);
  assert.equal(countReviewIssues('issue_count: 0\n\n```yaml\nverdict: issues\nissue_count: 4\n```'), 1);
  assert.equal(countReviewIssues('```yaml\nverdict: clean\nissue_count: 0\n```\nRegression risk in body.'), 0);
});

test('countReviewIssues converges only on an explicit clean verdict in loose prose', () => {
  assert.equal(countReviewIssues('verdict: issues'), 1);
  assert.equal(countReviewIssues('verdict: clean'), 0);
  assert.equal(countReviewIssues('Regression risk in parser.'), 1);
  // Prose that merely describes the verdict contract is not an explicit
  // clean verdict, so it must not converge to A/0.
  assert.equal(countReviewIssues('Return `verdict: clean | issues` and `issue_count: <number>`.'), 1);
});

test('quality detects missing-coverage prose via its issue keyword', () => {
  // `missing` is in QUALITY_ISSUE_PATTERN but not the review parser's
  // keyword set; quality therefore flags missing-coverage prose explicitly.
  // Review now treats any prose without an explicit clean verdict as
  // non-converged regardless of keyword, so both calls below return 1.
  const missingTestProse = 'Missing test coverage for parser edge cases.';

  assert.deepEqual(parseQualitySummary(missingTestProse), {
    score: 'B',
    issueCount: 1,
    synopsis: missingTestProse,
  });
  assert.equal(countReviewIssues(missingTestProse), 1);
  assert.equal(countReviewIssues(`Finding: ${missingTestProse}`), 1);
});

test('review summary parser returns score, count, and synopsis', () => {
  assert.deepEqual(parseReviewSummary([
    '```yaml',
    'score: C',
    'verdict: issues',
    'issue_count: 2',
    'summary: Needs a smaller clean fix.',
    '```',
    '',
    'Longer reviewer body.',
  ].join('\n')), {
    score: 'C',
    issueCount: 2,
    synopsis: 'Needs a smaller clean fix.',
  });

  assert.deepEqual(parseReviewSummary('verdict: clean\nsummary: Unfenced review synthesis.'), {
    score: 'A',
    issueCount: 0,
    synopsis: 'verdict: clean',
  });
});

test('quality summary parser uses YAML fields and grade fallback', () => {
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'score: C',
    'verdict: issues',
    'issue_count: 3',
    'summary: "Needs smaller modules"',
    '```',
    '',
    'Longer reviewer body.',
  ].join('\n')), {
    score: 'C',
    issueCount: 3,
    synopsis: 'Needs smaller modules',
  });

  assert.deepEqual(parseQualitySummary('Finding: missing test coverage.'), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Finding: missing test coverage.',
  });

  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'score: not-a-grade',
    'verdict: issues',
    'issue_count: 2',
    'summary: Invalid score falls back from issue count.',
    '```',
  ].join('\n')), {
    score: 'C',
    issueCount: 2,
    synopsis: 'Invalid score falls back from issue count.',
  });
});

test('cycle summary parsing treats structured summary diagnostics deterministically', () => {
  const malformedField = [
    '```yaml',
    'score A',
    'verdict: clean',
    'issue_count: 0',
    'summary: Malformed fields make the block non-converged.',
    '```',
  ].join('\n');
  assert.equal(countReviewIssues(malformedField), 1);
  assert.deepEqual(parseQualitySummary(malformedField), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Malformed fields make the block non-converged.',
  });

  assert.equal(countReviewIssues([
    '```yaml',
    'verdict: clean',
    'issue_count: 2',
    'summary: Contradictory but numeric count wins.',
    '```',
  ].join('\n')), 2);
  assert.equal(countReviewIssues([
    '```yaml',
    'verdict: issues',
    'issue_count: 0',
    'summary: Contradictory zero count cannot claim convergence.',
    '```',
  ].join('\n')), 1);
  assert.equal(countReviewIssues([
    '```yaml',
    'verdict: clean',
    'issue_count: 0',
    'issue_count: 3',
    'summary: Duplicate count is ambiguous.',
    '```',
  ].join('\n')), 1);

  const duplicateField = [
    '```yaml',
    'verdict: clean',
    'issue_count: 0',
    'summary: First summary wins.',
    'summary: Duplicate summary is diagnostic.',
    '```',
  ].join('\n');
  assert.equal(countReviewIssues(duplicateField), 1);
  assert.deepEqual(parseQualitySummary(duplicateField), {
    score: 'B',
    issueCount: 1,
    synopsis: 'First summary wins.',
  });

  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: clean',
    'issue_count: 2',
    'summary: Contradictory but numeric count wins.',
    '```',
  ].join('\n')), {
    score: 'C',
    issueCount: 2,
    synopsis: 'Contradictory but numeric count wins.',
  });
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: issues',
    'issue_count: 0',
    'summary: Contradictory zero count cannot claim convergence.',
    '```',
  ].join('\n')), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Contradictory zero count cannot claim convergence.',
  });
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: clean',
    'issue_count: nope',
    'summary: Malformed count cannot claim convergence.',
    '```',
  ].join('\n')), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Malformed count cannot claim convergence.',
  });
});

test('review and quality use explicit missing-count and verdict-driven policies', () => {
  assert.equal(countReviewIssues([
    '```yaml',
    'verdict: clean',
    'summary: Review summaries require issue_count to claim clean.',
    '```',
  ].join('\n')), 1);
  assert.equal(countReviewIssues([
    '```yaml',
    'verdict: issues',
    'summary: Review issues verdict counts as unresolved.',
    '```',
  ].join('\n')), 1);

  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: clean',
    'summary: Quality can use a clean verdict without a count.',
    '```',
  ].join('\n')), {
    score: 'A',
    issueCount: 0,
    synopsis: 'Quality can use a clean verdict without a count.',
  });
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: issues',
    'summary: Quality issues verdict counts as one unresolved issue.',
    '```',
  ].join('\n')), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Quality issues verdict counts as one unresolved issue.',
  });
});

test('quality summary parser lets fenced YAML take precedence over loose keywords', () => {
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'score: A',
    'verdict: clean',
    'issue_count: 0',
    'summary: Structured block is clean.',
    '```',
    '',
    'Finding: this loose fallback keyword should not override the block.',
  ].join('\n')), {
    score: 'A',
    issueCount: 0,
    synopsis: 'Structured block is clean.',
  });

  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'summary: Structured block without a verdict stays authoritative.',
    '```',
    '',
    'Finding: this loose fallback keyword should not override the block.',
  ].join('\n')), {
    score: 'A',
    issueCount: 0,
    synopsis: 'Structured block without a verdict stays authoritative.',
  });
});

test('quality summary parser only honors fenced YAML at the top of the response', () => {
  // Real top-level summary first, prior cycle's fenced block quoted below.
  // Top block wins regardless of later blocks.
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'score: A',
    'verdict: clean',
    'issue_count: 0',
    'summary: Real top-level verdict.',
    '```',
    '',
    'Prior cycle context for reference:',
    '',
    '```yaml',
    'score: F',
    'verdict: issues',
    'issue_count: 9',
    'summary: Old verdict from a previous cycle.',
    '```',
  ].join('\n')), {
    score: 'A',
    issueCount: 0,
    synopsis: 'Real top-level verdict.',
  });

  // Prose preamble before the first fenced block: the mid-body block must
  // not be promoted to the verdict (matches parseReviewSummary's contract).
  // Trigger words inside the fenced block must not flip issueCount via the
  // loose-prose fallback either.
  const midBodyBlockOnly = [
    'Prior cycle context for reference:',
    '',
    '```yaml',
    'score: F',
    'verdict: issues',
    'issue_count: 9',
    'summary: Missing test coverage finding regression failure from a previous cycle.',
    '```',
  ].join('\n');
  const midBodyResult = parseQualitySummary(midBodyBlockOnly);
  assert.deepEqual(midBodyResult, {
    score: 'B',
    issueCount: 1,
    synopsis: 'Prior cycle context for reference:',
  });
});

test('quality summary parser ignores QUALITY_ISSUE_PATTERN keywords inside fenced blocks', () => {
  // No top-level YAML block (prose preamble pushes the block mid-body).
  // Trigger words like 'missing' / 'finding' / 'failure' appear only inside
  // the fenced block — they must not flip a clean response to issues.
  const quotedFindings = [
    'Reviewing prior cycle context (no top-level summary):',
    '',
    '```yaml',
    'score: F',
    'issue_count: 9',
    'summary: Missing test coverage finding regression failure.',
    '```',
  ].join('\n');
  assert.deepEqual(parseQualitySummary(quotedFindings), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Reviewing prior cycle context (no top-level summary):',
  });

  // Sanity check: the same trigger words in unfenced prose still flip issueCount.
  assert.equal(parseQualitySummary('Missing test coverage finding.').issueCount, 1);

  // Review parser: prose without an explicit clean verdict is non-converged,
  // whether the trigger words appear inside or outside a fenced block.
  const reviewQuotedFindings = [
    'Reviewing prior cycle context (no top-level summary):',
    '',
    '```yaml',
    'summary: Bug finding regression failure from a prior cycle.',
    '```',
  ].join('\n');
  assert.equal(countReviewIssues(reviewQuotedFindings), 1);
  assert.equal(countReviewIssues('Bug finding regression failure.'), 1);
});

test('quality summary parser handles missing numeric counts and multiline summaries', () => {
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: issues',
    'summary: >',
    '  Missing numeric count',
    '  still means one issue.',
    '```',
  ].join('\n')), {
    score: 'B',
    issueCount: 1,
    synopsis: 'Missing numeric count still means one issue.',
  });

  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'score: A',
    'verdict: clean',
    'summary: |',
    '  No unresolved issues',
    '  after review.',
    '```',
  ].join('\n')), {
    score: 'A',
    issueCount: 0,
    synopsis: 'No unresolved issues after review.',
  });
});

test('quality score helpers map counts and select the worst valid score', () => {
  assert.equal(gradeFromIssueCount(0), 'A');
  assert.equal(gradeFromIssueCount(1), 'B');
  assert.equal(gradeFromIssueCount(3), 'C');
  assert.equal(gradeFromIssueCount(6), 'D');
  assert.equal(gradeFromIssueCount(7), 'F');
  assert.equal(worstScore(['B', 'F', 'C']), 'F');
  assert.equal(worstScore(['', 'A', 'not-a-score']), 'A');
  assert.equal(scoreIsWorseThanTarget('B', 'A'), true);
  assert.equal(scoreIsWorseThanTarget('A', 'A'), false);
  assert.equal(scoreIsWorseThanTarget('A', 'B'), false);
});

test('worstScore returns empty string for empty or all-invalid inputs', () => {
  assert.equal(worstScore([]), '');
  assert.equal(worstScore(['', 'not-a-score', undefined, null]), '');
});

test('quality score order and grade fallback cover the public score contract', () => {
  assert.deepEqual(Object.keys(QUALITY_SCORE_REPRESENTATIVE_COUNTS), SCORE_ORDER);
  for (const score of SCORE_ORDER) {
    assert.equal(gradeFromIssueCount(QUALITY_SCORE_REPRESENTATIVE_COUNTS[score]), score, score);
  }

  assert.equal(worstScore(SCORE_ORDER), SCORE_ORDER.at(-1));
});

test('quality summaries derive fallback synopsis from body text', () => {
  assert.deepEqual(parseQualitySummary([
    '```yaml',
    'verdict: clean',
    'issue_count: 0',
    '```',
    '',
    '# Heading',
    '- First useful line',
  ].join('\n')), {
    score: 'A',
    issueCount: 0,
    synopsis: 'First useful line',
  });

  assert.deepEqual(parseQualitySummary(''), {
    score: 'B',
    issueCount: 1,
    synopsis: 'No synopsis returned.',
  });
});

test('parseQualitySummary defaults unparseable output to one issue', () => {
  // Silent provider garble (no fenced summary, no clean verdict, no issue
  // keywords) is treated as one issue rather than a clean grade so that
  // failures surface instead of masquerading as convergence.
  const garble = 'arbitrary prose with no recognizable verdict';
  const result = parseQualitySummary(garble);
  assert.equal(result.score, 'B');
  assert.equal(result.issueCount, 1);
  assert.match(result.synopsis, /arbitrary prose/);
});

test('parseReviewSummary treats empty or unparseable output as non-converged', () => {
  // Convergence requires an explicit clean verdict (or structured summary
  // block). Empty / whitespace-only / unparseable prose must not default to
  // A/0, otherwise a provider/extractor regression could mask a missing
  // review with a silent clean verdict.
  const garble = parseReviewSummary('arbitrary prose with no recognizable verdict');
  assert.equal(garble.score, 'B');
  assert.equal(garble.issueCount, 1);
  assert.match(garble.synopsis, /arbitrary prose/);

  const empty = parseReviewSummary('');
  assert.equal(empty.score, 'B');
  assert.equal(empty.issueCount, 1);

  const whitespace = parseReviewSummary('   \n\t  ');
  assert.equal(whitespace.score, 'B');
  assert.equal(whitespace.issueCount, 1);
});

test('issue count formatting and quality cycle summaries are shared', () => {
  assert.equal(formatIssueCount(1), '1 issue');
  assert.equal(formatIssueCount(2), '2 issues');

  assert.deepEqual(summarizeQualityAreas([
    { area: 'tests', score: 'B', issueCount: 1, synopsis: 'Missing edge case coverage.' },
    { area: 'maintainability', score: 'C', issueCount: 2, synopsis: 'Duplicate parsing helper logic.' },
  ]), {
    score: 'C',
    issueCount: 3,
    synopsis: '3 issues across 2 areas. tests: B, 1 issue - Missing edge case coverage.; maintainability: C, 2 issues - Duplicate parsing helper logic.',
  });

  assert.deepEqual(summarizeQualityAreas([
    { area: 'tests', score: 'A', issueCount: 0, synopsis: 'Clean.' },
  ]), {
    score: 'A',
    issueCount: 0,
    synopsis: 'No unresolved quality issues across 1 area.',
  });

  const invalidScores = summarizeQualityAreas([
    { area: 'tests', score: '', issueCount: 1, synopsis: 'Missing edge case coverage.' },
    { area: 'maintainability', score: 'not-a-score', issueCount: 2, synopsis: 'Fallback should use counts.' },
  ]);
  assert.equal(invalidScores.score, 'C');
  assert.equal(invalidScores.issueCount, 3);

  const longSynopsis = `one   two\n${'x'.repeat(120)}`;
  assert.equal(summarizeQualityAreas([
    { area: 'tests', score: 'B', issueCount: 1, synopsis: longSynopsis },
  ]).synopsis, `1 issue across 1 area. tests: B, 1 issue - one two ${'x'.repeat(99)}...`);
});

test('review cycle summaries mirror quality scoring by reviewer role', () => {
  assert.deepEqual(summarizeReviewRoles([
    { role: 'correctness', score: 'B', issueCount: 1, synopsis: 'Parser edge-case risk.' },
    { role: 'maintainability', score: 'A', issueCount: 0, synopsis: 'Clean.' },
  ]), {
    score: 'B',
    issueCount: 1,
    synopsis: '1 issue across 2 roles. correctness: B, 1 issue - Parser edge-case risk.; maintainability: A, 0 issues - Clean.',
  });

  assert.deepEqual(summarizeReviewRoles([
    { role: 'tests', score: 'A', issueCount: 0, synopsis: 'Clean.' },
  ]), {
    score: 'A',
    issueCount: 0,
    synopsis: 'No unresolved review issues across 1 role.',
  });
});
