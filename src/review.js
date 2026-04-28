import { runCycleWorkflow } from './cycle-workflow.js';
import {
  DEFAULT_REVIEW_FINAL_CYCLE,
  finalCycleWithDefaults,
  formatReviewReport,
  reviewHasFinalIssues,
} from './assessment-report.js';
import {
  assessmentNeedsImplementation,
  buildAssessmentCompletionPayload,
  completeAssessmentCommandRun,
} from './assessment-completion.js';
import { metadataListOption, readResumeMetadata } from './resume-metadata.js';
import {
  formatIssueCount,
  parseReviewSummary,
  summarizeScoredOutputs,
} from './cycle-summary.js';
import { createCommandLogger } from './logger.js';
import {
  buildReviewPrompt,
  buildReviewSynthesisPrompt,
  formatReviewAssessmentOutputs,
} from './assessment-prompts.js';
import { createAssessmentFanoutItems } from './cycle-fanout.js';
import { safePathSegment } from './safe-path.js';

const DEFAULT_REVIEWERS = Object.freeze(['correctness', 'tests', 'maintainability']);

/**
 * @typedef {import('./cycle-state.js').CycleRecordBase} CycleRecordBase
 * @typedef {import('./cycle-state.js').CycleLogger} CycleLogger
 * @typedef {import('./cycle-state.js').CycleState} CycleState
 * @typedef {import('./cycle-state.js').CycleRunContext} CycleRunContext
 * @typedef {import('./cycle-state.js').CycleRepoContext} CycleRepoContext
 * @typedef {import('./cycle-workflow.js').ParsedCycleCommand} ParsedCycleCommand
 * @typedef {import('./cycle-workflow.js').RunCycleWorkflowDependencies} RunCycleWorkflowDependencies
 * @typedef {import('./assessment-cycle.js').AssessmentCycleAdapter} AssessmentCycleAdapter
 * @typedef {import('./assessment-cycle.js').AssessmentCycleProviderOutput} AssessmentCycleProviderOutput
 */

/**
 * Cycle record produced by `createReviewAssessmentAdapter().buildCycleRecord`.
 *
 * `reviewerIssueCount` is the pre-synthesis aggregate from raw reviewer outputs.
 * `issueCount` (from synthesis) may differ when synthesis collapses or expands
 * findings. Both are reported so consumers can see how synthesis adjusted them.
 *
 * @typedef {CycleRecordBase & {
 *   reviewers?: Array<AssessmentCycleProviderOutput & { role: string }>,
 *   reviewerIssueCount?: number,
 * }} ReviewCycleRecord
 */

/**
 * @typedef {object} RunReviewCommandArgs
 * @property {string} cwd Command working directory.
 * @property {CycleLogger} [logger] Optional logger override (defaults to a review logger).
 * @property {RunCycleWorkflowDependencies} [dependencies] Optional test seam forwarded to the cycle workflow.
 */

/**
 * @param {ParsedCycleCommand} parsed
 * @param {RunReviewCommandArgs} args
 */
export async function runReviewCommand(parsed, { cwd, logger = createCommandLogger(parsed, { kind: 'review' }), dependencies = {} }) {
  const metadata = await readResumeMetadata(parsed, cwd);
  const objective = parsed.positionals.join(' ').trim()
    || metadata?.objective
    || 'Review the current repository changes.';
  const reviewers = metadataListOption(parsed, metadata, {
    flag: 'reviewers',
    metadataField: 'reviewers',
    fallback: /** @type {string[]} */ (DEFAULT_REVIEWERS),
  });

  const state = await runCycleWorkflow(parsed, {
    cwd,
    kind: 'review',
    label: objective,
    metadata: {
      objective,
      reviewers,
    },
    logger,
    adapter: createReviewAssessmentAdapter({ objective, reviewers }),
    dependencies,
  });

  return completeAssessmentCommandRun({
    state,
    reportArtifactName: 'review-cycle',
    formatReport: formatReviewReport,
    formatReportOptions: { objective },
    selectFinalCycle: (cycles) => finalCycleWithDefaults(
      Array.isArray(cycles) ? cycles.at(-1) : undefined,
      DEFAULT_REVIEW_FINAL_CYCLE,
    ),
    buildCompletionPayload: (args) => buildAssessmentCompletionPayload({
      ...args,
      type: 'review.completed',
      fallbackCycle: DEFAULT_REVIEW_FINAL_CYCLE,
    }),
    hasFinalIssues: reviewHasFinalIssues,
  });
}

function createReviewAssessmentAdapter({ objective, reviewers }) {
  return {
    findingsTitle: 'Reviewer outputs',
    synthesisFallbackDescription: 'reviewer summaries',
    logCycleStart({ runContext, cycle }) {
      runContext.logger.info(`cycle ${cycle}: reviewers`);
    },
    fanout({ runContext, cycle }) {
      return {
        items: createAssessmentFanoutItems(reviewers, {
          getPathSegment: ({ value: role, itemIndex }) => (
            `${String(itemIndex + 1).padStart(2, '0')}-${safePathSegment(role, 'reviewer')}`
          ),
        }),
        label: 'reviewer fan-out',
        partial: true,
        adapter: {
          artifactRoot: 'reviewers',
          buildPrompt: ({ item: role, context }) => buildReviewPrompt({
            objective,
            role,
            context,
            cycle,
            priorFindings: runContext.priorFindings,
          }),
          buildOutput: ({ provider, item: role, text }) => ({
            provider: provider.id,
            role,
            text,
            ...parseReviewSummary(text),
          }),
          logOutput: ({ provider, item: role, output }) => {
            runContext.logger.info(`${provider.id}/${role}: ${output.score} (${formatIssueCount(output.issueCount)}) - ${output.synopsis}`);
          },
        },
      };
    },
    summarizeOutputs({ outputs }) {
      const summary = summarizeScoredOutputs(outputs.map(withReviewSummary), {
        noun: 'review issue',
        itemName: 'role',
        label: (output) => output.role,
      });
      return {
        ...summary,
        reviewerIssueCount: summary.issueCount,
      };
    },
    summarizeSynthesis({ outputSummary, synthesisText }) {
      return {
        ...parseReviewSummary(synthesisText),
        reviewerIssueCount: outputSummary.reviewerIssueCount,
      };
    },
    buildSynthesisPrompt({ context, cycle, outputs }) {
      return buildReviewSynthesisPrompt({
        objective,
        context,
        cycle,
        reviewerOutputs: outputs,
      });
    },
    buildCycleRecord({
      outputs,
      cycleSummary,
      synthesisProvider,
      synthesisText,
      synthesisError,
    }) {
      return {
        ...cycleSummary,
        synthesisProvider,
        synthesis: synthesisText,
        synthesisError,
        reviewers: outputs.map(withReviewSummary),
      };
    },
    formatOutputs(outputs) {
      return formatReviewAssessmentOutputs(outputs);
    },
    hasFixableIssues({ runContext, cycleRecord }) {
      return assessmentNeedsImplementation(runContext, cycleRecord, {
        hasFinalIssues: reviewHasFinalIssues,
      });
    },
    afterCycle({ runContext, cycle, cycleRecord }) {
      if (runContext.options.fix) {
        runContext.logger.info(`cycle ${cycle} score: ${cycleRecord.score} (${formatIssueCount(cycleRecord.issueCount)})`);
        runContext.logger.info(`cycle ${cycle} synopsis: ${cycleRecord.synopsis}`);
      }
    },
    implementation() {
      return { objective };
    },
  };
}

function withReviewSummary(output) {
  return {
    ...output,
    ...parseReviewSummary(output.text),
  };
}
