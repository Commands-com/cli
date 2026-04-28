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

function hasSummaryDiagnostics(summary) {
  return Boolean(
    summary.hasMalformedFields
      || summary.hasDuplicateFields
      || summary.contradictsVerdict,
  );
}

function numericSummaryIssueCount(summary) {
  if (summary.hasNumericMajorIssueCount) {
    if (summary.majorIssueCount > 0) return summary.majorIssueCount;
    if (summary.verdict === 'issues' || hasSummaryDiagnostics(summary)) return 1;
    return 0;
  }
  return undefined;
}

function numericSummaryMinorIssueCount(summary) {
  return summary.hasNumericMinorIssueCount ? summary.minorIssueCount : 0;
}

function duplicateFieldNames(duplicates) {
  if (!Array.isArray(duplicates) || duplicates.length === 0) return [];
  return [...new Set(duplicates.map((entry) => entry.field).filter(Boolean))];
}

function annotateSynopsisDuplicates(synopsis, duplicates) {
  const fields = duplicateFieldNames(duplicates);
  if (!fields.length) return synopsis;
  return `Duplicate ${fields.join(', ')}: ${synopsis}`;
}

function parseAssessmentSummary(text, { structured, fallback }) {
  const source = String(text || '').trimStart();
  const summary = parseSummaryBlock(source, { topOnly: true });
  const issueCount = summary.found
    ? structured(summary)
    : fallback({ source, summary });

  const withoutBlock = source.replace(/```ya?ml\s*\n[\s\S]*?\n```/i, '').trim();
  const firstBodyLine = withoutBlock
    .split('\n')
    .map((item) => item.replace(/^[-*]\s+/, '').trim())
    .find((item) => item && !item.startsWith('#'))
    || 'No synopsis returned.';
  const baseSynopsis = shorten(summary.summary || yamlScalar(firstBodyLine));
  const synopsis = annotateSynopsisDuplicates(baseSynopsis, summary.duplicates);

  const minorIssueCount = summary.found ? numericSummaryMinorIssueCount(summary) : 0;
  /** @type {{ score: string, issueCount: number, minorIssueCount?: number, synopsis: string }} */
  const result = {
    score: normalizeAssessmentScore(summary.score, issueCount),
    issueCount,
    synopsis,
  };
  if (minorIssueCount > 0) result.minorIssueCount = minorIssueCount;
  return result;
}

export function countReviewIssues(text) {
  return parseReviewSummary(text).issueCount;
}

export function parseReviewSummary(text) {
  return parseAssessmentSummary(text, {
    structured: (summary) => {
      const numericCount = numericSummaryIssueCount(summary);
      // Review convergence requires a numeric major_issue_count. A structured summary
      // without one cannot claim that all issues are resolved.
      return numericCount !== undefined ? numericCount : 1;
    },
    // Convergence requires an explicit clean verdict; empty / whitespace-only /
    // unparseable prose is treated as non-converged so a provider/extractor
    // regression cannot mask a missing review with A/0.
    fallback: ({ source }) => (parseSummary(source).verdict === 'clean' ? 0 : 1),
  });
}

export function parseQualitySummary(text) {
  return parseAssessmentSummary(text, {
    structured: (summary) => {
      const numericCount = numericSummaryIssueCount(summary);
      if (numericCount !== undefined) return numericCount;
      if (summary.issueCountPresent || hasSummaryDiagnostics(summary)) return 1;
      return summary.verdict === 'issues' ? 1 : 0;
    },
    // No parseable structured block: a clean verdict converges; everything
    // else (issues verdict, prose, silent provider garble) surfaces as one
    // issue so a quality cycle does not converge on output it could not parse.
    fallback: ({ summary }) => (summary.verdict === 'clean' ? 0 : 1),
  });
}

function shorten(text, max = 180) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3).trimEnd()}...`;
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

export function normalizedCycleMinorIssueCount(value) {
  return normalizeIssueCount(value?.minorIssueCount);
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

export function formatIssueCounts(value, minorIssueCount = 0) {
  const major = typeof value === 'object'
    ? normalizedCycleIssueCount(value)
    : normalizeIssueCount(value);
  const minor = typeof value === 'object'
    ? normalizedCycleMinorIssueCount(value)
    : normalizeIssueCount(minorIssueCount);
  return `${major} major, ${minor} minor`;
}

export function scoreIsWorseThanTarget(score, targetScore) {
  const scoreIndex = SCORE_ORDER.indexOf(String(score || '').trim().toUpperCase());
  const targetIndex = SCORE_ORDER.indexOf(String(targetScore || '').trim().toUpperCase());
  return targetIndex !== -1 && (scoreIndex === -1 || scoreIndex > targetIndex);
}

export function summarizeScoredOutputs(outputs, { noun, itemName, label }) {
  const issueCount = outputs.reduce((sum, output) => sum + normalizedCycleIssueCount(output), 0);
  const minorIssueCount = outputs.reduce((sum, output) => sum + normalizedCycleMinorIssueCount(output), 0);
  const score = worstScore(outputs.map((output) => output.score)) || gradeFromIssueCount(issueCount);
  const itemCount = `${outputs.length} ${outputs.length === 1 ? itemName : `${itemName}s`}`;
  const itemSummary = outputs
    .map((output) => `${label(output)}: ${output.score}, ${formatScoredOutputIssueCounts(output)} - ${shorten(output.synopsis, 110)}`)
    .join('; ');
  const synopsis = issueCount === 0
    ? cleanScoredOutputSynopsis({ noun, itemCount, minorIssueCount, itemSummary })
    : issueScoredOutputSynopsis({ issueCount, minorIssueCount, itemCount, itemSummary });
  /** @type {{ score: string, issueCount: number, minorIssueCount?: number, synopsis: string }} */
  const summary = {
    score,
    issueCount,
    synopsis,
  };
  if (minorIssueCount > 0) summary.minorIssueCount = minorIssueCount;
  return summary;
}

function cleanScoredOutputSynopsis({ noun, itemCount, minorIssueCount, itemSummary }) {
  if (minorIssueCount === 0) return `No unresolved ${noun}s across ${itemCount}.`;
  return `No major ${noun}s across ${itemCount}; ${minorIssueCount} minor. ${itemSummary}`;
}

function issueScoredOutputSynopsis({ issueCount, minorIssueCount, itemCount, itemSummary }) {
  if (minorIssueCount === 0) return `${formatIssueCount(issueCount)} across ${itemCount}. ${itemSummary}`;
  return `${formatIssueCounts({ issueCount, minorIssueCount })} across ${itemCount}. ${itemSummary}`;
}

function formatScoredOutputIssueCounts(output) {
  const minor = normalizedCycleMinorIssueCount(output);
  return minor > 0 ? formatIssueCounts(output) : formatIssueCount(normalizedCycleIssueCount(output));
}
