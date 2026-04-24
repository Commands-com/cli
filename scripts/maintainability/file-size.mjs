import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  DEFAULT_REPO_ROOT,
  DEFAULT_TEST_FILE_REPORT_LIMIT,
  collectUniqueJavaScriptFiles,
} from './config.mjs';
import { normalizePath } from './paths.mjs';

export function evaluateFileSizePolicy({
  repoRoot = DEFAULT_REPO_ROOT,
  runtimeRoots = [],
  excludedRoots = new Set(),
  maxRuntimeFileLines = Number.POSITIVE_INFINITY,
  testFileReportRoots = [],
  testFileReportLimit = DEFAULT_TEST_FILE_REPORT_LIMIT,
  maxTestFileLines = null,
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const runtimeExcludedRoots = excludedRoots instanceof Set
    ? excludedRoots
    : new Set(excludedRoots);
  const oversizedFiles = collectJavaScriptFileSizes(runtimeRoots, {
    repoRoot: resolvedRepoRoot,
    excludedRoots: runtimeExcludedRoots,
  })
    .filter(({ lineCount }) => lineCount > maxRuntimeFileLines);
  const testFileSizes = collectJavaScriptFileSizes(testFileReportRoots, {
    repoRoot: resolvedRepoRoot,
    excludedRoots: new Set(),
  }).sort(compareFileSizeEntries);
  const testFileSizeReport = testFileSizes.slice(0, testFileReportLimit);
  const oversizedTestFiles = maxTestFileLines === null
    ? []
    : testFileSizes.filter(({ lineCount }) => lineCount > maxTestFileLines);

  return {
    oversizedFiles,
    oversizedTestFiles,
    testFileSizes,
    testFileSizeReport,
  };
}

export function collectJavaScriptFileSizes(roots, { repoRoot, excludedRoots }) {
  return roots
    .flatMap((root) => collectUniqueJavaScriptFiles([root], {
      repoRoot,
      excludedRoots,
    }))
    .map((file) => ({
      file,
      lineCount: countLines(readFileSync(file, 'utf8')),
    }));
}

export function writeTestFileSizeReport({
  repoRoot,
  testFileSizeReport,
  totalTestFileCount,
  maxTestFileLines,
  testFileSizePolicy,
  writeOutput,
}) {
  if (totalTestFileCount === 0) {
    return;
  }

  const policyLabel = maxTestFileLines === null || testFileSizePolicy === 'off'
    ? 'report-only'
    : `${testFileSizePolicy} over ${maxTestFileLines}`;
  writeOutput(`Test file size report (${policyLabel}, top ${testFileSizeReport.length} of ${totalTestFileCount}):`);
  for (const { file, lineCount } of testFileSizeReport) {
    writeOutput(`  ${repoRelativePath(repoRoot, file)}: ${lineCount} lines`);
  }
}

export function writeOversizedTestFileFindings({
  repoRoot,
  oversizedTestFiles,
  maxTestFileLines,
  policy,
  writeError,
}) {
  if (policy === 'off' || oversizedTestFiles.length === 0) {
    return;
  }

  const label = policy === 'fail' ? 'Error' : 'Warning';
  for (const { file, lineCount } of oversizedTestFiles) {
    writeError(`${label}: ${repoRelativePath(repoRoot, file)}: ${lineCount} test lines exceeds ${maxTestFileLines}`);
  }
}

export function countLines(text) {
  if (text.length === 0) {
    return 0;
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  return lines.at(-1) === '' ? lines.length - 1 : lines.length;
}

function compareFileSizeEntries(left, right) {
  return right.lineCount - left.lineCount
    || left.file.localeCompare(right.file);
}

function repoRelativePath(repoRoot, file) {
  return normalizePath(relative(repoRoot, file));
}
