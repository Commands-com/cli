import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQualitySummary } from '../src/cycle-summary.js';
import { PROVIDER_PING_MARKER, runMockProvider } from '../src/mock-provider.js';
import { runProvider } from '../src/providers.js';
import { gradeFromIssueCount } from '../src/summary-contract.js';

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

test('runProvider routes mock providers through provider execution', async () => {
  const prompt = 'Commands.com provider health check.';
  const result = await runProvider(
    { id: 'mock', command: '' },
    { prompt, model: '', allowTools: false },
  );
  assert.deepEqual(result, runMockProvider({ prompt, model: '', allowTools: false }));
});

test('runProvider lets mock consume trailing prompt intent markers before synthesis dispatch', async () => {
  const prompt = [
    'Synthesize code quality findings for a Commands.com quality audit.',
    '',
    'Provider outputs:',
    '```yaml',
    'score: B',
    'verdict: issues',
    'issue_count: 1',
    'summary: One issue.',
    '```',
    '',
    '<!-- commands-com-prompt-intent: {"kind":"quality-synthesis","cycle":1,"inputLabel":"Provider outputs:","synthesisIssueCount":1} -->',
  ].join('\n');

  const result = await runProvider(
    { id: 'mock', command: '' },
    { prompt, model: '', allowTools: false },
  );

  assert.match(result.text, /score: B/);
  assert.match(result.text, /issue_count: 1/);
});

test('mock provider gives explicit intent precedence over trailing prompt markers', () => {
  const text = mockText({
    prompt: [
      'Plan implementation tasks for a Commands.com fix loop.',
      '',
      'Reviewer outputs:',
      '```yaml',
      'verdict: clean',
      'issue_count: 0',
      '```',
      '',
      '<!-- commands-com-prompt-intent: {"kind":"implementation-plan"} -->',
    ].join('\n'),
    promptIntent: { kind: 'review-synthesis', inputLabel: 'Reviewer outputs:' },
    allowTools: false,
  });

  assert.match(text, /verdict: clean/);
  assert.match(text, /Mock synthesis: the current reviewer pass is clean\./);
  assert.doesNotMatch(text, /"tasks"/);
});

test('mock synthesis ignores prior findings issue counts outside the output section', async () => {
  const reviewPrompt = [
    'Synthesize review findings for a Commands.com review cycle.',
    '',
    'Previously reported findings:',
    '```yaml',
    'verdict: issues',
    'issue_count: 4',
    '```',
    '',
    'Reviewer outputs:',
    '## mock / correctness',
    '',
    '```yaml',
    'verdict: clean',
    'issue_count: 0',
    '```',
    '',
    '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","cycle":2,"inputLabel":"Reviewer outputs:"} -->',
  ].join('\n');
  const qualityPrompt = [
    'Synthesize code quality findings for a Commands.com quality audit.',
    '',
    'Previously reported findings:',
    '```yaml',
    'score: B',
    'verdict: issues',
    'issue_count: 3',
    'summary: Prior issue.',
    '```',
    '',
    'Provider outputs:',
    '## mock / maintainability',
    '',
    '```yaml',
    'score: A',
    'verdict: clean',
    'issue_count: 0',
    'summary: Clean now.',
    '```',
    '',
    '<!-- commands-com-prompt-intent: {"kind":"quality-synthesis","cycle":2,"inputLabel":"Provider outputs:"} -->',
  ].join('\n');

  const review = await runProvider(
    { id: 'mock', command: '' },
    { prompt: reviewPrompt, model: '', allowTools: false },
  );
  const quality = await runProvider(
    { id: 'mock', command: '' },
    { prompt: qualityPrompt, model: '', allowTools: false },
  );

  assert.match(review.text, /verdict: clean/);
  assert.match(review.text, /issue_count: 0/);
  assert.match(quality.text, /score: A/);
  assert.match(quality.text, /verdict: clean/);
  assert.match(quality.text, /summary: Mock quality synthesis found no unresolved issues\./);
});

test('runMockProvider handles ping and implementer prompts', () => {
  assert.equal(
    mockText({ prompt: 'Commands.com provider health check.', allowTools: false }),
    `${PROVIDER_PING_MARKER} mock`,
  );
  assert.equal(
    mockText({ prompt: 'Any implementation task prompt', allowTools: true }),
    'Mock implementer: this is where the provider would apply safe fixes.',
  );
});

test('runMockProvider handles implementation planning prompts', () => {
  const text = mockText({
    prompt: 'Plan implementation tasks for a Commands.com fix loop.',
    promptIntent: { kind: 'implementation-plan' },
    allowTools: false,
  });
  assert.match(text, /^```json\n/);
  assert.match(text, /"id": "task-1"/);
  assert.match(text, /"files": \[\n\s+"src\/mock-task-one\.js"\n\s+\]/);
  assert.match(text, /"id": "task-2"/);
  assert.match(text, /"files": \[\n\s+"test\/mock-task-two\.test\.js"\n\s+\]/);
});

test('runMockProvider handles review synthesis prompts', () => {
  const clean = mockText({
    prompt: [
      'Synthesize review findings for a Commands.com review cycle.',
      'Repository context:',
      'issue_count: 4',
      'Reviewer outputs:',
      '```yaml',
      'verdict: clean',
      'issue_count: 0',
      '```',
    ].join('\n'),
    promptIntent: { kind: 'review-synthesis', synthesisIssueCount: 0 },
    allowTools: false,
  });
  assert.match(clean, /verdict: clean/);
  assert.match(clean, /issue_count: 0/);
  assert.match(clean, /Mock synthesis: the current reviewer pass is clean\./);

  const issues = mockText({
    prompt: [
      'Synthesize review findings for a Commands.com review cycle.',
      'Reviewer outputs:',
      '```yaml',
      'verdict: issues',
      'issue_count: 2',
      '```',
    ].join('\n'),
    promptIntent: { kind: 'review-synthesis', synthesisIssueCount: 1 },
    allowTools: false,
  });
  assert.match(issues, /verdict: issues/);
  assert.match(issues, /issue_count: 1/);
  assert.match(issues, /Mock synthesis: reviewers found actionable issues\./);
});

test('runMockProvider handles quality synthesis prompts', () => {
  const clean = mockText({
    prompt: [
      'Synthesize code quality findings for a Commands.com quality audit.',
      'Repository context:',
      'verdict: issues',
      'Provider outputs:',
      '```yaml',
      'score: A',
      'verdict: clean',
      'issue_count: 0',
      '```',
    ].join('\n'),
    promptIntent: { kind: 'quality-synthesis', synthesisIssueCount: 0 },
    allowTools: false,
  });
  assert.match(clean, /score: A/);
  assert.match(clean, /verdict: clean/);
  assert.match(clean, /summary: Mock quality synthesis found no unresolved issues\./);

  const issues = mockText({
    prompt: [
      'Synthesize code quality findings for a Commands.com quality audit.',
      'Provider outputs:',
      '```yaml',
      'score: C',
      'verdict: issues',
      'issue_count: 3',
      '```',
    ].join('\n'),
    promptIntent: { kind: 'quality-synthesis', synthesisIssueCount: 1 },
    allowTools: false,
  });
  assert.match(issues, /score: B/);
  assert.match(issues, /verdict: issues/);
  assert.match(issues, /summary: Mock quality synthesis found one actionable issue\./);
});

test('runMockProvider handles follow-up review, quality audit, and default review prompts', () => {
  const followup = mockText({
    prompt: [
      'You are the correctness reviewer in a Commands.com review cycle.',
      'Previously reported findings:',
      '```yaml',
      'verdict: issues',
      'issue_count: 1',
      '```',
    ].join('\n'),
    promptIntent: { kind: 'review', hasPriorFindings: true },
    allowTools: false,
  });
  assert.match(followup, /score: A/);
  assert.match(followup, /Prior issues look resolved after the implementer pass\./);

  const quality = mockText({
    prompt: 'You are running a Commands.com code quality audit for area: maintainability.',
    promptIntent: { kind: 'quality' },
    allowTools: false,
  });
  assert.match(quality, /score: B/);
  assert.match(quality, /summary: One mock quality issue was found in this area\./);

  const review = mockText({ prompt: 'You are the tests reviewer.', allowTools: false });
  assert.match(review, /verdict: issues/);
  assert.match(review, /Mock provider finding: this run path is wired correctly\./);
});
