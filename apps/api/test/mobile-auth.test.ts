import { afterEach, beforeEach, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createApp } from '../src/app';
import { sha256 } from '../src/lib/crypto';
import { provisionUserPassword } from '../src/services/password-login-service';
import { AuthService } from '../src/services/auth-service';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const USER = '00000000-0000-7000-8000-00000000a921';
const ORIGIN = 'https://app.example.test';
const attemptId = 'a'.repeat(43), codeVerifier = 'v'.repeat(43);
let db: DatabaseSync;
let cookie: string;
function env() {
  return createTestEnv({ DB: sqliteD1(db), AVALON_REGION: 'global', APP_ENV: 'production',
    BROWSER_APP_ORIGIN: ORIGIN, ALLOWED_ORIGINS: ORIGIN, PUBLIC_API_BASE_URL: 'https://api.example.test',
    SESSION_SIGNING_KEY: 'mobile-test-signing-key', OAUTH_STATE_ENCRYPTION_KEY: 'mobile-test-encryption-key', LOG_LEVEL: 'error' });
}
function request(path: string, body?: unknown, browserCookie?: string, origin = ORIGIN) {
  return createApp().request(`https://api.example.test/browser/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(browserCookie ? { cookie: browserCookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env());
}
async function ticket() {
  const response = await request('mobile/handoff', { attemptId, codeChallenge: await sha256(codeVerifier) }, cookie);
  expect(response.status).toBe(200);
  return await response.json() as { ticket: string; region: string; attemptId: string };
}
beforeEach(async () => {
  db = migratedSqliteDatabase();
  const at = new Date().toISOString();
  db.prepare("INSERT INTO users (id,email,name,created_at,updated_at) VALUES (?,'mobile@example.test','Mobile Tester',?,?)").run(USER, at, at);
  db.prepare("INSERT INTO user_verified_emails (email,user_id,verified_at) VALUES ('mobile@example.test',?,?)").run(USER, at);
  const { password } = await provisionUserPassword(env(), USER);
  const signedIn = await request('password', { email: 'mobile@example.test', password });
  expect(signedIn.status).toBe(200);
  cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!;
});
afterEach(() => db.close());

function desktopExchange(body: unknown) {
  return createApp().request('https://api.example.test/auth/desktop/exchange', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }, env());
}

it('rejects mobile tickets at the bearer endpoint without consuming them', async () => {
  const proof = { ...await ticket(), codeVerifier };
  const rejected = await desktopExchange(proof);
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_login_ticket' } });
  expect(rejected.headers.get('set-cookie')).toBeNull();
  expect((await request('mobile/exchange', proof)).status).toBe(200);
});

it.each(['google', 'apple'] as const)('rejects %s desktop tickets at the cookie endpoint without consuming them', async (provider) => {
  const issued = await new AuthService(env()).issueLoginTicket({
    userId: USER, attemptId, codeChallenge: await sha256(codeVerifier), audience: 'desktop', provider,
  });
  const proof = { ...issued, codeVerifier };
  const rejected = await request('mobile/exchange', proof);
  expect(rejected.status).toBe(401);
  expect(await rejected.json()).toMatchObject({ error: { code: 'invalid_login_ticket' } });
  expect(rejected.headers.get('set-cookie')).toBeNull();
  const completed = await desktopExchange(proof);
  expect(completed.status).toBe(200);
  expect(await completed.json()).toMatchObject({ accessToken: expect.any(String), refreshToken: expect.any(String), user: { id: USER } });
});

it.each(['pending', 'consumed', 'expired'])('returns a named conflict for a repeated %s handoff attempt', async (state) => {
  const proof = { ...await ticket(), codeVerifier };
  if (state === 'consumed') expect((await request('mobile/exchange', proof)).status).toBe(200);
  if (state === 'expired') db.prepare("UPDATE desktop_login_tickets SET expires_at='2000-01-01T00:00:00.000Z'").run();
  const repeated = await request('mobile/handoff', { attemptId, codeChallenge: await sha256('w'.repeat(43)) }, cookie);
  expect(repeated.status).toBe(409);
  expect(await repeated.json()).toMatchObject({ error: { code: 'attempt_already_used' } });
  expect(db.prepare('SELECT COUNT(*) AS count FROM desktop_login_tickets').get()).toEqual({ count: 1 });
  if (state === 'pending') expect((await request('mobile/exchange', proof)).status).toBe(200);
  expect((await request('mobile/handoff', { attemptId: 'b'.repeat(43), codeChallenge: await sha256(codeVerifier) }, cookie)).status).toBe(200);
});

it('hands a separate WebView a single-use session cookie without returning bearer credentials', async () => {
  expect((await request('session')).status).toBe(401);
  const proof = { ...await ticket(), codeVerifier };
  const completed = await request('mobile/exchange', proof);
  expect(completed.status).toBe(200);
  expect(completed.headers.get('cache-control')).toBe('no-store');
  const body = await completed.json();
  expect(body).toMatchObject({ user: { id: USER, email: 'mobile@example.test' }, workspace: null });
  expect(body).not.toHaveProperty('accessToken');
  expect(body).not.toHaveProperty('refreshToken');
  const webCookie = completed.headers.get('set-cookie')!;
  for (const attribute of ['__Host-rally-browser-global=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) expect(webCookie).toContain(attribute);
  expect(webCookie.split(';')[0]).not.toBe(cookie);
  const restored = await request('session', undefined, webCookie.split(';')[0]);
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ user: { id: USER } });
  expect((await request('mobile/exchange', proof)).status).toBe(401);
  await request('logout', {}, webCookie.split(';')[0]);
  expect((await request('session', undefined, webCookie.split(';')[0])).status).toBe(401);
  expect((await request('session', undefined, cookie)).status).toBe(200);
});

it('binds the ticket to its attempt and region, then burns it on an incorrect verifier', async () => {
  const issued = await ticket();
  expect((await request('mobile/exchange', { ...issued, codeVerifier, attemptId: 'b'.repeat(43) })).status).toBe(401);
  expect((await request('mobile/exchange', { ...issued, codeVerifier, region: 'enterprise' })).status).toBe(409);
  expect((await request('mobile/exchange', { ...issued, codeVerifier: 'w'.repeat(43) })).status).toBe(401);
  expect((await request('mobile/exchange', { ...issued, codeVerifier })).status).toBe(401);
});

it('refuses expired handoffs without setting a cookie', async () => {
  const proof = { ...await ticket(), codeVerifier };
  db.prepare("UPDATE desktop_login_tickets SET expires_at='2000-01-01T00:00:00.000Z'").run();
  const response = await request('mobile/exchange', proof);
  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toBeNull();
});

it('requires an authenticated browser and same-origin requests on both handoff endpoints', async () => {
  const binding = { attemptId, codeChallenge: await sha256(codeVerifier) };
  expect((await request('mobile/handoff', binding)).status).toBe(401);
  expect((await request('mobile/handoff', binding, cookie, 'https://other.example')).status).toBe(403);
  expect((await request('mobile/handoff', { ...binding, codeChallenge: 'plain' }, cookie)).status).toBe(400);
  const proof = { ...await ticket(), codeVerifier };
  expect((await request('mobile/exchange', proof, undefined, 'https://other.example')).status).toBe(403);
  expect((await request('mobile/exchange', proof)).status).toBe(200);
});
