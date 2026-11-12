import '../../../tests/isolated-region';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { asUserId, asWorkspaceId } from '@rally/contracts';
import type { HonoAppEnv } from '../src/env';
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';
import { billingAccount, billClosedOverage, createCheckout, syncSubscription } from '../src/services/billing';
import { expireOverageCredit, grantOverageCredit, readOverageCredits } from '../src/services/overage-credits';
import { reportMeteredOverages } from '../src/services/stripe-overages';
import { billingRoutes } from '../src/routes/billing';
import { errorHandler } from '../src/middleware/errors';

const ORG = '01900000-0000-7000-8000-0000000000aa';
const OPERATION = '01900000-0000-7000-8000-0000000000bb';
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function seed() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-20T12:15:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES ('owner','owner','owner@example.test','Owner','2026-11-01','2026-11-01')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Org','org','global','owner','2026-11-01T00:00:00Z','2026-11-01')").run(ORG);
  const env = createTestEnv({ DB: sqliteD1(db), USAGE_DB: sqliteD1(usage), AVALON_REGION: 'global', STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify({
    returnUrl: 'https://app.example.test', overageCredits: { priceId: 'price_overage', meterId: 'mtr_overage' },
    offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'], overagePriceId: 'price_overage' }],
  }) });
  await billingAccount(env, ORG);
  db.prepare("UPDATE billing_accounts SET customer_id = 'cus_1' WHERE workspace_id = ?").run(ORG);
  const provider = new StripeProvider(); vi.stubGlobal('fetch', provider.fetch.bind(provider));
  return { db, usage, env, provider };
}
const money = (value: number) => ({ type: 'monetary' as const, monetary: { currency: 'usd', value } });
function stripeGrant(overrides = {}) {
  return { id: 'credgr_1', customer: 'cus_1', amount: money(10000), effective_at: 1797768900, expires_at: null as number | null, voided_at: null,
    applicability_config: { scope: { prices: [{ id: 'price_overage' }] } }, metadata: {} as Record<string, string>, ...overrides };
}
function overageSubscription(overrides = {}) {
  return { id: 'sub_overage', customer: 'cus_1', status: 'active', currency: 'usd', cancel_at_period_end: false, discounts: ['di_customer'],
    metadata: { billing_role: 'overage' } as Record<string, string>, items: { data: [{ price: { id: 'price_overage', unit_amount: null } }] }, ...overrides };
}
/** Stripe is the external boundary; D1 and usage queries run real migrations. */
class StripeProvider {
  writes: { path: string; fields: URLSearchParams }[] = [];
  grants: ReturnType<typeof stripeGrant>[] = [];
  subscriptions: ReturnType<typeof overageSubscription>[] = [];
  available = 10000;
  loseGrantResponse = false;
  loseMeterResponse = false;
  fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname.replace('/v1/', '');
    const fields = new URLSearchParams(String(init?.body ?? ''));
    if (init?.method === 'POST') this.writes.push({ path, fields });
    if (path === 'prices/price_grow') return Response.json({ recurring: { interval: 'month', interval_count: 1 } });
    if (path === 'prices/price_overage') return Response.json({ currency: 'usd', unit_amount_decimal: '0.0001', billing_scheme: 'per_unit', transform_quantity: null,
      recurring: { usage_type: 'metered', interval: 'month', interval_count: 1, meter: 'mtr_overage' } });
    if (path === 'billing/meters/mtr_overage') return Response.json({ id: 'mtr_overage', event_name: 'rally_overage', status: 'active', event_time_window: 'hour',
      default_aggregation: { formula: 'sum' }, customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }, value_settings: { event_payload_key: 'value' } });
    if (path === 'billing/credit_grants' && init?.method === 'POST') {
      const grant = stripeGrant({ amount: money(Number(fields.get('amount[monetary][value]'))),
        applicability_config: { scope: { prices: [{ id: fields.get('applicability_config[scope][prices][0][id]')! }] } },
        metadata: { receipt: fields.get('metadata[receipt]')! }, expires_at: fields.has('expires_at') ? Number(fields.get('expires_at')) : null });
      this.grants.push(grant);
      if (this.loseGrantResponse) { this.loseGrantResponse = false; throw new Error('response_lost'); }
      return Response.json(grant);
    }
    if (path === 'billing/credit_grants') return Response.json({ data: [...this.grants, { ...stripeGrant(), id: 'credgr_general', applicability_config: { scope: { price_type: 'metered', prices: null } } }], has_more: false });
    if (path === 'billing/credit_grants/credgr_1/expire') {
      this.available = 0; this.grants[0]!.expires_at = Math.floor(Date.now() / 1000); return Response.json(this.grants[0]);
    }
    if (path === 'billing/credit_grants/credgr_1') return Response.json(this.grants[0]);
    if (path === 'billing/credit_balance_summary') return Response.json({ balances: [{ available_balance: money(this.available) }] });
    if (path === 'subscriptions' && init?.method !== 'POST') return Response.json({ data: this.subscriptions, has_more: false });
    if (path === 'subscriptions' && init?.method === 'POST') {
      const sub = overageSubscription({ metadata: { billing_role: 'overage', receipt: fields.get('metadata[receipt]')! } }); this.subscriptions.push(sub); return Response.json(sub);
    }
    if (path === 'subscriptions/sub_paid') return Response.json({ default_payment_method: 'pm_1' });
    if (path === 'subscriptions/sub_overage') {
      if (fields.has('discounts')) this.subscriptions[0]!.discounts = [];
      if (fields.has('cancel_at_period_end')) this.subscriptions[0]!.cancel_at_period_end = fields.get('cancel_at_period_end') === 'true';
      return Response.json(this.subscriptions[0]);
    }
    if (path === 'billing/meter_events') {
      if (this.loseMeterResponse) { this.loseMeterResponse = false; throw new Error('meter_response_lost'); }
      return Response.json({ identifier: fields.get('identifier') });
    }
    if (path === 'checkout/sessions' && init?.method !== 'POST') return Response.json({ data: [] });
    if (path === 'checkout/sessions') return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/test' });
    throw new Error(`Unexpected Stripe request ${path}`);
  };
}

it('recovers a price-scoped grant after a lost response beyond Stripe idempotency retention and refuses changed retry arguments', async () => {
  const { env, db, provider } = await seed();
  const input = { operationId: OPERATION, amountCents: 10000, reason: 'Service incident', expiresAt: '2027-02-01T00:00:00Z' };
  provider.loseGrantResponse = true;
  await expect(grantOverageCredit(env, ORG, input)).rejects.toThrow('response_lost');
  vi.setSystemTime(new Date('2026-12-23T00:00:00Z'));
  provider.available = 7500;
  expect(await grantOverageCredit(env, ORG, input)).toMatchObject({ id: 'credgr_1', amountCents: 10000, availableCents: 7500, expiresAt: '2027-02-01T00:00:00.000Z' });
  const writes = provider.writes.filter(write => write.path === 'billing/credit_grants');
  expect(writes).toHaveLength(1);
  expect(Object.fromEntries(writes[0]!.fields)).toMatchObject({ category: 'promotional', 'amount[monetary][value]': '10000',
    'applicability_config[scope][prices][0][id]': 'price_overage', 'metadata[reason]': 'Service incident', expires_at: '1801440000' });
  expect(writes[0]!.fields.has('applicability_config[scope][price_type]')).toBe(false);
  expect(db.prepare('SELECT stripe_grant_id FROM billing_credit_operations').get()).toEqual({ stripe_grant_id: 'credgr_1' });
  await expect(grantOverageCredit(env, ORG, { ...input, amountCents: 20000 })).rejects.toMatchObject({ code: 'billing_credit_operation_conflict' });
  expect((await readOverageCredits(env, ORG)).availableCents).toBe(7500);
  expect(db.prepare('SELECT plan FROM workspaces WHERE id = ?').get(ORG)).toEqual({ plan: 'starter' });
  expect(db.prepare('SELECT subscription_id, overage_enabled FROM billing_accounts').get()).toEqual({ subscription_id: null, overage_enabled: 0 });
  vi.setSystemTime(new Date('2027-02-02T00:00:00Z'));
  expect(await grantOverageCredit(env, ORG, input)).toMatchObject({ id: 'credgr_1', expiresAt: '2027-02-01T00:00:00.000Z' });
  expect(provider.writes.filter(write => write.path === 'billing/credit_grants')).toHaveLength(1);
});

it('expires only an owned overage grant and reflects Stripe balance changes without a local balance', async () => {
  const { env, provider } = await seed();
  provider.grants = [stripeGrant({ customer: 'cus_other' })];
  await expect(expireOverageCredit(env, ORG, 'credgr_1')).rejects.toMatchObject({ code: 'billing_credit_not_found' });
  provider.grants = [stripeGrant({ applicability_config: { scope: { prices: [{ id: 'price_grow' }] } } })];
  await expect(expireOverageCredit(env, ORG, 'credgr_1')).rejects.toMatchObject({ code: 'billing_credit_not_found' });
  provider.grants = [stripeGrant()]; provider.available = 7500;
  expect((await readOverageCredits(env, ORG)).availableCents).toBe(7500);
  expect(await expireOverageCredit(env, ORG, 'credgr_1')).toMatchObject({ amountCents: 10000, availableCents: 0 });
  expect((await readOverageCredits(env, ORG)).availableCents).toBe(0);
  await expireOverageCredit(env, ORG, 'credgr_1');
  expect(provider.writes.map(write => write.path)).toEqual(['billing/credit_grants/credgr_1/expire']);
});

it.each([null, 'credgr_legacy'])('recovers a legacy grant by operation ID with saved Stripe ID %s without issuing credit', async (stripeGrantId) => {
  const { env, db, provider } = await seed();
  const saved = JSON.stringify({ request: { operationId: OPERATION, amountCents: 10000, reason: 'Legacy credit' }, priceId: 'price_overage', meterId: 'mtr_overage' });
  db.prepare('INSERT INTO billing_credit_operations(workspace_id, operation_id, request_json, stripe_grant_id) VALUES (?, ?, ?, ?)')
    .run(ORG, OPERATION, saved, stripeGrantId);
  provider.grants = [stripeGrant({ id: 'credgr_other' }), stripeGrant({ id: 'credgr_legacy',
    metadata: stripeGrantId ? {} : { receipt: `overage-credit:global:${ORG}:${OPERATION}` },
  })];
  vi.setSystemTime(new Date('2027-01-20T00:00:00Z')); // Receipt lookup must outlive Stripe idempotency retention.
  expect(await readOverageCredits(env, ORG, OPERATION)).toEqual({ enabled: true, currency: 'usd', availableCents: 10000,
    grants: [{ id: 'credgr_legacy', amountCents: 10000, availableCents: 10000, effectiveAt: '2026-12-20T12:15:00.000Z', expiresAt: null, voided: false }],
  });
  expect(provider.writes).toEqual([]);
  expect(db.prepare('SELECT request_json, stripe_grant_id FROM billing_credit_operations').all()).toEqual([{ request_json: saved, stripe_grant_id: stripeGrantId }]);
});

it('keeps operation recovery scoped to the organization and never issues a missing legacy grant', async () => {
  const { env, db, provider } = await seed();
  db.prepare('INSERT INTO billing_credit_operations(workspace_id, operation_id, request_json) VALUES (?, ?, ?)')
    .run(ORG, OPERATION, JSON.stringify({ request: { operationId: OPERATION, amountCents: 10000, reason: 'Legacy credit' }, priceId: 'price_overage', meterId: 'mtr_overage' }));
  provider.grants = [stripeGrant({ id: 'credgr_unrelated' })];
  expect(await readOverageCredits(env, ORG, OPERATION)).toEqual({ enabled: true, currency: 'usd', availableCents: 0, grants: [] });
  await expect(readOverageCredits(env, ORG, '01900000-0000-7000-8000-0000000000cc')).rejects.toMatchObject({ code: 'billing_credit_operation_not_found' });
  await expect(readOverageCredits(env, 'other-org', OPERATION)).rejects.toMatchObject({ code: 'billing_credit_operation_not_found' });
  expect(provider.writes).toEqual([]);
  expect(db.prepare('SELECT stripe_grant_id FROM billing_credit_operations').all()).toEqual([{ stripe_grant_id: null }]);
});

it('rejects a past expiry and a meter with a price incompatible with credit grants before issuing money', async () => {
  const { env, provider } = await seed();
  await expect(grantOverageCredit(env, ORG, { operationId: OPERATION, amountCents: 100, reason: 'Test', expiresAt: '2020-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'billing_credit_expiry_past' });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => input.includes('/prices/') ? Response.json({ currency: 'usd', unit_amount_decimal: '100', billing_scheme: 'per_unit', transform_quantity: null, recurring: null }) : provider.fetch(input, init));
  await expect(grantOverageCredit(env, ORG, { operationId: OPERATION, amountCents: 100, reason: 'Test', expiresAt: '2027-02-01T00:00:00Z' })).rejects.toMatchObject({ code: 'billing_overage_credit_price_invalid' });
  expect(provider.writes).toEqual([]);
});

it.each([
  ['2026-12-20T12:15:00Z', 'billing_credit_expiry_past'],
  ['2026-12-20T12:15:00.500Z', 'billing_credit_expiry_past'],
  ['2028-12-20T12:15:00.001Z', 'billing_credit_expiry_too_late'],
  ['2028-12-20T04:15:01-08:00', 'billing_credit_expiry_too_late'],
])('rejects expiry %s before persisting a grant or issuing money', async (expiresAt, code) => {
  const { env, db, provider } = await seed();
  await expect(grantOverageCredit(env, ORG, { operationId: OPERATION, amountCents: 100, reason: 'Test', expiresAt })).rejects.toMatchObject({ code });
  expect(db.prepare('SELECT COUNT(*) AS count FROM billing_credit_operations').get()).toEqual({ count: 0 });
  expect(provider.writes).toEqual([]);
});

it.each([
  ['2026-12-21T12:15:00Z', '2026-12-21T12:15:00.000Z'],
  ['2028-06-20T12:15:00Z', '2028-06-20T12:15:00.000Z'],
  ['2028-12-20T04:15:00-08:00', '2028-12-20T12:15:00.000Z'],
])('issues credit with the chosen expiry %s, up to the inclusive two-year boundary', async (expiresAt, expected) => {
  const { env } = await seed();
  expect(await grantOverageCredit(env, ORG, { operationId: OPERATION, amountCents: 100, reason: 'Test', expiresAt })).toMatchObject({ expiresAt: expected });
});

it('clamps the two-year expiration limit from leap day to February 28', async () => {
  const { env, provider } = await seed();
  vi.setSystemTime(new Date('2028-02-29T12:15:00Z'));
  const input = { operationId: OPERATION, amountCents: 100, reason: 'Test' };
  await expect(grantOverageCredit(env, ORG, { ...input, expiresAt: '2030-03-01T00:00:00Z' })).rejects.toMatchObject({ code: 'billing_credit_expiry_too_late' });
  expect(provider.writes).toEqual([]);
  expect(await grantOverageCredit(env, ORG, { ...input, expiresAt: '2030-02-28T12:15:00Z' })).toMatchObject({ expiresAt: '2030-02-28T12:15:00.000Z' });
});

it('routes settled overages through a discount-free metered subscription and replays the absolute hour after a lost response', async () => {
  const { env, db, usage, provider } = await seed();
  db.prepare("INSERT INTO billing_terms(subscription_id,workspace_id,customer_id,price_id,starts_at) VALUES ('sub_paid',?,'cus_1','price_overage',unixepoch('2026-11-01'))").run(ORG);
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2026-11-08T00:00:00.000Z','2026-11-01T00:00:00.000Z',100000000,250000000,900000000)").run(ORG);
  provider.loseMeterResponse = true;
  await expect(billClosedOverage(env, ORG)).rejects.toThrow('meter_response_lost');
  vi.setSystemTime(new Date('2026-12-22T00:00:00Z'));
  await billClosedOverage(env, ORG);
  const created = provider.writes.filter(write => write.path === 'subscriptions');
  expect(created).toHaveLength(1);
  expect(Object.fromEntries(created[0]!.fields)).toMatchObject({ 'items[0][price]': 'price_overage', 'metadata[billing_role]': 'overage', default_payment_method: 'pm_1' });
  expect(provider.writes.some(write => write.path === 'subscriptions/sub_overage' && write.fields.get('discounts') === '')).toBe(true);
  const events = provider.writes.filter(write => write.path === 'billing/meter_events');
  expect(events).toHaveLength(2);
  for (const event of events) expect(Object.fromEntries(event.fields)).toMatchObject({ 'payload[value]': '150000000', 'payload[stripe_customer_id]': 'cus_1', event_name: 'rally_overage', timestamp: String(Date.parse('2026-12-20T12:15:00Z') / 1000) });
  expect(events[0]!.fields.get('identifier')).not.toBe(events[1]!.fields.get('identifier'));
  expect(db.prepare('SELECT amount_microusd, meter_id, invoice_item_id FROM billing_overages').get()).toEqual({ amount_microusd: 150000000, meter_id: 'mtr_overage', invoice_item_id: `meter:mtr_overage:${Date.parse('2026-12-20T12:00:00Z') / 1000}` });
  await billClosedOverage(env, ORG);
  expect(provider.writes.filter(write => write.path === 'billing/meter_events')).toHaveLength(2);
  // Cancellation tail goes to Stripe's regular metered invoice, without an
  // immediate one-off final invoice that would be ineligible for credit grants.
  db.prepare("UPDATE billing_terms SET ends_at = unixepoch('2026-12-01'), cutoff_quota_microusd = 100000000").run();
  await billClosedOverage(env, ORG);
  expect(provider.writes.at(-1)!.fields.get('cancel_at_period_end')).toBe('true');
  expect(provider.writes.some(write => write.path.startsWith('invoice'))).toBe(false);
  expect(db.prepare('SELECT final_invoice_finalized FROM billing_terms').get()).toEqual({ final_invoice_finalized: 1 });
});

it('combines multiple receipts in the same hour and retains a financial repair when Stripe cannot accept the timestamp', async () => {
  const { env, db, provider } = await seed();
  db.prepare("INSERT INTO billing_terms(subscription_id,workspace_id,customer_id,price_id,starts_at) VALUES ('sub_paid',?,'cus_1','price_overage',unixepoch('2026-11-01'))").run(ORG);
  const insert = db.prepare("INSERT INTO billing_overages(workspace_id,subscription_id,period_start,period_end,amount_microusd,price_id,meter_id) VALUES (?,'sub_paid',?, ?,?,'price_overage','mtr_overage')");
  insert.run(ORG, '2026-10-01', '2026-11-01', 25000000);
  await reportMeteredOverages(env, ORG);
  insert.run(ORG, '2026-11-01', '2026-12-01', 75000000);
  await reportMeteredOverages(env, ORG);
  expect(provider.writes.filter(write => write.path === 'billing/meter_events').map(write => write.fields.get('payload[value]'))).toEqual(['25000000', '100000000']);
  db.prepare('UPDATE billing_overages SET invoice_item_id = NULL').run();
  vi.setSystemTime(new Date('2027-02-01T00:00:00Z'));
  await expect(reportMeteredOverages(env, ORG)).rejects.toMatchObject({ code: 'billing_overage_event_expired' });
  expect(db.prepare('SELECT COUNT(*) AS count FROM billing_overages WHERE invoice_item_id IS NULL').get()).toEqual({ count: 2 });
});

it('ignores overage subscriptions for entitlements and first-paid eligibility', async () => {
  const { env, db, provider } = await seed();
  env.BILLING_CONFIG = JSON.stringify({ ...JSON.parse(env.BILLING_CONFIG!), pilotCouponId: 'coupon_pilot' });
  provider.subscriptions = [overageSubscription()];
  await syncSubscription(env, 'cus_1', 'sub_overage');
  expect(db.prepare('SELECT subscription_id FROM billing_accounts').get()).toEqual({ subscription_id: null });
  await expect(createCheckout(env, ORG, 'grow', 'usd', true)).resolves.toEqual({ url: 'https://checkout.stripe.com/test' });
  expect(provider.writes.find(write => write.path === 'checkout/sessions')!.fields.get('discounts[0][coupon]')).toBe('coupon_pilot');
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'starter' });
});

it.each(['member', 'support', 'owner'] as const)('exposes credit balances only to administrators outside support sessions: %s', async role => {
  const { env, provider } = await seed(); provider.grants = [stripeGrant()];
  const app = new Hono<HonoAppEnv>(); app.onError(errorHandler);
  app.use('*', async (c, next) => {
    c.set('auth', { sessionId: 'session', userId: asUserId(ORG), workspaceId: asWorkspaceId(ORG), region: 'global', role: role === 'member' ? 'member' : 'owner',
      ...(role === 'support' ? { impersonatorUserId: asUserId(OPERATION) } : {}) }); await next();
  });
  app.route('/billing', billingRoutes);
  const response = await app.request('/billing/credits', {}, env);
  expect(response.status).toBe(role === 'owner' ? 200 : 403);
  if (role === 'owner') expect(await response.json()).toMatchObject({ availableCents: 10000, grants: [{ id: 'credgr_1' }] });
  // Customer administrators have no HTTP grant or expiry endpoint.
  expect((await app.request('/billing/credits', { method: 'POST', body: JSON.stringify({ amountCents: 10000 }) }, env)).status).toBe(role === 'owner' ? 404 : 403);
});
