import { scryptSync, timingSafeEqual } from 'node:crypto';
import { PasswordLoginRequestSchema, type PasswordLoginRequest } from '@rally/contracts/password-login';
import { IDENTITY_REGION } from '@rally/contracts/regions';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { randomToken, sha256 } from '../lib/crypto';
import { AuthService } from './auth-service';

// Team-selected 2026-11-10: ten attempts per account per minute, across hosts.
// Stops online guessing and repeated expensive hashing; authBodyLimit only
// bounds individual requests. A full budget returns 429 before hashing.
export const PASSWORD_LOGIN_ATTEMPTS = 10;
export const PASSWORD_LOGIN_WINDOW_MS = 60_000;

// OWASP's equivalent 16 MiB scrypt profile, read 2026-11-10:
// https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#scrypt
// Workers supports native scrypt, but not native Argon2. No WASM runtime needed.
const SCRYPT_OPTIONS = { N: 2 ** 14, r: 8, p: 5 };
const HASH_BYTES = 32;
const DUMMY_SALT = 'rally-password-unknown-account';

export function hashPassword(password: string): string {
  const salt = randomToken();
  return `scrypt-v1$${salt}$${Buffer.from(scryptSync(password, salt, HASH_BYTES, SCRYPT_OPTIONS)).toString('hex')}`;
}

export function verifyPassword(password: string, encoded: string | null): boolean {
  const parts = encoded?.match(/^scrypt-v1\$([A-Za-z0-9_-]{43})\$([a-f0-9]{64})$/u);
  if (encoded !== null && !parts) throw new ApiError(503, 'password_hash_format_invalid', 'Password sign-in is unavailable');
  // Do the same KDF work for unknown and unprovisioned accounts. Nothing about
  // the supplied password or stored hash enters a diagnostic or response.
  const actual = scryptSync(password, parts?.[1] ?? DUMMY_SALT, HASH_BYTES, SCRYPT_OPTIONS);
  const expected = parts ? Buffer.from(parts[2]!, 'hex') : Buffer.alloc(HASH_BYTES);
  return timingSafeEqual(actual, expected) && parts !== undefined && parts !== null;
}

export function requirePasswordIdentityRegion(env: Env): void {
  if (env.AVALON_REGION !== IDENTITY_REGION) {
    throw new ApiError(409, 'global_identity_required', 'Use Rally’s identity endpoint to sign in');
  }
}

/** Atomic reservation before KDF work, including misses; both transports share it. */
async function consumeAttempt(env: Env, email: string): Promise<void> {
  const now = Date.now();
  const key = await sha256(email);
  const admitted = await env.DB.prepare(`INSERT INTO password_login_attempts (account_key, attempts, expires_at)
    VALUES (?, 1, ?)
    ON CONFLICT(account_key) DO UPDATE SET
      attempts = CASE WHEN expires_at <= ? THEN 1 ELSE attempts + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    WHERE expires_at <= ? OR attempts < ?
    RETURNING account_key`).bind(key, now + PASSWORD_LOGIN_WINDOW_MS, now, now, now, PASSWORD_LOGIN_ATTEMPTS).first();
  if (!admitted) throw new ApiError(429, 'password_login_rate_limited', 'Too many sign-in attempts. Try again in a minute.');
}

export async function passwordLogin(env: Env, input: PasswordLoginRequest) {
  requirePasswordIdentityRegion(env);
  const { email, password } = PasswordLoginRequestSchema.parse(input);
  await consumeAttempt(env, email);
  const credential = await env.DB.prepare(`SELECT c.user_id, c.credential_id, c.password_hash
    FROM user_password_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = ?`)
    .bind(email).first<{ user_id: string; credential_id: string; password_hash: string }>();
  if (!verifyPassword(password, credential?.password_hash ?? null) || !credential) {
    throw new ApiError(401, 'password_login_invalid', 'The email or password is incorrect.');
  }
  return new AuthService(env).createPasswordIdentitySession(credential.user_id, credential.credential_id);
}

/** Operator-only: returns a fresh generated password, never persists plaintext. */
export async function provisionUserPassword(env: Env, userId: string) {
  requirePasswordIdentityRegion(env);
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string }>();
  if (!user) throw new ApiError(404, 'password_user_not_found', 'The identity account was not found');
  const password = randomToken();
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO user_password_credentials
    (user_id, credential_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET credential_id = excluded.credential_id,
      password_hash = excluded.password_hash, updated_at = excluded.updated_at`)
    .bind(userId, crypto.randomUUID(), hashPassword(password), at, at).run();
  return { userId: user.id, email: user.email, password };
}

export async function revokeUserPassword(env: Env, userId: string) {
  requirePasswordIdentityRegion(env);
  await env.DB.prepare('DELETE FROM user_password_credentials WHERE user_id = ?').bind(userId).run();
  return { userId, passwordEnabled: false as const };
}

export async function purgeExpiredPasswordLoginAttempts(env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM password_login_attempts WHERE expires_at <= ?').bind(Date.now()).run();
}
