import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildImplementationBatches,
  parseImplementationPlan,
} from '../src/task-plan-parsing.js';

const LOCAL_DIR = '.commands-com';

function planText(tasks) {
  return JSON.stringify({ tasks });
}

test('parseImplementationPlan reads fenced JSON tasks and normalizes files', () => {
  const tasks = parseImplementationPlan([
    '```json',
    planText([
      {
        id: 'Parser task',
        title: 'Fix parser',
        files: [
          './src/parser.js',
          'src/parser.js',
          './src\\helpers.js',
          './src/generated/',
          '../secret',
          'foo/..',
          'C:\\tmp\\nope',
          '/tmp/nope',
          `${LOCAL_DIR}/runs/x`,
        ],
        instructions: 'Tighten parser behavior.',
      },
    ]),
    '```',
  ].join('\n'));

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'parser-task');
  assert.deepEqual(tasks[0].files, ['src/parser.js', 'src/helpers.js', 'src/generated/']);
  assert.equal(tasks[0].instructions, 'Tighten parser behavior.');
});

test('parseImplementationPlan adds concrete instruction file refs to task ownership', () => {
  const tasks = parseImplementationPlan(planText([
    {
      id: 'Task with conditional source edit',
      files: ['test/task-worktrees.test.js'],
      instructions: [
        'Add coverage in test/task-worktrees.test.js:165.',
        'If withWorktreeAddLock is module-private, export it from src/task-worktrees.js.',
        'Generated fixtures may live under test/fixtures/generated/.',
        'Keep package.json metadata in sync if the command surface changes.',
        'Ignore /tmp/nope.js, ../outside.js, and .commands-com/runs/x.md.',
      ].join(' '),
    },
  ]));

  assert.deepEqual(tasks[0].files, [
    'test/task-worktrees.test.js',
    'src/task-worktrees.js',
    'test/fixtures/generated/',
    'package.json',
  ]);
});

test('parseImplementationPlan reads unfenced JSON from surrounding text', () => {
  const tasks = parseImplementationPlan(
    'prefix {"tasks":[{"id":"a","files":["./src\\\\a.js","/tmp/nope"],"instructions":"Fix A"}]} suffix',
  );

  assert.deepEqual(tasks, [
    {
      id: 'a',
      title: 'a',
      files: ['src/a.js'],
      instructions: 'Fix A',
      order: 1,
    },
  ]);
});

test('parseImplementationPlan uses one fallback task for malformed JSON', () => {
  const tasks = parseImplementationPlan('not json', { fallbackInstructions: 'fix everything safely' });

  assert.deepEqual(tasks, [
    {
      id: 'task-1',
      title: 'Implement synthesized findings',
      files: [],
      instructions: 'fix everything safely',
      order: 1,
    },
  ]);
});

test('parseImplementationPlan treats an empty task array as an explicit no-op plan', () => {
  const tasks = parseImplementationPlan('{"tasks":[]}', { fallbackInstructions: 'fix empty plan safely' });

  assert.deepEqual(tasks, []);
});

test('parseImplementationPlan normalizes incomplete task entries without plan fallback', () => {
  const tasks = parseImplementationPlan(planText([
    {
      id: '!!!',
      title: '  ',
      files: 'src/parser.js',
      instructions: '  ',
    },
  ]), { fallbackInstructions: 'do not use this fallback' });

  assert.deepEqual(tasks, [
    {
      id: 'task-1',
      title: 'task-1',
      files: [],
      instructions: 'task-1',
      order: 1,
    },
  ]);
});

test('parseImplementationPlan de-duplicates normalized task ids before artifact paths use them', () => {
  const longId = 'Long duplicate implementation task id '.repeat(4);
  const tasks = parseImplementationPlan(planText([
    { id: 'Task A', instructions: 'Do A once.' },
    { id: 'task-a', instructions: 'Do A twice.' },
    { id: 'Task A!!', instructions: 'Do A three times.' },
    { id: 'task-a-2', instructions: 'Use an id that collides with a generated suffix.' },
    { id: longId, instructions: 'Use a long id once.' },
    { id: longId, instructions: 'Use a long id twice.' },
  ]));

  const ids = tasks.map((task) => task.id);
  assert.deepEqual(ids.slice(0, 4), [
    'task-a',
    'task-a-2',
    'task-a-3',
    'task-a-2-2',
  ]);
  assert.match(ids[4], /^long-duplicate-implementation-task-id-/);
  assert.match(ids[5], /^long-duplicate-implementation-task-id-.*-2$/);
  assert.equal(new Set(ids).size, tasks.length);
  assert.ok(ids.every((id) => id.length <= 80));
});

test('parseImplementationPlan caps tasks with explicit maxTasks handling', () => {
  const text = planText(Array.from({ length: 8 }, (_, index) => ({
    id: `Task ${index + 1}`,
    instructions: `Do task ${index + 1}.`,
  })));

  assert.deepEqual(
    parseImplementationPlan(text, { maxTasks: 2 }).map((task) => task.id),
    ['task-1', 'task-2'],
  );
  assert.deepEqual(
    parseImplementationPlan(text, { maxTasks: 0 }).map((task) => task.id),
    ['task-1'],
  );
  assert.equal(parseImplementationPlan(text, /** @type {any} */ ({ maxTasks: 'invalid' })).length, 6);
});

test('buildImplementationBatches groups only non-overlapping tasks', () => {
  const tasks = [
    { id: 'a', files: ['src/a.js'] },
    { id: 'b', files: ['src/b.js'] },
    { id: 'a2', files: ['src/a.js'] },
    { id: 'generated-dir', files: ['src/generated/'] },
    { id: 'generated-file', files: ['src/generated/new.js'] },
    { id: 'generated-sibling', files: ['src/generated-extra/new.js'] },
    { id: 'unknown', files: [] },
  ];

  const batches = buildImplementationBatches(tasks, { maxParallel: 2, parallel: true });
  assert.deepEqual(batches.map((batch) => batch.map((task) => task.id)), [
    ['a', 'b'],
    ['a2', 'generated-dir'],
    ['generated-file', 'generated-sibling'],
    ['unknown'],
  ]);
});

test('buildImplementationBatches serializes when parallel is disabled', () => {
  const tasks = [
    { id: 'a', files: ['src/a.js'] },
    { id: 'b', files: ['src/b.js'] },
  ];

  const batches = buildImplementationBatches(tasks, { maxParallel: 4, parallel: false });
  assert.deepEqual(batches.map((batch) => batch.map((task) => task.id)), [['a'], ['b']]);
});
