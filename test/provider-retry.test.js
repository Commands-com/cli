import test from 'node:test';
import assert from 'node:assert/strict';
import { isTransientProviderError, runProviderWithRetry } from '../src/provider-retry.js';

const TRANSIENT_MESSAGES = [
  'stream disconnected before completion',
  'Reconnecting...',
  'please retry your request',
  'service temporarily unavailable',
  'provider overloaded',
  'Selected model is at capacity. Please try a different model.',
  'Rate limit exceeded',
  'read ECONNRESET',
  'connect ECONNREFUSED 127.0.0.1:8080',
  'getaddrinfo ENOTFOUND api.example.com',
  'connect ETIMEDOUT',
  'write EPIPE',
  'HTTP 502 Bad Gateway',
  'HTTP 503',
  'HTTP 503 Service Unavailable',
  'HTTP 504 returned from upstream',
  'response: status 502',
  'service unavailable',
  'Gateway Timeout while contacting model host',
  'gateway timeout 504',
  'getaddrinfo EAI_AGAIN api.example.com',
  'socket hang up',
];

const PERMANENT_MESSAGES = [
  'invalid API key',
  'permission denied',
  'unsupported provider: custom',
  'model not found',
  'timed out waiting for user approval',
  'codex timed out after 20ms',
  'codex interrupted by SIGTERM',
  'build #502 succeeded',
  'commit 50324abc',
  '502 of 1000 records',
];

test('isTransientProviderError classifies retryable provider failures', () => {
  for (const message of TRANSIENT_MESSAGES) {
    assert.equal(isTransientProviderError(new Error(message)), true, message);
  }
});

test('isTransientProviderError does not classify permanent failures as retryable', () => {
  for (const message of PERMANENT_MESSAGES) {
    assert.equal(isTransientProviderError(new Error(message)), false, message);
  }
});

test('runProviderWithRetry does not retry non-transient provider failures', async () => {
  const retryEvents = [];
  let attempts = 0;

  await assert.rejects(
    runProviderWithRetry(
      { id: 'codex', command: 'codex' },
      {
        retries: 3,
        retryDelayMs: 0,
        onRetry: (event) => retryEvents.push(event.retry),
      },
      async () => {
        attempts += 1;
        throw new Error('invalid API key');
      },
    ),
    /invalid API key/,
  );

  assert.equal(attempts, 1);
  assert.deepEqual(retryEvents, []);
});

test('runProviderWithRetry does not retry provider timeout or interruption failures', async () => {
  const provider = { id: 'codex', command: 'codex' };

  for (const message of ['codex timed out after 20ms', 'codex interrupted by SIGTERM']) {
    const retryEvents = [];
    let attempts = 0;

    await assert.rejects(
      runProviderWithRetry(
        provider,
        {
          retries: 3,
          retryDelayMs: 0,
          onRetry: (event) => retryEvents.push(event.retry),
        },
        async () => {
          attempts += 1;
          throw new Error(message);
        },
      ),
      new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );

    assert.equal(attempts, 1, message);
    assert.deepEqual(retryEvents, [], message);
  }
});

test('runProviderWithRetry treats negative retry delays as zero', async () => {
  const provider = { id: 'codex', command: 'codex' };
  const delays = [];
  let attempts = 0;

  await assert.rejects(
    runProviderWithRetry(
      provider,
      { retries: 1, retryDelayMs: -50 },
      async () => {
        attempts += 1;
        throw new Error('temporarily unavailable');
      },
      async (ms) => {
        delays.push(ms);
      },
    ),
    /temporarily unavailable/,
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, []);
});
