import { join } from 'node:path';
import {
  DEFAULT_REPO_ROOT,
  DEFAULT_TEST_FILE_REPORT_LIMIT,
  DEFAULT_UNUSED_EXPORT_REPORT_LIMIT,
  GUARD_POLICIES,
  REQUIRED_COMPILER_OPTION_FLAGS,
  assertCompilerOptionFlags,
  assertExistingGuardRoots,
  assertGuardRoots,
  readJson,
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
  return {
    config,
    excludedRoots,
    maxRuntimeFileLines,
    maxTestFileLines,
    runtimeRoots,
    testFileReportLimit,
    testFileReportRoots,
    testFileSizePolicy,
    typeCheckRoots,
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
