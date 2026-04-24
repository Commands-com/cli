import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQualitySummary } from '../src/cycle-summary.js';
import { gradeFromIssueCount } from '../src/summary-contract.js';
import { runMockProvider } from '../src/mock-provider.js';

function intentMarker(intent) {
  return `<!-- commands-com-prompt-intent: ${JSON.stringify(intent)} -->`;
}

function mockText(options) {
  return runMockProvider(options).text;
}

test('mock synthesis uses the final trailing intent marker when multiple markers are present', () => {
  const text = mockText({
    prompt: [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      intentMarker({ kind: 'review-synthesis', cycle: 1, synthesisHasIssues: true }),
      '',
      '```yaml',
      'verdict: issues',
      'issue_count: 4',
      '```',
      '',
      intentMarker({ kind: 'review-synthesis', cycle: 2, synthesisHasIssues: false }),
    ].join('\n'),
    allowTools: false,
  });

  assert.match(text, /verdict: clean/);
  assert.match(text, /issue_count: 0/);
});

test('mock synthesis ignores earlier markers when the trailing marker is malformed', () => {
  const text = mockText({
    prompt: [
      'Synthesize review findings for a Commands.com review cycle.',
      '',
      intentMarker({ kind: 'review-synthesis', cycle: 1, synthesisHasIssues: true }),
      '',
      '```yaml',
      'verdict: clean',
      'issue_count: 0',
      '```',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","cycle":2 -->',
    ].join('\n'),
    allowTools: false,
  });

  assert.match(text, /verdict: issues/);
  assert.match(text, /issue_count: 1/);
  assert.match(text, /Mock provider finding: this run path is wired correctly\./);
  assert.doesNotMatch(text, /Mock synthesis:/);
});

test('mock provider resolves intent by explicit option, prompt marker, then default review', () => {
  const cases = [
    {
      label: 'explicit mock intent wins over prompt marker',
      options: {
        prompt: [
          'Mock provider contract check.',
          intentMarker({ kind: 'implementation-plan' }),
        ].join('\n'),
        promptIntent: { kind: 'review-synthesis', synthesisHasIssues: false },
      },
      expected: /Mock synthesis: the current reviewer pass is clean\./,
      excluded: /"tasks"/,
    },
    {
      label: 'prompt marker wins over default review',
      options: {
        prompt: [
          'Mock provider contract check.',
          intentMarker({ kind: 'implementation-plan' }),
        ].join('\n'),
      },
      expected: /"tasks"/,
      excluded: /Mock provider finding: this run path is wired correctly\./,
    },
    {
      label: 'default review is used when neither is present',
      options: {
        prompt: 'Mock provider contract check.',
      },
      expected: /Mock provider finding: this run path is wired correctly\./,
      excluded: /"tasks"/,
    },
  ];

  for (const { label, options, expected, excluded } of cases) {
    const text = mockText({ ...options, allowTools: false });

    assert.match(text, expected, label);
    assert.doesNotMatch(text, excluded, label);
  }
});

test('mock provider uses a separate default for unmatched structured intents', () => {
  const unmatched = mockText({
    prompt: [
      'Mock provider contract check.',
      intentMarker({ kind: 'future-intent' }),
    ].join('\n'),
    allowTools: false,
  });

  assert.match(unmatched, /Mock provider finding: this run path is wired correctly\./);
  assert.doesNotMatch(unmatched, /quality run path/);

  const specific = mockText({
    prompt: [
      'Mock provider contract check.',
      intentMarker({ kind: 'quality' }),
    ].join('\n'),
    allowTools: false,
  });

  assert.match(specific, /Mock provider finding: this quality run path is wired correctly\./);
});

test('mock provider summary grades stay aligned with issue count thresholds', () => {
  const cases = [
    {
      label: 'quality finding',
      intent: { kind: 'quality' },
      issueCount: 1,
    },
    {
      label: 'quality synthesis with issues',
      intent: { kind: 'quality-synthesis', synthesisHasIssues: true },
      issueCount: 1,
    },
    {
      label: 'quality synthesis clean',
      intent: { kind: 'quality-synthesis', synthesisHasIssues: false },
      issueCount: 0,
    },
    {
      label: 'review synthesis with issues',
      intent: { kind: 'review-synthesis', synthesisHasIssues: true },
      issueCount: 1,
    },
    {
      label: 'review synthesis clean',
      intent: { kind: 'review-synthesis', synthesisHasIssues: false },
      issueCount: 0,
    },
    {
      label: 'prior findings resolved',
      intent: { kind: 'review', hasPriorFindings: true },
      issueCount: 0,
    },
    {
      label: 'default review finding',
      intent: { kind: 'review' },
      issueCount: 1,
    },
  ];

  for (const { label, intent, issueCount } of cases) {
    const text = mockText({
      prompt: ['Mock provider contract check.', intentMarker(intent)].join('\n'),
      allowTools: false,
    });
    const summary = parseQualitySummary(text);

    assert.equal(summary.issueCount, issueCount, label);
    assert.equal(summary.score, gradeFromIssueCount(issueCount), label);
  }
});
