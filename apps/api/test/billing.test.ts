import type * as UsageMeteringModule from '../src/services/usage-metering';
import { z } from 'zod';
import { readOrganizationUsage } from '../src/services/usage-metering';
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
import { billingAccount, createCheckout, billClosedOverage, syncSubscription, refreshBillingAccount, withBillingLock, withOrganizationBillingClosure, settleBillingAccounts } from '../src/services/billing';
import { verifyStripeSignature, stripe } from '../src/services/stripe';
import { BillingConfigSchema } from '../src/services/billing-config';

const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
const workspace = '01900000-0000-7000-8000-0000000000aa';
function seed() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id, google_subject, email, name, created_at, updated_at) VALUES ('owner','owner','owner@example.test','Owner','2026-11-10','2026-11-10')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Test','test','global','owner','2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')").run(workspace);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,access_class,joined_at) VALUES (?,'owner','owner','active','member','2026-11-10T00:00:00Z')").run(workspace);
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
    db.prepare("UPDATE workspace_members SET status = 'active', joined_at = '2026-11-11T00:00:00Z' WHERE workspace_id = ?").run(workspace);
    expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2027-01-09T00:00:00Z') / 1000);
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2027-01-09T00:00:00Z') / 1000);
  });
  it('reuses pending checkout and sends organization quantity, tax and currency to Stripe', async () => {
    const { env } = seed();
    const requests: { url: string; body: URLSearchParams }[] = [];
    let open: Record<string, unknown> | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/subscriptions?')) return Response.json({ data: [], has_more: false });
      if (url.includes('/checkout/sessions?')) return Response.json({ data: open ? [open] : [] });
      const body = new URLSearchParams(String(init?.body ?? ''));
      requests.push({ url, body });
      if (url.endsWith('/customers')) return Response.json({ id: 'cus_1' });
      open = { id: 'cs_1', url: 'https://checkout.stripe.com/test', currency: body.get('currency'), metadata: {
        offer_id: body.get('metadata[offer_id]'), overage_enabled: body.get('metadata[overage_enabled]'), trial_ends_at: body.get('metadata[trial_ends_at]'),
      } };
      return Response.json(open);
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
  db.prepare("INSERT INTO billing_terms(subscription_id,workspace_id,customer_id,price_id,starts_at) VALUES ('sub_1',?,'cus_1','price_overage',unixepoch('2026-11-25'))").run(workspace);
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
    return Response.json(url.includes('/subscriptions?') ? { data: [], has_more: false } : {
      has_more: false, data: [{ id: 'cs_recovered', status: 'open', url: 'https://checkout.stripe.com/recovered', currency: 'usd', metadata: { offer_id: 'start', overage_enabled: 'false', trial_ends_at: String(Date.parse('2026-11-24') / 1000) } }],
    });
  }));
  expect(await createCheckout(env, workspace, 'start', 'usd', false)).toEqual({ url: 'https://checkout.stripe.com/recovered' });
  expect(db.prepare('SELECT subscription_id FROM billing_accounts').get()).toEqual({ subscription_id: null });
});

// The publisher crosses into a WorkspaceDO; these tests exercise the billing
// queries against real migrations, not the already-covered socket publisher.
vi.mock('../src/services/usage-metering', async (original) => ({
  ...await original<typeof UsageMeteringModule>(), publishOrganizationUsage: vi.fn(async () => undefined),
}));

function subscription(overrides: Record<string, unknown> = {}) {
  return { id: 'sub_1', customer: 'cus_1', status: 'active', currency: 'usd', ended_at: null, trial_end: null,
    metadata: { offer_id: 'grow', overage_enabled: 'false' }, items: { data: [{ price: { id: 'price_grow' } }] }, ...overrides };
}
async function accountFixture() {
  const fixture = seed();
  const config = JSON.parse(fixture.env.BILLING_CONFIG!);
  config.offers.push({ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'], overagePriceId: 'price_overage' });
  fixture.env.BILLING_CONFIG = JSON.stringify(config);
  await billingAccount(fixture.env, workspace);
  fixture.db.prepare("UPDATE billing_accounts SET customer_id = 'cus_1' WHERE workspace_id = ?").run(workspace);
  return fixture;
}
function addTeam(db: DatabaseSync, joined = '2026-11-23T00:00:00Z') {
  for (const id of ['two', 'three']) {
    db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id,id,`${id}@example.test`,id,joined,joined);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,access_class,joined_at) VALUES (?,?,'member','active','member',?)").run(workspace,id,joined);
  }
}

it('retains a day-13 team award through a day-15 read and later departure', async () => {
  const { db, env } = seed();
  addTeam(db);
  vi.setSystemTime(new Date('2026-11-25'));
  expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2027-01-09') / 1000);
  db.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = 'three'").run();
  expect((await billingAccount(env, workspace)).trial_extended).toBe(1);
});

it('persists the team award at membership transition before a later departure and read', async () => {
  const { db, env } = await accountFixture();
  addTeam(db);
  db.prepare("UPDATE workspace_members SET status = 'suspended' WHERE user_id = 'three'").run();
  vi.setSystemTime(new Date('2026-11-25'));
  expect((await billingAccount(env, workspace)).trial_ends_at).toBe(Date.parse('2027-01-09') / 1000);
});

it('expires checkout with stale trial terms and creates it with the earned extension', async () => {
  const { db, env } = await accountFixture();
  addTeam(db);
  const calls: { path: string; body: URLSearchParams }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/subscriptions?')) return Response.json({ data: [], has_more: false });
    if (url.includes('/checkout/sessions?')) return Response.json({ data: [{ id: 'cs_old', currency: 'usd', url: 'https://checkout.stripe.com/old',
      metadata: { offer_id: 'start', overage_enabled: 'false', trial_ends_at: String(Date.parse('2026-11-24') / 1000) } }] });
    calls.push({ path: url, body: new URLSearchParams(String(init?.body ?? '')) });
    return Response.json({ id: 'cs_new', url: 'https://checkout.stripe.com/new' });
  }));
  expect(await createCheckout(env, workspace, 'start', 'usd', false)).toEqual({ url: 'https://checkout.stripe.com/new' });
  expect(calls[0]!.path).toContain('/cs_old/expire');
  expect(calls[1]!.body.get('subscription_data[trial_end]')).toBe(String(Date.parse('2027-01-09') / 1000));
});

it('extends a trialing subscription even when the old hosted checkout completed first', async () => {
  const { db, env } = await accountFixture(); addTeam(db);
  const writes: URLSearchParams[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') { writes.push(new URLSearchParams(String(init.body))); return Response.json(subscription({ status: 'trialing', trial_end: Date.parse('2027-01-09') / 1000 })); }
    return Response.json(subscription({ status: 'trialing', trial_end: Date.parse('2026-11-24') / 1000 }));
  }));
  await syncSubscription(env, 'cus_1', 'sub_1');
  expect(writes[0]!.get('trial_end')).toBe(String(Date.parse('2027-01-09') / 1000));
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
});

it('recovers missed payment webhooks through the status read and downgrades terminal subscriptions', async () => {
  const { db, env } = await accountFixture();
  let current = subscription();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/subscriptions?') ? { data: [current], has_more: false } : current)));
  expect((await refreshBillingAccount(env, workspace)).status).toBe('active');
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
  current = subscription({ status: 'unpaid' });
  await syncSubscription(env, 'cus_1', 'sub_1');
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'starter' });
});

it.each(['canceled', 'incomplete_expired'])('allows fresh checkout after %s without letting an old event replace the new subscription', async (status) => {
  const { db, env } = await accountFixture();
  db.prepare('UPDATE billing_accounts SET subscription_id = ?, status = ?').run('sub_old', status);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/subscriptions?')) return Response.json({ data: [], has_more: false });
    if (url.includes('/checkout/sessions?')) return Response.json({ data: [] });
    return Response.json({ id: 'cs_new', url: 'https://checkout.stripe.com/new' });
  }));
  expect(await createCheckout(env, workspace, 'start', 'usd', false)).toEqual({ url: 'https://checkout.stripe.com/new' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(subscription({ id: 'sub_new' }))));
  await syncSubscription(env, 'cus_1', 'sub_new');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(subscription({ id: 'sub_old', status }))));
  await syncSubscription(env, 'cus_1', 'sub_old');
  expect(db.prepare('SELECT subscription_id FROM billing_accounts').get()).toEqual({ subscription_id: 'sub_new' });
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
});

it('selects offer metadata for a shared price and refuses an ambiguous price-only match', async () => {
  const { db, env } = await accountFixture();
  const config = JSON.parse(env.BILLING_CONFIG!); config.offers[1].priceId = 'price_start'; env.BILLING_CONFIG = JSON.stringify(config);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(subscription({ items: { data: [{ price: { id: 'price_start' } }] } }))));
  await syncSubscription(env, 'cus_1', 'sub_1');
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(subscription({ metadata: {}, items: { data: [{ price: { id: 'price_start' } }] } }))));
  await expect(syncSubscription(env, 'cus_1', 'sub_1')).rejects.toMatchObject({ code: 'billing_offer_ambiguous' });
});

it('acknowledges unknown Stripe customers without provider calls', async () => {
  const { env } = seed(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(syncSubscription(env, 'cus_other_product', 'sub_other')).resolves.toBeUndefined();
  expect(fetcher).not.toHaveBeenCalled();
});

it('does not steal ownership from a slow operation after the former five-minute deadline', async () => {
  const { env } = await accountFixture();
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const owner = withBillingLock(env, workspace, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
  await started; vi.setSystemTime(new Date('2027-01-01'));
  await expect(withBillingLock(env, workspace, async () => 'stolen')).rejects.toMatchObject({ code: 'billing_busy' });
  release(); await owner;
  await expect(withBillingLock(env, workspace, async () => 'released')).resolves.toBe('released');
});

it('blocks closing an organization with a live subscription', async () => {
  const { env } = await accountFixture(); const close = vi.fn(async () => 'closed');
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [subscription()], has_more: false })));
  await expect(withOrganizationBillingClosure(env, workspace, close)).rejects.toMatchObject({ code: 'billing_closure_blocked' });
  expect(close).not.toHaveBeenCalled();
});

it('shows overage enabled only after a subscription is active and consent has started', async () => {
  const { db, env } = await accountFixture();
  db.prepare("UPDATE billing_accounts SET overage_enabled = 1, status = 'none'").run();
  expect((await readOrganizationUsage(env, workspace, Date.now()))!.overage.billingEnabled).toBe(false);
  db.prepare("UPDATE billing_accounts SET status = 'active', overage_started_at = unixepoch('2026-11-11')").run();
  expect((await readOrganizationUsage(env, workspace, Date.now()))!.overage.billingEnabled).toBe(true);
});

it('logs safe Stripe error diagnostics without the provider message or arbitrary metadata keys', async () => {
  const { env } = seed();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', param: 'price', message: 'secret customer data' } }, { status: 400 })));
  await expect(stripe(env, 'invoiceitems', z.object({ id: z.string() }), { price: 'price_wrong' })).rejects.toMatchObject({ diagnosticCode: 'stripe_http_400:invalid_request_error:resource_missing:price' });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { type: 'invalid_request_error', code: 'resource_missing', param: 'metadata[secret_customer]' } }, { status: 400 })));
  await expect(stripe(env, 'invoiceitems', z.object({ id: z.string() }), { price: 'price_wrong' })).rejects.toMatchObject({ diagnosticCode: 'stripe_http_400:invalid_request_error:resource_missing' });
});

it('settles pre-cancellation usage through a final invoice and excludes later usage', async () => {
  const { db, usage, env } = await accountFixture();
  db.prepare(`INSERT INTO billing_terms(subscription_id,workspace_id,customer_id,price_id,starts_at,ends_at,cutoff_quota_microusd)
    VALUES ('sub_1',?,'cus_1','price_overage',unixepoch('2026-11-25'),NULL,NULL)`).run(workspace);
  db.prepare("UPDATE billing_accounts SET subscription_id = 'sub_1', status = 'active', overage_enabled = 1, overage_started_at = unixepoch('2026-11-25')").run();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(subscription({ status: 'canceled', ended_at: Date.parse('2027-01-15') / 1000 }))));
  await syncSubscription(env, 'cus_1', 'sub_1');
  expect(db.prepare('SELECT ends_at,cutoff_quota_microusd FROM billing_terms').get()).toEqual({ ends_at: Date.parse('2027-01-15') / 1000, cutoff_quota_microusd: 10000000 });
  const { applyUsageBatch } = await import('../src/services/usage-metering');
  for (const [id, at, cost] of [['before', '2026-12-15T12:00:00.000Z', 300000000], ['tail', '2027-01-12T12:00:00.000Z', 300000000], ['after', '2027-01-16T12:00:00.000Z', 500000000]] as const) {
    await applyUsageBatch(env, [{ v: 1, eventId: id, workspaceId: workspace, region: 'global', activity: 'agent_run', occurredAt: at, costMicrousd: cost, model: null, refs: {} }], at);
  }
  vi.setSystemTime(new Date('2027-01-30'));
  let finalized = false;
  const quantities: string[] = [];
  const seen: { url: string; body: URLSearchParams }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? '')); seen.push({ url, body });
    if (url.includes('?')) return Response.json({ data: [], has_more: false });
    if (url.endsWith('/invoiceitems')) { quantities.push(body.get('quantity')!); return Response.json({ id: `ii_${quantities.length}` }); }
    if (url.includes('/subscriptions/')) return Response.json(subscription({ status: 'canceled', default_payment_method: 'pm_saved' }));
    if (url.endsWith('/invoices')) return Response.json({ id: 'in_final' });
    if (url.endsWith('/finalize')) { finalized = true; return Response.json({ id: 'in_final' }); }
    return Response.json({ status: finalized ? 'open' : 'draft' });
  }));
  await settleBillingAccounts(env);
  await settleBillingAccounts(env);
  expect(quantities).toEqual(['290000000', '290000000']);
  expect(finalized).toBe(true);
  expect(seen.filter((r) => r.url.endsWith('/invoices'))).toHaveLength(1);
  expect(seen.find((r) => r.url.endsWith('/invoices'))!.body.get('default_payment_method')).toBe('pm_saved');
  expect(seen.filter((r) => r.url.endsWith('/invoiceitems')).every((r) => !r.body.has('subscription'))).toBe(true);
  expect(seen.find((r) => r.url.includes('invoiceitems?'))!.url).toContain('created[gte]=');
  expect(usage.prepare('SELECT COUNT(*) AS count FROM usage_events').get()).toEqual({ count: 3 });
});

it('continues settlement after another organization has a held billing claim', async () => {
  const { db, env } = await accountFixture();
  const other = '01900000-0000-7000-8000-0000000000bb';
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Other','other','global','owner','2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')").run(other);
  await billingAccount(env, other);
  for (const id of [workspace, other]) db.prepare("INSERT INTO billing_terms(subscription_id,workspace_id,customer_id,price_id,starts_at) VALUES (?,?,'cus_1','price_overage',unixepoch('2026-11-25'))").run(`sub_${id}`,id);
  db.prepare("UPDATE billing_accounts SET sync_token = 'held' WHERE workspace_id = ?").run(workspace);
  vi.setSystemTime(new Date('2027-01-30'));
  await settleBillingAccounts(env);
  expect(db.prepare('SELECT workspace_id,invoice_item_id FROM billing_overages').all()).toEqual([{ workspace_id: other, invoice_item_id: 'zero' }]);
});

it('refuses closure while an uncompleted checkout could still create a subscription', async () => {
  const { env } = await accountFixture(); const close = vi.fn(async () => 'closed');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('/subscriptions?') ? { data: [], has_more: false } : {
    data: [{ id: 'cs_open', url: 'https://checkout.stripe.com/open', currency: 'usd', metadata: {} }],
  })));
  await expect(withOrganizationBillingClosure(env, workspace, close)).rejects.toMatchObject({ code: 'billing_closure_blocked' });
  expect(close).not.toHaveBeenCalled();
});
