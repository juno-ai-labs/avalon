import { env } from 'cloudflare:workers';
import { createExecutionContext, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineeringInspectionBridge } from '../src/engineering-inspection-bridge';
import { seedInspectableWorkspace } from './helpers/engineering-inspection-fixture';
import { billingAccount } from '../src/services/billing';
import usageMigration from '../../../packages/db/usage-migrations/0001_usage_ledger.sql?raw';
import billingMigration from '../../../packages/db/migrations/0131_billing.sql?raw';
import signupMigration from '../../../packages/db/migrations/0132_signup_trials.sql?raw';

const ORG = '00000000-0000-7000-8000-00000000fcb1';
const USER = '00000000-0000-7000-8000-00000000fcb2';
const OPERATION = '00000000-0000-7000-8000-00000000fcb3';
const OPERATOR = { subject: 'engineer', email: 'engineer@example.test', audience: 'engineering-mcp' };
const configured = () => ({ ...env, STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify({ returnUrl: 'https://app.test',
  overageCredits: { priceId: 'price_overage', meterId: 'mtr_overage' },
  offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'], overagePriceId: 'price_overage' }],
}) });
const stub = () => env.BILLING_COORDINATORS.getByName(`global:billing:${ORG}`);
const money = (value: number) => ({ type: 'monetary', monetary: { currency: 'usd', value } });
let paidSubscription: Record<string, unknown> | null = null;
let writes = 0;
let grant: Record<string, unknown> | null = null;
beforeEach(async () => {
  await reset(); writes = 0; grant = null; paidSubscription = null;
  await seedInspectableWorkspace(env.DB, { workspaceId: ORG, userId: USER, sessionId: 'credit-operator', at: '2026-11-01T00:00:00Z' });
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-11-01T00:00:00Z'"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN updated_at TEXT"),
  ]);
  await env.DB.exec(billingMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await env.DB.exec(signupMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await env.USAGE_DB.exec(usageMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await billingAccount(configured(), ORG);
  await env.DB.prepare("UPDATE billing_accounts SET customer_id = 'cus_1'").run();
  await runInDurableObject(stub(), (instance) => { Object.defineProperty(instance, 'env', { value: configured(), configurable: true }); });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input); const path = url.pathname.replace('/v1/', ''); const fields = new URLSearchParams(String(init?.body ?? ''));
    if (path === 'subscriptions') return Response.json({ has_more: false, data: paidSubscription ? [paidSubscription] : [] });
    if (path === 'subscriptions/sub_paid') {
      if (init?.method === 'POST') {
        writes++;
        paidSubscription = { ...paidSubscription, status: 'trialing', trial_end: Number(fields.get('trial_end')), current_period_end: Number(fields.get('trial_end')),
          metadata: { offer_id: 'grow', overage_enabled: 'true', rally_trial_operation_id: fields.get('metadata[rally_trial_operation_id]') } };
      }
      return Response.json(paidSubscription);
    }
    if (path === 'prices/price_grow') return Response.json({ recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } });
    if (path === 'prices/price_overage') return Response.json({ currency: 'usd', unit_amount_decimal: '0.0001', billing_scheme: 'per_unit', transform_quantity: null,
      recurring: { usage_type: 'metered', interval: 'month', interval_count: 1, meter: 'mtr_overage' } });
    if (path === 'billing/meters/mtr_overage') return Response.json({ id: 'mtr_overage', event_name: 'overage', status: 'active', event_time_window: 'hour', default_aggregation: { formula: 'sum' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }, value_settings: { event_payload_key: 'value' } });
    if (path === 'billing/credit_grants' && init?.method === 'POST') {
      writes++;
      grant = { id: 'credgr_1', customer: 'cus_1', amount: money(5000), effective_at: Math.floor(Date.now() / 1000), expires_at: Number(fields.get('expires_at')),
        applicability_config: { scope: { prices: [{ id: fields.get('applicability_config[scope][prices][0][id]') }] } }, metadata: { receipt: fields.get('metadata[receipt]') } };
      return Response.json(grant);
    }
    if (path === 'billing/credit_grants') return Response.json({ data: grant ? [grant] : [], has_more: false });
    if (path === 'billing/credit_grants/credgr_1') return Response.json(grant);
    if (path === 'billing/credit_balance_summary') return Response.json({ balances: [{ available_balance: money(5000) }] });
    throw new Error(`Unexpected Stripe call ${path}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

it('audits operator grants through the real organization actor and serializes retries without issuing another grant', async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + 86_400_000).toISOString();
  const input = { orgId: ORG, operationId: OPERATION, amountCents: 5000, reason: 'Incident credit', expiresAt };
  expect(await bridge.grantOverageCredit(input, OPERATOR)).toMatchObject({ id: 'credgr_1', availableCents: 5000, voided: false, expiresAt });
  expect(await bridge.inspectOverageCredits({ orgId: ORG })).toMatchObject({ availableCents: 5000 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => stub().grantCredit(ORG, { operationId: OPERATION, amountCents: 5000, reason: 'Incident credit', expiresAt })));
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(results.some(result => result.status === 'rejected')).toBe(true);
  expect(writes).toBe(1);
  const audits = await env.AUDIT_DB.prepare("SELECT action, metadata_json FROM audit_events WHERE workspace_id = ? AND action LIKE 'engineering.grant_overage_credit.%' ORDER BY action")
    .bind(ORG).all<{ action: string; metadata_json: string }>();
  expect(audits.results.map(row => row.action)).toEqual(['engineering.grant_overage_credit.attempt', 'engineering.grant_overage_credit.result']);
  expect(JSON.parse(audits.results[1]!.metadata_json)).toMatchObject({ operator: OPERATOR, operationId: OPERATION, amountCents: 5000, grantId: 'credgr_1', outcome: 'admitted', expiresAt });
  expect(audits.results.some(row => row.metadata_json.includes('Incident credit'))).toBe(false);
});

it('refuses invalid operator input and another regions organization before issuing a grant', async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  const input = { orgId: ORG, operationId: OPERATION, amountCents: 5000, reason: 'Incident credit', expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  await expect(bridge.grantOverageCredit({ ...input, amountCents: -1 }, OPERATOR)).rejects.toThrow(/amountCents/);
  await expect(bridge.grantOverageCredit({ ...input, expiresAt: undefined }, OPERATOR)).rejects.toThrow(/expiresAt/);
  await expect(bridge.grantOverageCredit({ ...input, expiresAt: '2000-01-01T00:00:00Z' }, OPERATOR)).rejects.toThrow(/billing_credit_expiry_past/);
  const tooLate = new Date(); tooLate.setUTCFullYear(tooLate.getUTCFullYear() + 3);
  await expect(bridge.grantOverageCredit({ ...input, expiresAt: tooLate.toISOString() }, OPERATOR)).rejects.toThrow(/billing_credit_expiry_too_late/);
  await expect(bridge.grantOverageCredit(input, {})).rejects.toThrow(/subject/);
  await env.DB.prepare("UPDATE workspaces SET region = 'enterprise' WHERE id = ?").bind(ORG).run();
  await expect(bridge.grantOverageCredit(input, OPERATOR)).rejects.toThrow(/organization_not_found/);
  await expect(Promise.resolve(stub().grantCredit(ORG, { operationId: OPERATION, amountCents: 5000, reason: 'Incident credit', expiresAt: input.expiresAt }))).rejects.toMatchObject({ code: 'billing_account_not_found' });
  expect(writes).toBe(0);
});

it('recovers a legacy lost-response grant through inspection by operation ID without a financial write', async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  await env.DB.prepare('INSERT INTO billing_credit_operations(workspace_id, operation_id, request_json) VALUES (?, ?, ?)')
    .bind(ORG, OPERATION, JSON.stringify({ request: { operationId: OPERATION, amountCents: 5000, reason: 'Legacy credit' }, priceId: 'price_overage', meterId: 'mtr_overage' })).run();
  expect(await bridge.inspectOverageCredits({ orgId: ORG, operationId: OPERATION })).toMatchObject({ grants: [], availableCents: 0 });
  grant = { id: 'credgr_1', customer: 'cus_1', amount: money(5000), effective_at: 1797768900, expires_at: null,
    applicability_config: { scope: { prices: [{ id: 'price_overage' }] } }, metadata: { receipt: `overage-credit:global:${ORG}:${OPERATION}` } };
  expect(await bridge.inspectOverageCredits({ orgId: ORG, operationId: OPERATION })).toMatchObject({
    availableCents: 5000, grants: [{ id: 'credgr_1', expiresAt: null }],
  });
  await expect(bridge.inspectOverageCredits({ orgId: ORG, operationId: USER })).rejects.toThrow(/billing_credit_operation_not_found/);
  expect(writes).toBe(0);
  expect(await env.DB.prepare('SELECT stripe_grant_id FROM billing_credit_operations').first()).toEqual({ stripe_grant_id: null });
});


it('grants audited subscription-fee-only trial months through the real actor while keeping overage billing eligible', async () => {
  const now = Math.floor(Date.now() / 1000);
  paidSubscription = { id: 'sub_paid', customer: 'cus_1', status: 'active', currency: 'usd', start_date: now - 86400,
    trial_end: null, current_period_end: now + 86400, cancel_at_period_end: false, cancel_at: null, discounts: [],
    metadata: { offer_id: 'grow', overage_enabled: 'true' }, items: { data: [{ price: { id: 'price_grow', product: 'prod_grow' } }] } };
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  const input = { orgId: ORG, operationId: OPERATION, months: 1, reason: 'Evaluation extension' };
  const result = await bridge.grantTrialMonths(input, OPERATOR);
  expect(result).toMatchObject({ subscriptionId: 'sub_paid', months: 1 });
  expect(Date.parse(result.trialEndsAt)).toBeGreaterThan((now + 86400) * 1000);
  expect(await bridge.grantTrialMonths(input, OPERATOR)).toEqual(result);
  expect(writes).toBe(1);
  expect(await env.DB.prepare('SELECT status, overage_enabled FROM billing_accounts WHERE workspace_id = ?').bind(ORG).first()).toEqual({ status: 'trialing', overage_enabled: 1 });
  const actions = await env.AUDIT_DB.prepare("SELECT DISTINCT action FROM audit_events WHERE workspace_id = ? AND action LIKE 'engineering.grant_trial_months.%' ORDER BY action").bind(ORG).all<{ action: string }>();
  expect(actions.results.map(row => row.action)).toEqual(['engineering.grant_trial_months.attempt', 'engineering.grant_trial_months.result']);
  const audit = await env.AUDIT_DB.prepare("SELECT metadata_json FROM audit_events WHERE workspace_id = ? AND action = 'engineering.grant_trial_months.result'").bind(ORG).first<{ metadata_json: string }>();
  expect(JSON.parse(audit!.metadata_json)).toMatchObject({ operator: OPERATOR, operationId: OPERATION, months: 1, subscriptionId: 'sub_paid', trialEndsAt: result.trialEndsAt });
  expect(audit!.metadata_json).not.toContain('Evaluation extension');
  await expect(bridge.grantTrialMonths({ ...input, operationId: '00000000-0000-7000-8000-00000000fcb4' }, {})).rejects.toThrow(/subject/);
});
