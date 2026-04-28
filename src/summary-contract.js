export const SUMMARY_FIELD = Object.freeze({
  MAJOR_ISSUE_COUNT: 'major_issue_count',
  MINOR_ISSUE_COUNT: 'minor_issue_count',
  SCORE: 'score',
  SUMMARY: 'summary',
  VERDICT: 'verdict',
});

export const SUMMARY_FIELD_NAMES = Object.freeze([
  SUMMARY_FIELD.MAJOR_ISSUE_COUNT,
  SUMMARY_FIELD.MINOR_ISSUE_COUNT,
  SUMMARY_FIELD.SCORE,
  SUMMARY_FIELD.SUMMARY,
  SUMMARY_FIELD.VERDICT,
]);

export const SCORE_ORDER = Object.freeze(['A', 'B', 'C', 'D', 'F']);
export const VERDICT_VALUES = Object.freeze(['clean', 'issues']);

const ASSESSMENT_SUMMARY_FIELD_NAMES = Object.freeze([
  SUMMARY_FIELD.SCORE,
  SUMMARY_FIELD.VERDICT,
  SUMMARY_FIELD.MAJOR_ISSUE_COUNT,
  SUMMARY_FIELD.MINOR_ISSUE_COUNT,
  SUMMARY_FIELD.SUMMARY,
]);

const SUMMARY_FIELD_CONTRACT_VALUES = Object.freeze({
  [SUMMARY_FIELD.MAJOR_ISSUE_COUNT]: '<number>',
  [SUMMARY_FIELD.MINOR_ISSUE_COUNT]: '<number>',
  [SUMMARY_FIELD.SCORE]: SCORE_ORDER.join(' | '),
  [SUMMARY_FIELD.SUMMARY]: '<one sentence>',
  [SUMMARY_FIELD.VERDICT]: VERDICT_VALUES.join(' | '),
});

function summaryContractLines(fieldNames) {
  return Object.freeze([
    '```yaml',
    ...fieldNames.map((fieldName) => `${fieldName}: ${SUMMARY_FIELD_CONTRACT_VALUES[fieldName]}`),
    '```',
  ]);
}

export const ASSESSMENT_SUMMARY_CONTRACT = summaryContractLines(ASSESSMENT_SUMMARY_FIELD_NAMES);

const QUALITY_GRADE_THRESHOLDS = Object.freeze([
  Object.freeze({ score: 'A', maxIssueCount: 0 }),
  Object.freeze({ score: 'B', maxIssueCount: 1 }),
  Object.freeze({ score: 'C', maxIssueCount: 3 }),
  Object.freeze({ score: 'D', maxIssueCount: 6 }),
  Object.freeze({ score: 'F', maxIssueCount: Infinity }),
]);

export function gradeFromIssueCount(issueCount) {
  const count = Number.isFinite(issueCount) ? issueCount : 0;
  return QUALITY_GRADE_THRESHOLDS.find((threshold) => count <= threshold.maxIssueCount)?.score || 'F';
}
