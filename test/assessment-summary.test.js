import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedCycleIssueCount,
  normalizedCycleScore,
  parseQualitySummary,
  parseReviewSummary,
} from '../src/cycle-summary.js';

function summaryBlock(lines) {
  return ['```yaml', ...lines, '```'].join('\n');
}

test('assessment summaries do not preserve score A with unresolved issues', () => {
  const text = summaryBlock([
    'score: A',
    'verdict: clean',
    'major_issue_count: 2',
    'summary: Positive issue counts must control the final score.',
  ]);

  assert.deepEqual(parseReviewSummary(text), {
    score: 'C',
    issueCount: 2,
    synopsis: 'Positive issue counts must control the final score.',
  });
  assert.deepEqual(parseQualitySummary(text), {
    score: 'C',
    issueCount: 2,
    synopsis: 'Positive issue counts must control the final score.',
  });
});

test('assessment summaries treat contradictory issues verdicts as unresolved', () => {
  const text = summaryBlock([
    'score: A',
    'verdict: issues',
    'major_issue_count: 0',
    'summary: An issues verdict cannot pass with a zero count.',
  ]);

  assert.deepEqual(parseReviewSummary(text), {
    score: 'B',
    issueCount: 1,
    synopsis: 'An issues verdict cannot pass with a zero count.',
  });
  assert.deepEqual(parseQualitySummary(text), {
    score: 'B',
    issueCount: 1,
    synopsis: 'An issues verdict cannot pass with a zero count.',
  });
});

test('normalized cycle score derives missing scores from issue counts', () => {
  assert.equal(normalizedCycleScore({ issueCount: 0 }), 'A');
  assert.equal(normalizedCycleScore({ issueCount: 1 }), 'B');
  assert.equal(normalizedCycleScore({ issueCount: 2 }), 'C');
});

test('normalized cycle score preserves explicit worse scores', () => {
  assert.equal(normalizedCycleScore({ score: 'D', issueCount: 0 }), 'D');
  assert.equal(normalizedCycleScore({ score: 'a', issueCount: 2 }), 'C');
});

test('normalized cycle helpers fall back for missing issue counts and empty cycles', () => {
  assert.equal(normalizedCycleIssueCount({}), 0);
  assert.equal(normalizedCycleIssueCount({ issueCount: 'not-a-number' }), 0);
  assert.equal(normalizedCycleScore({}), '');
  assert.equal(normalizedCycleScore(undefined), '');
  assert.equal(normalizedCycleScore({ score: 'B' }), 'B');
});
