import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const TEST_ROOT = 'test';
const TEST_FILE_PATTERN = /\.test\.js$/;
const SOURCE_INCLUDE = 'src/**/*.js';
const THRESHOLDS = Object.freeze({
  lines: 80,
  branches: 70,
  functions: 75,
});

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

const forceCompatCoverage = process.env.COMMANDS_COM_COVERAGE_COMPAT === '1';
const supportsBuiltInCoverageThresholds = !forceCompatCoverage && [
  '--test-coverage-include',
  '--test-coverage-lines',
  '--test-coverage-branches',
  '--test-coverage-functions',
].every((flag) => process.allowedNodeEnvironmentFlags.has(flag));

const testFiles = await collectTestFiles(TEST_ROOT);
if (!testFiles.length) {
  process.stderr.write(`Error: no test files found under ${TEST_ROOT}.\n`);
  process.exit(1);
}

const args = coverageArgs({ supportsBuiltInCoverageThresholds, testFiles });
const result = await runNode(args);

if (result.exitCode !== 0) {
  process.exitCode = result.exitCode;
} else if (!supportsBuiltInCoverageThresholds) {
  process.exitCode = enforceCompatCoverageThresholds(result.output);
}

function coverageArgs({ supportsBuiltInCoverageThresholds, testFiles }) {
  const args = [
    '--test',
    '--experimental-test-coverage',
  ];
  if (supportsBuiltInCoverageThresholds) {
    args.push(
      `--test-coverage-include=${SOURCE_INCLUDE}`,
      `--test-coverage-lines=${THRESHOLDS.lines}`,
      `--test-coverage-branches=${THRESHOLDS.branches}`,
      `--test-coverage-functions=${THRESHOLDS.functions}`,
    );
  }
  args.push(...testFiles);
  return args;
}

async function collectTestFiles(root) {
  const files = [];
  await collectTestFilesInto(path.resolve(root), files);
  return files
    .sort()
    .map((file) => path.relative(process.cwd(), file).split(path.sep).join('/'));
}

async function collectTestFilesInto(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTestFilesInto(entryPath, files);
    } else if (entry.isFile() && TEST_FILE_PATTERN.test(entry.name)) {
      files.push(entryPath);
    }
  }));
}

function runNode(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      output += text;
      process.stderr.write(text);
    });
    child.on('error', (error) => {
      process.stderr.write(`${error.message}\n`);
      resolve({ exitCode: 1, output });
    });
    child.on('close', (code, signal) => {
      resolve({ exitCode: typeof code === 'number' ? code : signal ? 1 : 0, output });
    });
  });
}

function enforceCompatCoverageThresholds(output) {
  const coverage = parseAllFilesCoverage(output);
  if (!coverage) {
    process.stderr.write('Error: coverage report did not include an all files summary.\n');
    return 1;
  }

  const failures = [
    ['lines', coverage.lines],
    ['branches', coverage.branches],
    ['functions', coverage.functions],
  ].filter(([name, value]) => value < THRESHOLDS[name]);

  for (const [name, value] of failures) {
    process.stderr.write(`Error: coverage ${name} ${value.toFixed(2)} is below ${THRESHOLDS[name]}.\n`);
  }
  return failures.length ? 1 : 0;
}

function parseAllFilesCoverage(output) {
  const normalized = String(output || '').replace(ANSI_PATTERN, '');
  const match = normalized.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/i);
  if (!match) return null;
  return {
    lines: Number.parseFloat(match[1]),
    branches: Number.parseFloat(match[2]),
    functions: Number.parseFloat(match[3]),
  };
}
