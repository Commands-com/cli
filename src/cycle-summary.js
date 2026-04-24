import {
  parseSummary,
  parseSummaryBlock,
  yamlScalar,
} from './summary.js';
import { normalizeIssueCount } from './number-utils.js';
import {
  SCORE_ORDER,
  gradeFromIssueCount,
} from './summary-contract.js';

const QUALITY_ISSUE_PATTERN = /finding|bug|risk|regression|failure|missing/i;
const FENCED_BLOCK_PATTERN = /```[^\n]*\n[\s\S]*?\n```/g;

function stripFencedBlocks(text) {
  return String(text || '').replace(FENCED_BLOCK_PATTERN, '');
}

function hasSummaryDiagnostics(summary) {
  return Boolean(
    summary.hasMalformedFields
      || summary.hasDuplicateFields
      || summary.contradictsVerdict,
  );
}

function numericSummaryIssueCount(summary) {
  if (summary.hasNumericIssueCount) {
    if (summary.issueCount > 0) return summary.issueCount;
    if (summary.verdict === 'issues' || hasSummaryDiagnostics(summary)) return 1;
    return 0;
  }
  return undefined;
}

function reviewIssueCountFromStructuredSummary(summary) {
  const numericCount = numericSummaryIssueCount(summary);
  if (numericCount !== undefined) return numericCount;
  // Review convergence requires a numeric issue_count. A structured summary
  // without one cannot claim that all issues are resolved.
  return 1;
}

function qualityIssueCountFromStructuredSummary(summary) {
  const numericCount = numericSummaryIssueCount(summary);
  if (numericCount !== undefined) return numericCount;
  if (summary.issueCountPresent || hasSummaryDiagnostics(summary)) return 1;
  if (summary.verdict === 'issues') return 1;
  return 0;
}

export function countReviewIssues(text) {
  return parseReviewSummary(text).issueCount;
}

export function parseReviewSummary(text) {
  const source = String(text || '').trimStart();
  const summary = parseSummaryBlock(source, { topOnly: true });
  let issueCount;
  if (summary.found) {
    issueCount = reviewIssueCountFromStructuredSummary(summary);
  } else {
    // No structured block. Convergence requires an explicit clean verdict;
    // empty / whitespace-only / unparseable prose is treated as non-converged
    // so a provider/extractor regression cannot mask a missing review with A/0.
    const looseSummary = parseSummary(source);
    issueCount = looseSummary.verdict === 'clean' ? 0 : 1;
  }

  const synopsis = shorten(summary.summary || yamlScalar(firstBodyLine(text)));
  return {
    score: normalizeAssessmentScore(summary.score, issueCount),
    issueCount,
    synopsis,
  };
}

function firstBodyLine(text) {
  const withoutBlock = String(text || '').replace(/```ya?ml\s*\n[\s\S]*?\n```/i, '').trim();
  const line = withoutBlock
    .split('\n')
    .map((item) => item.replace(/^[-*]\s+/, '').trim())
    .find((item) => item && !item.startsWith('#'));
  return line || 'No synopsis returned.';
}

function shorten(text, max = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
}

export function parseQualitySummary(text) {
  const summary = parseSummaryBlock(text, { topOnly: true });
  let issueCount;
  if (summary.found) {
    // Structured summary blocks are the contract. Loose prose later in the
    // response should not reinterpret a fenced block.
    issueCount = qualityIssueCountFromStructuredSummary(summary);
  } else if (summary.verdict === 'clean') {
    issueCount = 0;
  } else if (summary.verdict === 'issues' || QUALITY_ISSUE_PATTERN.test(stripFencedBlocks(text))) {
    issueCount = 1;
  } else {
    // No parseable structured block, no clean verdict, no issue keyword:
    // surface silent provider garble as one issue instead of a clean grade
    // so a quality cycle does not converge on output it could not parse.
    issueCount = 1;
  }

  const synopsis = shorten(summary.summary || yamlScalar(firstBodyLine(text)));
  return {
    score: normalizeAssessmentScore(summary.score, issueCount),
    issueCount,
    synopsis,
  };
}

function normalizeAssessmentScore(score, issueCount) {
  const explicitScore = String(score || '').trim().toUpperCase();
  const issueScore = gradeFromIssueCount(normalizeIssueCount(issueCount));
  if (!SCORE_ORDER.includes(explicitScore)) return issueScore;
  return SCORE_ORDER.indexOf(explicitScore) > SCORE_ORDER.indexOf(issueScore)
    ? explicitScore
    : issueScore;
}

export function normalizedCycleIssueCount(value) {
  return normalizeIssueCount(value?.issueCount);
}

export function normalizedCycleScore(value, { fallbackScore = '' } = {}) {
  const score = value?.score || fallbackScore;
  if (!score && value?.issueCount === undefined) return '';
  return normalizeAssessmentScore(score, normalizedCycleIssueCount(value));
}

export function worstScore(scores) {
  return scores.reduce((worst, score) => {
    if (!SCORE_ORDER.includes(score)) return worst;
    if (!worst) return score;
    return SCORE_ORDER.indexOf(score) > SCORE_ORDER.indexOf(worst) ? score : worst;
  }, '');
}

export function formatIssueCount(count) {
  return `${count} ${count === 1 ? 'issue' : 'issues'}`;
}

export function scoreIsWorseThanTarget(score, targetScore) {
  const scoreIndex = SCORE_ORDER.indexOf(String(score || '').trim().toUpperCase());
  const targetIndex = SCORE_ORDER.indexOf(String(targetScore || '').trim().toUpperCase());
  return targetIndex !== -1 && (scoreIndex === -1 || scoreIndex > targetIndex);
}

export function summarizeReviewCycle(outputs) {
  return summarizeScoredOutputs(outputs, {
    noun: 'review issue',
    itemName: 'role',
    label: (output) => output.role,
  });
}

export function summarizeQualityCycle(outputs) {
  const combinedAreaAudits = outputs.some((output) => Array.isArray(output.areas) && output.areas.length > 1);
  return summarizeScoredOutputs(outputs, {
    noun: 'quality issue',
    itemName: combinedAreaAudits ? 'provider audit' : 'area',
    label: (output) => (combinedAreaAudits ? `${output.provider}: ${output.area}` : output.area),
  });
}

function summarizeScoredOutputs(outputs, { noun, itemName, label }) {
  const issueCount = outputs.reduce((sum, output) => sum + output.issueCount, 0);
  const score = worstScore(outputs.map((output) => output.score)) || gradeFromIssueCount(issueCount);
  const itemCount = `${outputs.length} ${outputs.length === 1 ? itemName : `${itemName}s`}`;
  const itemSummary = outputs
    .map((output) => `${label(output)}: ${output.score}, ${formatIssueCount(output.issueCount)} - ${shorten(output.synopsis, 110)}`)
    .join('; ');
  return {
    score,
    issueCount,
    synopsis: issueCount === 0
      ? `No unresolved ${noun}s across ${itemCount}.`
      : `${formatIssueCount(issueCount)} across ${itemCount}. ${itemSummary}`,
  };
}
