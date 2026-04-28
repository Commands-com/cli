import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_OPTIONS } from '../src/command-option-schema.js';
import { OPTION_READER_NAMES } from '../src/command-option-resolvers.js';
import { readCommandOptionValue } from '../src/command-options.js';
import { buildImplementationPlanPrompt, buildImplementationTaskPrompt } from '../src/implementation-prompts.js';
import { splitPromptIntent } from '../src/prompt-intent.js';
import { formatRepoContext } from '../src/repo-context-prompt.js';

const context = {
  repoRoot: '/tmp/repo',
  branch: 'main',
  head: 'abc123',
  status: ' M src/app.js',
  diffStat: 'src/app.js | 2 ++',
  diff: 'diff --git a/src/app.js b/src/app.js',
};

function promptIntent(prompt) {
  return splitPromptIntent(prompt).intent;
}

test('implementation plan prompt asks for non-overlapping JSON tasks', () => {
  const prompt = buildImplementationPlanPrompt({
    objective: 'fix review findings',
    context,
    findings: 'finding one',
    testCommand: 'npm test',
    maxTasks: 4,
  });
  assert.match(prompt, /Plan implementation tasks/);
  assert.match(prompt, /Maximum tasks: 4/);
  assert.match(prompt, /fenced JSON object/);
  assert.match(prompt, /Do not assign the same file/);
  assert.match(prompt, /files array is the enforced edit boundary/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'implementation-plan',
    maxTasks: 4,
    hasTestCommand: true,
  });
});

test('implementation task prompt scopes an implementer to assigned files', () => {
  const prompt = buildImplementationTaskPrompt({
    objective: 'fix review findings',
    context,
    findings: 'finding one',
    testCommand: 'npm test',
    task: {
      id: 'task-1',
      title: 'Fix parser',
      files: ['src/parser.js'],
      instructions: 'Tighten parsing.',
    },
  });
  assert.match(prompt, /not alone in the codebase/);
  assert.match(prompt, /Only edit the files assigned/);
  assert.match(prompt, /Assigned files: src\/parser\.js/);
  assert.match(prompt, /Tighten parsing/);
  assert.deepEqual(promptIntent(prompt), {
    kind: 'implementation-task',
    taskId: 'task-1',
    fileCount: 1,
    hasTestCommand: true,
  });
});

test('formatRepoContext caps long diffs with an explicit marker', () => {
  const text = formatRepoContext({ ...context, diff: 'abcdef' }, { maxDiffChars: 3 });
  assert.match(text, /Diff:\nabc\n\n\[commands-com: git diff truncated after 3 characters/);
  assert.doesNotMatch(text, /abcdef/);
});

test('formatRepoContext truncates large diffs', () => {
  const text = formatRepoContext({ ...context, diff: 'x'.repeat(20) }, { maxDiffChars: 5 });
  assert.match(text, /xxxxx/);
  assert.match(text, /git diff truncated after 5 characters/);
});

test('command option metadata has executable readers', () => {
  const cases = {
    stringOption: {
      raw: 'value',
      fallback: 'fallback',
      expected: 'value',
      missing: 'fallback',
    },
    booleanOption: {
      raw: 'true',
      fallback: false,
      expected: true,
      missing: false,
    },
    positiveIntegerOption: {
      raw: '3',
      fallback: 1,
      expected: 3,
      missing: 1,
    },
    nonNegativeIntegerOption: {
      raw: '0',
      fallback: 1,
      expected: 0,
      missing: 1,
    },
    listOption: {
      raw: 'tests, maintainability',
      fallback: ['default'],
      expected: ['tests', 'maintainability'],
      missing: ['default'],
    },
  };

  for (const option of COMMAND_OPTIONS) {
    assert.ok(OPTION_READER_NAMES.includes(option.readWith), `--${option.name} declares an unknown reader`);

    const readerCase = cases[option.readWith];
    assert.deepEqual(
      readCommandOptionValue(new Map([[option.name, readerCase.raw]]), option.name, readerCase.fallback),
      readerCase.expected,
      `--${option.name} should execute ${option.readWith}`,
    );
    assert.deepEqual(
      readCommandOptionValue(new Map(), option.name, readerCase.fallback),
      readerCase.missing,
      `--${option.name} should use fallback through ${option.readWith}`,
    );

    for (const alias of option.aliases) {
      assert.deepEqual(
        readCommandOptionValue(new Map([[alias, readerCase.raw]]), option.name, readerCase.fallback),
        readerCase.expected,
        `--${option.name} should read alias --${alias}`,
      );
      assert.deepEqual(
        readCommandOptionValue(new Map([[option.name, readerCase.raw]]), alias, readerCase.fallback),
        readerCase.expected,
        `--${alias} should read canonical option --${option.name}`,
      );
    }
  }

  assert.throws(
    () => readCommandOptionValue(new Map(), 'does-not-exist', ''),
    /unknown command option: --does-not-exist/,
  );
});
