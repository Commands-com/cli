import { relative } from 'node:path';
import {
  collectUniqueJavaScriptFiles,
  normalizePath,
} from './config.mjs';

export function collectTypeCheckMissingFiles({
  repoRoot,
  include = [],
  roots = [],
  excludedRoots = new Set(),
  allowlist = new Set(),
}) {
  if (roots.length === 0) {
    return [];
  }

  const includeEntries = normalizeJsconfigIncludes(include);
  const allowedMissingFiles = allowlist instanceof Set
    ? allowlist
    : new Set(allowlist);

  return collectUniqueJavaScriptFiles(roots, { repoRoot, excludedRoots })
    .map((file) => normalizePath(relative(repoRoot, file)))
    .filter((file) => (
      !jsconfigIncludesFile(includeEntries, file)
      && !allowedMissingFiles.has(file)
    ))
    .sort();
}

export function findTestTypeCheckIncludes(include) {
  if (!Array.isArray(include)) {
    return [];
  }
  return include
    .filter((entry) => typeof entry === 'string')
    .map((entry) => normalizePath(entry.trim()))
    .filter((entry) => (
      entry === 'test/**/*.js'
      || (entry.startsWith('test/') && entry.endsWith('.js'))
    ));
}

export function writeTestTypeCheckStatus({ testTypeCheckIncludes, writeOutput }) {
  const count = testTypeCheckIncludes.length;
  if (count === 0) {
    writeOutput('Test type-checking is incremental: jsconfig does not include test files yet.');
    return;
  }

  writeOutput(
    `Test type-checking is incremental: jsconfig includes ${count} test ${count === 1 ? 'path' : 'paths'}: ${testTypeCheckIncludes.join(', ')}`,
  );
}

export function writeTypeCheckCoverageFindings({ missingFiles, writeError }) {
  if (missingFiles.length === 0) {
    return;
  }

  writeError(`Error: jsconfig check-js coverage is missing ${missingFiles.length} src file${missingFiles.length === 1 ? '' : 's'} not in maintainabilityGuard.typeCheckAllowlist`);
  for (const file of missingFiles) {
    writeError(`  ${file}`);
  }
}

function normalizeJsconfigIncludes(include) {
  if (!Array.isArray(include)) {
    return [];
  }
  return include
    .filter((entry) => typeof entry === 'string')
    .map(normalizeJsconfigInclude)
    .filter(Boolean);
}

function normalizeJsconfigInclude(entry) {
  return normalizePath(entry.trim()).replace(/^\.\//, '');
}

function jsconfigIncludesFile(includeEntries, file) {
  return includeEntries.some((entry) => jsconfigIncludeCoversFile(entry, file));
}

function jsconfigIncludeCoversFile(entry, file) {
  if (entry === file) {
    return true;
  }
  if (entry.endsWith('/**/*.js')) {
    const prefix = entry.slice(0, -'/**/*.js'.length);
    return file.startsWith(`${prefix}/`) && file.endsWith('.js');
  }
  if (entry.endsWith('/*.js')) {
    const prefix = entry.slice(0, -'/*.js'.length);
    const fileName = file.slice(prefix.length + 1);
    return file.startsWith(`${prefix}/`)
      && file.endsWith('.js')
      && !fileName.includes('/');
  }
  return false;
}
