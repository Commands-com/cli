import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  prepareRun,
  resolveRunDir,
  RUN_ID_PATTERN,
  runStoreRoot,
} from '../src/run-store.js';
import { initGitRepo, tempDir } from './support/cli.js';

test('prepareRun creates a store and writes context plus metadata', async () => {
  const cwd = await tempDir();
  try {
    const { store, context } = await prepareRun(cwd, {
      kind: 'room-security',
      label: 'Audit CLI',
      metadata: {
        kind: 'room',
        roomId: 'security',
        changed: false,
      },
    });

    assert.match(store.runId, /^\d{8}-\d{6}-room-security-audit-cli-[0-9a-f]{6}$/);
    assert.match(store.runId, RUN_ID_PATTERN);
    assert.equal(store.dir, path.join(runStoreRoot(cwd), store.runId));
    assert.equal(context.repoRoot, await fs.realpath(cwd));

    const contextText = await fs.readFile(path.join(store.dir, 'context.md'), 'utf8');
    assert.match(contextText, new RegExp(`Repository: ${context.repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(contextText, /Git status:\n\(clean\)/);

    const metadata = JSON.parse(await fs.readFile(path.join(store.dir, 'metadata.json'), 'utf8'));
    const { createdAt, ...rest } = metadata;
    assert.deepEqual(rest, {
      kind: 'room',
      roomId: 'security',
      changed: false,
    });
    assert.equal(Number.isNaN(Date.parse(createdAt)), false);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('prepareRun preserves run store write path validation', async () => {
  const cwd = await tempDir();
  try {
    const { store } = await prepareRun(cwd, {
      kind: 'room-security',
      label: 'Path Validation',
      metadata: { kind: 'room' },
    });

    await assert.rejects(store.write('../outside.md', 'nope'), /outside run directory/);
    await assert.rejects(fs.stat(path.join(runStoreRoot(cwd), 'outside.md')), /ENOENT/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('run store rejects traversal and names that resolve to the run directory', async () => {
  const cwd = await tempDir();
  try {
    const { store } = await prepareRun(cwd, {
      kind: 'review',
      label: 'Path Safety',
      writeSetupArtifacts: false,
    });
    const siblingName = `${path.basename(store.dir)}-sibling`;

    await assert.rejects(store.write('../outside.md', 'nope'), /outside run directory/);
    await assert.rejects(store.write(`../${siblingName}/outside.md`, 'nope'), /outside run directory/);
    await assert.rejects(store.write('', 'nope'), /run directory itself/);
    await assert.rejects(store.write('.', 'nope'), /run directory itself/);
    await assert.rejects(store.write('nested/..', 'nope'), /run directory itself/);

    await assert.rejects(fs.stat(path.join(runStoreRoot(cwd), 'outside.md')), /ENOENT/);
    await assert.rejects(fs.stat(path.join(runStoreRoot(cwd), siblingName, 'outside.md')), /ENOENT/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('prepareRun returns a run-id that round-trips through RUN_ID_PATTERN when the label slug truncation lands on a hyphen', async () => {
  const cwd = await tempDir();
  try {
    // 25 alphanumeric chars separated by spaces normalize to 49 chars of
    // alternating letter/dash; slug()'s default 48-char slice lands on a
    // trailing dash that previously broke RUN_ID_PATTERN.
    const label = 'a b c d e f g h i j k l m n o p q r s t u v w x y';
    const { store } = await prepareRun(cwd, {
      kind: 'review',
      label,
      writeSetupArtifacts: false,
    });

    assert.match(store.runId, RUN_ID_PATTERN);
    assert.doesNotMatch(store.runId, /--/);

    const resolved = await resolveRunDir(cwd, store.runId);
    assert.equal(resolved, store.dir);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resolveRunDir(latest) picks the run with the newer metadata.createdAt when run IDs share a second', async () => {
  const cwd = await tempDir();
  try {
    // Both runs share the 20260101-010101 second portion. String sort would
    // pick bravo-ffffff (lexicographically larger), but ms-precision createdAt
    // says alpha-aaaaaa is the newer run.
    const earlierRunId = '20260101-010101-review-bravo-ffffff';
    const laterRunId = '20260101-010101-review-alpha-aaaaaa';
    const earlierDir = path.join(runStoreRoot(cwd), earlierRunId);
    const laterDir = path.join(runStoreRoot(cwd), laterRunId);
    await fs.mkdir(earlierDir, { recursive: true });
    await fs.mkdir(laterDir, { recursive: true });
    await fs.writeFile(path.join(earlierDir, 'metadata.json'), JSON.stringify({
      kind: 'review',
      createdAt: '2026-01-01T01:01:01.001Z',
    }), 'utf8');
    await fs.writeFile(path.join(laterDir, 'metadata.json'), JSON.stringify({
      kind: 'review',
      createdAt: '2026-01-01T01:01:01.999Z',
    }), 'utf8');

    assert.equal(await resolveRunDir(cwd, 'latest'), laterDir);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('resolveRunDir(latest) falls back to directory mtimeMs when metadata.createdAt is missing', async () => {
  const cwd = await tempDir();
  try {
    // Same-second run IDs with no metadata.createdAt; older string-sort winner
    // gets the newer mtime, so mtime fallback must override the run-ID compare.
    const stringSortWinnerId = '20260101-010101-review-zulu-ffffff';
    const newerByMtimeId = '20260101-010101-review-alpha-aaaaaa';
    const stringSortWinnerDir = path.join(runStoreRoot(cwd), stringSortWinnerId);
    const newerByMtimeDir = path.join(runStoreRoot(cwd), newerByMtimeId);
    await fs.mkdir(stringSortWinnerDir, { recursive: true });
    await fs.mkdir(newerByMtimeDir, { recursive: true });

    const olderTime = new Date('2026-01-01T01:01:01.000Z');
    const newerTime = new Date('2026-01-01T01:01:01.500Z');
    await fs.utimes(stringSortWinnerDir, olderTime, olderTime);
    await fs.utimes(newerByMtimeDir, newerTime, newerTime);

    assert.equal(await resolveRunDir(cwd, 'latest'), newerByMtimeDir);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('prepareRun forwards changed context into the context artifact', async () => {
  const cwd = await tempDir();
  try {
    await initGitRepo(cwd);
    await fs.appendFile(path.join(cwd, 'README.md'), 'changed line\n', 'utf8');

    const { store, context } = await prepareRun(cwd, {
      kind: 'room-security',
      label: 'Changed Run',
      changed: true,
      metadata: { kind: 'room' },
    });

    assert.match(context.diff, /\+changed line/);
    const contextText = await fs.readFile(path.join(store.dir, 'context.md'), 'utf8');
    assert.match(contextText, /Diff:/);
    assert.match(contextText, /\+changed line/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
