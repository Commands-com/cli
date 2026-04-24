import { statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizePath, readJson } from './config.mjs';

const NODE_COMMAND_PATTERN = /(?:^|\s)node(?:\s|$)/;
const NODE_TEST_FLAG_PATTERN = /(?:^|\s)--test(?:\s|$)/;
const RECURSIVE_TEST_GLOB_PATTERN = /(?:^|\s)(?:"(?:\.\/)?test\/\*\*\/\*\.test\.js"|'(?:\.\/)?test\/\*\*\/\*\.test\.js'|(?:\.\/)?test\/\*\*\/\*\.test\.js)(?=\s|$)/;
const SHALLOW_TEST_GLOB_PATTERN = /(?:^|\s)(?:"(?:\.\/)?test\/\*\.test\.js"|'(?:\.\/)?test\/\*\.test\.js'|(?:\.\/)?test\/\*\.test\.js)(?=\s|$)/;
const COVERAGE_FLAG_PATTERN = /(?:^|\s)--experimental-test-coverage(?:\s|$)/;
const COVERAGE_RUNNER_PATTERN = /(?:^|\s)node\s+scripts\/coverage\.mjs(?:\s|$)/;
const NPM_RUN_COVERAGE_PATTERN = /(?:^|\s)npm\s+run\s+coverage(?:\s|$)/;
const REQUIRED_COVERAGE_SOURCE_INCLUDE = 'src/**/*.js';
const COVERAGE_SOURCE_INCLUDE_FLAG = '--test-coverage-include';
const REQUIRED_COVERAGE_THRESHOLD_FLAGS = Object.freeze([
  '--test-coverage-lines',
  '--test-coverage-branches',
  '--test-coverage-functions',
]);

export function collectPackageValidationFindings({ repoRoot }) {
  const packageJsonPath = join(repoRoot, 'package.json');
  const stats = statSync(packageJsonPath, { throwIfNoEntry: false });
  if (!stats?.isFile()) {
    return [];
  }

  return validatePackageScripts(readJson(packageJsonPath).scripts || {});
}

export function validatePackageScripts(scripts = {}) {
  const testScript = packageScript(scripts, 'test');
  const coverageScript = packageScript(scripts, 'coverage');
  const validateScript = packageScript(scripts, 'validate');
  const findings = [];
  const coverageUsesRunner = usesCoverageRunner(coverageScript);

  if (!usesRecursiveNodeTestDiscovery(testScript)) {
    findings.push('package scripts.test must run node --test with recursive test discovery');
  }
  if (SHALLOW_TEST_GLOB_PATTERN.test(normalizePath(testScript))) {
    findings.push('package scripts.test must not use shallow test/*.test.js discovery');
  }
  if (!coverageUsesRunner && (!usesRecursiveNodeTestDiscovery(coverageScript) || !hasCoverageFlag(coverageScript))) {
    findings.push('package scripts.coverage must run node --test with recursive coverage reporting');
  }
  if (!coverageUsesRunner && !hasCoverageSourceInclude(coverageScript)) {
    findings.push(`package scripts.coverage must include ${REQUIRED_COVERAGE_SOURCE_INCLUDE} in coverage reporting`);
  }
  if (!coverageUsesRunner && !hasCoverageThresholdFlags(coverageScript)) {
    findings.push('package scripts.coverage must enforce line, branch, and function coverage thresholds');
  }
  const validateRunsCoverageScript = runsCoverageScript(validateScript);
  const validateHasInlineCoverage = hasCoverageFlag(validateScript);
  if (!validateRunsCoverageScript && !validateHasInlineCoverage) {
    findings.push('package scripts.validate must run coverage reporting');
  }
  if (!validateRunsCoverageScript && validateHasInlineCoverage) {
    if (!usesRecursiveNodeTestDiscovery(validateScript) || !hasCoverageSourceInclude(validateScript)) {
      findings.push(`package scripts.validate inline coverage must run recursively and include ${REQUIRED_COVERAGE_SOURCE_INCLUDE}`);
    }
    if (!hasCoverageThresholdFlags(validateScript)) {
      findings.push('package scripts.validate inline coverage must enforce line, branch, and function coverage thresholds');
    }
  }

  return findings;
}

export function usesRecursiveNodeTestDiscovery(script) {
  const normalized = normalizePath(script);
  return NODE_COMMAND_PATTERN.test(normalized)
    && NODE_TEST_FLAG_PATTERN.test(normalized)
    && RECURSIVE_TEST_GLOB_PATTERN.test(normalized);
}

export function writePackageValidationFindings({ findings, writeError }) {
  for (const finding of findings) {
    writeError(`Error: ${finding}`);
  }
}

function packageScript(scripts, name) {
  const value = scripts && typeof scripts === 'object' ? scripts[name] : '';
  return typeof value === 'string' ? value : '';
}

function hasCoverageFlag(script) {
  return COVERAGE_FLAG_PATTERN.test(normalizePath(script));
}

function usesCoverageRunner(script) {
  return COVERAGE_RUNNER_PATTERN.test(normalizePath(script));
}

function hasCoverageSourceInclude(script) {
  const words = shellWords(script);
  return words.some((word, index) => {
    if (word.startsWith(`${COVERAGE_SOURCE_INCLUDE_FLAG}=`)) {
      return isRequiredCoverageSourceInclude(word.slice(COVERAGE_SOURCE_INCLUDE_FLAG.length + 1));
    }
    return word === COVERAGE_SOURCE_INCLUDE_FLAG
      && isRequiredCoverageSourceInclude(words[index + 1] || '');
  });
}

function isRequiredCoverageSourceInclude(value) {
  const normalized = normalizePath(stripShellQuotes(value)).replace(/^\.\//, '');
  return normalized === REQUIRED_COVERAGE_SOURCE_INCLUDE;
}

function hasCoverageThresholdFlags(script) {
  return REQUIRED_COVERAGE_THRESHOLD_FLAGS.every((flag) => hasNumericFlagValue(script, flag));
}

function hasNumericFlagValue(script, flag) {
  const words = shellWords(script);
  return words.some((word, index) => {
    if (word.startsWith(`${flag}=`)) {
      return isNumericFlagValue(word.slice(flag.length + 1));
    }
    return word === flag && isNumericFlagValue(words[index + 1] || '');
  });
}

function isNumericFlagValue(value) {
  return /^\d+$/.test(stripShellQuotes(value));
}

function runsCoverageScript(script) {
  return NPM_RUN_COVERAGE_PATTERN.test(normalizePath(script));
}

function shellWords(script) {
  return normalizePath(String(script || ''))
    .match(/"[^"]*"|'[^']*'|\S+/g)
    ?.map(normalizeShellWord) || [];
}

function normalizeShellWord(word) {
  return stripShellQuotes(word)
    .replace(/=("[^"]*"|'[^']*')$/, (_match, value) => `=${stripShellQuotes(value)}`);
}

function stripShellQuotes(value) {
  const source = String(value || '').trim();
  if (
    (source.startsWith('"') && source.endsWith('"'))
    || (source.startsWith("'") && source.endsWith("'"))
  ) {
    return source.slice(1, -1);
  }
  return source;
}
