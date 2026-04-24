import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_REPO_ROOT } from './maintainability/config.mjs';
import {
  evaluateFileSizePolicy,
  writeOversizedTestFileFindings,
  writeTestFileSizeReport,
} from './maintainability/file-size.mjs';
import { readMaintainabilitySettings } from './maintainability/guard-config.mjs';
import {
  collectPackageValidationFindings,
  writePackageValidationFindings,
} from './maintainability/package-scripts.mjs';
import { checkSyntax } from './maintainability/syntax.mjs';
import {
  collectTypeCheckMissingFiles,
  findTestTypeCheckIncludes,
  writeTestTypeCheckStatus,
  writeTypeCheckCoverageFindings,
} from './maintainability/type-check-coverage.mjs';
import { normalizePath } from './maintainability/paths.mjs';
import {
  collectUnusedExports,
  writeUnusedExportFindings,
} from './maintainability/unused-exports.mjs';

if (isMainModule()) {
  const dependencies = {
    repoRoot: DEFAULT_REPO_ROOT,
    writeOutput: (message) => console.log(message),
    writeError: (message) => console.error(message),
  };
  const result = process.argv.includes('--syntax-check')
    ? checkSyntax(dependencies)
    : checkMaintainability(dependencies);
  if (!result.ok) {
    process.exitCode = 1;
  }
}

export function checkMaintainability({
  repoRoot = DEFAULT_REPO_ROOT,
  configPath = join(repoRoot, 'jsconfig.json'),
  writeOutput = (_message) => {},
  writeError = (_message) => {},
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const {
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
  } = readMaintainabilitySettings({
    repoRoot: resolvedRepoRoot,
    configPath,
  });

  const {
    oversizedFiles,
    oversizedTestFiles,
    testFileSizes,
    testFileSizeReport,
  } = evaluateFileSizePolicy({
    repoRoot: resolvedRepoRoot,
    excludedRoots,
    maxRuntimeFileLines,
    maxTestFileLines,
    runtimeRoots,
    testFileReportLimit,
    testFileReportRoots,
  });
  const testTypeCheckIncludes = findTestTypeCheckIncludes(config.include);
  const unusedExports = unusedExportPolicy === 'off'
    ? []
    : collectUnusedExports({
      repoRoot: resolvedRepoRoot,
      exportRoots: unusedExportRoots,
      consumerRoots: unusedExportConsumerRoots,
      excludedRoots,
      allowlist: unusedExportAllowlist,
    });
  const packageValidationFindings = collectPackageValidationFindings({
    repoRoot: resolvedRepoRoot,
  });
  const typeCheckMissingFiles = collectTypeCheckMissingFiles({
    repoRoot: resolvedRepoRoot,
    include: config.include,
    roots: typeCheckRoots,
    excludedRoots,
    allowlist: typeCheckAllowlist,
  });

  writeTestFileSizeReport({
    repoRoot: resolvedRepoRoot,
    testFileSizeReport,
    totalTestFileCount: testFileSizes.length,
    maxTestFileLines,
    testFileSizePolicy,
    writeOutput,
  });
  writeTestTypeCheckStatus({
    testTypeCheckIncludes,
    writeOutput,
  });
  writeOversizedTestFileFindings({
    repoRoot: resolvedRepoRoot,
    oversizedTestFiles,
    maxTestFileLines,
    policy: testFileSizePolicy,
    writeError,
  });
  writeUnusedExportFindings({
    unusedExports,
    policy: unusedExportPolicy,
    reportLimit: unusedExportReportLimit,
    writeError,
  });
  writePackageValidationFindings({
    findings: packageValidationFindings,
    writeError,
  });
  writeTypeCheckCoverageFindings({
    missingFiles: typeCheckMissingFiles,
    writeError,
  });

  for (const { file, lineCount } of oversizedFiles) {
    writeError(`${normalizePath(relative(resolvedRepoRoot, file))}: ${lineCount} lines exceeds ${maxRuntimeFileLines}`);
  }

  const oversizedTestsFail = testFileSizePolicy === 'fail' && oversizedTestFiles.length > 0;
  const unusedExportsFail = unusedExportPolicy === 'fail' && unusedExports.length > 0;

  return {
    ok: oversizedFiles.length === 0
      && !oversizedTestsFail
      && !unusedExportsFail
      && packageValidationFindings.length === 0
      && typeCheckMissingFiles.length === 0,
    maxRuntimeFileLines,
    maxTestFileLines,
    oversizedFiles,
    oversizedTestFiles,
    packageValidationFindings,
    testFileSizePolicy,
    testFileSizeReport,
    testTypeCheckIncludes,
    typeCheckMissingFiles,
    unusedExportPolicy,
    unusedExports,
  };
}

function isMainModule() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}
