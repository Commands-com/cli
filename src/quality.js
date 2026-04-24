import {
  providerItemResolvedArtifactPath,
} from './artifact-paths.js';
import { runCycleWorkflow } from './cycle-workflow.js';
import {
  formatQualityReport,
  qualityHasFinalIssues,
  selectQualityFinalCycleWithFallback,
} from './assessment-report.js';
import {
  assessmentNeedsImplementation,
  buildQualityCompletionPayload,
  completeAssessmentCommandRun,
} from './assessment-completion.js';
import {
  formatIssueCount,
  parseQualitySummary,
  summarizeQualityCycle,
  worstScore,
} from './cycle-summary.js';
import { hasFlag, listOption, stringOption } from './command-options.js';
import { readRunMetadata } from './run-store.js';
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
 *   outputs?: Array<Object>,
 *   providerIssueCount?: number,
 * }} QualityCycleRecord
 */

export async function runQualityCommand(parsed, { cwd, logger = createCommandLogger(parsed, { kind: 'quality' }), dependencies = {} } = {}) {
  const descriptors = await resolveQualityAreaDescriptors(parsed, cwd);
  const areas = descriptors.map((descriptor) => descriptor.value);
  const { runCycleWorkflow: workflow = runCycleWorkflow, ...workflowDeps } = dependencies;

  const state = await workflow(parsed, {
    cwd,
    kind: 'quality',
    label: areas.join('-'),
    metadata: {
      areas,
    },
    logger,
    adapter: createQualityAssessmentAdapter({ areas, descriptors }),
    dependencies: workflowDeps,
  });

  return completeAssessmentCommandRun({
    state,
    reportArtifactName: 'code-quality',
    formatReport: formatQualityReport,
    selectFinalCycle: selectQualityFinalCycleWithFallback,
    buildCompletionPayload: buildQualityCompletionPayload,
    hasFinalIssues: qualityHasFinalIssues,
  });
}

async function resolveQualityAreaDescriptors(parsed, cwd) {
  const areas = await loadQualityAreas(parsed, cwd);
  const descriptors = createAssessmentFanoutItems(areas, { pathFallback: 'area' });
  const seen = new Set();
  return descriptors.filter((descriptor) => {
    if (seen.has(descriptor.pathSegment)) return false;
    seen.add(descriptor.pathSegment);
    return true;
  });
}

async function loadQualityAreas(parsed, cwd) {
  if (stringOption(parsed.flags, 'resume', '') && !hasFlag(parsed.flags, 'area')) {
    const { value: metadata } = await readRunMetadata(cwd, stringOption(parsed.flags, 'resume', ''));
    if (Array.isArray(metadata.areas) && metadata.areas.length) return metadata.areas;
  }
  return listOption(parsed.flags, 'area', DEFAULT_AREAS);
}

function createQualityAssessmentAdapter({ areas, descriptors }) {
  const auditItems = createQualityAuditItems(descriptors);
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
      return summarizeQualityCycle(outputs);
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
    implementation({ cycleRecord }) {
      return {
        objective: `Improve code quality for areas: ${areas.join(', ')}`,
        testFailureUpdates: { score: worstScore([cycleRecord.score, 'F']) },
      };
    },
  };
}

function createQualityAuditItems(descriptors) {
  if (descriptors.length === 0) return [];
  return [{
    value: descriptors.map((descriptor) => String(descriptor.value)),
    label: descriptors.map((descriptor) => descriptor.label).join(', '),
    pathSegment: descriptors.length === 1 ? descriptors[0].pathSegment : 'all-areas',
  }];
}
