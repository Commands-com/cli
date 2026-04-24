import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { collectRepoContext } from '../src/git.js';
import { scopedWorktreeCwd, shouldBlockUnsafeFix } from '../src/workflow.js';
import {
  initWorkflowSafetyRepo,
  mustRunGit,
  withTempRun,
} from './support/workflow-fixtures.js';

const LOCAL_DIR = '.commands-com';

test('shouldBlockUnsafeFix follows the fix/worktree/allowDirty/dirty-status truth table', () => {
  const cliStatus = `?? ${LOCAL_DIR}/runs/20260101-010203-review/report.md`;
  const statusCases = [
    { name: 'empty status', status: '', dirty: false },
    { name: 'whitespace status', status: ' \n\t ', dirty: false },
    { name: 'CLI-owned status only', status: cliStatus, dirty: false },
    { name: 'dirty status', status: ' M src/workflow.js\n?? test/workflow-safety.test.js', dirty: true },
    { name: 'mixed CLI-owned and user status', status: `${cliStatus}\n M src/workflow.js`, dirty: true },
  ];

  for (const fix of [false, true]) {
    for (const worktree of [false, true]) {
      for (const allowDirty of [false, true]) {
        for (const { name, status, dirty } of statusCases) {
          const expected = fix && !worktree && !allowDirty && dirty;

          assert.equal(
            shouldBlockUnsafeFix({ fix, worktree, allowDirty, status }),
            expected,
            `fix=${fix} worktree=${worktree} allowDirty=${allowDirty} ${name}`,
          );
        }
      }
    }
  }
});

test('shouldBlockUnsafeFix filters quoted, escaped, and octal-escaped CLI status before blocking', () => {
  const cliOwnedStatus = [
    `?? "${LOCAL_DIR}/runs/report with spaces.md"`,
    String.raw`?? "${LOCAL_DIR}/runs/report \"quoted\".md"`,
    String.raw`?? "\056commands-com/runs/report\040with\040spaces.md"`,
    String.raw`R  "src/old.md" -> "\056commands-com/runs/new\040report.md"`,
  ].join('\n');

  assert.equal(
    shouldBlockUnsafeFix({ fix: true, worktree: false, allowDirty: false, status: cliOwnedStatus }),
    false,
  );

  assert.equal(
    shouldBlockUnsafeFix({
      fix: true,
      worktree: false,
      allowDirty: false,
      status: `${cliOwnedStatus}\n M src/workflow.js`,
    }),
    true,
  );
});

test('collectRepoContext filters quoted and escaped CLI-owned git status before unsafe fix blocking', async () => {
  await withTempRun(async (cwd) => {
    await initWorkflowSafetyRepo(cwd);

    await fs.writeFile(path.join(cwd, LOCAL_DIR, 'report with spaces.md'), 'generated\n', 'utf8');
    if (process.platform !== 'win32') {
      await fs.writeFile(path.join(cwd, LOCAL_DIR, 'report "quoted".md'), 'generated\n', 'utf8');
    }
    await fs.writeFile(path.join(cwd, LOCAL_DIR, 'café.md'), 'generated\n', 'utf8');

    const rawCliOnlyStatus = await mustRunGit(['status', '--short', '--', '.'], cwd);
    assert.match(rawCliOnlyStatus.stdout, /"\.commands-com\/report with spaces\.md"/);
    if (process.platform !== 'win32') {
      assert.match(rawCliOnlyStatus.stdout, /"\.commands-com\/report \\"quoted\\"\.md"/);
    }
    assert.match(rawCliOnlyStatus.stdout, /"\.commands-com\/caf\\303\\251\.md"/);

    const cliOnlyContext = await collectRepoContext(cwd);
    assert.equal(cliOnlyContext.status, '');
    assert.equal(
      shouldBlockUnsafeFix({ fix: true, worktree: false, allowDirty: false, status: cliOnlyContext.status }),
      false,
    );

    await fs.mkdir(path.join(cwd, 'src'), { recursive: true });
    await fs.writeFile(path.join(cwd, 'src', 'workflow.js'), 'dirty\n', 'utf8');

    const mixedContext = await collectRepoContext(cwd);
    assert.doesNotMatch(mixedContext.status, /\.commands-com/);
    assert.match(mixedContext.status, /src/);
    assert.equal(
      shouldBlockUnsafeFix({ fix: true, worktree: false, allowDirty: false, status: mixedContext.status }),
      true,
    );
  }, { prefix: 'commands-com-workflow-safety-' });
});

test('scopedWorktreeCwd resolves only safe scopes beneath the original git root', () => {
  const volumeRoot = path.parse(process.cwd()).root;
  const gitRoot = path.join(volumeRoot, 'repo');
  const isolated = { path: path.join(volumeRoot, 'tmp', 'commands-worktree') };

  const cases = [
    {
      name: 'dot path',
      context: { gitRoot, repoRoot: gitRoot },
      expected: isolated.path,
    },
    {
      name: 'normal scoped path',
      context: { gitRoot, repoRoot: path.join(gitRoot, 'packages', 'app') },
      expected: path.join(isolated.path, 'packages', 'app'),
    },
    {
      name: 'normalized scoped path',
      context: { gitRoot, repoRoot: path.join(gitRoot, 'packages', 'app', '..', 'app') },
      expected: path.join(isolated.path, 'packages', 'app'),
    },
    {
      name: 'nested normal scoped path',
      context: { gitRoot, repoRoot: path.join(gitRoot, 'tools', 'cli', 'src') },
      expected: path.join(isolated.path, 'tools', 'cli', 'src'),
    },
    {
      name: 'parent traversal',
      context: { gitRoot, repoRoot: path.resolve(gitRoot, '..', 'outside-repo') },
      expected: isolated.path,
    },
    {
      name: 'absolute path outside git root',
      context: { gitRoot, repoRoot: path.join(volumeRoot, 'absolute-repo') },
      expected: isolated.path,
    },
    {
      name: 'missing git root',
      context: { repoRoot: path.join(gitRoot, 'packages', 'app') },
      expected: isolated.path,
    },
  ];

  for (const { name, context, expected } of cases) {
    assert.equal(scopedWorktreeCwd(context, isolated), expected, name);
  }
});
