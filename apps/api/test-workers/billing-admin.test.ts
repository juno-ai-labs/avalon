import { asApiError } from "../src/lib/api-error";
import { asWorkspaceId } from "@rally/contracts";
import { env } from 'cloudflare:workers';
import { createExecutionContext, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { EngineeringInspectionBridge } from '../src/engineering-inspection-bridge';
import { seedInspectableWorkspace } from './helpers/engineering-inspection-fixture';
import { ensureAuditSchema } from './helpers/audit-fixture';
import { billingAccount } from '../src/services/billing';
import billingMigration from '../../../packages/db/migrations/0131_billing.sql?raw';
import signupMigration from '../../../packages/db/migrations/0132_signup_trials.sql?raw';

const ORG = asWorkspaceId('00000000-0000-7000-8000-00000000fda1');
const OPERATION = '00000000-0000-7000-8000-00000000fda2';
const OPERATOR = { subject: 'engineer', email: 'engineer@example.test', audience: 'engineering-mcp' };
const configured = () => ({ ...env, STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify({ returnUrl: 'https://app.test',
  offers: [{ id: 'grow', name: 'Grow', plan: 'growth', priceId: 'price_grow', currencies: ['usd'] }],
}) });
const actor = () => env.BILLING_COORDINATORS.getByName(`global:billing:${ORG}`);
const catalogActor = () => env.BILLING_COORDINATORS.getByName('global:billing:catalog');
let writes = 0;
let beforeWrite: (() => Promise<void>) | undefined;
beforeAll(async () => {
  // The pool crashes when reset destroys an RPC callback between these tests.
  // One schema per file and independent operation scopes avoid tearing down live
  // runtime machinery; only provider counters are reset between cases.
  await reset();
  await seedInspectableWorkspace(env.DB, { workspaceId: ORG, userId: '00000000-0000-7000-8000-00000000fda3', sessionId: 'billing-admin', at: '2026-11-01T00:00:00Z' });
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-11-01T00:00:00Z'"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'growth'"),
    env.DB.prepare('ALTER TABLE workspaces ADD COLUMN updated_at TEXT'),
  ]);
  await env.DB.exec(billingMigration.replace(/--[^\n]*\n/g,'').replace(/\s*\n\s*/g,' '));
  await env.DB.exec(signupMigration.replace(/--[^\n]*\n/g, '').replace(/\s*\n\s*/g, ' '));
  await ensureAuditSchema(); await billingAccount(configured(), ORG);
  await env.DB.prepare("UPDATE billing_accounts SET customer_id='cus_1'").run();
  for (const stub of [actor(),catalogActor()]) await runInDurableObject(stub, instance => { Object.defineProperty(instance,'env',{ value: configured(), configurable: true }); });
});
beforeEach(() => {
  writes = 0; beforeWrite = undefined;
  vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname.replace('/v1/','');
    if (init?.method === 'POST') { writes++; if (writes === 1) await beforeWrite?.(); }
    if (path === 'charges/ch_1') return Response.json({ id: 'ch_1', customer: 'cus_1', amount: 10000, amount_refunded: 0, paid: true });
    if (path === 'refunds') return Response.json(init?.method === 'POST' ? { id: 're_1', status: 'succeeded', amount: 1500, currency: 'usd' } : { data: [], has_more: false });
    if (path === 'prices/price_grow') return Response.json({ id: 'price_grow', product: 'prod_grow', active: true, unit_amount: 10000, unit_amount_decimal: '10000', tax_behavior: 'exclusive', currency: 'usd', billing_scheme: 'per_unit', transform_quantity: null, recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 } });
    if (path === 'billing_portal/configurations') return Response.json({ data: [{ id: 'bpc_1', is_default: true, active: true }] });
    if (path === 'billing_portal/configurations/bpc_1') return Response.json({ id: 'bpc_1', metadata: {} });
    throw new Error(`unexpected_provider_path:${path}`);
  });
});
afterEach(() => vi.unstubAllGlobals());

it('audits a refund through the real actor, excludes concurrent writes, and refuses unauthenticated or misrouted mutations', async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  const request = { orgId: ORG, operationId: OPERATION, kind: 'refund' as const, chargeId: 'ch_1', amountMinor: 1500, reason: 'Incident adjustment' };
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  beforeWrite = async () => { entered(); await held; };
  const first = bridge.administerOrgBilling(request, OPERATOR); await started;
  try { await expect(bridge.administerOrgBilling(request, OPERATOR)).rejects.toThrow(/billing_busy/); }
  finally { release(); await first; }
  expect(await first).toMatchObject({ resourceType: 'refund', resourceId: 're_1', amountMinor: 1500 });
  expect(await bridge.administerOrgBilling(request, OPERATOR)).toMatchObject({ resourceId: 're_1' }); expect(writes).toBe(1);
  const row = await env.DB.prepare('SELECT result_json FROM billing_admin_operations WHERE scope=? AND operation_id=?').bind(ORG,OPERATION).first<{ result_json: string }>();
  expect(JSON.parse(row!.result_json)).toMatchObject({ resourceId: 're_1', status: 'succeeded' });
  const audit = await env.AUDIT_DB.prepare("SELECT metadata_json FROM audit_events WHERE workspace_id=? AND action='engineering.administer_billing.result' AND metadata_json LIKE '%admitted%' LIMIT 1").bind(ORG).first<{ metadata_json: string }>();
  expect(JSON.parse(audit!.metadata_json)).toMatchObject({ operator: OPERATOR, resourceId: 're_1', operationId: OPERATION });
  expect(audit!.metadata_json).not.toContain('Incident adjustment');
  await expect(bridge.administerOrgBilling(request, {})).rejects.toThrow(/subject/);
  // Use the configured actor, as for the successful calls; a second owned
  // Organization must still fail the actor-name fence before touching Stripe.
  const other = asWorkspaceId('00000000-0000-7000-8000-00000000fda4');
  await env.DB.prepare("INSERT INTO workspaces(id, region) VALUES (?, 'global')").bind(other).run();
  expect(await runInDurableObject(actor(), async instance => {
    try { await instance.administer(other, { ...request, orgId: other }); return 'admitted'; }
    catch (error) { return asApiError(error)?.code; }
  })).toBe('billing_account_not_found');
  expect(writes).toBe(1);
});
it('publishes and audits a regional catalog through its dedicated actor and requires audit admission', async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), configured());
  const current = await bridge.inspectBillingCatalog({ region: 'global' });
  const request = { operationId: OPERATION, reason: 'End pilot', kind: 'catalog' as const, region: 'global' as const, expectedRevision: 0, catalog: { offers: current.offers, pilotCouponId: null } };
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  beforeWrite = async () => { entered(); await held; };
  const publication = bridge.administerBillingCatalog(request, OPERATOR); await started;
  try { await expect(bridge.administerBillingCatalog(request, OPERATOR)).rejects.toThrow(/billing_busy/); }
  finally { release(); await publication; }
  expect(await publication).toMatchObject({ status: 'published', revision: 1 });
  expect(await bridge.inspectBillingCatalog({ region: 'global' })).toMatchObject({ revision: 1, pilotCouponId: null });
  const audit = await env.AUDIT_DB.prepare("SELECT metadata_json FROM audit_events WHERE action='engineering.configure_billing.result' AND metadata_json LIKE '%admitted%'").first<{ metadata_json: string }>();
  expect(JSON.parse(audit!.metadata_json)).toMatchObject({ operator: OPERATOR, resourceType: 'catalog', revision: 1 });
  expect(await runInDurableObject(actor(), async instance => {
    try { await instance.configure(request); return 'admitted'; }
    catch (error) { return asApiError(error)?.code; }
  })).toBe('billing_region_mismatch');
  const blockedId = '00000000-0000-7000-8000-00000000fda5';
  await env.AUDIT_DB.prepare(`CREATE TRIGGER block_billing_admin_audit BEFORE INSERT ON audit_events
    WHEN NEW.request_id = '${blockedId}' BEGIN SELECT RAISE(ABORT, 'billing_audit_unavailable'); END`).run();
  try { await expect(bridge.administerBillingCatalog({ ...request, operationId: blockedId, expectedRevision: 1 }, OPERATOR)).rejects.toThrow(); }
  finally { await env.AUDIT_DB.prepare('DROP TRIGGER block_billing_admin_audit').run(); }
  expect(writes).toBe(1); expect((await bridge.inspectBillingCatalog({ region: 'global' })).revision).toBe(1);
});
