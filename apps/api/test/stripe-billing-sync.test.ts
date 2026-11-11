import '../../../tests/isolated-region';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import type { UsageEvent } from '@rally/contracts/usage';
import type * as UsageModule from '../src/services/usage-metering';
import { applyUsageBatch, pruneUsageEvents } from '../src/services/usage-metering';
import { billingAccount, createCheckout, refreshBillingAccount, settleBillingAccounts, withBillingLock } from '../src/services/billing';
import { synchronizeStripeUsage } from '../src/services/stripe-billing-sync';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

// The socket publisher is exercised in workerd. Stripe is the only external
// collaborator here; queries and transactions use the actual migrated schemas.
vi.mock('../src/services/usage-metering', async (original) => ({
  ...await original<typeof UsageModule>(), publishOrganizationUsage: vi.fn(async () => undefined),
}));
const WORKSPACE = '01900000-0000-7000-8000-0000000000aa';
const HOUR = Date.parse('2026-11-10T12:00:00Z') / 1000;
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });

interface StripeSubscription {
  id: string; customer: string; status: string; currency: string; trial_end: number | null;
  metadata: Record<string, string>; items: { data: { price: { id: string; unit_amount: number } }[] };
}
function stripeServer() {
  const customers = new Map<string, { id: string; metadata: Record<string, string> }>();
  const subscriptions = new Map<string, StripeSubscription>();
  const values = new Map<string, Map<number, number>>();
  const identifiers = new Set<string>();
  const writes: { path: string; body: URLSearchParams }[] = [];
  const controls = { lag: false, loseMeterReply: false, rawMeter: false, freeAmount: 0 };
  const metadata = (body: URLSearchParams) => Object.fromEntries([...body].filter(([key]) => /^metadata\[/.test(key)).map(([key, value]) => [key.slice(9, -1), value]));
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input); const path = url.pathname.slice('/v1/'.length);
    const body = new URLSearchParams(String(init?.body ?? ''));
    if (init?.method === 'POST') writes.push({ path, body });
    if (path === 'customers') {
      if (init?.method !== 'POST') return Response.json({ data: [...customers.values()], has_more: false });
      const customer = { id: `cus_${customers.size + 1}`, metadata: metadata(body) }; customers.set(customer.id, customer); return Response.json(customer);
    }
    if (path.startsWith('customers/')) {
      const customer = customers.get(path.slice('customers/'.length))!;
      if (init?.method === 'POST') Object.assign(customer.metadata, metadata(body));
      return Response.json(customer);
    }
    if (path.startsWith('prices/')) return Response.json({ unit_amount: controls.freeAmount, billing_scheme: 'per_unit', recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 } });
    if (path === 'subscriptions') {
      if (init?.method !== 'POST') return Response.json({ data: [...subscriptions.values()], has_more: false });
      const subscription: StripeSubscription = { id: `sub_${subscriptions.size + 1}`, customer: body.get('customer')!,
        status: body.has('trial_end') ? 'trialing' : 'active', currency: 'usd', trial_end: body.has('trial_end') ? Number(body.get('trial_end')) : null,
        metadata: metadata(body), items: { data: [{ price: { id: body.get('items[0][price]')!, unit_amount: 0 } }] },
      }; subscriptions.set(subscription.id, subscription); return Response.json(subscription);
    }
    if (path.startsWith('subscriptions/')) {
      const subscription = subscriptions.get(path.slice('subscriptions/'.length))!;
      if (init?.method === 'POST') {
        Object.assign(subscription.metadata, metadata(body));
        if (body.has('trial_end')) subscription.trial_end = Number(body.get('trial_end'));
      }
      return Response.json(subscription);
    }
    if (path === 'checkout/sessions') return Response.json(init?.method === 'POST' ? { id: 'cs_paid', url: 'https://checkout.stripe.com/paid' } : { data: [] });
    if (path.startsWith('billing/meters/')) {
      const meter = path.split('/')[2]!;
      if (path.endsWith('/event_summaries')) {
        const data = controls.lag ? [] : [...(values.get(meter) ?? [])]
          .filter(([hour]) => hour >= Number(url.searchParams.get('start_time')) && hour < Number(url.searchParams.get('end_time')))
          .map(([hour, amount]) => ({ id: `summary_${hour}`, start_time: hour, end_time: hour + 3600, aggregated_value: amount }));
        return Response.json({ data, has_more: false });
      }
      return Response.json({ id: meter, event_name: meter, event_time_window: controls.rawMeter ? null : 'hour', status: 'active',
        default_aggregation: { formula: 'sum' }, customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }, value_settings: { event_payload_key: 'value' },
      });
    }
    if (path === 'billing/meter_events') {
      const identifier = body.get('identifier')!;
      if (identifiers.has(identifier)) return Response.json({ error: { type: 'invalid_request_error' } }, { status: 400 });
      identifiers.add(identifier);
      const meter = body.get('event_name')!;
      const hours = values.get(meter) ?? new Map<number, number>();
      hours.set(Number(body.get('timestamp')), Number(body.get('payload[value]'))); values.set(meter, hours);
      if (controls.loseMeterReply) { controls.loseMeterReply = false; throw new Error('lost_provider_reply'); }
      return Response.json({ identifier: body.get('identifier') });
    }
    if (path === 'invoiceitems') return Response.json(init?.method === 'POST' ? { id: 'ii_1' } : { data: [], has_more: false });
    throw new Error(`Unexpected Stripe endpoint: ${path}`);
  }));
  return { customers, subscriptions, values, writes, controls };
}

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id, google_subject, email, name, created_at, updated_at) VALUES ('owner','owner','owner@example.test','Owner','2026-11-10','2026-11-10')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Test','test','global','owner','2026-11-10T00:00:00Z','2026-11-10T00:00:00Z')").run(WORKSPACE);
  db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,access_class,joined_at) VALUES (?,'owner','owner','active','member','2026-11-10T00:00:00Z')").run(WORKSPACE);
  const env = createTestEnv({ DB: sqliteD1(db), USAGE_DB: sqliteD1(usage), AVALON_REGION: 'global', STRIPE_SECRET_KEY: 'sk_test_fake',
    BILLING_CONFIG: JSON.stringify({ returnUrl: 'https://app.example.test', pilotCouponId: 'pilot',
      synchronization: { freePriceId: 'price_free', organizationMeterId: 'mtr_org', rallyMeterId: 'mtr_rally' },
      offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'] }],
    }),
  });
  const server = stripeServer();
  const add = async (id: string, cost = 1_000_000, occurredAt = '2026-11-10T12:15:00Z') => {
    const event: UsageEvent = { v: 1, eventId: id, workspaceId: WORKSPACE, region: 'global', activity: 'agent_run', occurredAt, costMicrousd: cost, model: null, refs: {} };
    await applyUsageBatch(env, [event, event], new Date().toISOString());
  };
  const syncUsage = async () => withBillingLock(env, WORKSPACE, async () => synchronizeStripeUsage(env, await billingAccount(env, WORKSPACE)));
  return { db, usage, env, server, add, syncUsage };
}

it('provisions a free account and synchronizes its earned team award without consuming the pilot', async () => {
  const { db, env, server } = fixture();
  await settleBillingAccounts(env);
  expect(server.writes.filter((request) => request.path === 'subscriptions')).toHaveLength(1);
  expect(server.writes.find((request) => request.path === 'subscriptions')!.body.get('trial_end')).toBe(String(Date.parse('2026-11-24') / 1000));
  for (const id of ['two', 'three']) {
    db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES (?,?,?,?,'2026-11-10','2026-11-10')").run(id, id, `${id}@example.test`, id);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,access_class,joined_at) VALUES (?,?,'member','active','member','2026-11-11T00:00:00Z')").run(WORKSPACE, id);
  }
  await settleBillingAccounts(env);
  const award = server.writes.find((request) => request.path === 'subscriptions/sub_1');
  expect(award!.body.get('trial_end')).toBe(String(Date.parse('2027-01-09') / 1000));
  expect(award!.body.get('metadata[team_trial_awarded]')).toBe('true');
  expect(server.writes.filter((request) => request.path === 'subscriptions')).toHaveLength(1);
  await createCheckout(env, WORKSPACE, 'grow', 'usd', false);
  expect(server.writes.find((request) => request.path === 'checkout/sessions')!.body.get('discounts[0][coupon]')).toBe('pilot');
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'starter' });
});

it('recovers customers and free records after lost local receipts beyond Stripe idempotency retention', async () => {
  const { db, env, server } = fixture();
  await settleBillingAccounts(env);
  db.prepare('UPDATE billing_accounts SET customer_id = NULL, free_subscription_id = NULL, trial_award_synced_end = NULL').run();
  vi.setSystemTime(new Date('2026-11-13'));
  await settleBillingAccounts(env);
  expect(server.writes.filter((request) => request.path === 'customers')).toHaveLength(1);
  expect(server.writes.filter((request) => request.path === 'subscriptions')).toHaveLength(1);
  expect(db.prepare('SELECT customer_id, free_subscription_id FROM billing_accounts').get()).toEqual({ customer_id: 'cus_1', free_subscription_id: 'sub_1' });
});

it('reads a Stripe-edited trial deadline without overwriting it on the next synchronization', async () => {
  const { env, server } = fixture(); await settleBillingAccounts(env);
  server.subscriptions.get('sub_1')!.trial_end = Date.parse('2026-12-01') / 1000;
  const account = await refreshBillingAccount(env, WORKSPACE);
  expect(account.trial_ends_at).toBe(Date.parse('2026-12-01') / 1000);
  await settleBillingAccounts(env);
  expect(server.writes.filter((request) => request.path === 'subscriptions/sub_1')).toHaveLength(0);
});

it('refuses a nonzero price for the no-card record before creating a subscription', async () => {
  const { env, server } = fixture(); server.controls.freeAmount = 100;
  await expect(refreshBillingAccount(env, WORKSPACE)).rejects.toMatchObject({ code: 'billing_free_price_invalid' });
  expect(server.writes.filter((request) => request.path === 'subscriptions')).toHaveLength(0);
});

it('reports all free-period usage once and replaces an hour with the complete late-arrival total', async () => {
  const { env, usage, server, add } = fixture();
  await add('first'); await settleBillingAccounts(env);
  await add('late', 2_000_000); await settleBillingAccounts(env);
  expect(server.writes.filter((request) => request.path === 'billing/meter_events').map((request) => request.body.get('payload[value]'))).toEqual(['1000000', '3000000']);
  expect(usage.prepare('SELECT amount_microusd, revision, sent_revision, confirmed_revision FROM billing_usage_hours').all())
    .toEqual([{ amount_microusd: 3_000_000, revision: 2, sent_revision: 2, confirmed_revision: 2 }]);
});

it('keeps Rally-paid usage separate from Organization usage', async () => {
  const { env, usage, server, add } = fixture(); await add('org', 2_000_000);
  usage.prepare(`INSERT INTO usage_events(event_id,workspace_id,activity,occurred_at,cost_microusd,organization_pays,received_at)
    VALUES ('rally',?,'agent_run','2026-11-10T12:20:00Z',700000,0,'2026-11-11')`).run(WORKSPACE);
  await settleBillingAccounts(env);
  expect(server.writes.filter((request) => request.path === 'billing/meter_events').map((request) => [request.body.get('event_name'), request.body.get('payload[value]')]))
    .toEqual([['mtr_rally', '700000'], ['mtr_org', '2000000']]);
});

it('replays an uncertain send after 24 hours as an absolute total instead of adding usage twice', async () => {
  const { env, usage, server, add } = fixture(); await add('one');
  server.controls.loseMeterReply = true; await settleBillingAccounts(env);
  expect(usage.prepare('SELECT confirmed_revision FROM billing_usage_hours').get()).toEqual({ confirmed_revision: 0 });
  vi.setSystemTime(new Date('2026-11-13')); await settleBillingAccounts(env);
  const sends = server.writes.filter((request) => request.path === 'billing/meter_events');
  expect(sends).toHaveLength(2);
  expect(sends.map((request) => request.body.get('payload[value]'))).toEqual(['1000000', '1000000']);
  expect(usage.prepare('SELECT confirmed_revision FROM billing_usage_hours').get()).toEqual({ confirmed_revision: 1 });
});

it('records reconciliation as pending until Stripe aggregation catches up', async () => {
  const { env, usage, server, add, syncUsage } = fixture(); await add('one');
  server.controls.lag = true; await settleBillingAccounts(env);
  expect(usage.prepare('SELECT error_code FROM billing_usage_hours').get()).toEqual({ error_code: 'billing_usage_unreconciled' });
  server.controls.lag = false; await syncUsage();
  expect(usage.prepare('SELECT confirmed_revision, error_code FROM billing_usage_hours').get()).toEqual({ confirmed_revision: 1, error_code: null });
});

it('continues overage settlement when background Stripe usage synchronization fails', async () => {
  const { db, env, server, add } = fixture(); await add('overage', 50_000_000); await settleBillingAccounts(env);
  db.prepare(`INSERT INTO billing_terms(subscription_id,workspace_id,customer_id,price_id,starts_at)
    VALUES ('sub_paid',?,'cus_1','price_overage',unixepoch('2026-11-10'))`).run(WORKSPACE);
  server.controls.rawMeter = true;
  vi.setSystemTime(new Date('2026-12-26'));
  await settleBillingAccounts(env);
  const invoice = server.writes.find((request) => request.path === 'invoiceitems');
  expect(invoice).toBeDefined();
  expect(invoice!.body.get('quantity')).toBe('40000000');
  expect(invoice!.body.get('discountable')).toBe('false');
});

it('refuses raw meters whose retries would count usage twice', async () => {
  const { env, server, add, syncUsage } = fixture(); await add('one'); await refreshBillingAccount(env, WORKSPACE);
  server.controls.rawMeter = true;
  await expect(syncUsage()).rejects.toMatchObject({ code: 'billing_usage_meter_invalid' });
  expect(server.writes.filter((request) => request.path === 'billing/meter_events')).toHaveLength(0);
});

it('retains unsendable history and continues reporting recent usage without changing timestamps', async () => {
  const { env, usage, server, add } = fixture();
  await add('old', 900_000, '2026-09-01T12:00:00Z'); await add('recent'); await settleBillingAccounts(env);
  expect(usage.prepare('SELECT error_code FROM billing_usage_hours ORDER BY hour_start').all())
    .toEqual([{ error_code: 'billing_usage_timestamp_expired' }, { error_code: null }]);
  expect(server.writes.filter((request) => request.path === 'billing/meter_events').map((request) => request.body.get('timestamp'))).toEqual([String(HOUR)]);
  await pruneUsageEvents(env, Date.parse('2027-03-01'));
  expect(usage.prepare('SELECT COUNT(*) AS count FROM usage_events').get()).toEqual({ count: 0 });
  expect(usage.prepare('SELECT SUM(amount_microusd) AS total FROM billing_usage_hours').get()).toEqual({ total: 1_900_000 });
});

it('does not acknowledge an event that arrived during a Stripe send', async () => {
  const { env, usage, add, syncUsage } = fixture(); await add('one'); await refreshBillingAccount(env, WORKSPACE);
  const provider = fetch;
  let added = false;
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const response = await provider(input, init);
    if (input.endsWith('/billing/meter_events') && !added) { added = true; await add('concurrent', 2_000_000); }
    return response;
  }));
  await syncUsage();
  expect(usage.prepare('SELECT revision, confirmed_revision FROM billing_usage_hours').get()).toEqual({ revision: 2, confirmed_revision: 0 });
  await syncUsage();
  expect(usage.prepare('SELECT amount_microusd, confirmed_revision FROM billing_usage_hours').get()).toEqual({ amount_microusd: 3_000_000, confirmed_revision: 2 });
});

it('backfills the retained ledger before capturing new events in the same hourly outbox', async () => {
  const { usage, add } = fixture();
  usage.exec('DROP TRIGGER usage_billing_hour_insert; DROP TABLE billing_usage_hours;');
  await add('before', 2_000_000);
  usage.exec(readFileSync(new URL('../../../packages/db/usage-migrations/0004_stripe_usage_sync.sql', import.meta.url), 'utf8'));
  expect(usage.prepare('SELECT amount_microusd, revision, confirmed_revision FROM billing_usage_hours').get()).toEqual({ amount_microusd: 2_000_000, revision: 1, confirmed_revision: 0 });
  await add('after', 3_000_000);
  expect(usage.prepare('SELECT amount_microusd, revision FROM billing_usage_hours').get()).toEqual({ amount_microusd: 5_000_000, revision: 2 });
});
