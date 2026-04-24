import { compactPrompt } from './prompt-intent.js';
import { formatRepoContext } from './repo-context-prompt.js';

export function buildImplementationPlanPrompt({ objective, findings, context, testCommand = '', maxTasks = 6 }) {
  return compactPrompt([
    'Plan implementation tasks for a Commands.com fix loop.',
    'Split the synthesized findings into non-overlapping implementation tasks that can safely run in parallel.',
    'Only separate tasks when their file ownership is clearly disjoint. If ownership is unclear or overlapping, return one task.',
    'Treat tests, fixtures, and shared helpers as owned files; assign them explicitly when a task needs them.',
    'If shared tests or helpers would overlap across tasks, collapse that work into one task instead of assigning competing implementers.',
    'Prefer deleting or collapsing code over adding abstractions when behavior and readability stay intact.',
    'Do not add tests by default; include test changes only when they protect user-visible contracts, risky integration boundaries, or realistic regressions.',
    '',
    `Objective: ${objective}`,
    `Maximum tasks: ${maxTasks}`,
    testCommand ? `Validation command: ${testCommand}` : '',
    '',
    'Repository context:',
    formatRepoContext(context),
    '',
    'Findings to fix:',
    findings || '(none)',
    '',
    'Return only a fenced JSON object with this shape:',
    '',
    '```json',
    '{',
    '  "tasks": [',
    '    {',
    '      "id": "task-1",',
    '      "title": "Short task title",',
    '      "files": ["relative/path.ext"],',
    '      "instructions": "Concrete implementation instructions for this task."',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'Rules:',
    '- Use repository-relative file paths.',
    '- Do not assign the same file to more than one task.',
    '- The files array is the enforced edit boundary; if task instructions allow touching a file, include that file in files.',
    '- Assign every file a worker may need, including tests, fixtures, and helpers.',
    '- Keep each task independently executable by a separate CLI.',
    '- Prefer fewer tasks when in doubt.',
  ], {
    kind: 'implementation-plan',
    maxTasks,
    hasTestCommand: Boolean(testCommand),
  });
}

export function buildImplementationTaskPrompt({ objective, task, findings, context, testCommand = '' }) {
  const files = Array.isArray(task?.files) ? task.files : [];
  return compactPrompt([
    'You are one implementer in a Commands.com orchestrated fix loop.',
    'You are not alone in the codebase; other implementers may be editing their assigned files in parallel.',
    files.length
      ? 'Only edit the files assigned to this task. Do not edit shared tests/helpers unless they are assigned. If another file is required, stop and explain why instead of editing it.'
      : 'No exclusive file list was assigned. Make the smallest safe changes and avoid unrelated files.',
    'Prefer deleting or collapsing code over adding abstractions, and add or adjust tests only for user-visible contracts, risky boundaries, or realistic regressions.',
    'Do not create public exports, wrappers, aliases, or facades solely to make tests easier.',
    '',
    `Objective: ${objective}`,
    `Task: ${task?.title || task?.id || 'implementation task'}`,
    files.length ? `Assigned files: ${files.join(', ')}` : '',
    testCommand ? `Validation command: ${testCommand}` : '',
    '',
    'Task instructions:',
    task?.instructions || '(none)',
    '',
    'Repository context:',
    formatRepoContext(context),
    '',
    'Full synthesized findings:',
    findings || '(none)',
    '',
    'Make the smallest safe code changes needed. Summarize what changed and any remaining risk.',
  ], {
    kind: 'implementation-task',
    taskId: task?.id,
    fileCount: files.length,
    hasTestCommand: Boolean(testCommand),
  });
}
