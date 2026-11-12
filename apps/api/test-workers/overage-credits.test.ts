import { env } from 'cloudflare:workers';
import { createExecutionContext, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineeringInspectionBridge } from '../src/engineering-inspection-bridge';
import { seedInspectableWorkspace } from './helpers/engineering-inspection-fixture';
import { billingAccount } from '../src/services/billing';
import billingMigration from '../../../packages/db/migrations/0131_billing.sql?raw';

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
let writes = 0;
let grant: Record<string, unknown> | null = null;
beforeEach(async () => {
  await reset(); writes = 0; grant = null;
  await seedInspectableWorkspace(env.DB, { workspaceId: ORG, userId: USER, sessionId: 'credit-operator', at: '2026-11-01T00:00:00Z' });
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-11-01T00:00:00Z'"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'"),
  ]);
  await env.DB.exec(billingMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await billingAccount(configured(), ORG);
  await env.DB.prepare("UPDATE billing_accounts SET customer_id = 'cus_1'").run();
  await runInDurableObject(stub(), (instance) => { Object.defineProperty(instance, 'env', { value: configured(), configurable: true }); });
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input); const path = url.pathname.replace('/v1/', ''); const fields = new URLSearchParams(String(init?.body ?? ''));
    if (path === 'prices/price_overage') return Response.json({ currency: 'usd', unit_amount_decimal: '0.0001', billing_scheme: 'per_unit', transform_quantity: null,
      recurring: { usage_type: 'metered', interval: 'month', interval_count: 1, meter: 'mtr_overage' } });
    if (path === 'billing/meters/mtr_overage') return Response.json({ id: 'mtr_overage', event_name: 'overage', status: 'active', event_time_window: 'hour', default_aggregation: { formula: 'sum' },
      customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }, value_settings: { event_payload_key: 'value' } });
    if (path === 'billing/credit_grants' && init?.method === 'POST') {
      writes++;
      grant = { id: 'credgr_1', customer: 'cus_1', amount: money(5000), effective_at: Math.floor(Date.now() / 1000), expires_at: null,
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
  const input = { orgId: ORG, operationId: OPERATION, amountCents: 5000, reason: 'Incident credit' };
  expect(await bridge.grantOverageCredit(input, OPERATOR)).toMatchObject({ id: 'credgr_1', availableCents: 5000, voided: false });
  expect(await bridge.inspectOverageCredits({ orgId: ORG })).toMatchObject({ availableCents: 5000 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => stub().grantCredit(ORG, { operationId: OPERATION, amountCents: 5000, reason: 'Incident credit' })));
  expect(results.some(result => result.status === 'fulfilled')).toBe(true);
  expect(results.some(result => result.status === 'rejected')).toBe(true);
  expect(writes).toBe(1);
  const audits = await env.AUDIT_DB.prepare("SELECT action, metadata_json FROM audit_events WHERE workspace_id = ? AND action LIKE 'engineering.grant_overage_credit.%' ORDER BY action")
    .bind(ORG).all<{ action: string; metadata_json: string }>();
  expect(audits.results.map(row => row.action)).toEqual(['engineering.grant_overage_credit.attempt', 'engineering.grant_overage_credit.result']);
  expect(JSON.parse(audits.results[1]!.metadata_json)).toMatchObject({ operator: OPERATOR, operationId: OPERATION, amountCents: 5000, grantId: 'credgr_1', outcome: 'admitted' });
  expect(audits.results.some(row => row.metadata_json.includes('Incident credit'))).toBe(false);
});

it('refuses invalid operator input and another regions organization before issuing a grant', async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  const input = { orgId: ORG, operationId: OPERATION, amountCents: 5000, reason: 'Incident credit' };
  await expect(bridge.grantOverageCredit({ ...input, amountCents: -1 }, OPERATOR)).rejects.toThrow(/amountCents/);
  await expect(bridge.grantOverageCredit(input, {})).rejects.toThrow(/subject/);
  await env.DB.prepare("UPDATE workspaces SET region = 'enterprise' WHERE id = ?").bind(ORG).run();
  await expect(bridge.grantOverageCredit(input, OPERATOR)).rejects.toThrow(/organization_not_found/);
  await expect(Promise.resolve(stub().grantCredit(ORG, { operationId: OPERATION, amountCents: 5000, reason: 'Incident credit' }))).rejects.toMatchObject({ code: 'billing_account_not_found' });
  expect(writes).toBe(0);
});
