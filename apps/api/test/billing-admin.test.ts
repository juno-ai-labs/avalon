import '../../../tests/isolated-region';
import { afterEach, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { asWorkspaceId } from '@rally/contracts';
import { migratedSqliteDatabase, migratedUsageSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';
import { createTestEnv } from './helpers/cloudflare-test';
import { billingAccount, createCheckout } from '../src/services/billing';
import { administerOrgBilling, inspectOrgBilling } from '../src/services/billing-admin';
import { administerBillingCatalog, inspectBillingCatalog } from '../src/services/billing-catalog';
import { readBillingCatalog, resolveBillingEnvironment, billingConfig } from '../src/services/billing-config';

const ORG = asWorkspaceId('01900000-0000-7000-8000-0000000000aa');
const operationId = '01900000-0000-7000-8000-0000000000bb';
const nextId = '01900000-0000-7000-8000-0000000000cc';
const reason = 'Customer support adjustment';
const identity = { operationId, reason };
const grow = { id: 'grow', name: 'Grow', plan: 'growth' as const, priceId: 'price_grow', currencies: ['usd'], overagePriceId: 'price_overage', enabled: true };
const max = { ...grow, id: 'max', name: 'Max', plan: 'max' as const, priceId: 'price_max' };
const databases: DatabaseSync[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function seed() {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-12-20T12:00:00Z'));
  const db = migratedSqliteDatabase(); const usage = migratedUsageSqliteDatabase(); databases.push(db, usage);
  db.prepare("INSERT INTO users(id,google_subject,email,name,created_at,updated_at) VALUES ('owner','owner','owner@example.test','Owner','2026-11-01','2026-11-01')").run();
  db.prepare("INSERT INTO workspaces(id,name,slug,region,created_by_user_id,created_at,updated_at,plan) VALUES (?,'Org','org','global','owner','2026-11-01T00:00:00Z','2026-11-01','growth')").run(ORG);
  const env = createTestEnv({ DB: sqliteD1(db), USAGE_DB: sqliteD1(usage), AVALON_REGION: 'global', STRIPE_SECRET_KEY: 'sk_test_fake', BILLING_CONFIG: JSON.stringify({ returnUrl: 'https://app.example.test', offers: [grow, max] }) });
  await billingAccount(env, ORG);
  db.prepare("UPDATE billing_accounts SET customer_id='cus_1', subscription_id='sub_paid', status='active', offer_id='grow', currency='usd', overage_enabled=1 WHERE workspace_id=?").run(ORG);
  const provider = new Provider(); vi.stubGlobal('fetch', provider.fetch.bind(provider));
  return { env, db, usage, provider };
}
class Provider {
  writes: { path: string; fields: URLSearchParams; key: string | null }[] = [];
  portalMetadata: Record<string,string> = {};
  loseResponse = false;
  hideReceipts = false;
  receipts = new Map<string, { request: string; response: string }>();
  reject = false;
  refundCustomer = 'cus_1';
  sub = { id: 'sub_paid', customer: 'cus_1', status: 'active', currency: 'usd', start_date: Date.parse('2026-11-01') / 1000, ended_at: null as number | null, trial_end: null as number | null,
    discounts: [] as { end: number | null; coupon: { id: string; duration: string } }[], cancel_at_period_end: false, cancel_at: null as number | null, metadata: { offer_id: 'grow', overage_enabled: 'true' } as Record<string,string>,
    items: { data: [{ id: 'si_1', quantity: 1, price: { id: 'price_grow', product: 'prod_grow', unit_amount: 10000 } }] } };
  prices = [this.price('price_grow','prod_grow',10000), this.price('price_max','prod_max',25000)];
  coupons = [{ id: 'coupon_pilot', valid: true, amount_off: null, currency: null, percent_off: 100, duration: 'repeating', duration_in_months: 2, applies_to: { products: ['prod_grow','prod_max'] }, metadata: {} as Record<string,string> }];
  refunds: { id: string; status: string; amount: number; currency: string; metadata: Record<string,string> }[] = [];
  credits: typeof this.refunds = [];
  invoice = { id: 'in_1', customer: 'cus_1', status: 'open', currency: 'usd', total: 10000, amount_paid: 4000, amount_remaining: 6000, charge: 'ch_1', metadata: {} };
  private price(id: string, product: string, amount: number) { return { id, product, active: true, unit_amount: amount, unit_amount_decimal: String(amount), tax_behavior: 'exclusive', currency_options: {} as Record<string, { unit_amount: number; unit_amount_decimal: string; tax_behavior: string }>, currency: 'usd', billing_scheme: 'per_unit', transform_quantity: null, recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 }, metadata: {} as Record<string,string> }; }
  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = new URL(String(input)); const path = url.pathname.replace('/v1/',''); const fields = new URLSearchParams(String(init?.body ?? ''));
    const write = init?.method === 'POST' || init?.method === 'DELETE';
    const metadata = Object.fromEntries([...fields].filter(([key]) => key.startsWith('metadata[')).map(([key,value]) => [key.slice(9,-1),value]));
    const key = new Headers(init?.headers).get('Idempotency-Key');
    const request = `${init?.method}:${path}:${fields}`;
    if (write) {
      this.writes.push({ path, fields, key });
      const cached = key && this.receipts.get(key);
      if (cached) { if (cached.request !== request) throw new Error('idempotency_arguments_changed'); return new Response(cached.response, { headers: { 'content-type': 'application/json' } }); }
      if (this.reject) return Response.json({ error: { type: 'invalid_request_error', code: 'parameter_invalid_integer' } }, { status: 400 });
    }
    let value: unknown;
    if (path === 'subscriptions' && !write) value = { data: [this.sub], has_more: false };
    else if (path === 'subscriptions/sub_paid') {
      if (write) {
        if (fields.has('items[0][price]')) { const price = this.prices.find(price => price.id === fields.get('items[0][price]'))!; this.sub.items.data[0]!.price = { id: price.id, product: price.product, unit_amount: price.unit_amount }; }
        if (fields.has('cancel_at_period_end')) this.sub.cancel_at_period_end = fields.get('cancel_at_period_end') === 'true';
        if (init?.method === 'DELETE') { this.sub.status = 'canceled'; this.sub.ended_at = Date.now()/1000; }
        Object.assign(this.sub.metadata, metadata);
      }
      value = this.sub;
    } else if (path.startsWith('prices/') && !write) value = this.prices.find(price => price.id === path.slice(7));
    else if (path === 'prices') {
      if (write) { const price = this.price('price_new', fields.get('product')!, Number(fields.get('unit_amount'))); price.metadata = metadata; price.recurring.interval = fields.get('recurring[interval]')!; price.recurring.interval_count = Number(fields.get('recurring[interval_count]')); this.prices.push(price); value = price; }
      else value = { data: this.prices, has_more: false };
    } else if (path.startsWith('coupons/') && !write) value = this.coupons.find(coupon => coupon.id === path.slice(8));
    else if (path === 'coupons') {
      if (write) { const coupon = { id: fields.get('id')!, valid: true, amount_off: null, currency: null, percent_off: Number(fields.get('percent_off')), duration: fields.get('duration')!, duration_in_months: Number(fields.get('duration_in_months')), applies_to: { products: [...fields].filter(([key]) => key.startsWith('applies_to')).map(([,value]) => value) }, metadata }; this.coupons.push(coupon); value = coupon; }
      else value = { data: this.coupons, has_more: false };
    } else if (path === 'charges/ch_1') value = { id: 'ch_1', customer: this.refundCustomer, paid: true, amount: 10000, amount_refunded: this.refunds.reduce((sum,refund) => sum+refund.amount,0) };
    else if (path === 'refunds' || path === 'credit_notes') {
      const items = path === 'refunds' ? this.refunds : this.credits;
      if (write) {
        const item = { id: path === 'refunds' ? 're_1' : 'cn_1', status: path === 'refunds' ? 'succeeded' : 'issued', amount: Number(fields.get('amount')), currency: 'usd', metadata }; items.push(item); value = item;
        if (path === 'credit_notes') this.invoice.amount_remaining = Math.max(0,this.invoice.amount_remaining-item.amount);
      } else value = { data: this.hideReceipts ? [] : items, has_more: false };
    } else if (path === 'invoices') value = { data: [this.invoice], has_more: false };
    else if (path.startsWith('invoices/in_1')) { if (write) this.invoice.status = path.endsWith('/void') ? 'void' : 'uncollectible'; value = this.invoice; }
    else if (path === 'billing_portal/configurations') value = { data: [{ id: 'bpc_default', active: true, is_default: true }] };
    else if (path === 'billing_portal/configurations/bpc_default') { if (write) this.portalMetadata = metadata; value = { id: 'bpc_default', metadata: this.portalMetadata }; }
    else throw new Error(`unexpected_provider_path:${path}`);
    if (write && key) this.receipts.set(key, { request, response: JSON.stringify(value) });
    if (write && this.loseResponse) { this.loseResponse = false; throw new Error('response_lost'); }
    return Response.json(value);
  }
}
const change = { ...identity, orgId: ORG, kind: 'subscription' as const, subscriptionId: 'sub_paid', change: { type: 'plan' as const, offerId: 'max', proration: 'none' as const } };
const refund = { ...identity, orgId: ORG, kind: 'refund' as const, chargeId: 'ch_1', amountMinor: 2500 };

it('changes the Stripe plan with explicit proration and reconciles entitlement without losing overage consent', async () => {
  const { env, db, provider } = await seed();
  expect(await administerOrgBilling(env, change)).toMatchObject({ resourceId: 'sub_paid', status: 'active' });
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'max' });
  expect(db.prepare('SELECT offer_id, overage_enabled FROM billing_accounts').get()).toEqual({ offer_id: 'max', overage_enabled: 1 });
  expect(Object.fromEntries(provider.writes[0]!.fields)).toMatchObject({ 'items[0][id]': 'si_1', 'items[0][price]': 'price_max', 'items[0][quantity]': '1', proration_behavior: 'none', payment_behavior: 'error_if_incomplete' });
  await administerOrgBilling(env, change); expect(provider.writes).toHaveLength(1);
  await expect(administerOrgBilling(env, { ...change, change: { type: 'cancel', when: 'now' } })).rejects.toMatchObject({ code: 'billing_operation_conflict' });
});
it('recovers a lost subscription write after Stripe idempotency expiry and preserves explicit usage overrides', async () => {
  const { env, db, provider } = await seed(); db.prepare('UPDATE workspaces SET billing_plan_override=1').run(); provider.loseResponse = true;
  await expect(administerOrgBilling(env, change)).rejects.toThrow('response_lost');
  await expect(administerOrgBilling(env, { ...change, operationId: nextId })).rejects.toMatchObject({ code: 'billing_operation_pending' });
  vi.setSystemTime(new Date('2026-12-23T12:00:00Z'));
  await administerOrgBilling(env, change);
  expect(provider.writes).toHaveLength(1);
  expect(db.prepare('SELECT plan FROM workspaces').get()).toEqual({ plan: 'growth' });
  expect(db.prepare('SELECT offer_id FROM billing_accounts').get()).toEqual({ offer_id: 'max' });
});
it('schedules cancellation, resumes it, and cancels immediately without erasing earlier overages', async () => {
  const { env, db, provider } = await seed();
  await administerOrgBilling(env, { ...change, change: { type: 'cancel', when: 'period_end' } }); expect(provider.sub.cancel_at_period_end).toBe(true);
  await administerOrgBilling(env, { ...change, operationId: nextId, change: { type: 'resume' } }); expect(provider.sub.cancel_at_period_end).toBe(false);
  await administerOrgBilling(env, { ...change, operationId: crypto.randomUUID(), change: { type: 'cancel', when: 'now' } });
  expect(db.prepare('SELECT status,overage_enabled FROM billing_accounts').get()).toEqual({ status: 'canceled', overage_enabled: 1 });
  expect(db.prepare('SELECT ends_at FROM billing_terms').get()).toEqual({ ends_at: Date.parse('2026-12-20T12:00:00Z')/1000 });
  expect(Object.fromEntries(provider.writes.at(-1)!.fields)).toEqual({ prorate: 'false', invoice_now: 'false' });
});
it('refuses another customer charge and recovers an uncertain refund exactly once after 24 hours', async () => {
  const { env, provider } = await seed(); provider.refundCustomer = 'cus_other';
  await expect(administerOrgBilling(env, refund)).rejects.toMatchObject({ code: 'billing_customer_mismatch' }); expect(provider.writes).toHaveLength(0);
  provider.refundCustomer = 'cus_1'; provider.loseResponse = true;
  await expect(administerOrgBilling(env, refund)).rejects.toThrow('response_lost'); vi.setSystemTime(new Date('2026-12-23T12:00:00Z'));
  expect(await administerOrgBilling(env, refund)).toMatchObject({ resourceId: 're_1', amountMinor: 2500, currency: 'usd' });
  expect(provider.refunds).toHaveLength(1); expect(provider.writes).toHaveLength(1);
  await expect(administerOrgBilling(env, { ...refund, amountMinor: 3000 })).rejects.toMatchObject({ code: 'billing_operation_conflict' });
});
it('refuses blind replay of an expired uncertain write without a provider receipt', async () => {
  const { env, db, provider } = await seed(); provider.loseResponse = true;
  await expect(administerOrgBilling(env, refund)).rejects.toThrow('response_lost'); provider.refunds = [];
  vi.setSystemTime(new Date('2026-12-23T12:00:00Z'));
  await expect(administerOrgBilling(env, refund)).rejects.toMatchObject({ code: 'billing_operation_uncertain_expired' });
  expect(provider.writes).toHaveLength(1); expect(db.prepare('SELECT result_json FROM billing_admin_operations').get()).toEqual({ result_json: null });
});
it('issues a credit note with only the paid portion refunded and recovers without a second credit', async () => {
  const { env, provider } = await seed();
  const request = { ...identity, orgId: ORG, kind: 'invoice' as const, invoiceId: 'in_1', correction: { type: 'credit_note' as const, amountMinor: 8000, disposition: 'refund' as const } };
  provider.loseResponse = true; await expect(administerOrgBilling(env, request)).rejects.toThrow('response_lost');
  expect(await administerOrgBilling(env, request)).toMatchObject({ resourceId: 'cn_1', amountMinor: 8000 });
  expect(provider.invoice.amount_remaining).toBe(0); expect(provider.credits).toHaveLength(1);
  expect(Object.fromEntries(provider.writes[0]!.fields)).toMatchObject({ invoice: 'in_1', amount: '8000', refund_amount: '2000' });
});
it('refuses cross-customer invoice corrections and ambiguous disposition of paid money', async () => {
  const { env, provider } = await seed();
  const request = { ...identity, orgId: ORG, kind: 'invoice' as const, invoiceId: 'in_1', correction: { type: 'credit_note' as const, amountMinor: 8000, disposition: 'invoice_balance' as const } };
  await expect(administerOrgBilling(env, request)).rejects.toMatchObject({ code: 'billing_credit_note_post_payment_disposition_required' });
  provider.invoice.customer = 'cus_other'; await expect(administerOrgBilling(env, { ...request, correction: { type: 'void' } })).rejects.toMatchObject({ code: 'billing_customer_mismatch' });
  expect(provider.writes).toHaveLength(0);
});
it.each(['void','uncollectible'] as const)('corrects an open invoice with %s and recovers a lost reply', async type => {
  const { env, provider } = await seed(); const request = { ...identity, orgId: ORG, kind: 'invoice' as const, invoiceId: 'in_1', correction: { type } };
  provider.loseResponse = true; await expect(administerOrgBilling(env, request)).rejects.toThrow('response_lost');
  expect(await administerOrgBilling(env, request)).toMatchObject({ resourceId: 'in_1', status: type }); expect(provider.writes).toHaveLength(1);
});
it('records definitive Stripe refusals so a new operation can proceed', async () => {
  const { env, provider } = await seed(); provider.reject = true;
  await expect(administerOrgBilling(env, refund)).rejects.toMatchObject({ code: 'stripe_http_400' }); provider.reject = false;
  await expect(administerOrgBilling(env, refund)).rejects.toMatchObject({ code: expect.stringContaining('stripe_http_400') });
  expect(await administerOrgBilling(env, { ...refund, operationId: nextId })).toMatchObject({ resourceId: 're_1' });
});
it('inspects live subscription and invoice identities without creating another Stripe object', async () => {
  const { env, provider } = await seed();
  expect(await inspectOrgBilling(env, { orgId: ORG })).toMatchObject({ customerId: 'cus_1', subscriptionId: 'sub_paid', usagePlanOverride: false,
    invoices: [{ id: 'in_1', amountPaid: 4000, amountRemaining: 6000, chargeId: 'ch_1' }], subscriptions: [{ id: 'sub_paid', priceIds: ['price_grow'] }], pendingOperations: [], nextInvoicePage: null });
  expect(provider.writes).toHaveLength(0);
});
it('creates prices and product-scoped coupons without publishing them or repricing subscribers', async () => {
  const { env, provider } = await seed();
  const price = { ...identity, region: 'global' as const, kind: 'price' as const, sourceOfferId: 'grow', amountMinor: 12000, currency: 'usd', interval: 'month' as const, intervalCount: 1, taxBehavior: 'exclusive' as const };
  provider.loseResponse = true; await expect(administerBillingCatalog(env, price)).rejects.toThrow('response_lost');
  expect(await administerBillingCatalog(env, price)).toMatchObject({ resourceId: 'price_new' });
  expect(provider.prices.at(-1)).toMatchObject({ product: 'prod_grow', unit_amount: 12000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } });
  expect(provider.writes[0]!.fields.get('tax_behavior')).toBe('exclusive');
  const coupon = { ...identity, operationId: nextId, region: 'global' as const, kind: 'coupon' as const, name: 'Pilot', offerIds: ['grow','max'], percentOff: 100, duration: { type: 'repeating' as const, months: 2 } };
  await administerBillingCatalog(env, coupon);
  expect(provider.coupons.at(-1)).toMatchObject({ percent_off: 100, duration_in_months: 2, applies_to: { products: ['prod_grow','prod_max'] } });
  expect((await readBillingCatalog(env)).revision).toBe(0); expect(provider.sub.items.data[0]!.price.id).toBe('price_grow'); expect(provider.writes).toHaveLength(2);
});
it('publishes a versioned catalog and portal while retaining retired mappings and refreshing operation snapshots', async () => {
  const { env, provider, db } = await seed();
  const initialSnapshot = await resolveBillingEnvironment(env);
  const request = { ...identity, region: 'global' as const, kind: 'catalog' as const, expectedRevision: 0, catalog: { offers: [{ ...grow, enabled: false },max], pilotCouponId: 'coupon_pilot' } };
  expect(await administerBillingCatalog(env, request)).toMatchObject({ revision: 1, status: 'published' });
  expect((await readBillingCatalog(env)).offers[0]!.enabled).toBe(false);
  expect(billingConfig(await resolveBillingEnvironment(env)).pilotCouponId).toBe('coupon_pilot'); expect(billingConfig(initialSnapshot).pilotCouponId).toBeUndefined();
  expect(db.prepare('SELECT revision FROM billing_catalog').get()).toEqual({ revision: 1 });
  expect(Object.fromEntries(provider.writes[0]!.fields)).toMatchObject({ 'features[subscription_update][products][0][product]': 'prod_max', 'features[subscription_update][products][0][prices][0]': 'price_max', 'features[subscription_update][trial_update_behavior]': 'continue_trial' });
  await expect(createCheckout(env, ORG, 'grow', 'usd', false)).rejects.toMatchObject({ code: 'billing_offer_unavailable' });
  await administerBillingCatalog(env, request); expect(provider.writes).toHaveLength(1);
  await expect(administerBillingCatalog(env, { ...request, operationId: nextId })).rejects.toMatchObject({ code: 'billing_catalog_revision_conflict' });
});
it('rejects catalog deletion or reinterpretation of a historical price and preserves pilot scope', async () => {
  const { env, provider } = await seed();
  const request = { ...identity, region: 'global' as const, kind: 'catalog' as const, expectedRevision: 0, catalog: { offers: [max], pilotCouponId: null } };
  await expect(administerBillingCatalog(env, request)).rejects.toMatchObject({ code: 'billing_catalog_history_required' });
  await expect(administerBillingCatalog(env, { ...request, catalog: { ...request.catalog, offers: [{ ...grow, priceId: 'price_max' },max] } })).rejects.toMatchObject({ code: 'billing_catalog_history_required' });
  provider.coupons[0]!.applies_to.products = ['prod_grow'];
  await expect(administerBillingCatalog(env, { ...request, catalog: { offers: [grow,max], pilotCouponId: 'coupon_pilot' } })).rejects.toMatchObject({ code: 'billing_coupon_scope_invalid' });
  expect(provider.writes).toHaveLength(0);
});

it('applies and removes scoped subscription promotions without altering overage consent', async () => {
  const { env, provider } = await seed();
  await administerOrgBilling(env, { ...change, change: { type: 'promotion', couponId: 'coupon_pilot' } });
  expect(Object.fromEntries(provider.writes[0]!.fields)).toMatchObject({ 'discounts[0][coupon]': 'coupon_pilot', proration_behavior: 'none' });
  await administerOrgBilling(env, { ...change, operationId: nextId, change: { type: 'promotion', couponId: null } });
  expect(provider.writes[1]!.fields.get('discounts')).toBe(''); expect(provider.sub.metadata.overage_enabled).toBe('true');
});
it('recovers a lost Portal publication after 24 hours before publishing Checkout configuration', async () => {
  const { env, provider } = await seed();
  const request = { ...identity, region: 'global' as const, kind: 'catalog' as const, expectedRevision: 0, catalog: { offers: [grow,max], pilotCouponId: 'coupon_pilot' } };
  provider.loseResponse = true; await expect(administerBillingCatalog(env, request)).rejects.toThrow('response_lost');
  expect((await readBillingCatalog(env)).revision).toBe(0);
  vi.setSystemTime(new Date('2026-12-23T12:00:00Z'));
  expect(await administerBillingCatalog(env, request)).toMatchObject({ revision: 1 });
  expect((await readBillingCatalog(env)).pilotCouponId).toBe('coupon_pilot'); expect(provider.writes).toHaveLength(1);
});


it('keeps the same Stripe key and frozen refund arguments when receipt discovery lags within 24 hours', async () => {
  const { env, provider } = await seed();
  provider.loseResponse = true; provider.hideReceipts = true;
  await expect(administerOrgBilling(env, refund)).rejects.toThrow('response_lost');
  vi.setSystemTime(new Date('2026-12-20T13:00:00Z'));
  expect(await administerOrgBilling(env, refund)).toMatchObject({ resourceId: 're_1', amountMinor: 2500 });
  expect(provider.refunds).toHaveLength(1);
  expect(provider.writes).toHaveLength(2);
  expect(provider.writes.map(write => write.key)).toEqual([
    `billing-admin:global:${ORG}:${operationId}`, `billing-admin:global:${ORG}:${operationId}`,
  ]);
  expect(provider.writes.map(write => Object.fromEntries(write.fields))).toEqual([0,1].map(() => ({ charge: 'ch_1', amount: '2500',
    'metadata[rally_admin_operation]': `billing-admin:global:${ORG}:${operationId}`, 'metadata[rally_admin_reason]': reason,
  })));
  expect(provider.refunds).toHaveLength(1);
});

it('refuses coupons covering metered overages for subscription promotions and catalog publication', async () => {
  const { env, provider } = await seed();
  env.BILLING_CONFIG = JSON.stringify({ ...JSON.parse(env.BILLING_CONFIG!), overageCredits: { priceId: 'price_overage', meterId: 'mtr_overage' } });
  provider.prices.push({ ...provider.prices[0]!, id: 'price_overage', product: 'prod_overage' });
  provider.coupons[0]!.applies_to.products.push('prod_overage');
  // Promotion preparation refreshes the account; disable consent for this scope
  // test so that refresh does not provision a metered subscription first.
  provider.sub.metadata.overage_enabled = 'false';
  await expect(administerOrgBilling(env, { ...change, change: { type: 'promotion', couponId: 'coupon_pilot' } })).rejects.toMatchObject({ code: 'billing_coupon_includes_overages' });
  await expect(administerBillingCatalog(env, { ...identity, region: 'global', kind: 'catalog', expectedRevision: 0,
    catalog: { offers: [grow,max], pilotCouponId: 'coupon_pilot' } })).rejects.toMatchObject({ code: 'billing_coupon_includes_overages' });
  expect(provider.writes).toHaveLength(0);
});

it('preserves existing repeating discounts when annual prices are published after the pilot ends', async () => {
  const { env, provider } = await seed();
  const annual = { ...grow, id: 'grow_annual', priceId: 'price_annual' };
  provider.prices.push({ ...provider.prices[0]!, id: 'price_annual', recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 } });
  provider.sub.discounts = [{ end: Date.parse('2027-01-01') / 1000, coupon: { id: 'coupon_pilot', duration: 'repeating' } }];
  await administerBillingCatalog(env, { ...identity, region: 'global', kind: 'catalog', expectedRevision: 0,
    catalog: { offers: [grow,max,annual], pilotCouponId: null } });
  expect([...provider.writes[0]!.fields.values()]).not.toContain('price_annual');
  await expect(administerOrgBilling(env, { ...change, change: { type: 'plan', offerId: 'grow_annual', proration: 'none' } })).rejects.toMatchObject({ code: 'billing_discount_requires_monthly_price' });
  expect(provider.writes).toHaveLength(1);
  provider.sub.discounts = [];
  expect(await administerOrgBilling(env, { ...change, change: { type: 'plan', offerId: 'grow_annual', proration: 'none' } })).toMatchObject({ status: 'active' });
  expect(provider.writes[1]!.fields.get('items[0][price]')).toBe('price_annual');
  await expect(administerOrgBilling(env, { ...change, operationId: nextId, change: { type: 'promotion', couponId: 'coupon_pilot' } })).rejects.toMatchObject({ code: 'billing_discount_requires_monthly_price' });
  await expect(administerBillingCatalog(env, { ...identity, operationId: nextId, region: 'global', kind: 'catalog', expectedRevision: 1,
    catalog: { offers: [grow,max,{ ...annual, couponId: 'coupon_pilot' }], pilotCouponId: null } })).rejects.toMatchObject({ code: 'billing_discount_requires_monthly_price' });
  expect(provider.writes).toHaveLength(2);
});

it('inspects live price currency options and coupon terms without publishing them', async () => {
  const { env, provider } = await seed();
  env.BILLING_CONFIG = JSON.stringify({ ...JSON.parse(env.BILLING_CONFIG!), pilotCouponId: 'coupon_pilot' });
  provider.prices[0]!.currency_options.eur = { unit_amount: 9000, unit_amount_decimal: '9000', tax_behavior: 'inclusive' };
  const result = await inspectBillingCatalog(env);
  expect(result.prices[0]).toMatchObject({ id: 'price_grow', amountMinor: 10000, amountDecimal: '10000', currency: 'usd', taxBehavior: 'exclusive',
    recurring: { interval: 'month', intervalCount: 1, usageType: 'licensed' }, currencyOptions: { eur: { amountMinor: 9000, amountDecimal: '9000', taxBehavior: 'inclusive' } } });
  expect(result.coupons).toEqual([{ id: 'coupon_pilot', valid: true, percentOff: 100, amountOff: null, currency: null, duration: 'repeating', months: 2, productIds: ['prod_grow','prod_max'] }]);
  expect(result.revision).toBe(0); expect(provider.writes).toHaveLength(0);
});
