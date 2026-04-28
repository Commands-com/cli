import { compactPrompt, literalPrompt } from './prompt-intent.js';
import { formatRepoContext } from './repo-context-prompt.js';
import { ASSESSMENT_SUMMARY_CONTRACT } from './summary-contract.js';

/**
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 * @typedef {{ provider: string, text: string, role?: string, area?: string, score?: string, issueCount?: number, minorIssueCount?: number, synopsis?: string }} AssessmentProviderOutput
 * @typedef {Record<string, string|number|boolean|string[]>} AssessmentPromptIntent
 * @typedef {{ summaryNoun: string, summaryContract: ReadonlyArray<string>, trailing?: ReadonlyArray<string> }} AssessmentPromptConfig
 * @typedef {{ opening: string, instructionLines?: ReadonlyArray<string>, detailLines?: ReadonlyArray<string>, context: CycleRepoContext, bodyParts?: ReadonlyArray<string>, config: AssessmentPromptConfig, trailingIntro?: string, trailingLines?: ReadonlyArray<string> }} AssessmentPromptPartsArgs
 * @typedef {{ intent: AssessmentPromptIntent, config: AssessmentPromptConfig, opening: string, guidance: string, objective?: string, cycle: number, scope?: string, context: CycleRepoContext, priorFindings?: string }} BuildFindingPromptArgs
 * @typedef {{ intent: AssessmentPromptIntent, config: AssessmentPromptConfig, opening: string, instructions: string, detailLines: ReadonlyArray<string>, context: CycleRepoContext, outputsLabel: string, outputs: string, synthesisHasIssues: boolean, trailing: ReadonlyArray<string> }} BuildSynthesisPromptArgs
 * @typedef {{ objective?: string, role: string, context: CycleRepoContext, cycle: number, priorFindings?: string }} BuildReviewPromptArgs
 * @typedef {{ objective: string, context: CycleRepoContext, cycle: number, reviewerOutputs: ReadonlyArray<AssessmentProviderOutput> }} BuildReviewSynthesisPromptArgs
 * @typedef {{ areas?: ReadonlyArray<string>, context: CycleRepoContext, changed?: boolean, cycle?: number, priorFindings?: string }} BuildQualityAuditPromptArgs
 * @typedef {{ areas: ReadonlyArray<string>, context: CycleRepoContext, cycle: number, outputs: ReadonlyArray<AssessmentProviderOutput> }} BuildQualitySynthesisPromptArgs
 */

const CURRENT_CODEBASE_SCOPE_GUIDANCE = 'Judge the current codebase, not hypothetical future polish; only prioritize issues worth fixing in the next cycle.';
const SCORE_RUBRIC_GUIDANCE = [
  'Calibrate severity strictly: A means no high-leverage actionable issues remain; B means healthy code with a few meaningful non-urgent improvements; C means moderate repeated change cost; D means serious near-term risk; F means validation is red, behavior is broken, data can be lost, security is compromised, or the code is very hard to change.',
  'Do not grade aspirational improvements, optional coverage, large tests, or minor duplication as D/F unless they create concrete near-term change risk.',
  'major_issue_count counts actionable findings worth another fix cycle; minor_issue_count counts optional cleanup, polish, or hardening that should be visible but should not block an A.',
  'if only minor cleanup and incremental hardening remain then grade it an A',
].join(' ');
const CODE_REDUCTION_GUIDANCE = 'More broadly, prefer deleting code, collapsing paths, and reducing concepts over introducing new abstractions.';
const TEST_COST_GUIDANCE = [
  'Tests are code and carry maintenance cost.',
  'Prefer deleting, consolidating, or simplifying brittle tests over adding more.',
  'Add tests only for user-visible contracts, dangerous integration boundaries, or realistic regressions.',
  'Do not add tests for private helper shapes, transitional aliases, exact log wording, or implementation details.',
].join(' ');
const TEST_SURFACE_GUIDANCE = 'Do not create or preserve public exports, wrappers, aliases, or facades solely to make tests easier.';
const ASSESSMENT_TRAILING_GUIDANCE = Object.freeze([
  CURRENT_CODEBASE_SCOPE_GUIDANCE,
  SCORE_RUBRIC_GUIDANCE,
]);

const REVIEW_ROLE_GUIDANCE = {
  correctness: 'Focus on bugs, edge cases, data integrity, concurrency, and behavioral regressions.',
  tests: [
    'Focus on meaningful regression coverage, brittle assertions, and test strategy.',
    TEST_COST_GUIDANCE,
  ].join(' '),
  maintainability: [
    'Focus on complexity, naming, duplication, boundaries, dead code, and future change cost.',
    'Treat safe code reduction as a review win: remove duplicate paths, collapse needless indirection, and prefer 50 clear lines over 200 lines when behavior and readability are preserved.',
    'Flag new legacy or compatibility layers, aliases, shims, and fallback paths unless the current public contract explicitly requires them.',
    CODE_REDUCTION_GUIDANCE,
    TEST_SURFACE_GUIDANCE,
  ].join(' '),
  security: 'Focus on trust boundaries, unsafe defaults, injection, auth, secrets, and filesystem/process risk.',
  performance: 'Focus on avoidable work, scaling limits, hot paths, memory, IO, and latency.',
};

const QUALITY_AREA_GUIDANCE = {
  architecture: 'Review module boundaries, dependency direction, abstraction weight, and extension points.',
  correctness: REVIEW_ROLE_GUIDANCE.correctness,
  maintainability: [
    'Focus on complexity, naming, duplication, dead code, boundaries, and future change cost.',
    'Treat safe code reduction as a maintainability win: remove duplicate paths, collapse needless indirection, and prefer 50 clear lines over 200 lines when behavior and readability are preserved.',
    'Flag new legacy or compatibility layers, aliases, shims, and fallback paths unless the current public contract explicitly requires them.',
    CODE_REDUCTION_GUIDANCE,
    TEST_SURFACE_GUIDANCE,
  ].join(' '),
  tests: REVIEW_ROLE_GUIDANCE.tests,
  security: REVIEW_ROLE_GUIDANCE.security,
  performance: REVIEW_ROLE_GUIDANCE.performance,
};

const REVIEW_PROMPT_CONFIG = Object.freeze({
  summaryNoun: 'review',
  summaryContract: ASSESSMENT_SUMMARY_CONTRACT,
  trailing: Object.freeze([
    ...ASSESSMENT_TRAILING_GUIDANCE,
    'Only report issues that are actionable and worth fixing. Include file paths when possible.',
    `Prefer small, behavior-preserving fixes; if the clean solution is 50 lines instead of 200, call that out. ${CODE_REDUCTION_GUIDANCE}`,
    TEST_SURFACE_GUIDANCE,
    TEST_COST_GUIDANCE,
  ]),
});

const QUALITY_PROMPT_CONFIG = Object.freeze({
  summaryNoun: 'audit',
  summaryContract: ASSESSMENT_SUMMARY_CONTRACT,
  trailing: Object.freeze([
    ...ASSESSMENT_TRAILING_GUIDANCE,
    'Then include:',
    '- High-leverage improvements',
    '- Code reduction opportunities that preserve clarity',
    '- Legacy or compatibility code that should be removed or avoided',
    '- Safe mechanical fixes',
    '- Risky refactors that need human approval',
    '- Missing validation for user-visible contracts, risky integration boundaries, or realistic regressions',
  ]),
});

const SYNTHESIS_PROMPT_CONFIG = Object.freeze({
  summaryNoun: 'synthesis',
  summaryContract: ASSESSMENT_SUMMARY_CONTRACT,
});

/** @param {ReadonlyArray<AssessmentProviderOutput>} outputs
 * @param {{ heading: (output: AssessmentProviderOutput) => string, details?: (output: AssessmentProviderOutput) => string[] }} options */
function formatAssessmentOutputs(outputs, { heading, details }) {
  const detailsFn = details || (() => []);
  return outputs
    .map((output) => {
      const detailLines = detailsFn(output);
      return [
        `## ${heading(output)}`,
        ...(detailLines.length ? ['', ...detailLines] : []),
        '',
        output.text,
      ].join('\n');
    })
    .join('\n\n');
}

/** @param {ReadonlyArray<AssessmentProviderOutput>} outputs */
export function formatReviewAssessmentOutputs(outputs) {
  return formatAssessmentOutputs(outputs, {
    heading: (output) => `${output.provider} / ${output.role}`,
    details: (output) => output.score ? [
      `Score: ${output.score}`,
      `Major issue count: ${output.issueCount}`,
      `Minor issue count: ${output.minorIssueCount ?? 0}`,
      `Synopsis: ${output.synopsis}`,
    ] : [],
  });
}

/** @param {ReadonlyArray<AssessmentProviderOutput>} outputs */
export function formatQualityAssessmentOutputs(outputs) {
  return formatAssessmentOutputs(outputs, {
    heading: (output) => `${output.provider} / ${output.area}`,
    details: (output) => [
      `Score: ${output.score}`,
      `Major issue count: ${output.issueCount}`,
      `Minor issue count: ${output.minorIssueCount ?? 0}`,
      `Synopsis: ${output.synopsis}`,
    ],
  });
}

/** @param {ReadonlyArray<string>} areas */
function qualityAreasLabel(areas) {
  return areas.map((area) => String(area)).join(', ');
}

/** @param {ReadonlyArray<string>} areas */
function qualityGuidanceForAreas(areas) {
  if (areas.length === 1) return guidanceForArea(areas[0]);
  return [
    'Assess all selected areas in one provider session so findings can share context instead of repeating separate scans.',
    'Choose one overall score for the current codebase across the selected areas.',
    'Area guidance:',
    ...areas.map((area) => `- ${area}: ${guidanceForArea(area)}`),
  ].join('\n');
}

/** @param {string} area
 * @returns {string} */
function guidanceForArea(area) {
  return /** @type {Record<string, string>} */ (QUALITY_AREA_GUIDANCE)[area]
    || QUALITY_AREA_GUIDANCE.maintainability;
}

/** @param {AssessmentPromptConfig} config */
function summaryContractParts(config) {
  return [
    `Return a concise Markdown ${config.summaryNoun} with this exact summary block at the top:`,
    '',
    ...config.summaryContract,
  ];
}

/** @param {string} priorFindings */
function priorFindingsPart(priorFindings) {
  return priorFindings ? ['', 'Previously reported findings:', priorFindings].join('\n') : '';
}

/** @param {ReadonlyArray<ReadonlyArray<string>>} sections */
function joinSections(sections) {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, i) => (i === 0 ? [...section] : ['', ...section]));
}

/** @param {AssessmentPromptPartsArgs} args */
function assessmentPromptParts({
  opening,
  instructionLines = [],
  detailLines = [],
  context,
  bodyParts = [],
  config,
  trailingIntro = '',
  trailingLines = [],
}) {
  return joinSections([
    [opening, ...instructionLines],
    detailLines,
    ['Repository context:', formatRepoContext(context)],
    bodyParts,
    summaryContractParts(config),
    [trailingIntro, ...trailingLines],
  ]);
}

/** @param {BuildFindingPromptArgs} args */
function buildFindingPrompt({
  intent,
  config,
  opening,
  guidance,
  objective = '',
  cycle,
  scope = '',
  context,
  priorFindings = '',
}) {
  return compactPrompt(assessmentPromptParts({
    opening,
    instructionLines: [guidance],
    detailLines: [
      objective ? `Objective: ${objective}` : '',
      `Cycle: ${cycle}`,
      scope,
    ],
    context,
    bodyParts: [priorFindingsPart(priorFindings)],
    config,
    trailingLines: config.trailing,
  }), {
    ...intent,
    cycle,
    hasPriorFindings: Boolean(priorFindings),
  });
}

/** @param {BuildSynthesisPromptArgs} args */
function buildSynthesisPrompt({
  intent,
  config,
  opening,
  instructions,
  detailLines,
  context,
  outputsLabel,
  outputs,
  synthesisHasIssues,
  trailing,
}) {
  return literalPrompt(assessmentPromptParts({
    opening,
    instructionLines: [instructions],
    detailLines,
    context,
    bodyParts: [outputsLabel, outputs || '(none)'],
    config,
    trailingIntro: 'Then include:',
    trailingLines: trailing,
  }), {
    ...intent,
    synthesisHasIssues,
  });
}

/** @param {string} text */
function promptTextHasIssues(text) {
  return /(?:major_issue_count|major issue count):\s*[1-9]\d*/i.test(String(text || ''))
    || /verdict:\s*issues/i.test(String(text || ''));
}

/** @param {BuildReviewPromptArgs} args */
export function buildReviewPrompt({ objective, role, context, cycle, priorFindings = '' }) {
  const guidance = REVIEW_ROLE_GUIDANCE[role] || REVIEW_ROLE_GUIDANCE.correctness;
  return buildFindingPrompt({
    intent: { kind: 'review', role },
    config: REVIEW_PROMPT_CONFIG,
    opening: `You are the ${role} reviewer in a Commands.com review cycle.`,
    guidance,
    objective,
    cycle,
    context,
    priorFindings,
  });
}

/** @param {BuildReviewSynthesisPromptArgs} args */
export function buildReviewSynthesisPrompt({ objective, context, cycle, reviewerOutputs }) {
  return buildSynthesisPrompt({
    intent: { kind: 'review-synthesis', cycle },
    config: SYNTHESIS_PROMPT_CONFIG,
    opening: 'Synthesize review findings for a Commands.com review cycle.',
    instructions: [
      'Deduplicate repeated issues, resolve conflicts between reviewers, prioritize only actionable findings, and choose the final A-F score.',
      CURRENT_CODEBASE_SCOPE_GUIDANCE,
      SCORE_RUBRIC_GUIDANCE,
      `Prefer fixes that reduce code volume, duplication, or indirection while preserving behavior and readability; call out 50-line clean fixes over 200-line versions. ${CODE_REDUCTION_GUIDANCE}`,
      TEST_SURFACE_GUIDANCE,
      TEST_COST_GUIDANCE,
    ].join(' '),
    detailLines: [
      `Objective: ${objective}`,
      `Cycle: ${cycle}`,
    ],
    context,
    outputsLabel: 'Reviewer outputs:',
    outputs: formatReviewAssessmentOutputs(reviewerOutputs),
    synthesisHasIssues: reviewerOutputs.some((output) => promptTextHasIssues(output.text)),
    trailing: [
      '- Final score rationale',
      '- Prioritized findings',
      '- Recommended next steps',
      '- Any disagreement, assumptions, or residual risk',
    ],
  });
}

/** @param {BuildQualityAuditPromptArgs} args */
export function buildQualityAuditPrompt({ areas, context, changed, cycle = 1, priorFindings = '' }) {
  const selectedAreas = Array.isArray(areas) && areas.length ? areas.map((area) => String(area)) : ['maintainability'];
  const singleArea = selectedAreas.length === 1;
  return buildFindingPrompt({
    intent: {
      kind: 'quality',
      ...(singleArea ? { area: selectedAreas[0] } : { areas: selectedAreas }),
      changed: Boolean(changed),
    },
    config: QUALITY_PROMPT_CONFIG,
    opening: singleArea
      ? `You are running a Commands.com code quality audit for area: ${selectedAreas[0]}.`
      : `You are running a Commands.com code quality audit across areas: ${qualityAreasLabel(selectedAreas)}.`,
    guidance: qualityGuidanceForAreas(selectedAreas),
    cycle,
    scope: changed
      ? 'Scope: prioritize the current diff, but mention nearby structural issues when they affect the change.'
      : 'Scope: review the repository at a high level and prioritize high-leverage improvements.',
    context,
    priorFindings,
  });
}

/** @param {BuildQualitySynthesisPromptArgs} args */
export function buildQualitySynthesisPrompt({ areas, context, cycle, outputs }) {
  return buildSynthesisPrompt({
    intent: { kind: 'quality-synthesis', cycle },
    config: SYNTHESIS_PROMPT_CONFIG,
    opening: 'Synthesize code quality findings for a Commands.com quality audit.',
    instructions: [
      'Compare provider scores, deduplicate repeated findings, and choose the final A-F score.',
      CURRENT_CODEBASE_SCOPE_GUIDANCE,
      SCORE_RUBRIC_GUIDANCE,
      `Prioritize fixes that reduce code volume, remove duplication, or simplify control flow when they preserve behavior and readability. ${CODE_REDUCTION_GUIDANCE}`,
      'Treat unnecessary legacy or compatibility layers as maintainability issues.',
      TEST_SURFACE_GUIDANCE,
      TEST_COST_GUIDANCE,
    ].join(' '),
    detailLines: [
      `Areas: ${areas.join(', ')}`,
      `Cycle: ${cycle}`,
    ],
    context,
    outputsLabel: 'Provider outputs:',
    outputs: formatQualityAssessmentOutputs(outputs),
    synthesisHasIssues: outputs.some((output) => {
      const issueCount = Number(output.issueCount);
      return (Number.isFinite(issueCount) && issueCount > 0) || promptTextHasIssues(output.text);
    }),
    trailing: [
      '- Final score rationale',
      '- Prioritized findings',
      '- Recommended next steps',
      '- Any disagreement, assumptions, or residual risk',
    ],
  });
}
