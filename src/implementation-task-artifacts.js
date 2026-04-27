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

/**
 * @typedef {import('./cycle-state.js').CycleStore} CycleStore
 * @typedef {import('./implementation-task-context.js').ImplementationTask} ImplementationTask
 * @typedef {import('./implementation-task-context.js').ImplementationTaskRunContext} ImplementationTaskRunContext
 * @typedef {import('./implementation-task-context.js').ImplementationTaskAttemptWorkspace} ImplementationTaskAttemptWorkspace
 * @typedef {import('./implementation-task-context.js').TaskBaseline} TaskBaseline
 * @typedef {import('./implementation-task-context.js').TaskPatchInfo} TaskPatchInfo
 * @typedef {import('./implementation-task-context.js').TaskWorktree} TaskWorktree
 * @typedef {import('./implementation-task-context.js').TaskWorktreeRemoval} TaskWorktreeRemoval
 */

/**
 * Subset of `TaskPatchInfo` carried into status/result payloads. Merge
 * call sites pass `{ files, diffStat }`; capture-phase call sites pass
 * the full `TaskPatchInfo`.
 *
 * @typedef {object} TaskArtifactPatchSummary
 * @property {string} [patch]
 * @property {string} [diffStat]
 * @property {Array<string>} [files]
 * @property {string} [status]
 */

/**
 * Set of artifact paths produced by `taskArtifacts`.
 *
 * @typedef {object} TaskArtifactPaths
 * @property {string} prompt
 * @property {string} status
 * @property {string} output
 * @property {string} worktree
 * @property {string} diff
 * @property {string} diffStat
 * @property {string} changedFiles
 * @property {string} mergeLog
 * @property {string} error
 * @property {(attempt: number) => string} attemptStatus
 * @property {(attempt: number, name: string) => string} attempts
 */

/**
 * Persisted task status payload written to `status.json`.
 *
 * @typedef {object} TaskStatusPayload
 * @property {string} id
 * @property {string} title
 * @property {string} state
 * @property {number} attempt
 * @property {string} provider
 * @property {Array<string>} files
 * @property {TaskWorktree | null} worktree
 * @property {string} worktreePath
 * @property {string} worktreeRoot
 * @property {string} baseSha
 * @property {TaskBaseline | null} baseline
 * @property {string} baselineRef
 * @property {string} baselineSha
 * @property {Array<string>} changedFiles
 * @property {string} diffStat
 * @property {TaskWorktreeRemoval | null} cleanup
 * @property {string} error
 * @property {string} updatedAt
 */

/**
 * Result payload returned by `taskResultPayload` and consumed by the
 * merge phase.
 *
 * @typedef {object} TaskResultPayload
 * @property {ImplementationTask} task
 * @property {string} provider
 * @property {string} text
 * @property {number} attempt
 * @property {string} state
 * @property {TaskWorktree | null} worktree
 * @property {string} worktreePath
 * @property {string} worktreeRoot
 * @property {string} baseSha
 * @property {TaskBaseline | null} baseline
 * @property {string} baselineRef
 * @property {string} baselineSha
 * @property {string} patch
 * @property {string} diffStat
 * @property {Array<string>} changedFiles
 */

const ACTIVE_TASK_ARTIFACT_ROOT = 'tasks';
const TASK_STATUS_ARTIFACT = 'status.json';

/**
 * @param {Pick<ImplementationTask, 'id'> | undefined} task
 * @returns {string}
 */
function taskArtifactSegment(task) {
  return safePathSegment(task?.id, 'task');
}

/**
 * @param {number} cycle
 * @param {Pick<ImplementationTask, 'id'>} task
 * @returns {TaskArtifactPaths}
 */
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

/**
 * @param {CycleStore} store
 * @param {string} artifactPath
 * @param {unknown} value
 * @returns {Promise<string>}
 */
export async function writeJsonArtifact(store, artifactPath, value) {
  if (typeof store.writeJson === 'function') {
    return store.writeJson(artifactPath, value);
  }
  return store.write(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {number} cycle
 * @param {Pick<ImplementationTask, 'id'>} task
 * @returns {Array<string>}
 */
export function taskFailureErrorArtifacts(cycle, task) {
  const artifacts = taskArtifacts(cycle, task);
  return [artifacts.error];
}

/**
 * Renders `error` via `formatFailureMessage` and writes the rendered text
 * to every `artifactPath` in order. Returns the rendered text so direct
 * callers can reuse it.
 *
 * @param {CycleStore} store
 * @param {Array<string>} artifactPaths
 * @param {unknown} error
 * @returns {Promise<string>}
 */
export async function writeTaskErrorArtifacts(store, artifactPaths, error) {
  const text = formatFailureMessage(error);
  for (const artifactPath of artifactPaths) {
    await store.write(artifactPath, text);
  }
  return text;
}

/**
 * @param {{
 *   taskRunContext: ImplementationTaskRunContext,
 *   task: ImplementationTask,
 *   state: string,
 *   attempt: number,
 *   worktree?: TaskWorktree | null,
 *   baseline?: TaskBaseline | null,
 *   patchInfo?: TaskArtifactPatchSummary,
 *   error?: unknown,
 *   cleanup?: TaskWorktreeRemoval | null,
 * }} args
 * @returns {TaskStatusPayload}
 */
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

/**
 * @param {{
 *   taskRunContext: ImplementationTaskRunContext,
 *   task: ImplementationTask,
 *   text?: string,
 *   attempt: number,
 *   state?: string,
 *   worktree?: TaskWorktree | null,
 *   baseline?: TaskBaseline | null,
 *   patchInfo?: TaskArtifactPatchSummary,
 * }} args
 * @returns {TaskResultPayload}
 */
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

/**
 * @param {ImplementationTaskRunContext} taskRunContext
 * @param {Pick<ImplementationTask, 'id'>} task
 * @param {TaskStatusPayload} status
 * @param {{ writeAttemptStatus?: boolean }} [options]
 * @returns {Promise<TaskStatusPayload>}
 */
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

/**
 * @param {ImplementationTaskRunContext} taskRunContext
 * @param {{
 *   task: ImplementationTask,
 *   attempt: number,
 *   state: string,
 *   workspace?: ImplementationTaskAttemptWorkspace,
 *   worktree?: TaskWorktree | null,
 *   baseline?: TaskBaseline | null,
 *   patchInfo?: TaskArtifactPatchSummary,
 *   error?: unknown,
 *   cleanup?: TaskWorktreeRemoval | null,
 *   writeAttemptStatus?: boolean,
 * }} args
 * @returns {Promise<TaskStatusPayload>}
 */
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
