import test from 'node:test';
import assert from 'node:assert/strict';
import { providerFallbackChain } from '../src/provider-fallback.js';

test('providerFallbackChain keeps primary first and de-duplicates by provider id', () => {
  const primary = { id: 'codex', command: 'primary-codex' };
  const duplicatePrimary = { id: 'codex', command: 'fallback-codex' };
  const claude = { id: 'claude', command: 'first-claude' };
  const duplicateClaude = { id: 'claude', command: 'second-claude' };
  const gemini = { id: 'gemini', command: 'gemini' };

  const chain = providerFallbackChain(primary, [
    duplicatePrimary,
    null,
    { id: '', command: 'empty-id' },
    claude,
    gemini,
    duplicateClaude,
  ]);

  assert.deepEqual(chain.map((provider) => provider.id), ['codex', 'claude', 'gemini']);
  assert.equal(chain[0], primary);
  assert.equal(chain[1], claude);
  assert.equal(chain[2], gemini);
});

test('providerFallbackChain accepts fallback-only chains', () => {
  const mock = { id: 'mock' };
  const chain = providerFallbackChain(null, [undefined, mock, { id: 'mock' }]);

  assert.deepEqual(chain, [mock]);
});
