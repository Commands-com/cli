import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { metadataListOption, readResumeMetadata } from '../src/resume-metadata.js';
import { tempDir } from './support/cli.js';

function parsed(flags = {}) {
  return {
    positionals: [],
    flags: new Map(Object.entries(flags).map(([key, value]) => [key, String(value)])),
  };
}

test('readResumeMetadata returns null when no run is being resumed', async () => {
  assert.equal(await readResumeMetadata(parsed(), '/unit/repo'), null);
});

test('readResumeMetadata reads the resumed run metadata once requested', async () => {
  const cwd = await tempDir('commands-com-resume-metadata-');
  try {
    const runDir = path.join(cwd, 'resume-run');
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(path.join(runDir, 'metadata.json'), JSON.stringify({
      objective: 'Resume objective',
      reviewers: ['correctness'],
    }), 'utf8');

    assert.deepEqual(await readResumeMetadata(parsed({ resume: runDir }), cwd), {
      objective: 'Resume objective',
      reviewers: ['correctness'],
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test('metadataListOption uses metadata list values only when the CLI flag is absent', () => {
  const metadata = {
    reviewers: ['correctness', 'tests'],
  };

  assert.deepEqual(
    metadataListOption(parsed(), metadata, {
      flag: 'reviewers',
      metadataField: 'reviewers',
      fallback: ['maintainability'],
    }),
    ['correctness', 'tests'],
  );
  assert.deepEqual(
    metadataListOption(parsed({ reviewers: 'security' }), metadata, {
      flag: 'reviewers',
      metadataField: 'reviewers',
      fallback: ['maintainability'],
    }),
    ['security'],
  );
});

test('metadataListOption falls back when metadata does not contain a list', () => {
  assert.deepEqual(
    metadataListOption(parsed(), { areas: [] }, {
      flag: 'area',
      metadataField: 'areas',
      fallback: ['architecture'],
    }),
    ['architecture'],
  );
});

test('metadataListOption ignores non-string array entries and falls back when none remain', () => {
  assert.deepEqual(
    metadataListOption(parsed(), { areas: [1, { name: 'tests' }, '', '   ', null] }, {
      flag: 'area',
      metadataField: 'areas',
      fallback: ['architecture'],
    }),
    ['architecture'],
  );
  assert.deepEqual(
    metadataListOption(parsed({ area: 'correctness' }), { areas: [42, null] }, {
      flag: 'area',
      metadataField: 'areas',
      fallback: ['architecture'],
    }),
    ['correctness'],
  );
  assert.deepEqual(
    metadataListOption(parsed(), { areas: [42, '  tests  ', null, ''] }, {
      flag: 'area',
      metadataField: 'areas',
      fallback: ['architecture'],
    }),
    ['tests'],
  );
});
