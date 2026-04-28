import {
  providerItemResolvedArtifactPath,
} from './artifact-paths.js';
import { runCycleWorkflow } from './cycle-workflow.js';
import {
  DEFAULT_QUALITY_FINAL_CYCLE,
  finalCycleWithDefaults,
  formatQualityReport,
  qualityHasFinalIssues,
} from './assessment-report.js';
import {
  assessmentNeedsImplementation,
  buildAssessmentCompletionPayload,
  completeAssessmentCommandRun,
} from './assessment-completion.js';
import {
  formatIssueCount,
  parseQualitySummary,
  summarizeScoredOutputs,
} from './cycle-summary.js';
import { metadataListOption, readResumeMetadata } from './resume-metadata.js';
import { createCommandLogger } from './logger.js';
import {
  buildQualityAuditPrompt,
  buildQualitySynthesisPrompt,
  formatQualityAssessmentOutputs,
} from './assessment-prompts.js';
import { createAssessmentFanoutItems } from './cycle-fanout.js';

const DEFAULT_AREAS = Object.freeze(['architecture', 'correctness', 'maintainability', 'tests']);

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
 * @typedef {import('./cycle-fanout.js').AssessmentFanoutItemDescriptor} AssessmentFanoutItemDescriptor
 */

/**
 * Cycle record produced by `createQualityAssessmentAdapter().buildCycleRecord`.
 *
 * `providerIssueCount` is the pre-synthesis aggregate from raw provider outputs.
 * `issueCount` (inherited from `cycleSummary`) is the post-synthesis count, which
 * may collapse or expand the provider total. Both are reported so consumers can
 * see how synthesis adjusted findings.
 *
 * @typedef {CycleRecordBase & {
 *   outputs?: Array<AssessmentCycleProviderOutput>,
 *   providerIssueCount?: number,
 * }} QualityCycleRecord
 */

/**
 * @typedef {object} RunQualityCommandArgs
 * @property {string} cwd Command working directory.
 * @property {CycleLogger} [logger] Optional logger override (defaults to a quality logger).
 * @property {RunCycleWorkflowDependencies} [dependencies] Optional test seam forwarded to the cycle workflow.
 */

/**
 * @param {ParsedCycleCommand} parsed
 * @param {RunQualityCommandArgs} args
 */
export async function runQualityCommand(parsed, { cwd, logger = createCommandLogger(parsed, { kind: 'quality' }), dependencies = {} }) {
  const descriptors = await resolveQualityAreaDescriptors(parsed, cwd);
  const areas = descriptors.map((descriptor) => descriptor.value);

  const state = await runCycleWorkflow(parsed, {
    cwd,
    kind: 'quality',
    label: areas.join('-'),
    metadata: {
      areas,
    },
    logger,
    adapter: createQualityAssessmentAdapter({ areas, descriptors }),
    dependencies,
  });

  return completeAssessmentCommandRun({
    state,
    reportArtifactName: 'code-quality',
    formatReport: formatQualityReport,
    selectFinalCycle: (cycles) => finalCycleWithDefaults(
      Array.isArray(cycles) ? cycles.at(-1) : undefined,
      DEFAULT_QUALITY_FINAL_CYCLE,
    ),
    buildCompletionPayload: ({ state: completionState, reportPath, finalCycle }) => buildAssessmentCompletionPayload({
      state: completionState,
      reportPath,
      finalCycle,
      type: 'quality.completed',
      fallbackCycle: DEFAULT_QUALITY_FINAL_CYCLE,
      extra: {
        provider: completionState.options.primaryProvider.id,
        outputs: finalCycle.outputs,
      },
    }),
    hasFinalIssues: qualityHasFinalIssues,
  });
}

async function resolveQualityAreaDescriptors(parsed, cwd) {
  const areas = await loadQualityAreas(parsed, cwd);
  return createAssessmentFanoutItems(areas, { pathFallback: 'area' });
}

async function loadQualityAreas(parsed, cwd) {
  return metadataListOption(parsed, await readResumeMetadata(parsed, cwd), {
    flag: 'area',
    metadataField: 'areas',
    fallback: /** @type {string[]} */ (DEFAULT_AREAS),
  });
}

function createQualityAssessmentAdapter({ areas, descriptors }) {
  const auditItems = descriptors.length === 0 ? [] : [{
    value: descriptors.map((descriptor) => String(descriptor.value)),
    label: descriptors.map((descriptor) => descriptor.label).join(', '),
    pathSegment: descriptors.length === 1 ? descriptors[0].pathSegment : 'all-areas',
  }];
  return {
    findingsTitle: 'Provider outputs',
    synthesisFallbackDescription: 'provider summaries',
    logCycleStart({ runContext, cycle }) {
      if (runContext.options.fix) runContext.logger.info(`cycle ${cycle}: audit`);
    },
    fanout({ runContext, cycle }) {
      const cycleChanged = cycle === 1 ? runContext.options.changed : true;
      return {
        items: auditItems,
        label: 'quality fan-out',
        partial: true,
        adapter: {
          artifactRoot: 'areas',
          writeAdditionalArtifacts: async ({ cycle, artifact, text }) => {
            if (cycle === 1) {
              await runContext.store.write(providerItemResolvedArtifactPath(artifact), text);
            }
          },
          buildPrompt: ({ item: auditAreas, context }) => buildQualityAuditPrompt({
            areas: auditAreas,
            context,
            changed: cycleChanged,
            cycle,
            priorFindings: runContext.priorFindings,
          }),
          buildOutput: ({ provider, item: auditAreas, text }) => ({
            provider: provider.id,
            area: auditAreas.join(', '),
            areas: auditAreas,
            text,
            ...parseQualitySummary(text),
          }),
          logOutput: ({ provider, output }) => {
            runContext.logger.info(`${provider.id}/${output.area}: ${output.score} (${formatIssueCount(output.issueCount)}) - ${output.synopsis}`);
          },
        },
      };
    },
    summarizeOutputs({ outputs }) {
      return summarizeScoredOutputs(outputs, {
        noun: 'quality issue',
        itemName: 'provider audit',
        label: (output) => `${output.provider}: ${output.area}`,
      });
    },
    summarizeSynthesis({ synthesisText }) {
      return parseQualitySummary(synthesisText);
    },
    buildSynthesisPrompt({ context, cycle, outputs }) {
      return buildQualitySynthesisPrompt({ areas, context, cycle, outputs });
    },
    buildCycleRecord({
      outputs,
      outputSummary,
      cycleSummary,
      synthesisProvider,
      synthesisText,
      synthesisError,
    }) {
      return {
        ...cycleSummary,
        providerIssueCount: outputSummary.issueCount,
        synthesisProvider,
        synthesis: synthesisText,
        synthesisError,
        outputs,
      };
    },
    formatOutputs(outputs) {
      return formatQualityAssessmentOutputs(outputs);
    },
    hasFixableIssues({ runContext, cycleRecord }) {
      return assessmentNeedsImplementation(runContext, cycleRecord, {
        hasFinalIssues: qualityHasFinalIssues,
      });
    },
    afterCycle({ runContext, cycle, cycleRecord }) {
      if (runContext.options.fix) {
        runContext.logger.info(`cycle ${cycle} score: ${cycleRecord.score} (${formatIssueCount(cycleRecord.issueCount)})`);
        runContext.logger.info(`cycle ${cycle} synopsis: ${cycleRecord.synopsis}`);
      }
    },
    implementation() {
      return {
        objective: `Improve code quality for areas: ${areas.join(', ')}`,
        testFailureUpdates: { score: 'F' },
      };
    },
  };
}
