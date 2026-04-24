import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSummary,
  parseSummaryBlock,
  yamlScalar,
} from '../src/summary.js';
import {
  SUMMARY_FIELD,
  SUMMARY_FIELD_NAMES,
} from '../src/summary-contract.js';
import { countReviewIssues } from '../src/cycle-summary.js';

test('parseSummaryBlock can require a top summary block', () => {
  const text = [
    'Intro text',
    '',
    '```yaml',
    'verdict: issues',
    'issue_count: 2',
    '```',
  ].join('\n');

  assert.equal(parseSummaryBlock(text, { topOnly: true }).found, false);
  assert.match(parseSummaryBlock(text).yaml, /issue_count: 2/);
});

test('summary block extraction ignores malformed and non-yaml fences', () => {
  assert.equal(parseSummaryBlock('```yaml\nscore: F').found, false);
  assert.equal(parseSummaryBlock('````yaml\nscore: F\n````').found, false);
  assert.equal(parseSummaryBlock('```json\n{"score":"F"}\n```').found, false);

  const parsed = parseSummaryBlock('```YML\r\nscore: d\r\nsummary: CRLF block.\r\n```   ');
  assert.equal(parsed.found, true);
  assert.equal(parsed.score, 'D');
  assert.equal(parsed.summary, 'CRLF block.');
});

test('parseSummary parses allowed fields and scalars', () => {
  const yaml = [
    'score: "b"',
    "summary: 'Quoted summary'",
    'verdict: clean',
    'issue_count: "0"',
  ].join('\n');

  const parsed = parseSummary(yaml);

  assert.equal(yamlScalar('"hello"'), 'hello');
  assert.deepEqual(parsed.fields, {
    score: '"b"',
    summary: "'Quoted summary'",
    verdict: 'clean',
    issue_count: '"0"',
  });
  assert.equal(parsed.score, 'B');
  assert.equal(parsed.summary, 'Quoted summary');
  assert.equal(parsed.verdict, 'clean');
  assert.equal(parsed.issueCount, 0);
  assert.equal(parsed.hasNumericIssueCount, true);
});

test('parseSummary accepts every field from the centralized summary contract', () => {
  const values = {
    [SUMMARY_FIELD.ISSUE_COUNT]: '0',
    [SUMMARY_FIELD.SCORE]: 'A',
    [SUMMARY_FIELD.SUMMARY]: 'Centralized summary contract.',
    [SUMMARY_FIELD.VERDICT]: 'clean',
  };
  const parsed = parseSummary(
    SUMMARY_FIELD_NAMES.map((field) => `${field}: ${values[field]}`).join('\n'),
  );

  assert.deepEqual(Object.keys(parsed.fields), SUMMARY_FIELD_NAMES);
  assert.equal(parsed.issueCount, 0);
  assert.equal(parsed.score, 'A');
  assert.equal(parsed.summary, 'Centralized summary contract.');
  assert.equal(parsed.verdict, 'clean');
});

test('parseSummaryBlock reports malformed summary fields without dropping valid fields', () => {
  const parsed = parseSummaryBlock([
    '```yaml',
    'score B',
    '  stray: value',
    'verdict: clean',
    'issue_count: nope',
    'summary: Parser kept valid fields.',
    '```',
  ].join('\n'));

  assert.equal(parsed.found, true);
  assert.equal(parsed.verdict, 'clean');
  assert.equal(parsed.issueCountPresent, true);
  assert.equal(parsed.hasNumericIssueCount, false);
  assert.equal(parsed.issueCount, undefined);
  assert.equal(parsed.summary, 'Parser kept valid fields.');
  assert.deepEqual(parsed.malformed, [
    {
      line: 1,
      reason: 'expected-key-value',
      text: 'score B',
    },
    {
      line: 2,
      reason: 'unexpected-indented-line',
      text: '  stray: value',
    },
    {
      field: 'issue_count',
      line: 4,
      reason: 'invalid-issue-count',
      text: 'issue_count: nope',
    },
  ]);
  assert.equal(parsed.hasMalformedFields, true);
  assert.equal(parsed.hasMalformedIssueCount, true);
});

test('parseSummary supports quoted and multiline summaries', () => {
  assert.equal(
    parseSummary('summary: "Parser handles: quoted text"').summary,
    'Parser handles: quoted text',
  );
  assert.equal(
    parseSummary([
      'summary: |',
      '  First line',
      '  Second line',
      'verdict: clean',
    ].join('\n')).summary,
    'First line\nSecond line',
  );
  assert.equal(
    parseSummary([
      'summary: |',
      '  First line',
      '  Second line',
      'verdict: clean',
    ].join('\n')).verdict,
    'clean',
  );
  assert.equal(
    parseSummary([
      'summary: >',
      '  First line',
      '  Second line',
    ].join('\n')).summary,
    'First line Second line',
  );
});

test('parseSummary exposes missing and non-numeric issue counts explicitly', () => {
  const missing = parseSummary('verdict: issues');
  assert.equal(missing.issueCountPresent, false);
  assert.equal(missing.hasNumericIssueCount, false);
  assert.equal(missing.issueCount, undefined);

  const malformed = parseSummary('verdict: issues\nissue_count: many');
  assert.equal(malformed.issueCountPresent, true);
  assert.equal(malformed.hasNumericIssueCount, false);
  assert.equal(malformed.issueCount, undefined);
  assert.equal(malformed.hasMalformedIssueCount, true);
  assert.deepEqual(malformed.malformed, [
    {
      field: 'issue_count',
      line: 2,
      reason: 'invalid-issue-count',
      text: 'issue_count: many',
    },
  ]);
});

test('parseSummary reports duplicate summary keys without replacing the first value', () => {
  const parsed = parseSummary([
    'summary: First summary wins.',
    'summary: Second summary is diagnostic only.',
    'verdict: issues',
    'Verdict: clean',
  ].join('\n'));

  assert.equal(parsed.summary, 'First summary wins.');
  assert.equal(parsed.verdict, 'issues');
  assert.equal(parsed.hasDuplicateFields, true);
  assert.deepEqual(parsed.duplicates, [
    {
      field: 'summary',
      line: 2,
      reason: 'duplicate-key',
      text: 'summary: Second summary is diagnostic only.',
    },
    {
      field: 'verdict',
      line: 4,
      reason: 'duplicate-key',
      text: 'Verdict: clean',
    },
  ]);
});

test('parseSummary consumes duplicate block scalars without cascading malformed lines', () => {
  const parsed = parseSummary([
    'summary: First summary wins.',
    'summary: |',
    '  Duplicate block content',
    '  is ignored.',
    'issue_count: 0',
  ].join('\n'));

  assert.equal(parsed.summary, 'First summary wins.');
  assert.equal(parsed.issueCount, 0);
  assert.deepEqual(parsed.malformed, []);
  assert.deepEqual(parsed.duplicates, [
    {
      field: 'summary',
      line: 2,
      reason: 'duplicate-key',
      text: 'summary: |',
    },
  ]);
});

test('parseSummary reports contradictory verdict and issue_count fields but keeps numeric count', () => {
  const cleanWithIssues = parseSummary('verdict: clean\nissue_count: 2');
  assert.equal(cleanWithIssues.issueCount, 2);
  assert.equal(cleanWithIssues.contradictsVerdict, true);
  assert.deepEqual(cleanWithIssues.contradictions, ['clean-with-positive-issue-count']);

  const issuesWithZero = parseSummary('verdict: issues\nissue_count: 0');
  assert.equal(issuesWithZero.issueCount, 0);
  assert.equal(issuesWithZero.contradictsVerdict, true);
  assert.deepEqual(issuesWithZero.contradictions, ['issues-with-zero-issue-count']);
});

test('review summaries use loose YAML-like verdict detection only for issues verdicts', () => {
  assert.equal(countReviewIssues('verdict: issues\nsummary: Unfenced review synthesis.'), 1);
  assert.equal(countReviewIssues('verdict: clean\nsummary: Unfenced review synthesis.'), 0);
  assert.equal(countReviewIssues('Return `verdict: clean | issues` and `issue_count: <number>`.'), 1);
});
