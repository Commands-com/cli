import { runCycleWorkflow } from './cycle-workflow.js';
import {
  formatReviewReport,
  reviewHasFinalIssues,
  selectReviewFinalCycleWithFallback,
} from './assessment-report.js';
import {
  assessmentNeedsImplementation,
  buildReviewCompletionPayload,
  completeAssessmentCommandRun,
} from './assessment-completion.js';
import { hasFlag, listOption, stringOption } from './command-options.js';
import { readRunMetadata } from './run-store.js';
import {
  formatIssueCount,
  parseReviewSummary,
  summarizeReviewCycle,
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
 * Test seam dependencies accepted by `runReviewCommand`. The bag may carry an
 * override for `runCycleWorkflow` itself; remaining fields are spread into the
 * inner workflow's own `dependencies` (see `RunCycleWorkflowDependencies`).
 *
 * @typedef {RunCycleWorkflowDependencies & { runCycleWorkflow?: typeof runCycleWorkflow }} RunReviewCommandDependencies
 */

/**
 * @typedef {object} RunReviewCommandArgs
 * @property {string} cwd Command working directory.
 * @property {CycleLogger} [logger] Optional logger override (defaults to a review logger).
 * @property {RunReviewCommandDependencies} [dependencies] Optional test seam.
 */

/**
 * @param {ParsedCycleCommand} parsed
 * @param {RunReviewCommandArgs} args
 */
export async function runReviewCommand(parsed, { cwd, logger = createCommandLogger(parsed, { kind: 'review' }), dependencies = {} }) {
  const metadata = await resumeMetadata(parsed, cwd);
  const objective = parsed.positionals.join(' ').trim()
    || metadata?.objective
    || 'Review the current repository changes.';
  const reviewers = metadata && !hasFlag(parsed.flags, 'reviewers') && Array.isArray(metadata.reviewers) && metadata.reviewers.length
    ? metadata.reviewers
    : listOption(parsed.flags, 'reviewers', /** @type {string[]} */ (DEFAULT_REVIEWERS));
  const { runCycleWorkflow: workflow = runCycleWorkflow, ...workflowDeps } = dependencies;

  const state = await workflow(parsed, {
    cwd,
    kind: 'review',
    label: objective,
    metadata: {
      objective,
      reviewers,
    },
    logger,
    adapter: createReviewAssessmentAdapter({ objective, reviewers }),
    dependencies: workflowDeps,
  });

  return completeAssessmentCommandRun({
    state,
    reportArtifactName: 'review-cycle',
    formatReport: formatReviewReport,
    formatReportOptions: { objective },
    selectFinalCycle: selectReviewFinalCycleWithFallback,
    buildCompletionPayload: buildReviewCompletionPayload,
    hasFinalIssues: reviewHasFinalIssues,
  });
}

async function resumeMetadata(parsed, cwd) {
  const resume = stringOption(parsed.flags, 'resume', '');
  if (!resume) return null;
  return (await readRunMetadata(cwd, resume)).value;
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
      const summary = summarizeReviewCycle(outputs.map(withReviewSummary));
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
