import { AccountOnboardingService } from '../src/services/account-onboarding-service';
import { Hono } from 'hono';
import { asUserId } from '@rally/contracts';
import type { HonoAppEnv } from '../src/env';
import { onboardingRoutes } from '../src/routes/onboarding';
import { createApp } from '../src/app';
import { resolveVerifiedEmailIdentity } from '../src/services/login-identity-service';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { newId } from '@rally/db';
import { TelemetryEnvelopeSchema } from '@rally/contracts/telemetry';
import { AuthService } from '../src/services/auth-service';
import { openEmailLoginSecret, redeemEmailLogin, startEmailLogin } from '../src/services/email-login-service';
import { observeSignup, observeSignupProgress, queueSignupIdentityTransition } from '../src/telemetry/signup';
import { createTestD1Database, createTestEnv } from './helpers/cloudflare-test';
import { drainWaitUntil } from './helpers/cloudflare-workers';
import { migratedObservabilityFixture, sqliteD1 } from './helpers/sqlite-d1';

let db: DatabaseSync;
beforeEach(() => { db = migratedObservabilityFixture(); });
afterEach(async () => { await drainWaitUntil(); db.close(); });
function bindings() {
  return createTestEnv({ DB: sqliteD1(db), TELEMETRY_DB: sqliteD1(db), APP_ENV: 'production', AVALON_REGION: 'global',
    LOG_LEVEL: 'error', SESSION_SIGNING_KEY: 'signup-test-signing-key', OAUTH_STATE_ENCRYPTION_KEY: 'signup-test-encryption-key',
    BROWSER_APP_ORIGIN: 'https://app.example.test', ALLOWED_ORIGINS: 'https://app.example.test', PUBLIC_API_BASE_URL: 'https://api.example.test', RESEND_FROM_EMAIL: 'Rally <login@example.test>',
    EMAIL_LOGIN_POLICY_JSON: '{"otpDigits":6,"ttlSeconds":600,"maxFailedAttempts":3}' });
}
// Each stage is accepted in its own deferred write, and stages emitted together
// (started and email submitted, authenticated and account created) race to the
// table. Read them back in funnel order; repeats of a stage keep their row order.
const funnel = ['signup_viewed', 'signup_started', 'signup_email_submitted', 'signup_verification_requested',
  'signup_verification_completed', 'authentication_completed', 'signup_account_created', 'signup_organization_requested',
  'signup_organization_ready', 'signup_onboarding_completed', 'signup_completed', 'signup_failed'];
function events() {
  return db.prepare('SELECT envelope_json FROM telemetry_accepted_events ORDER BY rowid').all()
    .map(row => TelemetryEnvelopeSchema.parse(JSON.parse(String(row.envelope_json))))
    .sort((a, b) => funnel.indexOf(a.name) - funnel.indexOf(b.name));
}
async function emailSignup(clientPlatform: 'browser' | 'desktop' = 'browser') {
  const env = bindings();
  const flowId = newId();
  const challengeId = crypto.randomUUID();
  observeSignup(env, { flowId, clientPlatform }, 'signup_viewed', 'unknown');
  await startEmailLogin(env, { challengeId, email: 'new@example.test', signupFlowId: flowId }, clientPlatform);
  const row = db.prepare('SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?').get(challengeId)!;
  const payload = await openEmailLoginSecret(env, challengeId, String(row.delivery_payload_encrypted)) as { text: string };
  const credential = /code is (\d+)\./u.exec(payload.text)![1]!;
  const input = { challengeId, redemptionId: crypto.randomUUID(), credential, method: 'otp' as const };
  const receipt = await redeemEmailLogin(env, input, clientPlatform);
  const session = await new AuthService(env).resumeEmailLogin(receipt, clientPlatform);
  await drainWaitUntil();
  return { env, flowId, session, input };
}

describe('complete signup analytics', () => {
  it.each(['new_organization', 'existing_organization'] as const)('completes %s only after organization access, with one occurrence per stage on retries', async signupPath => {
    const { env, flowId, session, input } = await emailSignup();
    expect(events().map(event => event.name)).toEqual(['signup_viewed', 'signup_started', 'signup_email_submitted',
      'signup_verification_requested', 'signup_verification_completed', 'authentication_completed', 'signup_account_created']);
    expect(db.prepare('SELECT signup_flow_id,signup_completed_at FROM users WHERE id=?').get(session.user.id))
      .toEqual({ signup_flow_id: flowId, signup_completed_at: null });
    observeSignupProgress(env, session.user.id, 'signup_organization_requested', signupPath, 'browser');
    await drainWaitUntil();
    expect(events().some(event => event.name === 'signup_completed')).toBe(false);
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', signupPath, 'browser');
    await drainWaitUntil();
    await new AuthService(env).resumeEmailLogin(await redeemEmailLogin(env, input, 'browser'), 'browser');
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', signupPath, 'browser');
    await drainWaitUntil();
    expect(events().map(event => event.name)).toEqual(['signup_viewed', 'signup_started', 'signup_email_submitted',
      'signup_verification_requested', 'signup_verification_completed', 'authentication_completed', 'signup_account_created',
      'signup_organization_requested', 'signup_organization_ready', 'signup_completed']);
    expect(events().at(-1)).toMatchObject({ source: 'api', identityScope: 'anonymous-epoch',
      properties: { flowId, clientPlatform: 'browser', entryPlatform: 'browser', accountStatus: 'new', signupPath, result: 'success' } });
    expect(JSON.stringify(events())).not.toContain('new@example.test');
    expect(JSON.stringify(events())).not.toContain(input.credential);
  });

  it('merges a new account\'s signup flow into its analytics person once, carrying its email', async () => {
    const { env, flowId, session, input } = await emailSignup();
    await new AuthService(env).resumeEmailLogin(await redeemEmailLogin(env, input, 'browser'), 'browser');
    await drainWaitUntil();
    const person = db.prepare('SELECT analytics_person_id FROM users WHERE id=?').get(session.user.id)!.analytics_person_id;
    expect(person).toEqual(expect.any(String));
    expect(db.prepare(`SELECT subject_user_id, destination_analytics_id, anonymous_epoch_id, properties_json, state
      FROM telemetry_profile_jobs WHERE job_kind='epoch_transition'`).all()).toEqual([{
      subject_user_id: session.user.id, destination_analytics_id: person, anonymous_epoch_id: flowId,
      properties_json: JSON.stringify({ email: 'new@example.test', name: 'new@example.test' }), state: 'pending',
    }]);
  });

  it('merges a signup flow shared by two new accounts into the first account only', async () => {
    const env = bindings();
    const flow = { flowId: newId(), clientPlatform: 'browser' as const };
    const first = (await resolveVerifiedEmailIdentity(env.DB, 'first@example.test', flow)).id;
    const second = (await resolveVerifiedEmailIdentity(env.DB, 'second@example.test', flow)).id;
    await queueSignupIdentityTransition(env, first);
    await queueSignupIdentityTransition(env, second);
    expect(db.prepare(`SELECT subject_user_id, anonymous_epoch_id FROM telemetry_profile_jobs
      WHERE job_kind='epoch_transition'`).all()).toEqual([{ subject_user_id: first, anonymous_epoch_id: flow.flowId }]);
  });

  it('records browser verification and authentication for a desktop-issued magic link', async () => {
    const env = bindings();
    const challengeId = crypto.randomUUID();
    await startEmailLogin(env, { challengeId, email: 'cross@example.test' }, 'desktop');
    const row = db.prepare('SELECT delivery_payload_encrypted FROM email_login_challenges WHERE id=?').get(challengeId)!;
    const payload = await openEmailLoginSecret(env, challengeId, String(row.delivery_payload_encrypted)) as { text: string };
    const link = new URL(payload.text.match(/https:\/\/[^\s]+/u)![0]);
    const credential = new URLSearchParams(link.hash.slice(1)).get('token')!;
    const response = await createApp().request('https://api.example.test/browser/email/redeem', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId, redemptionId: crypto.randomUUID(), method: 'magic', credential }),
    }, env);
    expect(response.status, await response.clone().text()).toBe(200);
    await drainWaitUntil();
    const stages = events().filter(event => ['signup_verification_requested', 'signup_verification_completed', 'authentication_completed', 'signup_account_created'].includes(event.name));
    expect(stages.map(event => event.name)).toEqual(['signup_verification_requested', 'signup_verification_completed', 'authentication_completed', 'signup_account_created']);
    for (const event of stages) expect(event.properties).toMatchObject({ clientPlatform: 'browser', entryPlatform: 'desktop' });
  });

  it('labels a browser organization activation request at the shared onboarding route', async () => {
    const { env, session } = await emailSignup('desktop');
    const app = new Hono<HonoAppEnv>();
    app.use('*', async (c, next) => {
      c.set('auth', { userId: asUserId(session.user.id), sessionId: 'test', workspaceId: null, region: 'global', role: null });
      await next();
    });
    app.route('/onboarding', onboardingRoutes);
    // A nonexistent organization cannot activate, but its observed request
    // must still identify the browser at this shared route boundary.
    const response = await app.request('/onboarding/workspace/activate', {
      method: 'POST', headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ region: 'global', workspaceId: newId() }),
    }, env);
    expect(response.ok).toBe(false);
    await drainWaitUntil();
    expect(events().filter(event => event.name === 'signup_organization_requested')).toMatchObject([
      { properties: { clientPlatform: 'browser', entryPlatform: 'desktop', signupPath: 'existing_organization' } },
    ]);
  });

  it('observes introduction only on its committed transition, not profile saves or replays', async () => {
    const { env, session } = await emailSignup();
    const service = new AccountOnboardingService(env, { userId: asUserId(session.user.id), sessionId: 'test', workspaceId: null, region: 'global', role: null });
    db.prepare('UPDATE users SET onboarding_eligible=1 WHERE id=?').run(session.user.id);
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', 'existing_organization', 'browser');
    await drainWaitUntil();
    let observations = 0;
    const observe = () => {
      observations++;
      observeSignupProgress(env, session.user.id, 'signup_onboarding_completed', undefined, 'browser');
    };
    await service.update({ expectedRevision: 0, introduced: true }, observe);
    await drainWaitUntil();
    await service.update({ expectedRevision: 0, introduced: true }, observe);
    await service.update({ expectedRevision: 1, introduced: true }, observe);
    expect(observations).toBe(1);
    await drainWaitUntil();
    expect(events().filter(event => event.name === 'signup_onboarding_completed')).toHaveLength(1);
  });

  it('preserves an introduction observer that starts after overlapping readiness has completed', async () => {
    const { env, session } = await emailSignup('desktop');
    db.prepare('UPDATE users SET onboarding_eligible=1,onboarding_introduced=1 WHERE id=?').run(session.user.id);
    // The profile commit can precede readiness, while the account request is
    // suspended before scheduling its observer. Drain readiness first to
    // deterministically exercise the late observer rather than a likely race.
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', 'new_organization', 'desktop');
    await drainWaitUntil();
    expect(events().filter(event => event.name === 'signup_completed')).toHaveLength(1);
    observeSignupProgress(env, session.user.id, 'signup_onboarding_completed', undefined, 'browser');
    observeSignupProgress(env, session.user.id, 'signup_onboarding_completed', undefined, 'browser');
    await drainWaitUntil();
    expect(events().filter(event => event.name === 'signup_onboarding_completed')).toMatchObject([
      { properties: { clientPlatform: 'browser', entryPlatform: 'desktop' } },
    ]);
    expect(events().filter(event => event.name === 'signup_completed')).toHaveLength(1);
  });

  it('waits for required onboarding and records the current platform separately from the entry platform', async () => {
    const { env, session } = await emailSignup('desktop');
    db.prepare('UPDATE users SET onboarding_eligible=1 WHERE id=?').run(session.user.id);
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', 'existing_organization', 'browser');
    await drainWaitUntil();
    expect(events().some(event => event.name === 'signup_completed')).toBe(false);
    db.prepare('UPDATE users SET onboarding_introduced=1 WHERE id=?').run(session.user.id);
    observeSignupProgress(env, session.user.id, 'signup_onboarding_completed', undefined, 'browser');
    await drainWaitUntil();
    expect(events().slice(-2).map(event => event.name)).toEqual(['signup_onboarding_completed', 'signup_completed']);
    expect(events().at(-1)?.properties).toMatchObject({ clientPlatform: 'browser', entryPlatform: 'desktop', signupPath: 'existing_organization' });
  });

  it('completes once when organization readiness and profile introduction overlap', async () => {
    const { env, session } = await emailSignup('desktop');
    db.prepare('UPDATE users SET onboarding_eligible=1 WHERE id=?').run(session.user.id);
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', 'new_organization', 'desktop');
    // The authoritative profile mutation commits while the readiness observer
    // is still waiting on its first read. Neither observer may use that stale
    // read to decide completion.
    db.prepare('UPDATE users SET onboarding_introduced=1 WHERE id=?').run(session.user.id);
    observeSignupProgress(env, session.user.id, 'signup_onboarding_completed', undefined, 'desktop');
    await drainWaitUntil();
    expect(events().filter(event => event.name === 'signup_completed')).toHaveLength(1);
    expect(events().filter(event => event.name === 'signup_onboarding_completed')).toHaveLength(1);
    expect(events().at(-1)).toMatchObject({ name: 'signup_completed', properties: { signupPath: 'new_organization' } });
  });

  it('suppresses known-account signup stages after analytics opt-out and tolerates a failed telemetry binding', async () => {
    const { env, session } = await emailSignup();
    const before = events().length;
    db.prepare('UPDATE users SET product_analytics_enabled=0 WHERE id=?').run(session.user.id);
    observeSignupProgress(env, session.user.id, 'signup_organization_ready', 'existing_organization', 'browser');
    await drainWaitUntil();
    expect(events()).toHaveLength(before);
    const unavailable = { ...env, TELEMETRY_DB: createTestD1Database({ prepare: () => { throw new Error('telemetry unavailable'); } }) };
    await expect(startEmailLogin(unavailable, { challengeId: crypto.randomUUID(), email: 'another@example.test' }))
      .resolves.toMatchObject({ challengeId: expect.any(String) });
    await drainWaitUntil();
  });

  it('authenticates a returning user with no signup lineage without counting a new account', async () => {
    const env = bindings();
    const existingId = (await resolveVerifiedEmailIdentity(env.DB, 'new@example.test')).id;
    const { session, flowId } = await emailSignup();
    expect(session.user.id).toBe(existingId);
    expect(events().map(event => event.name)).toEqual(['signup_viewed', 'signup_started', 'signup_email_submitted',
      'signup_verification_requested', 'signup_verification_completed', 'authentication_completed']);
    expect(events().at(-1)).toMatchObject({ properties: { flowId, accountStatus: 'existing' } });
    expect(db.prepare('SELECT signup_flow_id FROM users WHERE id=?').get(existingId)).toEqual({ signup_flow_id: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM telemetry_profile_jobs WHERE job_kind='epoch_transition'").get()).toEqual({ count: 0 });
  });

  it('records rejected verification and excludes returning accounts from signup completion', async () => {
    const { env, session } = await emailSignup();
    const challengeId = crypto.randomUUID();
    await startEmailLogin(env, { challengeId, email: 'new@example.test' });
    await expect(redeemEmailLogin(env, { challengeId, redemptionId: crypto.randomUUID(), credential: 'incorrect', method: 'otp' }, 'browser'))
      .rejects.toMatchObject({ code: 'email_login_invalid' });
    await drainWaitUntil();
    expect(events().at(-1)).toMatchObject({ name: 'signup_failed', properties: { method: 'otp', result: 'failed' } });
    const otherFlow = newId();
    const user = (await resolveVerifiedEmailIdentity(env.DB, 'new@example.test', { flowId: otherFlow, clientPlatform: 'desktop' })).id;
    expect(user).toBe(session.user.id);
    expect(db.prepare('SELECT signup_flow_id FROM users WHERE id=?').get(user)?.signup_flow_id).not.toBe(otherFlow);
  });
});
