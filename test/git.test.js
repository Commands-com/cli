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

test('filterCliStatus drops .commands-com entries from git status --short output', () => {
  const input = [
    ' M src/app.js',
    '?? .commands-com/',
    '?? .commands-com/runs/20260101-010203-review-foo/report.md',
    '?? packages/app/.commands-com/runs/20260101-010203-review-foo/report.md',
    'R  old/.commands-com/report.md -> new/.commands-com/report.md',
    'R  src/app.js -> ".commands-com/runs/report with spaces.md"',
    'R  "old path/.commands-com/report.md" -> "new path/report.md"',
    '?? "packages/app/.commands-com/run \\"quoted\\".md"',
    'A  README.md',
    'R  "src/old -> still tracked.md" -> "src/new -> still tracked.md"',
  ].join('\n');
  const filtered = filterCliStatus(input);
  assert.match(filtered, / M src\/app\.js/);
  assert.match(filtered, /A  README\.md/);
  assert.match(filtered, /src\/old -> still tracked\.md/);
  assert.doesNotMatch(filtered, /\.commands-com/);
});

test('filterCliStatus preserves quoted rename arrows while dropping CLI state renames', () => {
  const keptRename = 'R  "src/old -> still tracked.md" -> "src/new -> still tracked.md"';
  const keptEscapedArrow = 'R  "src/old \\" -> name.md" -> "src/new \\" -> name.md"';
  const input = [
    'R  "src/old -> tracked.md" -> ".commands-com/new -> cli.md"',
    'R  ".commands-com/old -> cli.md" -> "src/restored -> name.md"',
    'R  "src/old \\" -> name.md" -> ".commands-com/new \\" -> name.md"',
    keptRename,
    keptEscapedArrow,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptRename,
    keptEscapedArrow,
  ].join('\n'));
});

test('filterCliStatus applies Git C-quoted UTF-8 octal escapes before CLI state filtering', () => {
  const keptUtf8Path = String.raw`?? "src/caf\303\251\040notes.md"`;
  const keptUtf8Rename = String.raw`R  "src/caf\303\251.md" -> "docs/na\303\257ve.md"`;
  const input = [
    String.raw`?? "src/\056commands-com/caf\303\251\040notes.md"`,
    String.raw`R  "src/caf\303\251\040notes.md" -> "\056commands-com/na\303\257ve.md"`,
    keptUtf8Path,
    keptUtf8Rename,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptUtf8Path,
    keptUtf8Rename,
  ].join('\n'));
});

test('filterCliStatus applies Git C control escapes before CLI state filtering', () => {
  const keptControlPath = String.raw`?? "src/bell\a\vtab.md"`;
  const input = [
    String.raw`?? "src/\056commands-com/run\a\vtab.md"`,
    keptControlPath,
  ].join('\n');

  assert.equal(filterCliStatus(input), keptControlPath);
});

test('filterCliStatus handles renamed, copied, quoted, and escaped path entries', () => {
  const keptRename = 'R  "src/old -> still tracked.md" -> "src/new -> still tracked.md"';
  const keptCopy = 'C  "src/template.md" -> "src/copied \\"quoted\\".md"';
  const keptLookalike = '?? "src/.commands-composer/file.md"';
  const input = [
    'R  ".commands-com/old -> cli.md" -> "src/restored.md"',
    'R  "src/old -> tracked.md" -> ".commands-com/new -> cli.md"',
    'C  "templates/base.md" -> "packages/app/.commands-com/copied.md"',
    '?? "packages/app/.commands-com/run\\040space.md"',
    keptRename,
    keptCopy,
    keptLookalike,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptRename,
    keptCopy,
    keptLookalike,
  ].join('\n'));
});

test('filterCliStatus preserves tracked quoted paths with spaces while dropping CLI state', () => {
  const keptModified = ' M "src/file with spaces.js"';
  const keptAdded = 'A  "docs/release notes.md"';
  const keptLookalike = '?? "packages/app/.commands-composer/run with spaces.md"';
  const input = [
    keptModified,
    '?? ".commands-com/run with spaces.md"',
    '?? "packages/app/.commands-com/run with spaces.md"',
    'A  "packages/app/.commands-com/generated report.md"',
    keptAdded,
    keptLookalike,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptModified,
    keptAdded,
    keptLookalike,
  ].join('\n'));
});

test('filterCliStatus parses multi-segment rename arrows before CLI state filtering', () => {
  const keptMultiSegmentRename = 'R  src/alpha.md -> src/beta.md -> src/gamma.md';
  const keptQuotedArrows = 'R  "src/old -> name.md" -> "src/new -> name.md"';
  const input = [
    'R  src/alpha.md -> .commands-com/beta.md -> src/gamma.md',
    'R  src/alpha.md -> src/beta.md -> packages/app/.commands-com/gamma.md',
    'R  ".commands-com/old -> generated.md" -> "src/restored.md"',
    keptMultiSegmentRename,
    keptQuotedArrows,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptMultiSegmentRename,
    keptQuotedArrows,
  ].join('\n'));
});

test('filterCliStatus handles escaped quotes and backslashes before CLI state filtering', () => {
  const keptEscapedRename = 'R  "src/old \\"quoted\\".md" -> "src/new \\\\backslash.md"';
  const keptEscapedCopy = 'C  "src/template.md" -> "src/copied \\"quote\\" and -> arrow.md"';
  const input = [
    'R  "src/.commands-com/old \\"quoted\\".md" -> "src/restored.md"',
    'R  "src/old.md" -> "src/.commands-com/new \\\\backslash.md"',
    'C  "src/template.md" -> ".commands-com/copied \\"quoted\\".md"',
    '?? "src/.commands-com/run\\040with\\040spaces.md"',
    keptEscapedRename,
    keptEscapedCopy,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptEscapedRename,
    keptEscapedCopy,
  ].join('\n'));
});

test('filterCliStatus handles mixed quoted renames with octal and backslash escapes', () => {
  const keptQuotedSource = String.raw`R  "src/old\040name\\draft.md" -> docs/new.md`;
  const keptQuotedTarget = String.raw`R  src/plain.md -> "docs/new\040name\\draft.md"`;
  const input = [
    String.raw`R  "src/\056commands-com/old\040name\\draft.md" -> docs/restored.md`,
    String.raw`R  src/plain.md -> "packages/app/\056commands-com/new\040name\\draft.md"`,
    keptQuotedSource,
    keptQuotedTarget,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptQuotedSource,
    keptQuotedTarget,
  ].join('\n'));
});

test('filterCliStatus handles Git C-quoted porcelain escapes before CLI state filtering', () => {
  const keptTabPath = '?? "src/user\\tfile.md"';
  const keptNewlineRename = 'R  "src/old\\nname.md" -> "src/new\\nname.md"';
  const input = [
    '?? "src/.commands-com/run\\twith\\nescapes.md"',
    ' M "packages/app/.commands-com/report\\rwith\\tescapes.md"',
    'R  "src/old\\nname.md" -> "src/.commands-com/new\\tname.md"',
    'C  "src/template.md" -> ".commands-com/copied\\nname.md"',
    keptTabPath,
    keptNewlineRename,
  ].join('\n');

  assert.equal(filterCliStatus(input), [
    keptTabPath,
    keptNewlineRename,
  ].join('\n'));
});

test('filterCliStatus leaves scored copy and rename lines outside the git status contract', () => {
  const input = [
    'R100 .commands-com/source.md -> src/restored.md',
    'C100 src/template.md -> packages/app/.commands-com/copied.md',
    'R100 src/old.md -> src/new.md',
  ].join('\n');

  assert.equal(filterCliStatus(input), input);
});
