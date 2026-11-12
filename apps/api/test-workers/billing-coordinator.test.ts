import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { HonoAppEnv } from '../src/env';
import { billingAccount } from '../src/services/billing';
import { initializeOrganizationBilling } from '../src/services/billing-coordination';
import { stripeWebhookRoutes, billingRoutes } from '../src/routes/billing';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import { errorHandler } from '../src/middleware/errors';
import billingMigration from '../../../packages/db/migrations/0131_billing.sql?raw';
import signupMigration from '../../../packages/db/migrations/0132_signup_trials.sql?raw';
import usageMigration from '../../../packages/db/usage-migrations/0001_usage_ledger.sql?raw';

const ORG = '00000000-0000-7000-8000-00000000b111';
const config = JSON.stringify({ returnUrl: 'https://app.test', offers: [
  { id: 'start', name: 'Start', plan: 'starter', priceId: 'price_start', currencies: ['usd', 'eur'] },
  { id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'] },
] });
const testEnv = () => ({ ...env, BILLING_CONFIG: config, STRIPE_SECRET_KEY: 'sk_test_not_a_credential', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
const stub = () => env.BILLING_COORDINATORS.getByName(`global:billing:${ORG}`);
async function configureActor() {
  await runInDurableObject(stub(), (instance) => {
    // Configure the real actor with test-only provider credentials, without
    // enabling billing for unrelated workerd fixtures sharing Worker bindings.
    Object.defineProperty(instance, 'env', { value: testEnv(), configurable: true });
  });
}
beforeEach(async () => {
  await reset();
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, region TEXT, plan TEXT DEFAULT 'starter', created_at TEXT, updated_at TEXT, abandoned_at TEXT);
    CREATE TABLE IF NOT EXISTS workspace_members (workspace_id TEXT, user_id TEXT, status TEXT, access_class TEXT);
    CREATE TABLE IF NOT EXISTS workspace_invitations (workspace_id TEXT, revoked_at TEXT, accepted_at TEXT);`);
  if (!(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'billing_accounts'").first())) await env.DB.exec(billingMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  if (!(await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'billing_signup_trials'").first())) await env.DB.exec(signupMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await env.DB.prepare('DELETE FROM billing_signup_trials WHERE workspace_id = ?').bind(ORG).run();
  await env.USAGE_DB.exec(usageMigration.replaceAll('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ').replaceAll('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ').replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await env.DB.prepare('DELETE FROM billing_accounts WHERE workspace_id = ?').bind(ORG).run();
  await env.DB.prepare('DELETE FROM workspaces WHERE id = ?').bind(ORG).run();
  await env.DB.prepare("INSERT INTO workspaces(id, region, created_at) VALUES (?, 'global', '2026-01-01T00:00:00Z')").bind(ORG).run();
  await billingAccount(testEnv(), ORG);
  await env.DB.prepare("UPDATE billing_accounts SET customer_id = 'cus_1'").run();
  await configureActor();
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('serializes concurrent checkout without creating a second hosted session', async () => {
  await expect(Promise.resolve(stub().checkout(ORG, 'start', 'gbp', false))).rejects.toMatchObject({ code: 'billing_offer_unavailable' });
  let open: Record<string, unknown> | null = null;
  let created = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/subscriptions?')) return Response.json({ has_more: false, data: [] });
    if (url.includes('/checkout/sessions?')) return Response.json({ data: open ? [open] : [] });
    if (url.endsWith('/checkout/sessions')) {
      created++;
      const body = new URLSearchParams(String(init?.body));
      open = { id: 'cs_one', url: 'https://checkout.stripe.com/one', currency: 'usd', metadata: {
        offer_id: 'start', overage_enabled: 'false', trial_ends_at: body.get('metadata[trial_ends_at]'),
      } };
      return Response.json(open);
    }
    throw new Error(`Unexpected provider call: ${url}`);
  });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => stub().checkout(ORG, 'start', 'usd', false)));
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(results.some(result => result.status === 'rejected')).toBe(true);
  for (const result of results) {
    if (result.status === 'fulfilled') expect(result.value).toEqual({ url: 'https://checkout.stripe.com/one' });
    else expect(result.reason).toMatchObject({ code: 'billing_busy' });
  }
  expect(created).toBe(1);
  expect(await stub().checkout(ORG, 'start', 'usd', false)).toEqual({ url: 'https://checkout.stripe.com/one' });
  expect(created).toBe(1);
});

it('recovers an uncertain Stripe checkout after actor restart without leaving a persistent lock', async () => {
  let created = 0;
  let open: Record<string, unknown> | null = null;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/subscriptions?')) return Response.json({ has_more: false, data: [] });
    if (url.includes('/checkout/sessions?')) return Response.json({ data: open ? [open] : [] });
    if (url.endsWith('/checkout/sessions')) {
      created++;
      const body = new URLSearchParams(String(init?.body));
      open = { id: 'cs_recovered', url: 'https://checkout.stripe.com/recovered', currency: 'usd', metadata: {
        offer_id: 'start', overage_enabled: 'false', trial_ends_at: body.get('metadata[trial_ends_at]'),
      } };
      throw new Error('provider_response_lost');
    }
    throw new Error(`Unexpected provider call: ${url}`);
  });
  await expect(Promise.resolve(stub().checkout(ORG, 'start', 'usd', false))).rejects.toThrow('provider_response_lost');
  await expect(runInDurableObject(stub(), (_instance, state) => { state.abort('billing_test_restart'); })).rejects.toThrow('billing_test_restart'); await configureActor();
  expect(await stub().checkout(ORG, 'start', 'usd', false)).toEqual({ url: 'https://checkout.stripe.com/recovered' });
  expect(created).toBe(1);
});

async function signature(body: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('whsec_test'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)));
  return `t=${timestamp},v1=${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

it('dispatches only valid signed subscription webhooks through the real billing actor', async () => {
  const app = new Hono<HonoAppEnv>(); app.onError(errorHandler); app.route('/webhook', stripeWebhookRoutes);
  const provider = vi.fn(async () => Response.json({ id: 'sub_1', customer: 'cus_1', status: 'active', currency: 'usd',
    metadata: { offer_id: 'grow' }, items: { data: [{ price: { id: 'price_grow' } }] } }));
  vi.stubGlobal('fetch', provider);
  const body = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1' } } });
  const signed = await signature(body);
  const request = (payload: string, sig?: string) => app.request('/webhook', { method: 'POST', body: payload,
    headers: sig ? { 'stripe-signature': sig } : {} }, testEnv());
  expect((await request(body)).status).toBe(400);
  expect((await request(`${body} `, signed)).status).toBe(400);
  const malformed = JSON.stringify({ type: 'customer.subscription.updated', data: { object: { customer: 'cus_1' } } });
  expect((await request(malformed, await signature(malformed))).status).toBe(400);
  expect(provider).not.toHaveBeenCalled();
  expect(await env.DB.prepare('SELECT plan FROM workspaces').first()).toEqual({ plan: 'starter' });
  expect((await request(body, signed)).status).toBe(200);
  expect(await env.DB.prepare('SELECT plan FROM workspaces').first()).toEqual({ plan: 'growth' });
});


it('rejects oversized unsigned Stripe webhooks before buffering their full stream', async () => {
  const app = new Hono<HonoAppEnv>(); app.onError(errorHandler); app.route('/webhook', stripeWebhookRoutes);
  const provider = vi.fn(); vi.stubGlobal('fetch', provider);
  const configured = { ...testEnv(), PROVIDER_WEBHOOK_MAX_BYTES: '8' };
  expect((await app.request('/webhook', { method: 'POST', headers: { 'content-length': '9' }, body: '123456789' }, configured)).status).toBe(413);
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new TextEncoder().encode('123456789')); },
    cancel() { canceled = true; },
  });
  expect((await app.request('/webhook', { method: 'POST', body }, configured)).status).toBe(413);
  expect(canceled).toBe(true); expect(provider).not.toHaveBeenCalled();
});

it('creates a no-card signup trial through the actor and refreshes payment readiness from a signed customer webhook', async () => {
  const configured = { ...testEnv(), BILLING_CONFIG: JSON.stringify({ ...JSON.parse(config), automaticTax: true, enforceUsageLimits: true,
    signupTrial: { offerId: 'grow', currency: 'usd', months: 2, startsAt: new Date(Date.now() - 86400000).toISOString() } }) };
  await env.DB.prepare('UPDATE workspaces SET created_at = ? WHERE id = ?').bind(new Date().toISOString(), ORG).run();
  await runInDurableObject(stub(), instance => { Object.defineProperty(instance, 'env', { value: configured, configurable: true }); });
  let ready = false;
  let sub: { id: string; customer: string; status: string; currency: string; trial_end: number; cancel_at: number | null; metadata: Record<string, string>; items: { data: { price: { id: string; unit_amount: number } }[] } } | null = null;
  let creates = 0;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/prices/')) return Response.json({ recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
    if (url.includes('/subscriptions?')) return Response.json({ data: sub ? [sub] : [], has_more: false });
    if (url.includes('/customers/cus_1')) return Response.json({ invoice_settings: { default_payment_method: ready ? 'pm_card' : null }, tax: { automatic_tax: ready ? 'supported' : 'unrecognized_location' } });
    const fields = new URLSearchParams(String(init?.body ?? ''));
    if (url.endsWith('/subscriptions') && init?.method === 'POST') {
      creates++;
      sub = { id: 'sub_signup', customer: 'cus_1', status: 'trialing', currency: 'usd', trial_end: Number(fields.get('trial_end')), cancel_at: Number(fields.get('cancel_at')),
        metadata: Object.fromEntries([...fields].filter(([key]) => key.startsWith('metadata[')).map(([key, value]) => [key.slice(9, -1), value])),
        items: { data: [{ price: { id: 'price_grow', unit_amount: 10000 } }] } };
      return Response.json(sub);
    }
    if (url.endsWith('/subscriptions/sub_signup') && sub) {
      if (init?.method === 'POST') { sub.cancel_at = null; sub.metadata.signup_trial_conversion_pending = 'false'; }
      return Response.json(sub);
    }
    throw new Error(`Unexpected provider call: ${url}`);
  });
  expect(initializeOrganizationBilling(configured, ORG)).toBeUndefined();
  await expect.poll(async () => env.DB.prepare('SELECT status, payment_method_ready FROM billing_accounts WHERE workspace_id = ?').bind(ORG).first()).toEqual({ status: 'trialing', payment_method_ready: 0 });
  expect(await env.DB.prepare('SELECT plan FROM workspaces WHERE id = ?').bind(ORG).first()).toEqual({ plan: 'growth' });
  expect(await env.DB.prepare('SELECT subscription_id FROM billing_signup_trials WHERE workspace_id = ?').bind(ORG).first()).toEqual({ subscription_id: 'sub_signup' });
  await expect(Promise.resolve(stub().overages(ORG, true))).rejects.toMatchObject({ code: 'billing_overage_unavailable' });
  ready = true;
  const app = new Hono<HonoAppEnv>(); app.onError(errorHandler); app.route('/webhook', stripeWebhookRoutes);
  const body = JSON.stringify({ type: 'customer.updated', data: { object: { id: 'cus_1' } } });
  expect((await app.request('/webhook', { method: 'POST', body, headers: { 'stripe-signature': await signature(body) } }, configured)).status).toBe(200);
  expect(await env.DB.prepare('SELECT payment_method_ready FROM billing_accounts WHERE workspace_id = ?').bind(ORG).first()).toEqual({ payment_method_ready: 1 });
  expect(creates).toBe(1);
});


it('refreshes payment readiness for legacy billing settings through the actor', async () => {
  await env.DB.prepare("UPDATE billing_accounts SET subscription_id='sub_legacy', status='active', offer_id='grow', currency='usd'").run();
  const subscription = { id: 'sub_legacy', customer: 'cus_1', status: 'active', currency: 'usd', metadata: { offer_id: 'grow' }, items: { data: [{ price: { id: 'price_grow' } }] } };
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/customers/cus_1')) return Response.json({ invoice_settings: { default_payment_method: 'pm_card' } });
    if (url.includes('/subscriptions?')) return Response.json({ data: [subscription], has_more: false });
    throw new Error(`Unexpected provider call: ${url}`);
  });
  const app = new Hono<HonoAppEnv>(); app.onError(errorHandler);
  app.use('*', async (c, next) => { c.set('auth', { sessionId: 'session', userId: asUserId('01900000-0000-7000-8000-000000000001'), workspaceId: asWorkspaceId(ORG), region: 'global', role: 'owner' }); await next(); });
  app.route('/billing', billingRoutes);
  const response = await app.request('/billing', {}, testEnv());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ enabled: true, subscribed: true, paymentMethodReady: true });
});


it('keeps overage consent visible and revocable after the payment method is removed', async () => {
  const configured = { ...testEnv(), BILLING_CONFIG: JSON.stringify({ ...JSON.parse(config), enforceUsageLimits: true,
    offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'], overagePriceId: 'price_overage' }] }) };
  await runInDurableObject(stub(), instance => { Object.defineProperty(instance, 'env', { value: configured, configurable: true }); });
  await env.DB.prepare("UPDATE billing_accounts SET subscription_id='sub_legacy', status='active', offer_id='grow', currency='usd'").run();
  const subscription = { id: 'sub_legacy', customer: 'cus_1', status: 'active', currency: 'usd', metadata: { offer_id: 'grow', overage_enabled: 'true' }, items: { data: [{ price: { id: 'price_grow' } }] } };
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/customers/cus_1')) return Response.json({ invoice_settings: { default_payment_method: null } });
    if (url.includes('/subscriptions?')) return Response.json({ data: [subscription], has_more: false });
    if (url.endsWith('/subscriptions/sub_legacy') && init?.method === 'POST') {
      subscription.metadata.overage_enabled = new URLSearchParams(String(init.body)).get('metadata[overage_enabled]')!;
      return Response.json(subscription);
    }
    throw new Error(`Unexpected provider call: ${url}`);
  });
  const app = new Hono<HonoAppEnv>(); app.onError(errorHandler);
  app.use('*', async (c, next) => { c.set('auth', { sessionId: 'session', userId: asUserId('01900000-0000-7000-8000-000000000001'), workspaceId: asWorkspaceId(ORG), region: 'global', role: 'owner' }); await next(); });
  app.route('/billing', billingRoutes);
  const response = await app.request('/billing', {}, configured);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ paymentMethodReady: false, overageEnabled: true });
  expect(await env.DB.prepare('SELECT overage_started_at FROM billing_accounts WHERE workspace_id = ?').bind(ORG).first()).toEqual({ overage_started_at: null });
  const disabled = await app.request('/billing/overages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) }, configured);
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toEqual({ enabled: false });
});
