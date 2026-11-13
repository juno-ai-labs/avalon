import assert from 'node:assert/strict';
import test from 'node:test';

import { isTransientWranglerFailure, runWranglerWithTransientRetry } from './release-cloudflare.mjs';

// The line Wrangler printed when release 1.727.0's DMG upload was refused.
const gatewayTimeout = {
  code: 1,
  stdout: '',
  stderr: '✘ [ERROR] Failed to fetch /accounts/abc/r2/buckets/releases/objects/stable/Rally-1.727.0-mac-arm64.dmg - 504: Gateway Timeout;',
};
const unauthorized = {
  code: 1,
  stdout: '',
  stderr: '✘ [ERROR] Failed to fetch /accounts/abc/r2/buckets/releases/objects/stable/Rally.dmg - 403: Forbidden;',
};
const success = { code: 0, stdout: 'Upload complete.', stderr: '' };

function scripted(results) {
  const queue = [...results];
  const calls = { attempts: 0, sleeps: [] };
  return {
    calls,
    attempt: async () => {
      calls.attempts += 1;
      return queue.shift();
    },
    sleep: async (milliseconds) => { calls.sleeps.push(milliseconds); },
  };
}

test('classifies Cloudflare 5xx, 429 and dropped connections as transient, and 4xx as final', () => {
  assert.equal(isTransientWranglerFailure(gatewayTimeout), true);
  assert.equal(isTransientWranglerFailure({ stderr: 'Failed to fetch /x - 429: Too Many Requests;' }), true);
  assert.equal(isTransientWranglerFailure({ stderr: 'TypeError: fetch failed' }), true);
  assert.equal(isTransientWranglerFailure({ stdout: 'read ECONNRESET' }), true);
  assert.equal(isTransientWranglerFailure(unauthorized), false);
  assert.equal(isTransientWranglerFailure({ stderr: 'The specified bucket does not exist.' }), false);
});

test('retries an upload refused with a gateway timeout until it succeeds', async () => {
  const run = scripted([gatewayTimeout, gatewayTimeout, success]);
  const result = await runWranglerWithTransientRetry({
    attempt: run.attempt,
    maxAttempts: Number.POSITIVE_INFINITY,
    sleep: run.sleep,
  });
  assert.equal(result.code, 0);
  assert.equal(run.calls.attempts, 3);
  assert.deepEqual(run.calls.sleeps, [1_000, 2_000]);
});

test('fails a non-transient refusal on the first attempt', async () => {
  const run = scripted([unauthorized, success]);
  const result = await runWranglerWithTransientRetry({
    attempt: run.attempt,
    maxAttempts: Number.POSITIVE_INFINITY,
    sleep: run.sleep,
  });
  assert.equal(result.stderr, unauthorized.stderr);
  assert.equal(run.calls.attempts, 1);
  assert.deepEqual(run.calls.sleeps, []);
});

test('returns the last transient failure once a finite attempt ceiling is spent', async () => {
  const run = scripted([gatewayTimeout, gatewayTimeout, gatewayTimeout, success]);
  const result = await runWranglerWithTransientRetry({
    attempt: run.attempt,
    maxAttempts: 3,
    sleep: run.sleep,
  });
  assert.equal(result.code, 1);
  assert.equal(run.calls.attempts, 3);
  assert.deepEqual(run.calls.sleeps, [1_000, 2_000]);
});

test('caps the backoff between attempts at thirty seconds', async () => {
  const run = scripted([...Array(7).fill(gatewayTimeout), success]);
  await runWranglerWithTransientRetry({
    attempt: run.attempt,
    maxAttempts: Number.POSITIVE_INFINITY,
    sleep: run.sleep,
  });
  assert.deepEqual(run.calls.sleeps, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
});
