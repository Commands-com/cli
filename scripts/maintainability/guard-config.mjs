import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_REPO_ROOT,
  DEFAULT_TEST_FILE_REPORT_LIMIT,
  DEFAULT_UNUSED_EXPORT_REPORT_LIMIT,
  GUARD_POLICIES,
  REQUIRED_COMPILER_OPTION_FLAGS,
  UNUSED_EXPORT_REFERENCE_SEPARATOR,
  assertCompilerOptionFlags,
  assertExistingGuardRoots,
  assertGuardRoots,
  isJavaScriptIdentifier,
  normalizePath,
  readJson,
  unusedExportReference,
} from './config.mjs';

export function readMaintainabilitySettings({
  repoRoot = DEFAULT_REPO_ROOT,
  configPath = join(repoRoot, 'jsconfig.json'),
} = {}) {
  const config = readJson(configPath);
  const compilerOptions = config.compilerOptions || {};
  const guard = config.maintainabilityGuard || {};

  assertCompilerOptionFlags(compilerOptions, REQUIRED_COMPILER_OPTION_FLAGS);

  const runtimeRoots = assertRuntimeRoots(guard.runtimeRoots, { repoRoot });
  const excludedRoots = new Set(assertGuardRoots(
    'excludedRoots',
    guard.excludedRoots === undefined ? [] : guard.excludedRoots,
  ));
  const maxRuntimeFileLines = assertPositiveInteger(
    guard.maxRuntimeFileLines,
    'jsconfig maintainabilityGuard.maxRuntimeFileLines must be a positive integer',
  );
  const testFileReportRoots = assertExistingGuardRoots(
    'testFileReportRoots',
    guard.testFileReportRoots === undefined ? [] : guard.testFileReportRoots,
    { repoRoot },
  );
  const testFileReportLimit = guard.testFileReportLimit === undefined
    ? DEFAULT_TEST_FILE_REPORT_LIMIT
    : assertPositiveInteger(
      guard.testFileReportLimit,
      'jsconfig maintainabilityGuard.testFileReportLimit must be a positive integer',
    );
  const maxTestFileLines = guard.maxTestFileLines === undefined
    ? null
    : assertPositiveInteger(
      guard.maxTestFileLines,
      'jsconfig maintainabilityGuard.maxTestFileLines must be a positive integer',
    );
  const testFileSizePolicy = assertGuardPolicy(
    guard.testFileSizePolicy,
    'jsconfig maintainabilityGuard.testFileSizePolicy',
  );
  if (testFileSizePolicy !== 'off' && maxTestFileLines === null) {
    throw new Error('jsconfig maintainabilityGuard.maxTestFileLines is required when testFileSizePolicy is enabled');
  }
  const unusedExportPolicy = assertGuardPolicy(
    guard.unusedExportPolicy,
    'jsconfig maintainabilityGuard.unusedExportPolicy',
  );
  const unusedExportRoots = unusedExportPolicy === 'off' && guard.unusedExportRoots === undefined
    ? []
    : assertExistingGuardRoots(
      'unusedExportRoots',
      guard.unusedExportRoots === undefined ? runtimeRoots : guard.unusedExportRoots,
      { repoRoot },
    );
  const unusedExportConsumerRoots = unusedExportPolicy === 'off' && guard.unusedExportConsumerRoots === undefined
    ? []
    : assertExistingGuardRoots(
      'unusedExportConsumerRoots',
      guard.unusedExportConsumerRoots === undefined ? unusedExportRoots : guard.unusedExportConsumerRoots,
      { repoRoot },
    );
  const unusedExportAllowlist = assertUnusedExportAllowlist(
    guard.unusedExportAllowlist === undefined ? [] : guard.unusedExportAllowlist,
  );
  const unusedExportReportLimit = guard.unusedExportReportLimit === undefined
    ? DEFAULT_UNUSED_EXPORT_REPORT_LIMIT
    : assertPositiveInteger(
      guard.unusedExportReportLimit,
      'jsconfig maintainabilityGuard.unusedExportReportLimit must be a positive integer',
    );
  const typeCheckRoots = guard.typeCheckRoots === undefined
    ? []
    : assertExistingGuardRoots(
      'typeCheckRoots',
      guard.typeCheckRoots,
      { repoRoot },
    );
  const typeCheckAllowlist = assertTypeCheckAllowlist(
    guard.typeCheckAllowlist === undefined ? [] : guard.typeCheckAllowlist,
  );

  return {
    config,
    excludedRoots,
    maxRuntimeFileLines,
    maxTestFileLines,
    runtimeRoots,
    testFileReportLimit,
    testFileReportRoots,
    testFileSizePolicy,
    typeCheckAllowlist,
    typeCheckRoots,
    unusedExportAllowlist,
    unusedExportConsumerRoots,
    unusedExportPolicy,
    unusedExportReportLimit,
    unusedExportRoots,
  };
}

function assertGuardPolicy(value, name) {
  if (value === undefined) {
    return 'off';
  }
  if (!GUARD_POLICIES.has(value)) {
    throw new Error(`${name} must be one of: ${[...GUARD_POLICIES].join(', ')}`);
  }
  return value;
}

function assertRuntimeRoots(roots, { repoRoot }) {
  return assertExistingGuardRoots('runtimeRoots', roots, { repoRoot, required: true });
}

function assertPositiveInteger(value, message) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(message);
  }
  return value;
}

function assertUnusedExportAllowlist(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('jsconfig maintainabilityGuard.unusedExportAllowlist must be an array');
  }
  return new Set(entries.map((entry) => normalizeUnusedExportReference(entry)));
}

function normalizeUnusedExportReference(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new Error('jsconfig maintainabilityGuard.unusedExportAllowlist must contain non-empty strings');
  }

  const normalized = normalizePath(entry.trim());
  const [file, exportName, extra] = normalized.split(UNUSED_EXPORT_REFERENCE_SEPARATOR);
  if (
    extra !== undefined
    || !file
    || !exportName
    || isAbsolute(file)
    || /^[A-Za-z]:\//.test(file)
    || file === '..'
    || file.startsWith('../')
    || file.includes('/../')
    || !file.endsWith('.js')
    || !isJavaScriptIdentifier(exportName)
  ) {
    throw new Error(
      'jsconfig maintainabilityGuard.unusedExportAllowlist entries must use repo-relative file.js#exportName references',
    );
  }
  return unusedExportReference(file, exportName);
}

function assertTypeCheckAllowlist(entries) {
  if (!Array.isArray(entries)) {
    throw new Error('jsconfig maintainabilityGuard.typeCheckAllowlist must be an array');
  }
  return new Set(entries.map((entry) => normalizeTypeCheckFileReference(entry)));
}

function normalizeTypeCheckFileReference(entry) {
  if (typeof entry !== 'string' || entry.trim() === '') {
    throw new Error('jsconfig maintainabilityGuard.typeCheckAllowlist must contain non-empty strings');
  }

  const normalized = normalizePath(entry.trim()).replace(/^\.\//, '');
  if (
    normalized === ''
    || isAbsolute(normalized)
    || /^[A-Za-z]:\//.test(normalized)
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.includes('/../')
    || !normalized.endsWith('.js')
  ) {
    throw new Error(
      'jsconfig maintainabilityGuard.typeCheckAllowlist entries must use repo-relative file.js paths',
    );
  }
  return normalized;
}
