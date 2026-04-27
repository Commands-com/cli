import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { localWorktreesPath } from '../src/config.js';
import * as git from '../src/git.js';
import { initGitRepo } from './support/git.js';

const {
  collectRepoContext,
  createIsolatedWorktree,
  filterCliStatus,
  runGit,
} = git;
const NODE_EXECFILE_DEFAULT_MAX_BUFFER = 1024 * 1024;

function mockExecFile(t, execFile) {
  const mockedExecFile = t.mock.method(childProcess, 'execFile', execFile);
  syncBuiltinESMExports();
  t.after(() => {
    mockedExecFile.mock.restore();
    syncBuiltinESMExports();
  });
}

async function createRepoWithLargeDiff() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-large-git-output-'));
  const repoRoot = path.join(tmp, 'repo');
  await fs.mkdir(repoRoot, { recursive: true });
  await initGitRepo(repoRoot, { readmeText: '# repo\n' });

  const target = path.join(repoRoot, 'large.txt');
  await fs.writeFile(target, 'seed\n', 'utf8');
  await runGit(['add', 'large.txt'], repoRoot);
  await runGit(['commit', '--no-gpg-sign', '-m', 'add large file'], repoRoot);
  await fs.writeFile(target, `${'x'.repeat(120)}\n`.repeat(11_000), 'utf8');
  return { tmp, repoRoot };
}

async function removeTree(target) {
  await fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}

test('createIsolatedWorktree creates safe paths and branches for a label', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-worktree-plan-'));
  const repoRoot = path.join(tmp, 'repo');

  try {
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot, { readmeText: '# repo\n' });
    const expectedRepoRoot = await fs.realpath(repoRoot);

    const workspace = await createIsolatedWorktree(repoRoot, {
      kind: 'review',
      label: 'Fix failing tests!',
    });
    const id = path.basename(workspace.path);
    const match = id.match(/^\d{8}-\d{6}-review-fix-failing-tests-([a-f0-9]{6})$/);

    assert.ok(match, `unexpected worktree id: ${id}`);
    const suffix = match[1];
    assert.equal(workspace.id, id);
    assert.equal(workspace.path, localWorktreesPath(expectedRepoRoot, id));
    assert.equal(workspace.branch, `commands-com/review/fix-failing-tests-${suffix}`);
    assert.equal(workspace.originalRepoRoot, expectedRepoRoot);
    assert.match(workspace.baseSha, /^[a-f0-9]{40}$/);
  } finally {
    await removeTree(tmp);
  }
});

test('createIsolatedWorktree trims trailing dashes when the label slug truncation lands on a hyphen', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-worktree-slug-trim-'));
  const repoRoot = path.join(tmp, 'repo');

  try {
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot, { readmeText: '# repo\n' });

    // 22 alphanumeric chars separated by spaces normalize to 43 chars of
    // alternating letter/dash; slug()'s 42-char WORKTREE_SLUG_MAX slice lands
    // on a trailing dash that previously left a `--` in the worktree id and
    // git branch name.
    const label = 'a b c d e f g h i j k l m n o p q r s t u v';
    const workspace = await createIsolatedWorktree(repoRoot, { kind: 'review', label });
    const id = path.basename(workspace.path);

    assert.doesNotMatch(id, /--/);
    assert.match(id, /^\d{8}-\d{6}-review-a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-[a-f0-9]{6}$/);
    assert.doesNotMatch(workspace.branch, /--/);
    assert.match(workspace.branch, /^commands-com\/review\/a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-[a-f0-9]{6}$/);
  } finally {
    await removeTree(tmp);
  }
});

test('createIsolatedWorktree emits random suffixes by default so parallel runs do not collide', { skip: process.platform === 'win32' }, async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-worktree-random-'));
  const repoRoot = path.join(tmp, 'repo');

  try {
    await fs.mkdir(repoRoot, { recursive: true });
    await initGitRepo(repoRoot, { readmeText: '# repo\n' });

    const a = await createIsolatedWorktree(repoRoot, { kind: 'review', label: 'same label' });
    const b = await createIsolatedWorktree(repoRoot, { kind: 'review', label: 'same label' });

    assert.notEqual(a.id, b.id);
    assert.notEqual(a.path, b.path);
    assert.notEqual(a.branch, b.branch);
  } finally {
    await removeTree(tmp);
  }
});

test('runGit returns a stable result shape with exit code 0 on successful commands', async () => {
  const result = await runGit(['--version'], process.cwd());
  assert.deepEqual(Object.keys(result).sort(), ['code', 'errorCode', 'ok', 'reason', 'stderr', 'stdout']);
  assert.deepEqual({
    ok: result.ok,
    code: result.code,
    reason: result.reason,
    errorCode: result.errorCode,
    stderr: result.stderr,
  }, {
    ok: true,
    code: 0,
    reason: '',
    errorCode: '',
    stderr: '',
  });
  assert.match(result.stdout, /^git version /);
});

test('runGit returns a stable result shape with numeric exit code on failed commands', async () => {
  const result = await runGit(['--definitely-not-a-real-option'], process.cwd());
  assert.deepEqual(Object.keys(result).sort(), ['code', 'errorCode', 'ok', 'reason', 'stderr', 'stdout']);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'exit');
  assert.equal(result.errorCode, '');
  assert.equal(typeof result.code, 'number');
  assert.notEqual(result.code, 0);
  assert.equal(typeof result.stdout, 'string');
  assert.equal(typeof result.stderr, 'string');
});

test('runGit classifies spawn failures with the child process error code', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-git-spawn-'));
  const missingCwd = path.join(tmp, 'missing');

  try {
    const result = await runGit(['--version'], missingCwd);

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'spawn');
    assert.equal(result.code, 'ENOENT');
    assert.equal(result.errorCode, 'ENOENT');
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ENOENT/);
  } finally {
    await removeTree(tmp);
  }
});

test('runGit classifies child process timeouts', async (t) => {
  mockExecFile(t, (file, args, options, callback) => {
    assert.equal(file, 'git');
    assert.deepEqual(args, ['status']);
    assert.equal(options.timeout, 12);

    const error = Object.assign(new Error('Command failed: git status'), {
      code: null,
      killed: true,
      signal: 'SIGTERM',
      cmd: 'git status',
    });
    callback(error, '', '');
  });

  const result = await runGit(['status'], process.cwd(), { timeoutMs: 12 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.code, 124);
  assert.equal(result.errorCode, '');
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /git command timed out after 12ms/);
});

test('runGit captures git output larger than Node execFile default buffer', async () => {
  const { tmp, repoRoot } = await createRepoWithLargeDiff();

  try {
    const result = await runGit(['--no-pager', 'diff', '--', 'large.txt'], repoRoot, { timeoutMs: 30_000 });

    assert.equal(result.ok, true, result.stderr);
    assert.ok(
      result.stdout.length > NODE_EXECFILE_DEFAULT_MAX_BUFFER,
      `expected diff output above ${NODE_EXECFILE_DEFAULT_MAX_BUFFER} bytes, got ${result.stdout.length}`,
    );
    assert.match(result.stdout, /^diff --git /);
  } finally {
    await removeTree(tmp);
  }
});

test('runGit reports a clear error when git output exceeds the configured buffer', async () => {
  const { tmp, repoRoot } = await createRepoWithLargeDiff();

  try {
    const result = await runGit(['--no-pager', 'diff', '--', 'large.txt'], repoRoot, {
      timeoutMs: 30_000,
      maxBuffer: 1024,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'max-buffer');
    assert.equal(result.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.equal(result.errorCode, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.match(result.stderr, /git output exceeded the 1 KiB capture limit/);
    assert.match(result.stderr, /git --no-pager diff -- large\.txt/);
  } finally {
    await removeTree(tmp);
  }
});

test('collectRepoContext reports oversized changed diffs to callers', async () => {
  const { tmp, repoRoot } = await createRepoWithLargeDiff();

  try {
    const context = await collectRepoContext(repoRoot, {
      changed: true,
      diffMaxBuffer: 1024,
    });

    assert.match(context.diffError, /git diff capture failed/);
    assert.match(context.diffError, /git output exceeded the 1 KiB capture limit/);
    assert.equal(context.diff, context.diffError);
  } finally {
    await removeTree(tmp);
  }
});

// Build a `git status --porcelain=v1 -z` buffer. Each record is NUL-terminated;
// rename/copy entries emit the new path first followed by the original path as
// a separate NUL record per Git's -z contract.
function nulRecords(...records) {
  return `${records.join('\0')}\0`;
}

test('filterCliStatus drops .commands-com entries from -z porcelain output', () => {
  const input = nulRecords(
    ' M src/app.js',
    '?? .commands-com/',
    '?? .commands-com/runs/20260101-010203-review-foo/report.md',
    '?? packages/app/.commands-com/runs/20260101-010203-review-foo/report.md',
    'R  new/.commands-com/report.md', 'old/.commands-com/report.md',
    'R  .commands-com/runs/report with spaces.md', 'src/app.js',
    'R  new path/report.md', 'old path/.commands-com/report.md',
    '?? packages/app/.commands-com/run "quoted".md',
    'A  README.md',
    'R  src/new -> still tracked.md', 'src/old -> still tracked.md',
  );
  const filtered = filterCliStatus(input);
  assert.match(filtered, / M src\/app\.js/);
  assert.match(filtered, /A  README\.md/);
  assert.match(filtered, /src\/old -> still tracked\.md/);
  assert.doesNotMatch(filtered, /\.commands-com/);
});

test('filterCliStatus preserves rename arrows in raw paths while dropping CLI state renames', () => {
  const input = nulRecords(
    'R  .commands-com/new -> cli.md', 'src/old -> tracked.md',
    'R  src/restored -> name.md', '.commands-com/old -> cli.md',
    'R  .commands-com/new " -> name.md', 'src/old " -> name.md',
    'R  src/new -> still tracked.md', 'src/old -> still tracked.md',
    'R  src/new " -> name.md', 'src/old " -> name.md',
  );

  assert.equal(filterCliStatus(input), [
    'R  src/old -> still tracked.md -> src/new -> still tracked.md',
    'R  src/old " -> name.md -> src/new " -> name.md',
  ].join('\n'));
});

test('filterCliStatus filters CLI state paths with non-ASCII bytes', () => {
  const input = nulRecords(
    '?? src/.commands-com/café notes.md',
    'R  .commands-com/naïve.md', 'src/café notes.md',
    '?? src/café notes.md',
    'R  docs/naïve.md', 'src/café.md',
  );

  assert.equal(filterCliStatus(input), [
    '?? src/café notes.md',
    'R  src/café.md -> docs/naïve.md',
  ].join('\n'));
});

test('filterCliStatus filters CLI state paths with control bytes', () => {
  const input = nulRecords(
    '?? src/.commands-com/run\x07\vtab.md',
    '?? src/bell\x07\vtab.md',
  );

  assert.equal(filterCliStatus(input), '?? src/bell\x07\vtab.md');
});

test('filterCliStatus handles renamed and copied entries with raw special chars', () => {
  const input = nulRecords(
    'R  src/restored.md', '.commands-com/old -> cli.md',
    'R  .commands-com/new -> cli.md', 'src/old -> tracked.md',
    'C  packages/app/.commands-com/copied.md', 'templates/base.md',
    '?? packages/app/.commands-com/run space.md',
    'R  src/new -> still tracked.md', 'src/old -> still tracked.md',
    'C  src/copied "quoted".md', 'src/template.md',
    '?? src/.commands-composer/file.md',
  );

  assert.equal(filterCliStatus(input), [
    'R  src/old -> still tracked.md -> src/new -> still tracked.md',
    'C  src/template.md -> src/copied "quoted".md',
    '?? src/.commands-composer/file.md',
  ].join('\n'));
});

test('filterCliStatus preserves tracked paths with spaces while dropping CLI state', () => {
  const input = nulRecords(
    ' M src/file with spaces.js',
    '?? .commands-com/run with spaces.md',
    '?? packages/app/.commands-com/run with spaces.md',
    'A  packages/app/.commands-com/generated report.md',
    'A  docs/release notes.md',
    '?? packages/app/.commands-composer/run with spaces.md',
  );

  assert.equal(filterCliStatus(input), [
    ' M src/file with spaces.js',
    'A  docs/release notes.md',
    '?? packages/app/.commands-composer/run with spaces.md',
  ].join('\n'));
});

test('filterCliStatus handles paths containing multiple " -> " sequences', () => {
  const input = nulRecords(
    'R  .commands-com/beta.md -> src/gamma.md', 'src/alpha.md',
    'R  packages/app/.commands-com/gamma.md', 'src/alpha.md -> src/beta.md',
    'R  src/restored.md', '.commands-com/old -> generated.md',
    'R  src/beta.md -> src/gamma.md', 'src/alpha.md',
    'R  src/new -> name.md', 'src/old -> name.md',
  );

  assert.equal(filterCliStatus(input), [
    'R  src/alpha.md -> src/beta.md -> src/gamma.md',
    'R  src/old -> name.md -> src/new -> name.md',
  ].join('\n'));
});

test('filterCliStatus handles paths with literal quote and backslash bytes', () => {
  const input = nulRecords(
    'R  src/restored.md', 'src/.commands-com/old "quoted".md',
    'R  src/.commands-com/new \\backslash.md', 'src/old.md',
    'C  .commands-com/copied "quoted".md', 'src/template.md',
    '?? src/.commands-com/run with spaces.md',
    'R  src/new \\backslash.md', 'src/old "quoted".md',
    'C  src/copied "quote" and -> arrow.md', 'src/template.md',
  );

  assert.equal(filterCliStatus(input), [
    'R  src/old "quoted".md -> src/new \\backslash.md',
    'C  src/template.md -> src/copied "quote" and -> arrow.md',
  ].join('\n'));
});

test('filterCliStatus handles renames with raw spaces and backslashes in either side', () => {
  const input = nulRecords(
    'R  docs/restored.md', 'src/.commands-com/old name\\draft.md',
    'R  packages/app/.commands-com/new name\\draft.md', 'src/plain.md',
    'R  docs/new.md', 'src/old name\\draft.md',
    'R  docs/new name\\draft.md', 'src/plain.md',
  );

  assert.equal(filterCliStatus(input), [
    'R  src/old name\\draft.md -> docs/new.md',
    'R  src/plain.md -> docs/new name\\draft.md',
  ].join('\n'));
});

test('filterCliStatus filters CLI state paths with tab bytes', () => {
  // Newlines in raw paths would conflict with the newline-joined return shape,
  // so we exercise tab and carriage-return bytes here; the parser handles all
  // raw bytes the same way.
  const input = nulRecords(
    '?? src/.commands-com/run\twith\rescapes.md',
    ' M packages/app/.commands-com/report\rwith\tescapes.md',
    'R  src/.commands-com/new\tname.md', 'src/old\rname.md',
    'C  .commands-com/copied\rname.md', 'src/template.md',
    '?? src/user\tfile.md',
    'R  src/new\rname.md', 'src/old\rname.md',
  );

  assert.equal(filterCliStatus(input), [
    '?? src/user\tfile.md',
    'R  src/old\rname.md -> src/new\rname.md',
  ].join('\n'));
});

test('filterCliStatus passes through records that do not match the porcelain status prefix', () => {
  const input = nulRecords(
    'R100 .commands-com/source.md -> src/restored.md',
    'C100 src/template.md -> packages/app/.commands-com/copied.md',
    'R100 src/old.md -> src/new.md',
  );

  assert.equal(filterCliStatus(input), [
    'R100 .commands-com/source.md -> src/restored.md',
    'C100 src/template.md -> packages/app/.commands-com/copied.md',
    'R100 src/old.md -> src/new.md',
  ].join('\n'));
});
