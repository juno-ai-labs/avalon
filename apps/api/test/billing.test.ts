import { Hono } from 'hono';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { HonoAppEnv } from '../src/env';
import { billingRoutes } from '../src/routes/billing';
import { errorHandler } from '../src/middleware/errors';
import '../../../tests/isolated-region';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';
import { billingAccount, createCheckout, billClosedOverage } from '../src/services/billing';
import { verifyStripeSignature } from '../src/services/stripe';
import { BillingConfigSchema } from '../src/services/billing-config';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const workspace = '01900000-0000-7000-8000-0000000000aa';
function seed() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id, google_subject, email, name, created_at, updated_at) VALUES ('owner','owner','owner@example.test','Owner','2026-11-10','2026-11-10')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Test','test','global','owner','2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')").run(workspace);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,access_class) VALUES (?,'owner','owner','active','member')").run(workspace);
  const env = createTestEnv({ DB: sqliteD1(db), USAGE_DB: sqliteD1(usage), AVALON_REGION: 'global', STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify({ returnUrl: 'https://app.example.test', offers: [{ id: 'start', name: 'Start', plan: 'starter', priceId: 'price_start', currencies: ['usd', 'eur'] }] }) });
  return { db, usage, env };
}

describe('organization billing', () => {
  it('starts a no-card trial once and awards the team extension only for active members', async () => {
    const { db, env } = seed();
    expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2026-11-24T00:00:00Z') / 1000);
    for (const id of ['two', 'three']) {
      db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id,id,`${id}@example.test`,id,'2026-11-10','2026-11-10');
      db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,access_class) VALUES (?,?,'member','invited','member')").run(workspace,id);
    }
    expect((await billingAccount(env, workspace)).trial_extended).toBe(0);
    db.prepare("UPDATE workspace_members SET status = 'active' WHERE workspace_id = ?").run(workspace);
    expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2027-01-09T00:00:00Z') / 1000);
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2027-01-09T00:00:00Z') / 1000);
  });
  it('reuses pending checkout and sends organization quantity, tax and currency to Stripe', async () => {
    const { env } = seed();
    const requests: { url: string; body: URLSearchParams }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('?customer=')) return Response.json({ data: [], has_more: false });
      requests.push({ url, body: new URLSearchParams(String(init?.body ?? '')) });
      return Response.json(url.endsWith('/customers') ? { id: 'cus_1' } : url.endsWith('/checkout/sessions') ? { id: 'cs_1', url: 'https://checkout.stripe.com/test' } : { status: 'open', url: 'https://checkout.stripe.com/test' });
    }));
    await createCheckout(env, workspace, 'start', 'eur', false);
    expect(requests[1]!.body.get('line_items[0][quantity]')).toBe('1');
    expect(requests[1]!.body.get('currency')).toBe('eur');
    expect(requests[1]!.body.get('automatic_tax[enabled]')).toBe('true');
    expect(requests[1]!.body.get('allow_promotion_codes')).toBe('true');
    expect(await createCheckout(env, workspace, 'start', 'eur', false)).toEqual({ url: 'https://checkout.stripe.com/test' });
    expect(requests.filter((r) => r.url.endsWith('/checkout/sessions'))).toHaveLength(1);
    await expect(createCheckout(env, workspace, 'start', 'usd', false)).rejects.toMatchObject({ code: 'billing_checkout_pending' });
  });
  it('rejects client prices, unsupported currency and unconfigured overages before Stripe', async () => {
    const { env } = seed();
    await expect(createCheckout(env, workspace, 'price_evil', 'usd', false)).rejects.toMatchObject({ code: 'billing_offer_unavailable' });
    await expect(createCheckout(env, workspace, 'start', 'gbp', false)).rejects.toMatchObject({ code: 'billing_offer_unavailable' });
    await expect(createCheckout(env, workspace, 'start', 'usd', true)).rejects.toMatchObject({ code: 'billing_overage_unavailable' });
  });
});

it('verifies raw webhook signatures including rotated keys and rejects tampering and replay', async () => {
  const body = '{"type":"test"}'; const timestamp = '1804896000'; const secret = 'whsec_test';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const header = `t=${timestamp},v1=${'0'.repeat(64)},v1=${signature}`;
  expect(await verifyStripeSignature(body, header, secret, Number(timestamp) * 1000)).toBe(true);
  expect(await verifyStripeSignature(body + ' ', header, secret, Number(timestamp) * 1000)).toBe(false);
  expect(await verifyStripeSignature(body, header, secret, (Number(timestamp) + 301) * 1000)).toBe(false);
});

it('rejects duplicate offer IDs and insecure return URLs', () => {
  const offer = { id: 'start', name: 'Start', plan: 'starter', priceId: 'price_1', currencies: ['usd'] };
  expect(BillingConfigSchema.safeParse({ returnUrl: 'http://example.test', offers: [offer] }).success).toBe(false);
  expect(BillingConfigSchema.safeParse({ returnUrl: 'https://example.test', offers: [offer, offer] }).success).toBe(false);
});

it('settles closed opted-in periods once and excludes usage before consent', async () => {
  const { db, usage, env } = seed();
  await billingAccount(env, workspace);
  const config = JSON.parse(env.BILLING_CONFIG!);
  config.offers[0].overagePriceId = 'price_overage';
  env.BILLING_CONFIG = JSON.stringify(config);
  db.prepare(`UPDATE billing_accounts SET customer_id = 'cus_1', subscription_id = 'sub_1',
    status = 'active', offer_id = 'start', currency = 'usd', overage_enabled = 1,
    overage_started_at = unixepoch('2026-11-25') WHERE workspace_id = ?`).run(workspace);
  usage.prepare(`INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd)
    VALUES (?, '2026-12-15T00:00:00.000Z', '2026-12-10T00:00:00.000Z', 200000000, 300000000, 0)`).run(workspace);
  const writes: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { writes.push(new URLSearchParams(String(init.body))); return Response.json({ id: 'ii_1' }); }
    return Response.json({ data: [], has_more: false });
  }));
  await billClosedOverage(env, workspace, Date.parse('2027-01-30'));
  await billClosedOverage(env, workspace, Date.parse('2027-01-30'));
  expect(writes).toHaveLength(1);
  expect(writes[0]!.get('quantity')).toBe('100000000');
  expect(db.prepare('SELECT period_start, invoice_item_id FROM billing_overages').all()).toEqual([
    { period_start: '2026-12-10T00:00:00.000Z', invoice_item_id: 'ii_1' },
  ]);
});

it.each(['member', 'support'] as const)('refuses billing access for %s sessions before reaching Stripe', async (kind) => {
  const { env } = seed();
  const app = new Hono<HonoAppEnv>();
  app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('auth', { sessionId: 'session', userId: asUserId('01900000-0000-7000-8000-000000000001'), workspaceId: asWorkspaceId(workspace), region: 'global',
      role: kind === 'member' ? 'member' : 'owner', ...(kind === 'support' ? { impersonatorUserId: asUserId('01900000-0000-7000-8000-000000000002') } : {}) });
    await next();
  });
  app.route('/billing', billingRoutes);
  const response = await app.request('/billing/portal', { method: 'POST' }, env);
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: kind === 'member' ? 'workspace_admin_required' : 'support_session_not_allowed' } });
});

it('recovers an open Stripe checkout when the local session receipt was lost', async () => {
  const { db, env } = seed();
  await billingAccount(env, workspace);
  db.prepare("UPDATE billing_accounts SET customer_id = 'cus_1' WHERE workspace_id = ?").run(workspace);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') throw new Error('A second checkout must not be created');
    return Response.json(url.includes('/subscriptions?') ? { data: [] } : {
      has_more: false, data: [{ id: 'cs_recovered', status: 'open', url: 'https://checkout.stripe.com/recovered', currency: 'usd', metadata: { offer_id: 'start', overage_enabled: 'false' } }],
    });
  }));
  expect(await createCheckout(env, workspace, 'start', 'usd', false)).toEqual({ url: 'https://checkout.stripe.com/recovered' });
  expect(db.prepare('SELECT checkout_id FROM billing_accounts').get()).toEqual({ checkout_id: 'cs_recovered' });
});
