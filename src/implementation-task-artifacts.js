import {
  cycleArtifactPath,
  cycleMarkdownArtifactPath,
  cyclePromptArtifactPath,
} from './artifact-paths.js';
import {
  implementationTaskExecution,
  implementationTaskWorkspace,
} from './implementation-task-context.js';
import { formatFailureMessage } from './errors.js';
import { safePathSegment } from './safe-path.js';

const ACTIVE_TASK_ARTIFACT_ROOT = 'tasks';
const TASK_STATUS_ARTIFACT = 'status.json';

function taskArtifactSegment(task) {
  return safePathSegment(task?.id, 'task');
}

export function taskArtifacts(cycle, task) {
  const taskSegment = taskArtifactSegment(task);
  const taskRoot = [ACTIVE_TASK_ARTIFACT_ROOT, taskSegment];
  const artifact = (...segments) => cycleArtifactPath(cycle, ...taskRoot, ...segments);
  const markdown = (...segments) => cycleMarkdownArtifactPath(cycle, ...taskRoot, ...segments);

  return {
    prompt: cyclePromptArtifactPath(cycle, 'task', taskSegment),
    status: artifact(TASK_STATUS_ARTIFACT),
    output: markdown('output'),
    worktree: artifact('worktree-path.txt'),
    diff: artifact('diff.patch'),
    diffStat: artifact('diff-stat.txt'),
    changedFiles: artifact('changed-files.json'),
    mergeLog: artifact('merge.log'),
    error: markdown('error'),
    attemptStatus: (attempt) => artifact(
      'attempts',
      String(attempt),
      TASK_STATUS_ARTIFACT,
    ),
    attempts: (attempt, name) => markdown(
      'attempts',
      String(attempt),
      name,
    ),
  };
}

export async function writeJsonArtifact(store, artifactPath, value) {
  if (typeof store.writeJson === 'function') {
    return store.writeJson(artifactPath, value);
  }
  return store.write(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function taskFailureErrorArtifacts(cycle, task) {
  const artifacts = taskArtifacts(cycle, task);
  return [artifacts.error];
}

export async function writeTaskErrorArtifacts(store, artifactPaths, error) {
  const text = formatFailureMessage(error);
  for (const artifactPath of artifactPaths) {
    await store.write(artifactPath, text);
  }
  return text;
}

function taskStatusPayload({
  taskRunContext,
  task,
  state,
  attempt,
  worktree,
  baseline,
  patchInfo,
  error,
  cleanup,
}) {
  const { provider } = implementationTaskExecution(taskRunContext);
  const worktreePath = worktree?.cwd || worktree?.path || '';
  const worktreeRoot = worktree?.path || '';
  const baseSha = worktree?.baseSha || '';
  const baselineRef = baseline?.baselineRef || '';
  const baselineSha = baseline?.baselineSha || '';
  const changedFiles = patchInfo?.files || [];
  const diffStat = patchInfo?.diffStat || '';

  return {
    id: task.id,
    title: task.title,
    state,
    attempt,
    provider: provider?.id || '',
    files: Array.isArray(task.files) ? task.files : [],
    worktree: worktree || null,
    worktreePath,
    worktreeRoot,
    baseSha,
    baseline: baseline || null,
    baselineRef,
    baselineSha,
    changedFiles,
    diffStat,
    cleanup: cleanup || null,
    error: error ? formatFailureMessage(error) : '',
    updatedAt: new Date().toISOString(),
  };
}

export function taskResultPayload({
  taskRunContext,
  task,
  text,
  attempt,
  state = 'succeeded',
  worktree,
  baseline,
  patchInfo,
}) {
  const { provider } = implementationTaskExecution(taskRunContext);
  const worktreePath = worktree?.cwd || worktree?.path || '';
  const worktreeRoot = worktree?.path || '';
  const baseSha = worktree?.baseSha || '';
  const baselineRef = baseline?.baselineRef || '';
  const baselineSha = baseline?.baselineSha || '';
  const patch = patchInfo?.patch || '';
  const diffStat = patchInfo?.diffStat || '';
  const changedFiles = patchInfo?.files || [];

  return {
    task,
    provider: provider?.id || '',
    text: text || '',
    attempt,
    state,
    worktree: worktree || null,
    worktreePath,
    worktreeRoot,
    baseSha,
    baseline: baseline || null,
    baselineRef,
    baselineSha,
    patch,
    diffStat,
    changedFiles,
  };
}

async function writeTaskStatus(taskRunContext, task, status, {
  writeAttemptStatus = false,
} = {}) {
  const { store, cycle } = implementationTaskWorkspace(taskRunContext);
  const artifacts = taskArtifacts(cycle, task);
  await writeJsonArtifact(store, artifacts.status, status);
  if (writeAttemptStatus && Number.isInteger(status?.attempt) && status.attempt > 0) {
    await writeJsonArtifact(store, artifacts.attemptStatus(status.attempt), status);
  }
  return status;
}

export async function writeTaskState(taskRunContext, {
  task,
  attempt,
  state,
  workspace,
  worktree,
  baseline,
  patchInfo,
  error,
  cleanup,
  writeAttemptStatus,
}) {
  return writeTaskStatus(taskRunContext, task, taskStatusPayload({
    taskRunContext,
    task,
    attempt,
    state,
    worktree: worktree ?? workspace?.worktree,
    baseline: baseline ?? workspace?.baseline,
    patchInfo,
    error,
    cleanup,
  }), { writeAttemptStatus });
}
