import { PasswordLoginRequestSchema, type PasswordLoginRequest } from '@rally/contracts/password-login';
import { IDENTITY_REGION } from '@rally/contracts/regions';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { randomToken, sha256 } from '../lib/crypto';
import { AuthService } from './auth-service';

// Team-selected 2026-11-10: ten attempts per account per minute, across hosts.
// Bounds repeated account attempts; authBodyLimit only bounds request bytes.
// A full budget returns 429. Known emails can be locked out by consuming it.
export const PASSWORD_LOGIN_ATTEMPTS = 10;
export const PASSWORD_LOGIN_WINDOW_MS = 60_000;

export function requirePasswordIdentityRegion(env: Env): void {
  if (env.AVALON_REGION !== IDENTITY_REGION) {
    throw new ApiError(409, 'global_identity_required', 'Use Rally’s identity endpoint to sign in');
  }
}

/** Atomic reservation including misses; both transports share it. */
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
  const credential = await env.DB.prepare(`SELECT c.user_id, c.credential_id
    FROM user_password_credentials c JOIN users u ON u.id = c.user_id WHERE u.email = ? AND c.password_hash = ?`)
    .bind(email, await sha256(password)).first<{ user_id: string; credential_id: string }>();
  if (!credential) {
    throw new ApiError(401, 'password_login_invalid', 'The email or password is incorrect.');
  }
  return new AuthService(env).createPasswordIdentitySession(credential.user_id, credential.credential_id);
}

/** Operator-only: returns a fresh generated password, never persists plaintext. */
export async function provisionUserPassword(env: Env, userId: string) {
  requirePasswordIdentityRegion(env);
  const user = await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(userId).first<{ id: string; email: string }>();
  if (!user) throw new ApiError(404, 'password_user_not_found', 'The identity account was not found');
  // Only generated 256-bit secrets: use the same digest primitive as refresh tokens.
  // Human-chosen passwords would require a slow password KDF instead.
  const password = randomToken();
  const at = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO user_password_credentials
    (user_id, credential_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET credential_id = excluded.credential_id,
      password_hash = excluded.password_hash, updated_at = excluded.updated_at`)
    .bind(userId, crypto.randomUUID(), await sha256(password), at, at).run();
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
