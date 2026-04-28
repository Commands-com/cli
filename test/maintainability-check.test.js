import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkMaintainability } from '../scripts/maintainability-check.mjs';
import { readJson } from '../scripts/maintainability/config.mjs';
import { countLines } from '../scripts/maintainability/file-size.mjs';
import { validatePackageScripts } from '../scripts/maintainability/package-scripts.mjs';
import { normalizePath } from '../scripts/maintainability/paths.mjs';
import { checkSyntax } from '../scripts/maintainability/syntax.mjs';
import { collectTypeCheckMissingFiles } from '../scripts/maintainability/type-check-coverage.mjs';

const REQUIRED_COMPILER_OPTIONS = Object.freeze({
  allowJs: true,
  checkJs: true,
  noEmit: true,
});

test('countLines handles trailing newlines and platform newline styles', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('one'), 1);
  assert.equal(countLines('one\n'), 1);
  assert.equal(countLines('one\n\n'), 2);
  assert.equal(countLines('one\r\ntwo\rthree'), 3);
});

test('syntax check scans configured roots and reports broken JavaScript', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stdout = [];
  const stderr = [];
  await writeFile(path.join(repoRoot, 'src', 'index.js'), ['const value = 1;', 'void value;']);
  await writeFile(path.join(repoRoot, 'test', 'broken.test.js'), ['function broken(']);

  const result = checkSyntax({
    repoRoot,
    writeOutput: (message) => stdout.push(message),
    writeError: (message) => stderr.push(message),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.checkedFiles.map((file) => path.relative(repoRoot, file)),
    [path.join('src', 'index.js'), path.join('test', 'broken.test.js')],
  );
  assert.equal(result.failures.length, 1);
  assert.equal(path.relative(repoRoot, result.failures[0].file), path.join('test', 'broken.test.js'));
  assert.match(stderr.join('\n'), /SyntaxError|Unexpected/);
  assert.deepEqual(stdout, ['Syntax check scanned 2 JavaScript files.']);
});

test('maintainability check skips excluded runtime roots', async (t) => {
  const repoRoot = await createTempRepo(t);
  await writeConfig(repoRoot, {
    maintainabilityGuard: { excludedRoots: ['src/generated'], maxRuntimeFileLines: 2 },
  });
  await writeFile(path.join(repoRoot, 'src', 'index.js'), 2);
  await writeFile(path.join(repoRoot, 'src', 'generated', 'oversized.js'), 4);

  const result = checkMaintainability({ repoRoot });

  assert.equal(result.ok, true);
  assert.deepEqual(result.oversizedFiles, []);
});

test('maintainability check requires compiler guard flags to stay enabled', async (t) => {
  const repoRoot = await createTempRepo(t);
  await fs.mkdir(path.join(repoRoot, 'src'), { recursive: true });

  for (const flag of Object.keys(REQUIRED_COMPILER_OPTIONS)) {
    await writeConfig(repoRoot, {
      compilerOptions: { ...REQUIRED_COMPILER_OPTIONS, [flag]: false },
    });

    assert.throws(
      () => checkMaintainability({ repoRoot }),
      new RegExp(`compilerOptions\\.${flag} must stay true`),
    );
  }
});

test('maintainability check rejects invalid runtime roots', async (t) => {
  const repoRoot = await createTempRepo(t);
  const cases = [
    {
      runtimeRoots: ['../outside'],
      expected: /maintainabilityGuard\.runtimeRoots must contain repo-relative paths/,
    },
    {
      runtimeRoots: ['missing'],
      expected: /runtimeRoots entry must be an existing directory: missing/,
    },
  ];

  for (const { runtimeRoots, expected } of cases) {
    await writeConfig(repoRoot, { maintainabilityGuard: { runtimeRoots } });
    assert.throws(() => checkMaintainability({ repoRoot }), expected);
  }
});

test('maintainability check reports oversized runtime files', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stderr = [];
  await writeConfig(repoRoot, { maintainabilityGuard: { maxRuntimeFileLines: 2 } });
  await writeFile(path.join(repoRoot, 'src', 'large.js'), 3);

  const result = checkMaintainability({
    repoRoot,
    writeError: (message) => stderr.push(message),
  });

  assert.equal(result.ok, false);
  assert.equal(result.maxRuntimeFileLines, 2);
  assert.deepEqual(
    result.oversizedFiles.map(({ file, lineCount }) => ({
      file: normalizePath(path.relative(repoRoot, file)),
      lineCount,
    })),
    [{ file: 'src/large.js', lineCount: 3 }],
  );
  assert.deepEqual(stderr, ['src/large.js: 3 lines exceeds 2']);
});

test('maintainability check reports test file sizes without failing', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stdout = [];
  await writeConfig(repoRoot, {
    include: ['src/**/*.js', 'test/small.test.js'],
    maintainabilityGuard: {
      testFileReportRoots: ['test'],
      testFileReportLimit: 2,
    },
  });
  await writeFile(path.join(repoRoot, 'src', 'index.js'), 2);
  await writeFile(path.join(repoRoot, 'test', 'large.test.js'), 6);
  await writeFile(path.join(repoRoot, 'test', 'medium.test.js'), 4);
  await writeFile(path.join(repoRoot, 'test', 'small.test.js'), 2);

  const result = checkMaintainability({
    repoRoot,
    writeOutput: (message) => stdout.push(message),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.testFileSizeReport.map(({ file, lineCount }) => ({
      file: path.relative(repoRoot, file),
      lineCount,
    })),
    [
      { file: path.join('test', 'large.test.js'), lineCount: 6 },
      { file: path.join('test', 'medium.test.js'), lineCount: 4 },
    ],
  );
  assert.deepEqual(result.testTypeCheckIncludes, ['test/small.test.js']);
  assert.deepEqual(stdout, [
    'Test file size report (report-only, top 2 of 3):',
    '  test/large.test.js: 6 lines',
    '  test/medium.test.js: 4 lines',
    'Test type-checking is incremental: jsconfig includes 1 test path: test/small.test.js',
  ]);
});

test('maintainability check honors testFileSizePolicy for oversized test files', async (t) => {
  const cases = [
    { policy: 'warn', ok: true },
    { policy: 'fail', ok: false },
  ];

  for (const { policy, ok } of cases) {
    const repoRoot = await createTempRepo(t);
    await writeConfig(repoRoot, {
      maintainabilityGuard: {
        testFileReportRoots: ['test'],
        maxTestFileLines: 2,
        testFileSizePolicy: policy,
      },
    });
    await writeFile(path.join(repoRoot, 'src', 'index.js'), 1);
    await writeFile(path.join(repoRoot, 'test', 'large.test.js'), 3);

    const result = checkMaintainability({ repoRoot });

    assert.equal(result.ok, ok);
    assert.equal(result.testFileSizePolicy, policy);
    assert.deepEqual(
      result.oversizedTestFiles.map(({ file, lineCount }) => ({
        file: path.relative(repoRoot, file),
        lineCount,
      })),
      [{ file: path.join('test', 'large.test.js'), lineCount: 3 }],
    );
  }
});

test('maintainability check requires a test limit when test size policy is enabled', async (t) => {
  const repoRoot = await createTempRepo(t);
  await writeConfig(repoRoot, {
    maintainabilityGuard: { testFileSizePolicy: 'warn' },
  });
  await writeFile(path.join(repoRoot, 'src', 'index.js'), 1);

  assert.throws(
    () => checkMaintainability({ repoRoot }),
    /maxTestFileLines is required when testFileSizePolicy is enabled/,
  );
});

test('maintainability check reports unused runtime exports', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stderr = [];
  await writeConfig(repoRoot, {
    maintainabilityGuard: {
      maxRuntimeFileLines: 20,
      unusedExportPolicy: 'warn',
      unusedExportRoots: ['src'],
      unusedExportConsumerRoots: ['src'],
    },
  });
  await writeFile(path.join(repoRoot, 'src', 'source.js'), [
    'export function used() {}',
    'export function reexported() {}',
    'export function unused() {}',
  ]);
  await writeFile(path.join(repoRoot, 'src', 'barrel.js'), [
    "export { reexported as renamed } from './source.js';",
  ]);
  await writeFile(path.join(repoRoot, 'src', 'index.js'), [
    "import { used } from './source.js';",
    "import { renamed } from './barrel.js';",
    'used();',
    'renamed();',
  ]);

  const result = checkMaintainability({
    repoRoot,
    writeError: (message) => stderr.push(message),
  });

  assert.equal(result.ok, true);
  assert.equal(result.unusedExportPolicy, 'warn');
  assert.deepEqual(
    result.unusedExports.map(({ reference }) => reference),
    ['src/source.js#unused'],
  );
  assert.deepEqual(stderr, [
    'Warning: unused exports detected (1 of 1 shown; policy: warn)',
    '  src/source.js#unused is not imported by configured runtime consumers',
  ]);
});

test('maintainability check can fail on unused runtime exports', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stderr = [];
  await writeConfig(repoRoot, {
    maintainabilityGuard: {
      maxRuntimeFileLines: 20,
      unusedExportPolicy: 'fail',
      unusedExportRoots: ['src'],
      unusedExportConsumerRoots: ['src'],
    },
  });
  await writeFile(path.join(repoRoot, 'src', 'index.js'), ['export function unused() {}']);

  const result = checkMaintainability({
    repoRoot,
    writeError: (message) => stderr.push(message),
  });

  assert.equal(result.ok, false);
  assert.equal(result.unusedExportPolicy, 'fail');
  assert.deepEqual(
    result.unusedExports.map(({ reference }) => reference),
    ['src/index.js#unused'],
  );
  assert.deepEqual(stderr, [
    'Error: unused exports detected (1 of 1 shown; policy: fail)',
    '  src/index.js#unused is not imported by configured runtime consumers',
  ]);
});

test('maintainability check counts test imports as runtime export consumers', async (t) => {
  const repoRoot = await createTempRepo(t);
  await writeConfig(repoRoot, {
    maintainabilityGuard: {
      maxRuntimeFileLines: 20,
      unusedExportPolicy: 'fail',
      unusedExportRoots: ['src'],
      unusedExportConsumerRoots: ['src', 'test'],
    },
  });
  await writeFile(path.join(repoRoot, 'src', 'source.js'), ['export function testOnlyConsumer() {}']);
  await writeFile(path.join(repoRoot, 'test', 'source.test.js'), [
    "import { testOnlyConsumer } from '../src/source.js';",
    'testOnlyConsumer();',
  ]);

  const result = checkMaintainability({ repoRoot });

  assert.equal(result.ok, true);
  assert.deepEqual(result.unusedExports, []);
});

test('maintainability check fails src files missing check-js coverage', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stderr = [];
  await writeConfig(repoRoot, {
    include: ['src/checked.js'],
    maintainabilityGuard: {
      maxRuntimeFileLines: 20,
      typeCheckRoots: ['src'],
    },
  });
  await writeFile(path.join(repoRoot, 'src', 'checked.js'), ['const checked = true;', 'void checked;']);
  await writeFile(path.join(repoRoot, 'src', 'new-file.js'), ['const missed = true;', 'void missed;']);

  const result = checkMaintainability({
    repoRoot,
    writeError: (message) => stderr.push(message),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.typeCheckMissingFiles, ['src/new-file.js']);
  assert.deepEqual(stderr, [
    'Error: jsconfig check-js coverage is missing 1 configured file',
    '  src/new-file.js',
  ]);
});

test('type-check coverage guard catches new files outside include', async (t) => {
  const repoRoot = await createTempRepo(t);
  await writeFile(path.join(repoRoot, 'src', 'checked.js'), ['const checked = true;', 'void checked;']);
  await writeFile(path.join(repoRoot, 'src', 'new-runtime-file.js'), [
    'const uncovered = true;',
    'void uncovered;',
  ]);

  const missingFiles = collectTypeCheckMissingFiles({
    repoRoot,
    include: ['src/checked.js'],
    roots: ['src'],
    excludedRoots: new Set(),
  });

  assert.deepEqual(missingFiles, ['src/new-runtime-file.js']);
});

test('maintainability check accepts recursive src check-js coverage', async (t) => {
  const repoRoot = await createTempRepo(t);
  await writeConfig(repoRoot, {
    include: ['bin/**/*.js', 'src/**/*.js', 'test/**/*.js'],
    maintainabilityGuard: {
      maxRuntimeFileLines: 20,
      typeCheckRoots: ['bin', 'src'],
    },
  });
  await writeFile(path.join(repoRoot, 'bin', 'cli.js'), ['const cli = true;', 'void cli;']);
  await writeFile(path.join(repoRoot, 'src', 'index.js'), ['const index = true;', 'void index;']);
  await writeFile(path.join(repoRoot, 'src', 'nested', 'module.js'), [
    'const nested = true;',
    'void nested;',
  ]);
  await writeFile(path.join(repoRoot, 'test', 'index.test.js'), ['const checked = true;', 'void checked;']);

  const stdout = [];
  const result = checkMaintainability({
    repoRoot,
    writeOutput: (message) => stdout.push(message),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.typeCheckMissingFiles, []);
  assert.deepEqual(result.testTypeCheckIncludes, ['test/**/*.js']);
  assert.deepEqual(stdout, ['Test type-checking covers all test JavaScript files: test/**/*.js']);
});

test('maintainability check fails broken package script policies', async (t) => {
  const repoRoot = await createTempRepo(t);
  const stderr = [];
  await writeConfig(repoRoot, { maintainabilityGuard: { maxRuntimeFileLines: 20 } });
  await writeFile(path.join(repoRoot, 'src', 'index.js'), ['const ok = true;', 'void ok;']);
  await writeJson(path.join(repoRoot, 'package.json'), {
    scripts: {
      test: 'node --test "test/*.test.js"',
      coverage: 'node --test "test/**/*.test.js"',
      validate: 'npm test',
    },
  });

  const result = checkMaintainability({
    repoRoot,
    writeError: (message) => stderr.push(message),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.packageValidationFindings, [
    'package scripts.test must run node --test with recursive test discovery',
    'package scripts.test must not use shallow test/*.test.js discovery',
    'package scripts.coverage must run node --test with recursive coverage reporting',
    'package scripts.coverage must include src/**/*.js in coverage reporting',
    'package scripts.coverage must enforce line, branch, and function coverage thresholds',
    'package scripts.validate must run coverage reporting',
  ]);
  assert.deepEqual(
    stderr,
    result.packageValidationFindings.map((finding) => `Error: ${finding}`),
  );
});

test('package script validation rejects missing recursive test discovery', () => {
  assert.deepEqual(validatePackageScripts({
    test: 'node --test',
    coverage: coverageScript(),
    validate: 'npm run coverage',
  }), [
    'package scripts.test must run node --test with recursive test discovery',
  ]);
});

test('package script validation accepts the compatibility coverage runner', () => {
  assert.deepEqual(validatePackageScripts({
    test: 'node --test "test/**/*.test.js"',
    coverage: 'node scripts/coverage.mjs',
    validate: 'npm run coverage',
  }), []);
});

test('package script validation rejects coverage misconfigurations', () => {
  const cases = [
    {
      coverage: coverageScript({ coverageMode: false }),
      expected: ['package scripts.coverage must run node --test with recursive coverage reporting'],
    },
    {
      coverage: coverageScript({ thresholds: false }),
      expected: ['package scripts.coverage must enforce line, branch, and function coverage thresholds'],
    },
    {
      coverage: coverageScript({ sourceInclude: false }),
      expected: ['package scripts.coverage must include src/**/*.js in coverage reporting'],
    },
  ];

  for (const { coverage, expected } of cases) {
    assert.deepEqual(validatePackageScripts({
      test: 'node --test "test/**/*.test.js"',
      coverage,
      validate: 'npm run coverage',
    }), expected);
  }
});

test('package script validation rejects misleading recursive-looking targets', () => {
  assert.deepEqual(validatePackageScripts({
    test: 'node --test "./test/**/*.test.js"',
    coverage: coverageScript({ testGlob: './test/**/*.test.js' }),
    validate: 'npm run coverage -- --reporter=spec',
  }), []);

  const findings = validatePackageScripts({
    test: 'node --test "ztest/**/*.test.js"',
    coverage: coverageScript({ testGlob: 'test/**/*.test.js.bak' }),
    validate: 'npm run coverage',
  });

  assert.deepEqual(findings, [
    'package scripts.test must run node --test with recursive test discovery',
    'package scripts.coverage must run node --test with recursive coverage reporting',
  ]);
});

test('repository maintainability guard enables strict export and type-check policies', () => {
  const config = readJson(new URL('../jsconfig.json', import.meta.url));
  const guard = config.maintainabilityGuard;

  assert.deepEqual(guard.unusedExportConsumerRoots, ['bin', 'src', 'test']);
  assert.deepEqual(guard.typeCheckRoots, ['bin', 'src']);
});

async function createTempRepo(t) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'commands-com-maintainability-'));
  t.after(() => fs.rm(repoRoot, { recursive: true, force: true }));
  return repoRoot;
}

async function writeConfig(repoRoot, overrides = {}) {
  const { maintainabilityGuard, ...rest } = overrides;
  await writeJson(path.join(repoRoot, 'jsconfig.json'), {
    compilerOptions: REQUIRED_COMPILER_OPTIONS,
    maintainabilityGuard: {
      runtimeRoots: ['src'],
      excludedRoots: [],
      maxRuntimeFileLines: 10,
      ...maintainabilityGuard,
    },
    ...rest,
  });
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const lines = typeof content === 'number'
    ? Array.from({ length: content }, (_, index) => `line${index + 1}`)
    : content;
  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf8');
}

async function writeJson(file, data) {
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function coverageScript({
  coverageMode = true,
  sourceInclude = true,
  thresholds = true,
  testGlob = 'test/**/*.test.js',
} = {}) {
  return [
    'node --test',
    coverageMode ? '--experimental-test-coverage' : '',
    sourceInclude ? '"--test-coverage-include=src/**/*.js"' : '',
    thresholds ? '--test-coverage-lines=80 --test-coverage-branches=70 --test-coverage-functions=75' : '',
    `"${testGlob}"`,
  ].filter(Boolean).join(' ');
}
