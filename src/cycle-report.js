import { WORKSPACE_MODES } from './workflow-constants.js';

export function cycleReportHeader({
  title,
  store,
  providerIds,
  model,
  primaryProvider,
  context,
  workspace,
  summaryLines = [],
  unresolvedTestFailure = false,
}) {
  return [
    `# ${title}`,
    '',
    `Run: ${store.runId}`,
    `Providers: ${providerIds.join(', ')}${model ? ` (${model})` : ''}`,
    `Synthesizer/implementer: ${primaryProvider.id}`,
    `Repository: ${context.repoRoot}`,
    `Workspace mode: ${workspace.mode}`,
    ...summaryLines,
    unresolvedTestFailure ? 'Unresolved test failure: yes' : '',
    workspace.mode === WORKSPACE_MODES.WORKTREE ? `Worktree branch: ${workspace.branch}` : '',
    workspace.mode === WORKSPACE_MODES.WORKTREE ? `Worktree path: ${workspace.cwd}` : '',
    workspace.prune?.ok ? 'Worktree pruned: yes (no changes vs base)' : '',
    '',
  ].filter((line) => line !== undefined && line !== null && line !== false);
}

export function worktreeNextSteps(workspace) {
  if (workspace.mode !== WORKSPACE_MODES.WORKTREE || workspace.prune?.ok) return '';
  return [
    '',
    '## Worktree Next Steps',
    '',
    `Inspect changes: \`cd ${workspace.cwd}\``,
    `Merge manually from branch: \`${workspace.branch}\``,
  ].join('\n');
}
