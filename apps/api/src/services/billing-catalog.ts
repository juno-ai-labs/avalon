import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { ApiError } from "../lib/api-error";
import { z } from 'zod';
import { BillingCatalogInspectionSchema, BillingCatalogMutationSchema, type BillingCatalogMutation, type BillingMutationResult, type BillingCatalog } from '@rally/contracts/billing-admin';
import type { Env } from '../env';
import { billingConfig, BillingConfigSchema, readBillingCatalog, resolveBillingEnvironment } from './billing-config';
import { AdminPrice, AdminCoupon, readAdminPrice, requireLicensedPrice, requirePlanCoupon } from './billing-admin';
import { billingOperation, billingRefusal } from './billing-admin-operations';
import { stripe } from './stripe';

const enc = encodeURIComponent;
interface Delivery { path: string; fields: Record<string, string>; recoveryList?: string; couponId?: string; catalog?: BillingCatalog; expectedRevision?: number }
const receipt = (request: BillingCatalogMutation, id: string, status = 'created', revision?: number): BillingMutationResult => ({ operationId: request.operationId, resourceId: id, resourceType: request.kind, status, ...(revision === undefined ? {} : { revision }) });

/** Live provider terms are inspection data, never persisted as catalog authority. */
export async function inspectBillingCatalog(env: Env) {
  const catalog = await readBillingCatalog(env);
  const amount = z.object({ unit_amount: z.number().nullable(), unit_amount_decimal: z.string().nullable(), tax_behavior: z.string() });
  const prices = await Promise.all([...new Set(catalog.offers.map(offer => offer.priceId))].map(async id => {
    const price = await stripe(env, `prices/${enc(id)}?expand[]=currency_options`, AdminPrice.extend({ ...amount.shape, currency_options: z.record(z.string(), amount).optional() }));
    const describe = (value: z.infer<typeof amount>) => ({ amountMinor: value.unit_amount, amountDecimal: value.unit_amount_decimal, taxBehavior: value.tax_behavior });
    return { id: price.id, productId: price.product, active: price.active, currency: price.currency, ...describe(price),
      recurring: price.recurring && { interval: price.recurring.interval, intervalCount: price.recurring.interval_count, usageType: price.recurring.usage_type },
      currencyOptions: Object.fromEntries(Object.entries(price.currency_options ?? {}).map(([currency, value]) => [currency, describe(value)])),
    };
  }));
  const couponIds = new Set([...catalog.offers.map(offer => offer.couponId), catalog.pilotCouponId].filter((id): id is string => Boolean(id)));
  const coupons = await Promise.all([...couponIds].map(async id => {
    const coupon = await stripe(env, `coupons/${enc(id)}?expand[]=applies_to`, AdminCoupon.extend({ amount_off: z.number().nullable(), currency: z.string().nullable() }));
    return { id: coupon.id, valid: coupon.valid, percentOff: coupon.percent_off, amountOff: coupon.amount_off, currency: coupon.currency,
      duration: coupon.duration, months: coupon.duration_in_months, productIds: coupon.applies_to?.products ?? null };
  }));
  return BillingCatalogInspectionSchema.parse({ ...catalog, prices, coupons });
}
async function prepare(env: Env, request: BillingCatalogMutation): Promise<Delivery> {
  const current = await readBillingCatalog(env);
  if (request.kind === 'price') {
    const offer = current.offers.find(offer => offer.id === request.sourceOfferId);
    if (!offer || offer.plan === 'starter') billingRefusal('billing_source_offer_unknown');
    const source = await readAdminPrice(env, offer.priceId);
    return { path: 'prices', recoveryList: `prices?product=${enc(source.product)}`, fields: {
      product: source.product, unit_amount: String(request.amountMinor), currency: request.currency,
      'recurring[interval]': request.interval, 'recurring[interval_count]': String(request.intervalCount), tax_behavior: request.taxBehavior,
    } };
  }
  if (request.kind === 'coupon') {
    const products = new Set<string>();
    for (const id of request.offerIds) {
      const offer = current.offers.find(offer => offer.id === id);
      if (!offer || offer.plan === 'starter') billingRefusal('billing_coupon_offer_unknown');
      products.add((await readAdminPrice(env, offer.priceId)).product);
    }
    const couponId = `rally_${env.AVALON_REGION}_${request.operationId}`;
    const fields: Record<string, string> = { id: couponId, name: request.name, percent_off: String(request.percentOff), duration: request.duration.type };
    if (request.duration.type === 'repeating') fields.duration_in_months = String(request.duration.months);
    [...products].forEach((product, i) => { fields[`applies_to[products][${i}]`] = product; });
    return { path: 'coupons', fields, couponId, recoveryList: 'coupons?' };
  }
  if (request.expectedRevision !== current.revision) billingRefusal('billing_catalog_revision_conflict');
  const proposed = { ...request.catalog, signupTrial: request.catalog.signupTrial === undefined ? current.signupTrial : request.catalog.signupTrial };
  const parsed = BillingConfigSchema.safeParse({ ...billingConfig(env), ...proposed, pilotCouponId: proposed.pilotCouponId ?? undefined, signupTrial: proposed.signupTrial ?? undefined });
  if (!parsed.success) throw new ApiError(400, zodDiagnosticCode(parsed.error, 'billing_catalog')!, 'Billing catalog is invalid');
  // Historical prices must stay mapped to their original entitlement and
  // overage rate. New prices use new offer IDs; disable the retired offer.
  for (const old of current.offers) {
    const next = proposed.offers.find(offer => offer.id === old.id);
    if (!next || next.priceId !== old.priceId || next.plan !== old.plan || next.overagePriceId !== old.overagePriceId) billingRefusal('billing_catalog_history_required');
  }
  const productPlans = new Map<string, string>();
  const prices = new Map<string, z.infer<typeof AdminPrice>>();
  for (const offer of proposed.offers) {
    const price = await readAdminPrice(env, offer.priceId); prices.set(offer.id, price);
    const plan = productPlans.get(price.product);
    if (plan && plan !== offer.plan) billingRefusal('billing_product_plan_conflict');
    productPlans.set(price.product, offer.plan);
    if (offer.enabled) {
      requireLicensedPrice(price);
      if (offer.currencies.some(currency => currency !== price.currency && !Object.hasOwn(price.currency_options ?? {}, currency))) billingRefusal('billing_currency_unavailable');
      if (offer.couponId) {
        const coupon = await requirePlanCoupon(env, offer.couponId, [price.product]);
        if (coupon.duration === 'repeating' && (price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1)) billingRefusal('billing_discount_requires_monthly_price');
      }
    }
    // Infrastructure rates/meters are deployment-owned. Publishing a catalog
    // cannot silently introduce a new financial meter or overage unit price.
    if (offer.overagePriceId && !current.offers.some(old => old.overagePriceId === offer.overagePriceId)) billingRefusal('billing_overage_price_not_configured');
  }
  const active = proposed.offers.filter(offer => offer.enabled && offer.plan !== 'starter');
  if (proposed.signupTrial) {
    const price = prices.get(proposed.signupTrial.offerId)!;
    if (price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) billingRefusal('billing_signup_trial_requires_monthly_price');
  }
  if (proposed.pilotCouponId) {
    await requirePlanCoupon(env, proposed.pilotCouponId, active.map(offer => prices.get(offer.id)!.product));
    if (active.some(offer => prices.get(offer.id)!.recurring?.interval !== 'month' || prices.get(offer.id)!.recurring?.interval_count !== 1)) billingRefusal('billing_pilot_requires_monthly_prices');
  }
  const portals = await stripe(env, 'billing_portal/configurations?is_default=true&limit=100', z.object({ data: z.array(z.object({ id: z.string(), active: z.boolean(), is_default: z.boolean() })) }));
  const portal = portals.data.find(item => item.active && item.is_default);
  if (!portal) billingRefusal('billing_portal_configuration_required');
  const products = new Map<string, Set<string>>();
  // Portal has no per-transition hook to inspect existing discounts. Keep its
  // self-service choices monthly even after new pilot awards are disabled.
  // Longer intervals remain available through Checkout and guarded MCP changes.
  for (const offer of active.filter(offer => {
    const recurring = prices.get(offer.id)!.recurring;
    return recurring?.interval === 'month' && recurring.interval_count === 1;
  })) {
    const product = prices.get(offer.id)!.product;
    const ids = products.get(product) ?? new Set<string>(); ids.add(offer.priceId); products.set(product, ids);
  }
  const fields: Record<string, string> = { 'features[subscription_update][enabled]': String(products.size > 0),
    'features[subscription_update][default_allowed_updates][0]': 'price', 'features[subscription_update][trial_update_behavior]': 'continue_trial' };
  [...products].forEach(([product, ids], i) => {
    fields[`features[subscription_update][products][${i}][product]`] = product;
    [...ids].forEach((price, j) => { fields[`features[subscription_update][products][${i}][prices][${j}]`] = price; });
  });
  if (!products.size) fields['features[subscription_update][products]'] = '';
  return { path: `billing_portal/configurations/${enc(portal.id)}`, fields, expectedRevision: current.revision, catalog: { ...proposed, revision: current.revision + 1 } };
}
async function commitCatalog(env: Env, request: BillingCatalogMutation, delivery: Delivery) {
  const { revision, ...catalog } = delivery.catalog!;
  const written = await env.DB.prepare(`INSERT INTO billing_catalog(region, revision, catalog_json, operation_id) VALUES (?, ?, ?, ?)
    ON CONFLICT(region) DO UPDATE SET revision = excluded.revision, catalog_json = excluded.catalog_json, operation_id = excluded.operation_id
    WHERE billing_catalog.revision = ? RETURNING revision`)
    .bind(env.AVALON_REGION, revision, JSON.stringify(catalog), request.operationId, delivery.expectedRevision!).first();
  if (!written) billingRefusal('billing_catalog_revision_conflict');
  return receipt(request, env.AVALON_REGION, 'published', revision);
}
export async function administerBillingCatalog(env: Env, input: BillingCatalogMutation) {
  env = await resolveBillingEnvironment(env);
  const request = BillingCatalogMutationSchema.parse(input);
  if (request.region !== env.AVALON_REGION) billingRefusal('billing_region_mismatch');
  return billingOperation(env, `catalog:${env.AVALON_REGION}`, request, {
    prepare: () => prepare(env, request),
    execute: async (delivery, key) => {
      if (delivery.catalog) {
        if ((await readBillingCatalog(env)).revision !== delivery.expectedRevision) billingRefusal('billing_catalog_revision_conflict');
        await stripe(env, delivery.path, z.object({ id: z.string() }), { ...delivery.fields, 'metadata[rally_admin_operation]': key }, key);
        return commitCatalog(env, request, delivery);
      }
      const value = await stripe(env, delivery.path, z.object({ id: z.string() }), { ...delivery.fields, 'metadata[rally_admin_operation]': key, 'metadata[rally_admin_reason]': request.reason }, key);
      return receipt(request, value.id);
    },
    recover: async (delivery, key) => {
      if (delivery.catalog) {
        const row = await env.DB.prepare('SELECT revision, operation_id FROM billing_catalog WHERE region = ?').bind(env.AVALON_REGION).first<{ revision: number; operation_id: string }>();
        if (row?.operation_id === request.operationId) return receipt(request, env.AVALON_REGION, 'published', row.revision);
        const portal = await stripe(env, delivery.path, z.object({ id: z.string(), metadata: z.record(z.string(), z.string()) }));
        if (portal.metadata.rally_admin_operation === key) return commitCatalog(env, request, delivery);
        return null;
      }
      let after = '';
      do {
        const path = `${delivery.recoveryList}${delivery.recoveryList!.endsWith('?') ? '' : '&'}limit=100${after ? `&starting_after=${enc(after)}` : ''}`;
        const page = await stripe(env, path, z.object({ has_more: z.boolean(), data: z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.string()) })) }));
        const found = page.data.find(item => item.metadata.rally_admin_operation === key);
        if (found) return receipt(request, found.id);
        after = page.has_more ? page.data.at(-1)!.id : '';
      } while (after);
      return null;
    },
  });
}
