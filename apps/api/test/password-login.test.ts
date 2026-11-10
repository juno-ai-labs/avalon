import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { SessionSchema } from '@rally/contracts';
import { createApp } from '../src/app';
import { AuthService, verifyAccessToken } from '../src/services/auth-service';
import { passwordLogin, provisionUserPassword, purgeExpiredPasswordLoginAttempts, revokeUserPassword } from '../src/services/password-login-service';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const USER = '00000000-0000-7000-8000-00000000a901';
const EMAIL = 'reviewer@example.test';
const ORIGIN = 'https://app.example.test';
let db: DatabaseSync;
let now: number;
function bindings() {
  return createTestEnv({ DB: sqliteD1(db), AVALON_REGION: 'global', APP_ENV: 'production',
    ALLOWED_ORIGINS: ORIGIN, BROWSER_APP_ORIGIN: ORIGIN, PUBLIC_API_BASE_URL: 'https://api.example.test',
    SESSION_SIGNING_KEY: 'password-login-test-signing-key', OAUTH_STATE_ENCRYPTION_KEY: 'password-login-test-encryption-key', LOG_LEVEL: 'error' });
}
function login(path: '/auth/password' | '/browser/password', password: string, email = EMAIL, origin = ORIGIN) {
  return createApp().request(`https://api.example.test${path}`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ email, password }) }, bindings());
}
beforeEach(() => {
  db = migratedSqliteDatabase();
  now = Date.parse('2026-11-10T18:00:00Z');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  db.prepare(`INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, 'Reviewer', ?, ?)`)
    .run(USER, EMAIL, new Date(now).toISOString(), new Date(now).toISOString());
});
afterEach(() => { db.close(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('operator-provisioned passwords', () => {
  it('provisions only an existing identity without verifying its email or granting access', async () => {
    await expect(provisionUserPassword(bindings(), '00000000-0000-7000-8000-00000000a902')).rejects.toMatchObject({ code: 'password_user_not_found' });
    const result = await provisionUserPassword(bindings(), USER);
    expect(result).toMatchObject({ userId: USER, email: EMAIL });
    expect(db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM user_verified_emails').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM workspace_members').get()).toEqual({ n: 0 });
    const stored = db.prepare('SELECT password_hash FROM user_password_credentials').get()!;
    expect(stored.password_hash).toMatch(/^scrypt-v1\$/u);
    expect(JSON.stringify(stored)).not.toContain(result.password);
    const session = await passwordLogin(bindings(), { email: '  REVIEWER@EXAMPLE.TEST  ', password: result.password });
    expect(session.user.id).toBe(USER);
    expect(session.workspace).toBeNull();
  });

  it('rejects unknown, unprovisioned, and wrong passwords with the same response', async () => {
    const unprovisioned = await login('/auth/password', 'incorrect');
    await provisionUserPassword(bindings(), USER);
    const wrong = await login('/auth/password', 'incorrect');
    const unknown = await login('/auth/password', 'incorrect', 'missing@example.test');
    expect([unprovisioned.status, wrong.status, unknown.status]).toEqual([401, 401, 401]);
    for (const response of [unprovisioned, wrong, unknown]) expect(await response.json()).toMatchObject({
      error: { code: 'password_login_invalid', message: 'The email or password is incorrect.' },
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('issues ordinary desktop credentials and an HttpOnly browser cookie with no bearer in JSON', async () => {
    const { password } = await provisionUserPassword(bindings(), USER);
    const desktop = await login('/auth/password', password);
    expect(desktop.status).toBe(200);
    expect(desktop.headers.get('cache-control')).toBe('no-store');
    const session = SessionSchema.parse(await desktop.json());
    expect((await verifyAccessToken(bindings(), session.accessToken)).userId).toBe(USER);
    const browser = await login('/browser/password', password);
    expect(browser.status).toBe(200);
    const body = await browser.json();
    expect(body).toMatchObject({ user: { id: USER }, workspace: null });
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('refreshToken');
    const cookie = browser.headers.get('set-cookie')!;
    for (const attribute of ['__Host-rally-browser-global=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(cookie).toContain(attribute);
    const restored = await createApp().request('https://api.example.test/browser/session', { headers: { origin: ORIGIN, cookie: cookie.split(';')[0]! } }, bindings());
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ user: { id: USER } });
  });

  it('requires browser Origin and rejects public provisioning and other identity regions', async () => {
    const { password } = await provisionUserPassword(bindings(), USER);
    expect((await login('/browser/password', password, EMAIL, 'https://evil.example')).status).toBe(403);
    expect((await createApp().request('https://api.example.test/auth/password/provision', { method: 'POST' }, bindings())).status).toBe(401);
    await expect(passwordLogin({ ...bindings(), AVALON_REGION: 'enterprise' }, { email: EMAIL, password })).rejects.toMatchObject({ code: 'global_identity_required' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
  });

  it('shares ten attempts across hosts and email casing and restores the budget after one minute', async () => {
    const { password } = await provisionUserPassword(bindings(), USER);
    for (let i = 0; i < 10; i++) {
      expect((await login(i % 2 ? '/auth/password' : '/browser/password', 'incorrect', i % 2 ? EMAIL : ' REVIEWER@EXAMPLE.TEST ')).status).toBe(401);
    }
    expect((await login('/auth/password', password)).status).toBe(429);
    now += 60_000;
    vi.setSystemTime(now);
    expect((await login('/browser/password', password)).status).toBe(200);
    now += 60_000;
    vi.setSystemTime(now);
    await purgeExpiredPasswordLoginAttempts(bindings());
    expect(db.prepare('SELECT COUNT(*) AS n FROM password_login_attempts').get()).toEqual({ n: 0 });
  });

  it('rotation and revocation fence both old passwords and proofs already verified before the change', async () => {
    const first = await provisionUserPassword(bindings(), USER);
    const old = db.prepare('SELECT credential_id FROM user_password_credentials').get()!;
    const second = await provisionUserPassword(bindings(), USER);
    await expect(passwordLogin(bindings(), { email: EMAIL, password: first.password })).rejects.toMatchObject({ code: 'password_login_invalid' });
    await expect(new AuthService(bindings()).createPasswordIdentitySession(USER, String(old.credential_id))).rejects.toMatchObject({ code: 'password_login_invalid' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 0 });
    const valid = await passwordLogin(bindings(), { email: EMAIL, password: second.password });
    expect(valid.user.id).toBe(USER);
    const current = db.prepare('SELECT credential_id FROM user_password_credentials').get()!;
    expect(await revokeUserPassword(bindings(), USER)).toEqual({ userId: USER, passwordEnabled: false });
    await expect(new AuthService(bindings()).createPasswordIdentitySession(USER, String(current.credential_id))).rejects.toMatchObject({ code: 'password_login_invalid' });
    await expect(passwordLogin(bindings(), { email: EMAIL, password: second.password })).rejects.toMatchObject({ code: 'password_login_invalid' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
  });
});
