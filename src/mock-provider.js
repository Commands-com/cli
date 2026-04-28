import { isObjectRecord } from './objects.js';
import { splitPromptIntent } from './prompt-intent.js';

export const PROVIDER_PING_MARKER = 'commands-com-provider-ok';

function explicitPromptIntent(options) {
  const intent = options.promptIntent || options.intent;
  return isObjectRecord(intent) ? intent : null;
}

function normalizeMockIntent(intent) {
  if (!isObjectRecord(intent)) return null;
  return { ...intent };
}

function resolvePromptIntent(options, markerIntent) {
  return normalizeMockIntent(explicitPromptIntent(options))
    || normalizeMockIntent(markerIntent)
    || { kind: 'review' };
}

function isSynthesisIntent(intent) {
  return ['review-synthesis', 'quality-synthesis'].includes(intent.kind);
}

function structuredSynthesisHasIssues(intent) {
  if (typeof intent.synthesisHasIssues === 'boolean') return intent.synthesisHasIssues;

  if (
    intent.synthesisIssueCount === undefined
    || intent.synthesisIssueCount === null
    || intent.synthesisIssueCount === ''
  ) {
    return null;
  }
  const issueCount = Number(intent.synthesisIssueCount);
  if (Number.isFinite(issueCount)) return issueCount > 0;

  return null;
}

function implementationPlanText() {
  return [
    '```json',
    JSON.stringify({
      tasks: [
        {
          id: 'task-1',
          title: 'Apply the highest-priority fix',
          files: ['src/mock-task-one.js'],
          instructions: 'Apply the first safe fix from the synthesized findings.',
        },
        {
          id: 'task-2',
          title: 'Add focused validation',
          files: ['test/mock-task-two.test.js'],
          instructions: 'Add or update focused validation for the synthesized findings.',
        },
      ],
    }, null, 2),
    '```',
  ].join('\n');
}

function qualitySynthesisText({ synthesisHasIssues }) {
  if (synthesisHasIssues) {
    return [
      '```yaml',
      'score: B',
      'verdict: issues',
      'major_issue_count: 1',
      'minor_issue_count: 0',
      'summary: Mock quality synthesis found one actionable issue.',
      '```',
      '',
      'Mock quality synthesis: provider outputs agree there is one actionable quality issue.',
    ].join('\n');
  }
  return [
    '```yaml',
    'score: A',
    'verdict: clean',
    'major_issue_count: 0',
    'minor_issue_count: 0',
    'summary: Mock quality synthesis found no unresolved issues.',
    '```',
    '',
    'Mock quality synthesis: provider outputs are clean.',
  ].join('\n');
}

function reviewSynthesisText({ synthesisHasIssues }) {
  if (synthesisHasIssues) {
    return [
      '```yaml',
      'score: B',
      'verdict: issues',
      'major_issue_count: 1',
      'minor_issue_count: 0',
      'summary: Mock review synthesis found one actionable issue.',
      '```',
      '',
      'Mock synthesis: reviewers found actionable issues. Prioritize the concrete findings above and rerun after implementation.',
    ].join('\n');
  }
  return [
    '```yaml',
    'score: A',
    'verdict: clean',
    'major_issue_count: 0',
    'minor_issue_count: 0',
    'summary: Mock review synthesis found no unresolved issues.',
    '```',
    '',
    'Mock synthesis: the current reviewer pass is clean.',
  ].join('\n');
}

function roomParticipantText({ intent }) {
  const role = intent.role || 'participant';
  return `Mock room participant (${role}): this room path is wired correctly.`;
}

function roomSynthesisText() {
  return 'Mock room synthesis: participant outputs were combined into a final room report.';
}

function priorFindingsText() {
  return [
    '```yaml',
    'score: A',
    'verdict: clean',
    'major_issue_count: 0',
    'minor_issue_count: 0',
    'summary: Prior issues look resolved after the implementer pass.',
    '```',
    '',
    'Mock provider: prior issues look resolved after the implementer pass.',
  ].join('\n');
}

function qualityText() {
  return [
    '```yaml',
    'score: B',
    'verdict: issues',
    'major_issue_count: 1',
    'minor_issue_count: 0',
    'summary: One mock quality issue was found in this area.',
    '```',
    '',
    'Mock provider finding: this quality run path is wired correctly. Replace --provider mock with codex, claude, or gemini for real output.',
  ].join('\n');
}

function reviewText() {
  return [
    '```yaml',
    'score: B',
    'verdict: issues',
    'major_issue_count: 1',
    'minor_issue_count: 0',
    'summary: One mock review issue was found in this role.',
    '```',
    '',
    'Mock provider finding: this run path is wired correctly. Replace --provider mock with codex, claude, or gemini for real output.',
  ].join('\n');
}

const MOCK_INTENT_TEXT_HANDLERS = Object.freeze([
  {
    matches: ({ intent }) => intent.kind === 'implementation-plan',
    text: implementationPlanText,
  },
  {
    matches: ({ intent }) => intent.kind === 'quality-synthesis',
    text: qualitySynthesisText,
  },
  {
    matches: ({ intent }) => intent.kind === 'review-synthesis',
    text: reviewSynthesisText,
  },
  {
    matches: ({ intent }) => intent.kind === 'room-synthesis',
    text: roomSynthesisText,
  },
  {
    matches: ({ intent }) => intent.kind === 'room-participant',
    text: roomParticipantText,
  },
  {
    matches: ({ intent }) => intent.hasPriorFindings,
    text: priorFindingsText,
  },
  {
    matches: ({ intent }) => intent.kind === 'quality',
    text: qualityText,
  },
]);

const DEFAULT_MOCK_INTENT_TEXT = reviewText;

function textForMockIntent(context) {
  const handler = MOCK_INTENT_TEXT_HANDLERS.find((candidate) => candidate.matches(context));
  return (handler?.text || DEFAULT_MOCK_INTENT_TEXT)(context);
}

function resolveMockProviderText(options = {}) {
  const promptParts = splitPromptIntent(options.prompt);
  const prompt = promptParts.prompt;
  const intent = resolvePromptIntent(options, promptParts.intent);
  const isImplementer = options.allowTools === true || intent.kind === 'implementation-task';
  const isPing = /^\s*Commands\.com provider health check\./i.test(prompt);
  const synthesisHasIssues = isSynthesisIntent(intent)
    ? structuredSynthesisHasIssues(intent) ?? false
    : false;

  if (isPing) {
    return `${PROVIDER_PING_MARKER} mock`;
  }
  if (isImplementer) {
    return 'Mock implementer: this is where the provider would apply safe fixes.';
  }
  return textForMockIntent({ intent, synthesisHasIssues });
}

export function runMockProvider(options = {}) {
  const promptParts = splitPromptIntent(options.prompt);
  const intent = resolvePromptIntent(options, promptParts.intent);
  const sessionParts = [
    'mock-session',
    intent.kind || 'default',
    intent.role || intent.area || (Array.isArray(intent.areas) ? intent.areas.join('-') : ''),
  ].filter(Boolean);
  const sessionId = String(options.resumeSessionId || '').trim()
    || sessionParts.join('-').replace(/[^a-z0-9]+/gi, '-');
  return {
    text: resolveMockProviderText(options),
    sessionId,
    stdout: '',
    stderr: '',
    exitCode: 0,
  };
}
