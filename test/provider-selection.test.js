import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderRequest } from '../src/provider-selection.js';

test('resolveProviderRequest preserves CLI and runtime precedence', () => {
  assert.equal(
    resolveProviderRequest(new Map([['providers', 'codex,claude']]), { provider: 'mock', providers: '' }),
    'codex,claude',
  );
  assert.equal(
    resolveProviderRequest(new Map([['provider', 'mock']]), { provider: 'codex', providers: 'claude' }),
    'mock',
  );
  assert.equal(resolveProviderRequest(new Map(), { provider: 'auto', providers: 'claude' }), 'claude');
  assert.equal(resolveProviderRequest(new Map(), { provider: 'mock', providers: '' }), 'mock');
  assert.equal(resolveProviderRequest(new Map(), { provider: 'auto', providers: '' }), 'all');
});

test('resolveProviderRequest uses caller fallback when no provider is selected', () => {
  assert.equal(resolveProviderRequest(new Map(), { provider: 'auto', providers: '' }, 'mock'), 'mock');
});
