import '../../../tests/isolated-region';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';
import { refreshBillingAccount, setBillingOverages, createCheckout } from '../src/services/billing';
import { grantTrialMonths } from '../src/services/trial-months';
import { runEmbeddingInference } from '../src/services/structured-inference';
import { requireUsageAllowance } from '../src/services/usage-admission';
import { requireRunUsageAllowance } from '../src/services/integrations';
import { readOrganizationUsage } from '../src/services/usage-metering';
import { HarnessLimitError } from '@rally/agent-harness';

// Stripe is external; entitlement SQL and award receipts use the real migrations.
const ORG = '01900000-0000-7000-8000-0000000000aa';
const second = (at: string) => Date.parse(at) / 1000;
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function seed() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2027-01-31T10:30:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES ('owner','owner','owner@example.test','Owner','2027-01-31','2027-01-31')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at) VALUES (?,'Org','org','global','owner','2027-01-31T10:30:00Z','2027-01-31')").run(ORG);
  const config = { returnUrl: 'https://app.example.test', automaticTax: true, enforceUsageLimits: true,
    signupTrial: { offerId: 'grow', currency: 'usd', months: 2, startsAt: '2027-01-01T00:00:00Z' },
    offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'], overagePriceId: 'price_overage' }] };
  const env = createTestEnv({ DB: sqliteD1(db), USAGE_DB: sqliteD1(usage), AVALON_REGION: 'global', STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify(config) });
  const provider = new StripeProvider(); vi.stubGlobal('fetch', provider.fetch.bind(provider));
  return { db, usage, env, provider, config };
}
class StripeProvider {
  customer = { id: 'cus_signup', metadata: { workspace_id: ORG, region: 'global' }, invoice_settings: { default_payment_method: null as string | null }, tax: { automatic_tax: 'unrecognized_location' } };
  sub: { id: string; customer: string; status: string; currency: string; start_date: number; ended_at: number | null; trial_end: number; current_period_end: number; cancel_at: number | null; cancel_at_period_end: boolean; metadata: Record<string,string>; automatic_tax: { enabled: boolean }; items: { data: { price: { id: string; product: string; unit_amount: number } }[] }; discounts: [] } | null = null;
  writes: { path: string; fields: URLSearchParams }[] = [];
  loseCreateResponse = false;
  failCreate = false;
  fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)); const path = url.pathname.replace('/v1/', ''); const fields = new URLSearchParams(String(init?.body ?? ''));
    if (init?.method === 'POST') this.writes.push({ path, fields });
    if (path === 'prices/price_grow') return Response.json({ recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
    if (path === 'customers/search') return Response.json({ data: [this.customer] });
    if (path === 'customers/cus_signup') return Response.json(this.customer);
    if (path === 'subscriptions' && init?.method !== 'POST') return Response.json({ data: this.sub ? [this.sub] : [], has_more: false });
    if (path === 'subscriptions' && init?.method === 'POST') {
      if (this.failCreate) throw new Error('provider_unavailable');
      if (this.sub) throw new Error('duplicate_subscription');
      this.sub = { id: 'sub_signup', customer: 'cus_signup', status: 'trialing', currency: 'usd', start_date: Math.floor(Date.now()/1000), ended_at: null,
        trial_end: Number(fields.get('trial_end')), current_period_end: Number(fields.get('trial_end')), cancel_at: Number(fields.get('cancel_at')), cancel_at_period_end: false,
        automatic_tax: { enabled: fields.get('automatic_tax[enabled]') === 'true' }, metadata: {},
        items: { data: [{ price: { id: 'price_grow', product: 'prod_grow', unit_amount: 10000 } }] }, discounts: [] };
      for (const [key,value] of fields) if (key.startsWith('metadata[')) this.sub.metadata[key.slice(9,-1)] = value;
      if (this.loseCreateResponse) { this.loseCreateResponse = false; throw new Error('response_lost'); }
      return Response.json(this.sub);
    }
    if (path === 'subscriptions/sub_signup' && this.sub) {
      if (init?.method === 'POST') {
        if (fields.has('trial_end')) { this.sub.trial_end = Number(fields.get('trial_end')); this.sub.current_period_end = this.sub.trial_end; }
        if (fields.has('cancel_at')) this.sub.cancel_at = fields.get('cancel_at') ? Number(fields.get('cancel_at')) : null;
        if (fields.has('automatic_tax[enabled]')) this.sub.automatic_tax.enabled = fields.get('automatic_tax[enabled]') === 'true';
        for (const [key,value] of fields) if (key.startsWith('metadata[')) this.sub.metadata[key.slice(9,-1)] = value;
      }
      return Response.json(this.sub);
    }
    if (path === 'checkout/sessions' && init?.method !== 'POST') return Response.json({ data: [] });
    if (path === 'checkout/sessions') return Response.json({ id: 'cs_after', url: 'https://checkout.stripe.com/after' });
    throw new Error(`Unexpected Stripe call: ${path}`);
  };
}

it('automatically awards Grow for two calendar months without payment details and recovers a lost create response once', async () => {
  const { db, env, provider } = seed(); provider.loseCreateResponse = true;
  await expect(refreshBillingAccount(env, ORG)).rejects.toThrow('response_lost');
  expect(await refreshBillingAccount(env, ORG)).toMatchObject({ status: 'trialing', offer_id: 'grow', payment_method_ready: 0, trial_ends_at: second('2027-03-31T10:30:00Z') });
  await refreshBillingAccount(env, ORG);
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
  expect(db.prepare('SELECT subscription_id FROM billing_signup_trials').get()).toEqual({ subscription_id: 'sub_signup' });
  const creates = provider.writes.filter(row => row.path === 'subscriptions'); expect(creates).toHaveLength(1);
  expect(Object.fromEntries(creates[0]!.fields)).toMatchObject({ 'items[0][price]': 'price_grow', trial_end: '1806489000', cancel_at: '1806489000', 'automatic_tax[enabled]': 'false', 'trial_settings[end_behavior][missing_payment_method]': 'cancel' });
});

it('preserves the original offer and deadline when recovering after the campaign is disabled', async () => {
  const { env, config, provider } = seed(); provider.failCreate = true;
  await expect(refreshBillingAccount(env, ORG)).rejects.toThrow('provider_unavailable');
  env.BILLING_CONFIG = JSON.stringify({ ...config, signupTrial: undefined }); provider.failCreate = false;
  vi.setSystemTime(new Date('2027-02-03T10:30:00Z'));
  expect(await refreshBillingAccount(env, ORG)).toMatchObject({ trial_ends_at: second('2027-03-31T10:30:00Z') });
});

it.each(['old', 'override', 'retired'] as const)('does not award the campaign to an %s organization', async kind => {
  const { db, env, provider } = seed();
  if (kind === 'old') db.prepare("UPDATE workspaces SET created_at = '2026-12-01T00:00:00Z'").run();
  if (kind === 'override') db.prepare('UPDATE workspaces SET billing_plan_override = 1').run();
  if (kind === 'retired') {
    provider.failCreate = true; await expect(refreshBillingAccount(env, ORG)).rejects.toThrow('provider_unavailable');
    db.prepare("UPDATE workspaces SET abandoned_at = '2027-01-31'").run(); provider.writes.length = 0; provider.failCreate = false;
  }
  await refreshBillingAccount(env, ORG);
  expect(provider.writes).toEqual([]);
});

it('requires both a card and tax location, then converts without shortening free time and permits only opted-in overages', async () => {
  const { env, provider, db, usage } = seed(); await refreshBillingAccount(env, ORG);
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-31T10:30:00.000Z','2027-01-31T10:30:00.000Z',50000000,50000000,0)").run(ORG);
  await expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' });
  await expect(setBillingOverages(env, ORG, true)).rejects.toMatchObject({ code: 'billing_payment_method_required' });
  provider.customer.invoice_settings.default_payment_method = 'pm_card';
  expect((await refreshBillingAccount(env, ORG)).payment_method_ready).toBe(0);
  expect(provider.sub!.cancel_at).toBe(second('2027-03-31T10:30:00Z'));
  provider.customer.tax.automatic_tax = 'not_collecting';
  expect((await refreshBillingAccount(env, ORG)).payment_method_ready).toBe(1);
  expect(provider.sub).toMatchObject({ cancel_at: null, automatic_tax: { enabled: true }, trial_end: second('2027-03-31T10:30:00Z') });
  await expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' });
  vi.setSystemTime(new Date('2027-01-31T11:30:00Z'));
  expect(await setBillingOverages(env, ORG, true)).toEqual({ enabled: true });
  expect(db.prepare('SELECT overage_started_at FROM billing_accounts').get()).toEqual({ overage_started_at: second('2027-01-31T11:30:00Z') });
  await expect(requireUsageAllowance(env, ORG)).resolves.toBeUndefined();
  // Overages admit the work, so running out stops nothing and nothing warns.
  expect(await readOrganizationUsage(env, ORG, Date.now())).toMatchObject({ allowanceExhausted: false, stopsAtAllowance: false });
  await setBillingOverages(env, ORG, false);
  await expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' });
  vi.setSystemTime(new Date('2027-02-07T10:30:00Z'));
  await expect(requireUsageAllowance(env, ORG)).resolves.toBeUndefined();
});

it('extends the automatic cancellation deadline with an MCP month grant, clamping calendar months', async () => {
  const { env, provider } = seed(); await refreshBillingAccount(env, ORG);
  expect(await grantTrialMonths(env, ORG, { operationId: '01900000-0000-7000-8000-0000000000bb', months: 1, reason: 'Pilot extension' })).toMatchObject({ trialEndsAt: '2027-04-30T10:30:00.000Z' });
  expect(provider.sub!.cancel_at).toBe(second('2027-04-30T10:30:00Z'));
});

it('restores automatic cancellation after a premature resume but preserves an explicit earlier cancellation', async () => {
  const { env, provider } = seed(); await refreshBillingAccount(env, ORG); provider.sub!.cancel_at = null;
  await refreshBillingAccount(env, ORG); expect(provider.sub!.cancel_at).toBe(provider.sub!.trial_end);
  provider.sub!.cancel_at = second('2027-02-10T10:30:00Z'); provider.customer.invoice_settings.default_payment_method = 'pm_card'; provider.customer.tax.automatic_tax = 'supported';
  await refreshBillingAccount(env, ORG); expect(provider.sub!.cancel_at).toBe(second('2027-02-10T10:30:00Z'));
});

it('falls back to Start at expiry and never re-awards the promotion on later checkout', async () => {
  const { env, provider, db, usage } = seed(); await refreshBillingAccount(env, ORG);
  vi.setSystemTime(new Date('2027-03-31T10:30:01Z'));
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-03-28T10:30:00.000Z','2027-03-31T10:30:00.000Z',50000000,10000000,0)").run(ORG);
  await expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' });
  provider.sub!.status = 'canceled'; provider.sub!.ended_at = provider.sub!.trial_end;
  await refreshBillingAccount(env, ORG); expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'starter' });
  await createCheckout(env, ORG, 'grow', 'usd', false);
  const checkout = provider.writes.find(row => row.path === 'checkout/sessions')!.fields;
  expect(checkout.has('subscription_data[trial_end]')).toBe(false);
  expect(checkout.has('discounts[0][coupon]')).toBe(false);
  expect(provider.writes.filter(row => row.path === 'subscriptions')).toHaveLength(1);
});


it('ends an agent run on the exhausted allowance as a usage limit, not as a broken port', async () => {
  const { env, usage } = seed(); await refreshBillingAccount(env, ORG);
  await expect(requireRunUsageAllowance(env, ORG)).resolves.toBeUndefined();
  expect(await readOrganizationUsage(env, ORG, Date.now())).toMatchObject({ allowanceExhausted: false, stopsAtAllowance: true });
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-31T10:30:00.000Z','2027-01-31T10:30:00.000Z',50000000,50000000,0)").run(ORG);
  const refusal = await requireRunUsageAllowance(env, ORG).then(() => null, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(HarnessLimitError);
  expect(refusal).toMatchObject({ code: 'usage_allowance_exhausted' });
  expect(await readOrganizationUsage(env, ORG, Date.now())).toMatchObject({ allowanceExhausted: true, stopsAtAllowance: true });
});

it('emails each owner and administrator once a week when the allowance runs out, and no plain member', async () => {
  const { env, db, usage } = seed(); await refreshBillingAccount(env, ORG);
  const sent: { to: string; subject: string; text: string }[] = [];
  Object.assign(env, { APP_ENV: 'production', EMAIL_FROM: 'Rally <notices@example.test>', PUBLIC_WEB_BASE_URL: 'https://rally.example.test', BROWSER_APP_ORIGIN: 'https://app.example.test',
    EMAIL: { send: async (message: { to: string; subject: string; text: string }) => { sent.push(message); return { messageId: `m${sent.length}` }; } } });
  for (const [id, role] of [['owner', 'owner'], ['admin', 'admin'], ['member', 'member']] as const) {
    if (id !== 'owner') db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES (?,?,?,?,'2027-01-31','2027-01-31')").run(id, id, `${id}@example.test`, `${id} person`);
    db.prepare("INSERT INTO workspace_members(workspace_id,user_id,role,status,joined_at) VALUES (?,?,?,'active','2027-01-31')").run(ORG, id, role);
    // Each has signed in: email about activity goes only to people who have.
    db.prepare("INSERT INTO sessions(id,user_id,workspace_id,region,refresh_token_hash,expires_at,created_at) VALUES (?,?,?,'global',?,'2099-01-01','2027-01-31')")
      .run(`session-${id}`, id, ORG, `hash-${id}`);
  }
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-31T10:30:00.000Z','2027-01-31T10:30:00.000Z',50000000,50000000,0)").run(ORG);

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // Two refusals at once: the email is deferred, so the second races the first.
  await Promise.all([
    expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' }),
    expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' }),
  ]);
  await vi.waitFor(() => expect(sent).toHaveLength(2));
  // A later refusal that week finds both receipts and sends nothing.
  await expect(requireUsageAllowance(env, ORG)).rejects.toMatchObject({ code: 'usage_allowance_exhausted' });
  await vi.advanceTimersByTimeAsync(50);

  expect(sent.map((message) => message.to).sort()).toEqual(['admin@example.test', 'owner@example.test']);
  expect(warn.mock.calls.map((call) => (call[0] as { event?: string }).event)).not.toContain('usage_allowance_email_failed');
  expect(sent[0]).toMatchObject({ subject: "Org has used this week's included Rally usage" });
  expect(sent[0]!.text).toContain('turn on overage billing in Settings, Organization, Billing');
  // The desktop handoff and a browser link, since `/open` reaches only the desktop app.
  expect(sent[0]!.text).toContain('Open usage settings in the Rally app: https://rally.example.test/open#target=');
  expect(sent[0]!.text).toContain(`Open usage settings in your browser: https://app.example.test/app/workspaces/global/${ORG}#/settings?section=billing`);
});

it('blocks a real provider entry point before opening a request after the allowance is exhausted', async () => {
  const { env, usage } = seed(); await refreshBillingAccount(env, ORG);
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-31T10:30:00.000Z','2027-01-31T10:30:00.000Z',50000000,50000000,0)").run(ORG);
  const provider = vi.fn(); vi.stubGlobal('fetch', provider);
  await expect(runEmbeddingInference(env, { context: { workspaceId: ORG }, text: 'query', feature: 'search_embedding', inputType: 'search_query', dimensions: 1024, generationName: 'Search' })).rejects.toMatchObject({ code: 'usage_allowance_exhausted' });
  expect(provider).not.toHaveBeenCalled();
});


it('keeps payment readiness while a legacy subscription disables and re-enables overages', async () => {
  const { env, provider, config } = seed(); await refreshBillingAccount(env, ORG);
  env.BILLING_CONFIG = JSON.stringify({ ...config, signupTrial: undefined, enforceUsageLimits: false });
  delete provider.sub!.metadata.signup_trial; delete provider.sub!.metadata.signup_trial_conversion_pending;
  provider.sub!.status = 'active'; provider.sub!.cancel_at = null;
  provider.customer.invoice_settings.default_payment_method = 'pm_card';
  expect((await refreshBillingAccount(env, ORG, true)).payment_method_ready).toBe(1);
  for (const enabled of [true, false, true]) {
    expect(await setBillingOverages(env, ORG, enabled)).toEqual({ enabled });
    expect((await refreshBillingAccount(env, ORG)).payment_method_ready).toBe(1);
  }
});

it('keeps human conversation available and preserves the quota reason for background embedding', async () => {
  const { env, usage } = seed(); await refreshBillingAccount(env, ORG);
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-31T10:30:00.000Z','2027-01-31T10:30:00.000Z',50000000,50000000,0)").run(ORG);
  const { classifyWorkstreamMessage } = await import('../src/services/integrations');
  const { embedSearchDocuments } = await import('../src/services/search-embedding');
  const provider = vi.fn(); vi.stubGlobal('fetch', provider);
  expect(await classifyWorkstreamMessage(env, { workspaceId: ORG, workstreamId: 'canvas', userId: 'owner', message: 'Thanks, I will review it', activeTask: false, connectorMentions: [], humanMentions: [], recentMessages: [], defer: () => undefined })).toMatchObject({ classification: 'human_only' });
  await expect(embedSearchDocuments(env, ORG, ['document'])).rejects.toMatchObject({ code: 'usage_allowance_exhausted', details: { retryAfterSeconds: 604800 } });
  expect(provider).not.toHaveBeenCalled();
});

it('refuses a quota-blocked semantic trigger as policy instead of retrying a provider failure', async () => {
  const { env, usage } = seed(); await refreshBillingAccount(env, ORG);
  usage.prepare("INSERT INTO usage_rollups(workspace_id,week_start,period_start,quota_microusd,organization_microusd,rally_microusd) VALUES (?, '2027-01-31T10:30:00.000Z','2027-01-31T10:30:00.000Z',50000000,50000000,0)").run(ORG);
  const { asWorkspaceId, asAutomationId } = await import('@rally/contracts');
  const { admitExternalEventWithSemanticGate } = await import('../src/services/semantic-trigger-admission');
  const provider = vi.fn(); vi.stubGlobal('fetch', provider);
  const sidekick = { admitExternalEvent: vi.fn(async () => ({ admitted: false, outcomeCode: 'sidekick_semantic_condition_unjudged', judge: { conditions: ['Pull requests needing review'], connectorType: 'github' } })) };
  expect(await admitExternalEventWithSemanticGate(env, { workspaceId: ORG, sidekick, defer: () => undefined, admission: {
    workspaceId: asWorkspaceId(ORG), automationId: asAutomationId('01900000-0000-7000-8000-0000000000bb'), registrationId: '01900000-0000-7000-8000-0000000000cc', payloadHash: 'sha256:test',
    event: { id: '01900000-0000-7000-8000-0000000000dd', eventSequence: 1, eventType: 'github.pull_request.opened', title: 'Review', summary: 'Review', textSnippet: 'Review', metadata: {}, occurredAt: Date.now(), audienceUserIds: [], audienceKind: 'workspace' },
  } })).toEqual({ admitted: false, outcomeCode: 'usage_allowance_exhausted' });
  expect(provider).not.toHaveBeenCalled();
});
