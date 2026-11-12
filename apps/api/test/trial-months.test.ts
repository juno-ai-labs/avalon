import '../../../tests/isolated-region';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';
import { billingAccount, billClosedOverage } from '../src/services/billing';
import { grantTrialMonths } from '../src/services/trial-months';
import { readOrganizationUsage } from '../src/services/usage-metering';

const ORG = '01900000-0000-7000-8000-0000000000aa';
const OPERATION = '01900000-0000-7000-8000-0000000000bb';
const SECOND = '01900000-0000-7000-8000-0000000000cc';
const second = (date: string) => Date.parse(date) / 1000;
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function seed() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-20T12:15:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES ('owner','owner','owner@example.test','Owner','2026-11-01','2026-11-01')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at,plan) VALUES (?,'Org','org','global','owner','2026-11-01T00:00:00Z','2026-11-01','growth')").run(ORG);
  const env = createTestEnv({ DB: sqliteD1(db), USAGE_DB: sqliteD1(usage), AVALON_REGION: 'global', STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify({
    returnUrl: 'https://app.example.test', overageCredits: { priceId: 'price_overage', meterId: 'mtr_overage' },
    offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd', 'eur'], overagePriceId: 'price_overage' }],
  }) });
  await billingAccount(env, ORG);
  db.prepare("UPDATE billing_accounts SET customer_id = 'cus_1', subscription_id = 'sub_paid', status = 'active', offer_id = 'grow', currency = 'usd', overage_enabled = 1, overage_started_at = unixepoch('2026-11-01') WHERE workspace_id = ?").run(ORG);
  const provider = new StripeProvider(); vi.stubGlobal('fetch', provider.fetch.bind(provider));
  return { db, usage, env, provider };
}
class StripeProvider {
  writes: { path: string; fields: URLSearchParams }[] = [];
  loseResponse = false;
  rejectUpdate = false;
  failBeforeUpdate = false;
  sub = { id: 'sub_paid', customer: 'cus_1', status: 'active', currency: 'usd', start_date: second('2026-11-01'), ended_at: null as number | null,
    trial_end: null as number | null, current_period_end: second('2027-01-01'), default_payment_method: 'pm_1', cancel_at_period_end: false, cancel_at: null,
    metadata: { offer_id: 'grow', overage_enabled: 'true', pilot_coupon_id: 'pilot_two_months' } as Record<string, string>,
    items: { data: [{ price: { id: 'price_grow', product: 'prod_grow', unit_amount: 10000 } }] },
    discounts: [{ end: second('2027-01-01'), coupon: { percent_off: 100, duration: 'repeating', applies_to: { products: ['prod_grow'] } } }],
  };
  meterSub: Record<string, unknown> | null = null;
  fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname.replace('/v1/', ''); const fields = new URLSearchParams(String(init?.body ?? ''));
    if (init?.method === 'POST') this.writes.push({ path, fields });
    if (path === 'subscriptions' && init?.method !== 'POST') return Response.json({ data: [this.sub, ...(this.meterSub ? [this.meterSub] : [])], has_more: false });
    if (path === 'subscriptions/sub_paid') {
      if (init?.method === 'POST') {
        if (this.failBeforeUpdate) throw new Error('request_failed');
        if (this.rejectUpdate) return Response.json({ error: { type: 'invalid_request_error', code: 'parameter_invalid_integer', param: 'trial_end' } }, { status: 400 });
        this.sub.trial_end = Number(fields.get('trial_end')); this.sub.current_period_end = this.sub.trial_end; this.sub.status = 'trialing';
        this.sub.metadata.rally_trial_operation_id = fields.get('metadata[rally_trial_operation_id]')!;
        if (this.loseResponse) { this.loseResponse = false; throw new Error('response_lost'); }
      }
      return Response.json(this.sub);
    }
    if (path === 'prices/price_grow') return Response.json({ recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
    if (path === 'prices/price_overage') return Response.json({ currency: 'usd', unit_amount_decimal: '0.0001', billing_scheme: 'per_unit', transform_quantity: null,
      recurring: { usage_type: 'metered', interval: 'month', interval_count: 1, meter: 'mtr_overage' } });
    if (path === 'billing/meters/mtr_overage') return Response.json({ id: 'mtr_overage', event_name: 'overage', status: 'active', event_time_window: 'hour', default_aggregation: { formula: 'sum' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }, value_settings: { event_payload_key: 'value' } });
    if (path === 'subscriptions' && init?.method === 'POST') {
      this.meterSub = { id: 'sub_overage', customer: 'cus_1', status: 'active', currency: 'usd', cancel_at_period_end: false, discounts: [],
        metadata: { billing_role: 'overage', receipt: fields.get('metadata[receipt]') }, items: { data: [{ price: { id: 'price_overage' } }] } };
      return Response.json(this.meterSub);
    }
    if (path === 'subscriptions/sub_overage') return Response.json(this.meterSub);
    if (path === 'billing/meter_events') return Response.json({ identifier: fields.get('identifier') });
    if (path === 'invoices') return Response.json({ has_more: false, data: [] });
    throw new Error(`Unexpected Stripe request ${path}`);
  };
}
const input = { operationId: OPERATION, months: 2, reason: 'Extra evaluation time' };

it('extends existing pilot coverage once, preserves plan and coupons, and bills overages during the added trial months', async () => {
  const { env, db, usage, provider } = await seed();
  expect(await grantTrialMonths(env, ORG, input)).toEqual({ subscriptionId: 'sub_paid', months: 2, previousFeeCoveredUntil: '2027-01-01T00:00:00.000Z', trialEndsAt: '2027-03-01T00:00:00.000Z' });
  const write = provider.writes[0]!.fields;
  expect(Object.fromEntries(write)).toMatchObject({ trial_end: String(second('2027-03-01')), proration_behavior: 'none', 'metadata[rally_trial_operation_id]': OPERATION });
  expect([...write.keys()].some(key => key.startsWith('discounts') || key.startsWith('items'))).toBe(false);
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
  expect(db.prepare('SELECT status, overage_enabled, overage_started_at FROM billing_accounts').get()).toEqual({ status: 'trialing', overage_enabled: 1, overage_started_at: second('2026-11-01') });
  expect((await readOrganizationUsage(env, ORG, Date.now()))!.overage.billingEnabled).toBe(true);
  await grantTrialMonths(env, ORG, input);
  expect(provider.writes).toHaveLength(1);
  await expect(grantTrialMonths(env, ORG, { ...input, months: 3 })).rejects.toMatchObject({ code: 'billing_trial_operation_conflict' });
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-08T00:00:00.000Z','2027-01-01T00:00:00.000Z',50000000,150000000,0)").run(ORG);
  vi.setSystemTime(new Date('2027-02-20T00:00:00Z'));
  await billClosedOverage(env, ORG);
  expect(provider.writes.find(row => row.path === 'billing/meter_events')!.fields.get('payload[value]')).toBe('100000000');
  expect(provider.sub.status).toBe('trialing');
});

it('recovers an uncertain Stripe write after its idempotency window without adding months twice or losing the next grant', async () => {
  const { env, provider } = await seed(); provider.loseResponse = true;
  await expect(grantTrialMonths(env, ORG, input)).rejects.toThrow('response_lost');
  await expect(grantTrialMonths(env, ORG, { ...input, operationId: SECOND })).rejects.toMatchObject({ code: 'billing_trial_grant_pending' });
  vi.setSystemTime(new Date('2026-12-23T00:00:00Z'));
  expect(await grantTrialMonths(env, ORG, input)).toMatchObject({ trialEndsAt: '2027-03-01T00:00:00.000Z' });
  expect(provider.writes).toHaveLength(1);
  expect(await grantTrialMonths(env, ORG, { ...input, operationId: SECOND, months: 1 })).toMatchObject({ previousFeeCoveredUntil: '2027-03-01T00:00:00.000Z', trialEndsAt: '2027-04-01T00:00:00.000Z' });
  await grantTrialMonths(env, ORG, input);
  expect(provider.sub.trial_end).toBe(second('2027-04-01'));
  expect(provider.writes).toHaveLength(2);
});

it('uses the later existing trial or pilot end and clamps calendar months at month end across currencies', async () => {
  const { env, provider } = await seed();
  provider.sub.currency = 'eur'; provider.sub.metadata.overage_enabled = 'false';
  provider.sub.status = 'trialing'; provider.sub.trial_end = second('2027-01-31T10:30:00Z'); provider.sub.current_period_end = provider.sub.trial_end;
  expect(await grantTrialMonths(env, ORG, { ...input, months: 1 })).toMatchObject({ previousFeeCoveredUntil: '2027-01-31T10:30:00.000Z', trialEndsAt: '2027-02-28T10:30:00.000Z' });
});

it('refuses a canceling subscription, free organization, and legacy overages before granting free months', async () => {
  const { env, provider, db } = await seed();
  provider.sub.cancel_at_period_end = true;
  await expect(grantTrialMonths(env, ORG, input)).rejects.toMatchObject({ code: 'billing_trial_subscription_canceling' });
  provider.sub.cancel_at_period_end = false;
  const config = JSON.parse(env.BILLING_CONFIG!); delete config.overageCredits; env.BILLING_CONFIG = JSON.stringify(config);
  await expect(grantTrialMonths(env, ORG, input)).rejects.toMatchObject({ code: 'billing_trial_requires_metered_overages' });
  db.prepare('UPDATE billing_accounts SET customer_id = NULL, subscription_id = NULL').run();
  await expect(grantTrialMonths(env, ORG, input)).rejects.toMatchObject({ code: 'billing_paid_subscription_required' });
  expect(provider.writes).toEqual([]);
});

it('does not leave a definitively rejected grant blocking later corrected operator requests', async () => {
  const { env, provider, db } = await seed(); provider.rejectUpdate = true;
  await expect(grantTrialMonths(env, ORG, input)).rejects.toMatchObject({ code: 'billing_trial_grant_rejected' });
  expect(db.prepare('SELECT error_code FROM billing_trial_operations').get()).toEqual({ error_code: 'billing_trial_grant_rejected' });
  provider.rejectUpdate = false;
  await expect(grantTrialMonths(env, ORG, input)).rejects.toMatchObject({ code: 'billing_trial_grant_rejected' });
  expect(await grantTrialMonths(env, ORG, { ...input, operationId: SECOND })).toMatchObject({ trialEndsAt: '2027-03-01T00:00:00.000Z' });
});


it('adds months after a pilot that outlasts the current paid billing period', async () => {
  const { env, provider } = await seed();
  provider.sub.discounts[0]!.end = second('2027-02-01');
  expect(await grantTrialMonths(env, ORG, input)).toMatchObject({ previousFeeCoveredUntil: '2027-02-01T00:00:00.000Z', trialEndsAt: '2027-04-01T00:00:00.000Z' });
});

it('does not restart a canceled subscription when retrying an unapplied grant', async () => {
  const { env, provider, db } = await seed(); provider.failBeforeUpdate = true;
  await expect(grantTrialMonths(env, ORG, input)).rejects.toThrow('request_failed');
  provider.failBeforeUpdate = false; provider.sub.status = 'canceled';
  await expect(grantTrialMonths(env, ORG, input)).rejects.toMatchObject({ code: 'billing_trial_grant_stale' });
  expect(provider.writes).toHaveLength(1);
  expect(db.prepare('SELECT error_code FROM billing_trial_operations').get()).toEqual({ error_code: 'billing_trial_grant_stale' });
});
