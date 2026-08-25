import { createHash, randomBytes } from 'node:crypto';
import type { RallyRegion, DesktopAuthAttempt } from '../common/desktop';

const DEFAULT_ATTEMPT_TTL_MS = 12 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 6;

interface StoredDesktopAuthAttempt {
  attemptId: string;
  apiBaseUrl: string;
  region: RallyRegion;
  verifier: string;
  createdAt: number;
  expiresAt: number;
}

interface DesktopAuthAttemptStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxAttempts?: number;
  randomBytes?: (size: number) => Uint8Array;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/**
 * Process-local PKCE material for desktop sign-in. Verifiers intentionally
 * never cross the preload boundary or touch disk. A restart therefore safely
 * abandons any in-flight browser authorization and the user starts again.
 */
export class DesktopAuthAttemptStore {
  private readonly attempts = new Map<string, StoredDesktopAuthAttempt>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxAttempts: number;
  private readonly random: (size: number) => Uint8Array;

  constructor(options: DesktopAuthAttemptStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? DEFAULT_ATTEMPT_TTL_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.random = options.randomBytes ?? randomBytes;
  }

  create(apiBaseUrl: string, region: RallyRegion): DesktopAuthAttempt {
    this.prune();
    while (this.attempts.size >= this.maxAttempts) {
      const oldest = this.attempts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.attempts.delete(oldest);
    }

    let attemptId = base64Url(this.random(32));
    while (this.attempts.has(attemptId)) attemptId = base64Url(this.random(32));
    // 48 random bytes produce a 64-character RFC 7636 verifier, comfortably
    // above the 256-bit entropy recommendation and within the 43–128 range.
    const verifier = base64Url(this.random(48));
    const createdAt = this.now();
    this.attempts.set(attemptId, {
      attemptId,
      apiBaseUrl,
      region,
      verifier,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
    });
    return { attemptId, codeChallenge: s256(verifier) };
  }

  proof(attemptId: string): Readonly<StoredDesktopAuthAttempt> | null {
    this.prune();
    return this.attempts.get(attemptId) ?? null;
  }

  discard(attemptId: string): void {
    this.attempts.delete(attemptId);
  }

  clear(): void {
    this.attempts.clear();
  }

  get size(): number {
    this.prune();
    return this.attempts.size;
  }

  private prune(): void {
    const at = this.now();
    for (const [attemptId, attempt] of this.attempts) {
      if (attempt.expiresAt <= at) this.attempts.delete(attemptId);
    }
  }
}

export const __desktopAuthAttemptTesting = { base64Url, s256 };
