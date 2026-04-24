import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { localWorktreesPath } from '../src/config.js';
import {
  createTaskWorktree,
  prepareTaskWorktreeBaseline,
  removeTaskWorktree,
  repoRelativePathForContext,
  validateTaskPatch,
} from '../src/task-worktrees.js';
import { runGit } from '../src/git.js';
import { initGitRepo } from './support/git.js';

const LOCAL_DIR = '.commands-com';

test('createTaskWorktree creates a scoped cwd and removeTaskWorktree cleans it up', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-lifecycle-'));
  const repoRoot = path.join(tmp, 'repo');
  const appRoot = path.join(repoRoot, 'packages', 'app');

  try {
    await fs.mkdir(appRoot, { recursive: true });
    await initGitRepo(repoRoot, { initialCommit: false });
    await fs.writeFile(path.join(appRoot, 'README.md'), '# app\n', 'utf8');
    await runGit(['add', 'packages/app/README.md'], repoRoot);
    await runGit(['commit', '--no-gpg-sign', '-m', 'init app'], repoRoot);

    const worktree = await createTaskWorktree({
      integrationCwd: appRoot,
      context: {
        isGit: true,
        gitRoot: repoRoot,
        repoRoot: appRoot,
      },
      taskRoot: tmp,
      runId: 'Run With Spaces',
      cycle: 4,
      taskId: 'Task With Spaces',
      attempt: 2,
    });

    assert.equal(path.dirname(worktree.path), localWorktreesPath(tmp, 'run-with-spaces', 'cycle-4'));
    assert.match(path.basename(worktree.path), /^task-with-spaces-attempt-2-[a-f0-9]{6}$/);
    assert.equal(worktree.cwd, path.join(worktree.path, 'packages', 'app'));
    assert.equal(worktree.managerCwd, appRoot);
    assert.equal(worktree.attempt, 2);
    assert.match(worktree.baseSha, /^[a-f0-9]{40}$/);
    assert.equal(await fs.readFile(path.join(worktree.cwd, 'README.md'), 'utf8'), '# app\n');

    const listed = await runGit(['worktree', 'list', '--porcelain'], appRoot);
    assert.ok(listed.stdout.includes(worktree.path));

    const cleanup = await removeTaskWorktree(worktree);
    assert.deepEqual(cleanup, { ok: true, error: '' });
    assert.equal(await pathExists(worktree.path), false);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createTaskWorktree trims trailing dashes when runId or taskId slug truncation lands on a hyphen', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-slug-trim-'));
  const repoRoot = path.join(tmp, 'repo');

  try {
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot, { readmeText: '# repo\n' });

    // 25 alphanumeric chars separated by spaces normalize to 49 chars of
    // alternating letter/dash; slug()'s 48-char TASK_WORKTREE_SLUG_MAX slice
    // lands on a trailing dash that previously left a stray `-` in both the
    // run and task path segments.
    const longSlugInput = 'a b c d e f g h i j k l m n o p q r s t u v w x y';
    const expectedSlug = 'a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x';

    const worktree = await createTaskWorktree({
      integrationCwd: repoRoot,
      context: { isGit: true, gitRoot: repoRoot, repoRoot },
      taskRoot: tmp,
      runId: longSlugInput,
      cycle: 2,
      taskId: longSlugInput,
      attempt: 1,
    });

    const taskSegment = path.basename(worktree.path);
    const cycleSegment = path.basename(path.dirname(worktree.path));
    const runSegment = path.basename(path.dirname(path.dirname(worktree.path)));

    assert.equal(cycleSegment, 'cycle-2');
    assert.equal(runSegment, expectedSlug);
    assert.match(taskSegment, new RegExp(`^${expectedSlug}-attempt-1-[a-f0-9]{6}$`));
    assert.doesNotMatch(runSegment, /--/);
    assert.doesNotMatch(taskSegment, /--/);

    await removeTaskWorktree(worktree);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createTaskWorktree rejects an empty successful base ref resolution', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-empty-base-'));
  const bin = path.join(tmp, 'bin');
  const integrationCwd = path.join(tmp, 'repo');
  const callLog = path.join(tmp, 'git-calls.txt');
  const fakeGit = path.join(bin, 'git');
  const originalPath = process.env.PATH;
  const originalCallLog = process.env.GIT_CALL_LOG;

  try {
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(integrationCwd, { recursive: true });
    await fs.writeFile(fakeGit, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$GIT_CALL_LOG"',
      'if [ "$1" = "rev-parse" ]; then',
      '  exit 0',
      'fi',
      'if [ "$1" = "worktree" ]; then',
      '  echo "worktree add should not run" >&2',
      '  exit 2',
      'fi',
      'echo "unexpected git command: $*" >&2',
      'exit 2',
      '',
    ].join('\n'), { mode: 0o755 });

    process.env.PATH = `${bin}${path.delimiter}${originalPath || ''}`;
    process.env.GIT_CALL_LOG = callLog;

    await assert.rejects(
      () => createTaskWorktree({
        integrationCwd,
        context: {
          isGit: true,
          gitRoot: integrationCwd,
          repoRoot: integrationCwd,
        },
        taskRoot: tmp,
        runId: 'empty-base-run',
        cycle: 1,
        taskId: 'empty-base-task',
      }),
      /could not resolve task worktree base 'HEAD'/,
    );
    assert.equal(await fs.readFile(callLog, 'utf8'), 'rev-parse --verify HEAD\n');
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    if (originalCallLog === undefined) {
      delete process.env.GIT_CALL_LOG;
    } else {
      process.env.GIT_CALL_LOG = originalCallLog;
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('createTaskWorktree serializes concurrent add operations against the same repo', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-race-'));
  const repoRoot = path.join(tmp, 'repo');
  try {
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot);
    const context = { isGit: true, gitRoot: repoRoot, repoRoot };
    const worktrees = await Promise.all(Array.from({ length: 8 }, (_, i) => createTaskWorktree({
      integrationCwd: repoRoot, context, taskRoot: tmp,
      runId: 'race-run', cycle: 1, taskId: `race-task-${i + 1}`,
    })));
    assert.equal(worktrees.length, 8);
    for (const worktree of worktrees) {
      assert.match(worktree.baseSha, /^[a-f0-9]{40}$/);
    }
    await Promise.all(worktrees.map((worktree) => removeTaskWorktree(worktree)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('prepareTaskWorktreeBaseline rejects non-0/1 staged diff status', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-task-worktree-staged-status-'));

  try {
    await assert.rejects(
      () => prepareTaskWorktreeBaseline({ cwd: tmp, baseSha: 'base-sha' }, ''),
      /task worktree baseline diff failed:/,
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('validateTaskPatch rejects CLI artifacts and files outside the task assignment', () => {
  const task = {
    id: 'patch-task',
    files: ['src/allowed.js'],
  };
  const cliArtifact = [LOCAL_DIR, 'runs', 'cycle-1', 'tasks', 'status.json'].join('/');

  assert.deepEqual(validateTaskPatch({
    task,
    files: ['src/allowed.js'],
  }), {
    ok: true,
    errors: [],
  });

  const validation = validateTaskPatch({
    task,
    files: [
      'src/allowed.js',
      'src/unassigned.js',
      cliArtifact,
    ],
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, [
    `task patch-task changed CLI-owned artifact path: ${cliArtifact}`,
    'task patch-task changed unassigned file: src/unassigned.js',
    `task patch-task changed unassigned file: ${cliArtifact}`,
  ]);

  assert.deepEqual(validateTaskPatch({
    task: { id: 'open-task', files: [] },
    files: ['src/anything.js'],
  }), {
    ok: true,
    errors: [],
  });
});

test('validateTaskPatch treats assigned directory entries as owned scopes', () => {
  const validation = validateTaskPatch({
    task: { id: 'directory-task', files: ['src/generated/', 'test/fixtures'] },
    files: [
      'src/generated/new-helper.js',
      'src/generated/nested/deeper.js',
      'test/fixtures',
      'src/generated-extra/not-owned.js',
    ],
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, [
    'task directory-task changed unassigned file: src/generated-extra/not-owned.js',
  ]);
});

test('validateTaskPatch rejects Windows drive-letter absolute paths as outside task scope', () => {
  const task = { id: 'win-task', files: ['src/allowed.js'] };

  const validation = validateTaskPatch({
    task,
    files: [
      'src/allowed.js',
      'C:/foo',
      'c:/foo',
      'Z:/x/y.js',
      'D:\\nested\\file.js',
    ],
  });

  assert.equal(validation.ok, false);
  assert.deepEqual(validation.errors, [
    'task win-task changed file outside assigned scope: C:/foo',
    'task win-task changed file outside assigned scope: c:/foo',
    'task win-task changed file outside assigned scope: Z:/x/y.js',
    'task win-task changed file outside assigned scope: D:/nested/file.js',
  ]);

  assert.deepEqual(validateTaskPatch({
    task: { id: 'posix-task', files: ['src/allowed.js', 'lib/helper.js'] },
    files: ['src/allowed.js', 'lib/helper.js'],
  }), {
    ok: true,
    errors: [],
  });
});

test('repoRelativePathForContext only rejects parent-traversal segments, not names that merely start with ".."', () => {
  const gitRoot = path.resolve('/repo');
  const callForRelative = (rel) => repoRelativePathForContext({
    gitRoot,
    repoRoot: path.resolve(gitRoot, rel),
  });

  // In-repo paths whose first segment merely begins with '..' must be accepted.
  assert.equal(callForRelative('..foo'), '..foo');
  assert.equal(callForRelative('..bar/baz'), '..bar/baz');
  assert.equal(callForRelative('src/x'), 'src/x');

  // Genuine parent-traversal must still be rejected.
  assert.equal(callForRelative('..'), '');
  assert.equal(callForRelative('../escape'), '');

  // Same gitRoot/repoRoot yields '' from path.relative — must be rejected.
  assert.equal(repoRelativePathForContext({ gitRoot, repoRoot: gitRoot }), '');

  // Missing gitRoot or repoRoot is rejected (covers the '' guard).
  assert.equal(repoRelativePathForContext({ gitRoot: '', repoRoot: gitRoot }), '');
  assert.equal(repoRelativePathForContext({ gitRoot, repoRoot: '' }), '');

  // A relative value of '.' is defensively rejected even though path.relative
  // would not normally produce it: simulate by pointing repoRoot at gitRoot
  // via a trailing '.' segment, which path.resolve collapses to gitRoot.
  assert.equal(repoRelativePathForContext({ gitRoot, repoRoot: path.resolve(gitRoot, '.') }), '');
});

test('repoRelativePathForContext rejects cross-drive absolute relative results on Windows', { skip: process.platform !== 'win32' }, () => {
  // On Windows, path.relative returns an absolute path when from/to live on
  // different drives. The path.isAbsolute guard must keep rejecting that.
  const gitRoot = 'C:\\repo';
  const repoRoot = 'D:\\elsewhere';
  assert.equal(repoRelativePathForContext({ gitRoot, repoRoot }), '');
});

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
