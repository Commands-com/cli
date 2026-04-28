import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQualityAuditPrompt,
  buildQualitySynthesisPrompt,
  buildReviewPrompt,
  buildReviewSynthesisPrompt,
  formatQualityAssessmentOutputs,
  formatReviewAssessmentOutputs,
} from '../src/assessment-prompts.js';
import {
  ASSESSMENT_SUMMARY_CONTRACT,
  SUMMARY_FIELD,
  SUMMARY_FIELD_NAMES,
} from '../src/summary-contract.js';
import {
  buildImplementationPlanPrompt,
  buildImplementationTaskPrompt,
} from '../src/implementation-prompts.js';
import { splitPromptIntent } from '../src/prompt-intent.js';
import { formatRepoContext } from '../src/repo-context-prompt.js';
import { parseSummary } from '../src/summary.js';

const context = {
  repoRoot: '/tmp/repo',
  branch: 'main',
  head: 'abc123',
  status: ' M src/app.js',
  diffStat: 'src/app.js | 2 ++',
  diff: 'diff --git a/src/app.js b/src/app.js',
};

const REVIEWER_OUTPUTS = Object.freeze([
  { provider: 'codex', role: 'correctness', text: 'finding one' },
  { provider: 'claude', role: 'tests', text: 'finding two' },
]);

const QUALITY_OUTPUTS = Object.freeze([
  {
    provider: 'codex',
    area: 'maintainability',
    score: 'B',
    issueCount: 1,
    synopsis: 'one issue',
    text: 'finding one',
  },
  {
    provider: 'claude',
    area: 'maintainability',
    score: 'A',
    issueCount: 0,
    synopsis: 'clean',
    text: 'no findings',
  },
]);

const EXPECTED_SUMMARY_FIELDS = Object.freeze([
  SUMMARY_FIELD.SCORE,
  SUMMARY_FIELD.VERDICT,
  SUMMARY_FIELD.MAJOR_ISSUE_COUNT,
  SUMMARY_FIELD.MINOR_ISSUE_COUNT,
  SUMMARY_FIELD.SUMMARY,
]);

function promptBody(prompt) {
  return splitPromptIntent(prompt).prompt;
}

function promptIntent(prompt) {
  return splitPromptIntent(prompt).intent;
}

function synthesisProviderBlock(prompt, label) {
  const body = promptBody(prompt);
  const start = `${label}\n`;
  const startIndex = body.indexOf(start);
  assert.notEqual(startIndex, -1);
  const afterLabel = body.slice(startIndex + start.length);
  const endMarker = '\n\nReturn a concise Markdown synthesis';
  const endIndex = afterLabel.indexOf(endMarker);
  assert.notEqual(endIndex, -1);
  return afterLabel.slice(0, endIndex);
}

function assertSummaryContractBlock(body) {
  assert.match(body, /^score: A \| B \| C \| D \| F$/m);
  assert.match(body, /^verdict: clean \| issues$/m);
  assert.match(body, /^major_issue_count: <number>$/m);
  assert.match(body, /^minor_issue_count: <number>$/m);
  assert.match(body, /^summary: <one sentence>$/m);
}

function contractFieldNames(contract) {
  return contract
    .filter((line) => !line.startsWith('```'))
    .map((line) => line.slice(0, line.indexOf(':')));
}

function contractBody(contract) {
  return contract.filter((line) => !line.startsWith('```')).join('\n');
}

test('review prompt declares the YAML summary contract and intent metadata', () => {
  const prompt = buildReviewPrompt({
    objective: 'review login',
    role: 'correctness',
    context,
    cycle: 2,
    priorFindings: 'old issue',
  });
  const body = promptBody(prompt);

  assertSummaryContractBlock(body);
  assert.match(body, /Objective: review login/);
  assert.match(body, /Cycle: 2/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'review',
    role: 'correctness',
    cycle: 2,
    hasPriorFindings: true,
  });
});

test('quality prompt declares the YAML summary contract and intent metadata', () => {
  const prompt = buildQualityAuditPrompt({ areas: ['maintainability'], context, changed: true });
  const body = promptBody(prompt);

  assertSummaryContractBlock(body);
  assert.match(body, /code quality audit for area: maintainability/);
  assert.match(body, /Cycle: 1/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'quality',
    area: 'maintainability',
    changed: true,
    cycle: 1,
    hasPriorFindings: false,
  });
});

test('combined quality prompt audits multiple areas in one provider session', () => {
  const prompt = buildQualityAuditPrompt({
    areas: ['architecture', 'maintainability'],
    context,
    changed: false,
    cycle: 2,
  });
  const body = promptBody(prompt);

  assertSummaryContractBlock(body);
  assert.match(body, /code quality audit across areas: architecture, maintainability/);
  assert.match(body, /Assess all selected areas in one provider session/);
  assert.match(body, /- architecture: Review module boundaries/);
  assert.match(body, /- maintainability: Focus on complexity/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'quality',
    areas: ['architecture', 'maintainability'],
    changed: false,
    cycle: 2,
    hasPriorFindings: false,
  });
});

test('review synthesis prompt declares the YAML contract, lists provider headings, and emits intent metadata', () => {
  const prompt = buildReviewSynthesisPrompt({
    objective: 'review login',
    context,
    cycle: 1,
    reviewerOutputs: REVIEWER_OUTPUTS,
  });
  const body = promptBody(prompt);

  assertSummaryContractBlock(body);
  assert.match(body, /Synthesize review findings/);
  assert.match(body, /Objective: review login/);
  assert.match(body, /Cycle: 1/);
  assert.match(body, /## codex \/ correctness/);
  assert.match(body, /## claude \/ tests/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'review-synthesis',
    cycle: 1,
    synthesisHasIssues: false,
  });
  assert.equal(
    synthesisProviderBlock(prompt, 'Reviewer outputs:'),
    formatReviewAssessmentOutputs(REVIEWER_OUTPUTS),
  );
});

test('quality synthesis prompt declares the YAML contract, lists provider blocks, and emits intent metadata', () => {
  const prompt = buildQualitySynthesisPrompt({
    areas: ['maintainability'],
    context,
    cycle: 1,
    outputs: QUALITY_OUTPUTS,
  });
  const body = promptBody(prompt);

  assertSummaryContractBlock(body);
  assert.match(body, /Synthesize code quality findings/);
  assert.match(body, /Areas: maintainability/);
  assert.match(body, /Cycle: 1/);
  assert.match(body, /## codex \/ maintainability/);
  assert.match(body, /## claude \/ maintainability/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'quality-synthesis',
    cycle: 1,
    synthesisHasIssues: true,
  });
  assert.equal(
    synthesisProviderBlock(prompt, 'Provider outputs:'),
    formatQualityAssessmentOutputs(QUALITY_OUTPUTS),
  );
});

test('all internal prompt builders emit parseable intent metadata', () => {
  const contractCases = [
    {
      label: 'review prompt',
      prompt: buildReviewPrompt({
        objective: 'review auth',
        role: 'security',
        context,
        cycle: 3,
      }),
      expected: {
        kind: 'review',
        role: 'security',
        cycle: 3,
        hasPriorFindings: false,
      },
    },
    {
      label: 'review prompt with prior findings',
      prompt: buildReviewPrompt({
        objective: 'review auth',
        role: 'tests',
        context,
        cycle: 4,
        priorFindings: 'previous issue',
      }),
      expected: {
        kind: 'review',
        role: 'tests',
        cycle: 4,
        hasPriorFindings: true,
      },
    },
    {
      label: 'review synthesis prompt with issues',
      prompt: buildReviewSynthesisPrompt({
        objective: 'review auth',
        context,
        cycle: 5,
        reviewerOutputs: [
          { provider: 'codex', role: 'correctness', text: '```yaml\nverdict: issues\nmajor_issue_count: 1\n```' },
        ],
      }),
      expected: {
        kind: 'review-synthesis',
        cycle: 5,
        synthesisHasIssues: true,
      },
    },
    {
      label: 'quality prompt',
      prompt: buildQualityAuditPrompt({
        areas: ['performance'],
        context,
        changed: false,
        cycle: 6,
        priorFindings: 'previous issue',
      }),
      expected: {
        kind: 'quality',
        area: 'performance',
        changed: false,
        cycle: 6,
        hasPriorFindings: true,
      },
    },
    {
      label: 'quality synthesis prompt clean',
      prompt: buildQualitySynthesisPrompt({
        areas: ['maintainability', 'tests'],
        context,
        cycle: 7,
        outputs: [
          {
            provider: 'codex',
            area: 'maintainability',
            score: 'A',
            issueCount: 0,
            synopsis: 'clean',
            text: '```yaml\nscore: A\nverdict: clean\nmajor_issue_count: 0\nsummary: Clean.\n```',
          },
        ],
      }),
      expected: {
        kind: 'quality-synthesis',
        cycle: 7,
        synthesisHasIssues: false,
      },
    },
    {
      label: 'implementation plan prompt',
      prompt: buildImplementationPlanPrompt({
        objective: 'fix review findings',
        context,
        findings: 'finding one',
        testCommand: '',
        maxTasks: 2,
      }),
      expected: {
        kind: 'implementation-plan',
        maxTasks: 2,
        hasTestCommand: false,
      },
    },
    {
      label: 'implementation task prompt',
      prompt: buildImplementationTaskPrompt({
        objective: 'fix review findings',
        context,
        findings: 'finding one',
        testCommand: 'npm test',
        task: {
          id: 'task-9',
          title: 'Fix parser',
          files: ['src/parser.js', 'test/parser.test.js'],
          instructions: 'Tighten parsing.',
        },
      }),
      expected: {
        kind: 'implementation-task',
        taskId: 'task-9',
        fileCount: 2,
        hasTestCommand: true,
      },
    },
  ];

  for (const { label, prompt, expected } of contractCases) {
    const split = splitPromptIntent(prompt);
    assert.ok(split.intent, label);
    assert.deepEqual(split.intent, expected, label);
    assert.doesNotMatch(split.prompt, /commands-com-prompt-intent/, label);
  }
});

test('formatRepoContext renders the repository line', () => {
  assert.match(formatRepoContext(context), /Repository: \/tmp\/repo/);
});

test('summary prompt contract fields are accepted by the parser', () => {
  const fields = contractFieldNames(ASSESSMENT_SUMMARY_CONTRACT);
  const parsed = parseSummary(contractBody(ASSESSMENT_SUMMARY_CONTRACT));

  assert.deepEqual(fields, EXPECTED_SUMMARY_FIELDS);
  assert.deepEqual(Object.keys(parsed.fields), fields);
  assert.ok(fields.every((field) => SUMMARY_FIELD_NAMES.includes(field)));
});

test('splitPromptIntent uses the final trailing marker when multiple markers are present', () => {
  const prompt = [
    'Reviewer output with embedded metadata.',
    '<!-- commands-com-prompt-intent: {"kind":"review","cycle":1} -->',
    '',
    '<!-- commands-com-prompt-intent: {"kind":"review-synthesis","cycle":2,"synthesisHasIssues":true} -->',
  ].join('\n');

  assert.deepEqual(promptIntent(prompt), {
    kind: 'review-synthesis',
    cycle: 2,
    synthesisHasIssues: true,
  });
  assert.equal(splitPromptIntent(prompt).prompt, [
    'Reviewer output with embedded metadata.',
    '<!-- commands-com-prompt-intent: {"kind":"review","cycle":1} -->',
  ].join('\n'));
});
