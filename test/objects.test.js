import test from 'node:test';
import assert from 'node:assert/strict';
import { isObjectRecord } from '../src/objects.js';

test('isObjectRecord accepts only plain object records', () => {
  assert.equal(isObjectRecord({}), true);
  assert.equal(isObjectRecord({ id: 'mock' }), true);
  assert.equal(isObjectRecord(Object.create(Object.prototype)), true);
  assert.equal(isObjectRecord(Object.create(null)), true);
  assert.equal(isObjectRecord(Object.freeze({ id: 'codex' })), true);

  assert.equal(isObjectRecord(null), false);
  assert.equal(isObjectRecord(undefined), false);
  assert.equal(isObjectRecord('object'), false);
  assert.equal(isObjectRecord(1), false);
  assert.equal(isObjectRecord([]), false);
  assert.equal(isObjectRecord(() => {}), false);
});

test('isObjectRecord rejects object instances even when they expose record-like fields', () => {
  class ProviderCandidate {
    constructor() {
      this.id = 'mock';
      this.path = 'built-in';
    }
  }

  assert.equal(isObjectRecord(new ProviderCandidate()), false);
  assert.equal(isObjectRecord(new Date()), false);
  assert.equal(isObjectRecord(new Map([['id', 'mock']])), false);
  assert.equal(isObjectRecord(/mock/u), false);
  assert.equal(isObjectRecord(Object.create({ id: 'inherited' })), false);
});

test('isObjectRecord accepts provider and run-state shapes only when they are records', () => {
  const provider = Object.freeze({
    id: 'mock',
    path: 'built-in',
    available: true,
  });
  const nullPrototypeProvider = Object.assign(Object.create(null), {
    id: 'codex',
    path: '/usr/local/bin/codex',
  });
  const runStatePayload = JSON.parse(JSON.stringify({
    version: 1,
    status: 'running',
    options: { provider: 'mock' },
    cycles: [],
  }));

  assert.equal(isObjectRecord(provider), true);
  assert.equal(isObjectRecord(nullPrototypeProvider), true);
  assert.equal(isObjectRecord(runStatePayload), true);
  assert.equal(isObjectRecord(runStatePayload.options), true);
  assert.equal(isObjectRecord(runStatePayload.cycles), false);
});

