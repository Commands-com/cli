import { spawnSync } from 'node:child_process';
import { relative, resolve } from 'node:path';
import {
  DEFAULT_REPO_ROOT,
  collectUniqueJavaScriptFiles,
} from './config.mjs';

export function checkSyntax({
  repoRoot = DEFAULT_REPO_ROOT,
  roots = ['src', 'test'],
  writeOutput = (_message) => {},
  writeError = (_message) => {},
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const files = collectUniqueJavaScriptFiles(roots, {
    repoRoot: resolvedRepoRoot,
    excludedRoots: new Set(),
  });
  const failures = [];

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
    });
    if (result.status === 0) {
      continue;
    }

    failures.push({ file, result });
    writeError(result.stderr.trim() || result.stdout.trim() || `${relative(resolvedRepoRoot, file)} failed syntax check`);
  }

  writeOutput(`Syntax check scanned ${files.length} JavaScript files.`);
  return {
    ok: failures.length === 0,
    checkedFiles: files,
    failures,
  };
}
