import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DesktopAuthAttemptStore } from './desktop-auth-attempts';

describe('native desktop authentication attempts', () => {
  it('returns only an opaque id and S256 challenge while retaining the verifier', () => {
    let byte = 0;
    const store = new DesktopAuthAttemptStore({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => byte++ % 256),
    });
    const publicAttempt = store.create('https://api.rallywith.ai', 'global');
    const retained = store.proof(publicAttempt.attemptId);

    expect(publicAttempt).toEqual({
      attemptId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      codeChallenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(retained?.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    expect(publicAttempt).not.toHaveProperty('verifier');
    expect(publicAttempt.codeChallenge).toBe(
      createHash('sha256').update(retained!.verifier, 'ascii').digest('base64url'),
    );
    expect(retained).toMatchObject({
      apiBaseUrl: 'https://api.rallywith.ai',
      region: 'global',
    });
  });

  it('expires abandoned attempts and bounds concurrent attempts', () => {
    let now = 1_000;
    let seed = 0;
    const store = new DesktopAuthAttemptStore({
      maxAttempts: 2,
      ttlMs: 100,
      now: () => now,
      randomBytes: (size) => Uint8Array.from({ length: size }, () => seed++ % 256),
    });
    const first = store.create('https://api.rallywith.ai', 'global');
    const second = store.create('https://eu.api.rallywith.ai', 'eu');
    const third = store.create('https://api.rallywith.ai', 'global');

    expect(store.proof(first.attemptId)).toBeNull();
    expect(store.proof(second.attemptId)).not.toBeNull();
    expect(store.proof(third.attemptId)).not.toBeNull();
    expect(store.size).toBe(2);

    now += 101;
    expect(store.proof(second.attemptId)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('supports explicit single-attempt and logout cleanup', () => {
    const store = new DesktopAuthAttemptStore();
    const first = store.create('https://api.rallywith.ai', 'global');
    store.create('https://eu.api.rallywith.ai', 'eu');
    store.discard(first.attemptId);
    expect(store.proof(first.attemptId)).toBeNull();
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });
});
