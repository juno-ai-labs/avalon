import { z } from 'zod';
import { BillingAdminMutationSchema, InspectOrgBillingSchema, OrgBillingResultSchema, type BillingAdminMutation, type BillingMutationResult } from '@rally/contracts/billing-admin';
import type { Env } from '../env';
import { billingConfig, resolveBillingEnvironment } from './billing-config';
import { billingAccount, refreshBillingAccount, syncSubscription, SubscriptionSchema } from './billing';
import { stripe } from './stripe';
import { billingOperation, billingRefusal } from './billing-admin-operations';

const Metadata = z.record(z.string(), z.string());
export const AdminSubscription = SubscriptionSchema.extend({ cancel_at_period_end: z.boolean(), cancel_at: z.number().nullable(),
  items: z.object({ data: z.array(z.object({ id: z.string(), quantity: z.number().nullable().optional(), price: z.object({ id: z.string(), product: z.string() }) })) }),
});
export const AdminPrice = z.object({ id: z.string(), active: z.boolean(), product: z.string(), currency: z.string(),
  unit_amount: z.number().nullable(), billing_scheme: z.string(), transform_quantity: z.unknown().nullable(),
  recurring: z.object({ usage_type: z.string(), interval: z.string(), interval_count: z.number() }).nullable(),
  currency_options: z.record(z.string(), z.unknown()).optional(), metadata: Metadata.default({}),
});
export const AdminCoupon = z.object({ id: z.string(), valid: z.boolean(), percent_off: z.number().nullable(), duration: z.string(),
  duration_in_months: z.number().nullable(), applies_to: z.object({ products: z.array(z.string()) }).optional(), metadata: Metadata.default({}),
});
const Invoice = z.object({ id: z.string(), customer: z.string(), status: z.string().nullable(), currency: z.string(), total: z.number(),
  amount_paid: z.number(), amount_remaining: z.number(), charge: z.string().nullable(), metadata: Metadata.default({}),
});
const FinancialReceipt = z.object({ id: z.string(), status: z.string(), amount: z.number(), currency: z.string(), metadata: Metadata });
const enc = encodeURIComponent;
export const readAdminPrice = (env: Env, id: string) => stripe(env, `prices/${enc(id)}?expand[]=currency_options`, AdminPrice);
export function requireLicensedPrice(price: z.infer<typeof AdminPrice>) {
  if (!price.active || price.recurring?.usage_type !== 'licensed' || price.billing_scheme !== 'per_unit' || price.transform_quantity !== null || !(price.unit_amount! > 0)) billingRefusal('billing_plan_price_ineligible');
}
export async function requirePlanCoupon(env: Env, id: string, products: string[]) {
  const coupon = await stripe(env, `coupons/${enc(id)}?expand[]=applies_to`, AdminCoupon);
  if (!coupon.valid || !coupon.applies_to?.products.length || products.some(product => !coupon.applies_to!.products.includes(product))) billingRefusal('billing_coupon_scope_invalid');
  const config = billingConfig(env);
  if (config.overageCredits && coupon.applies_to.products.includes((await readAdminPrice(env, config.overageCredits.priceId)).product)) billingRefusal('billing_coupon_includes_overages');
  return coupon;
}
async function customerForOrg(env: Env, orgId: string) {
  const account = await billingAccount(env, orgId, true);
  if (!account.customer_id) billingRefusal('billing_customer_required');
  return account.customer_id;
}
async function ownedInvoice(env: Env, customer: string, id: string) {
  const invoice = await stripe(env, `invoices/${enc(id)}`, Invoice);
  if (invoice.customer !== customer) billingRefusal('billing_customer_mismatch');
  return invoice;
}

export async function inspectOrgBilling(env: Env, input: z.infer<typeof InspectOrgBillingSchema>) {
  env = await resolveBillingEnvironment(env);
  const request = InspectOrgBillingSchema.parse(input);
  const account = await billingAccount(env, request.orgId, true);
  const subscriptions: z.infer<typeof AdminSubscription>[] = [];
  let after = '';
  if (account.customer_id) do {
    const page = await stripe(env, `subscriptions?customer=${enc(account.customer_id)}&status=all&limit=100${after ? `&starting_after=${enc(after)}` : ''}`, z.object({ has_more: z.boolean(), data: z.array(AdminSubscription) }));
    subscriptions.push(...page.data); after = page.has_more ? page.data.at(-1)!.id : '';
  } while (after);
  const invoices = account.customer_id ? await stripe(env, `invoices?customer=${enc(account.customer_id)}&limit=100${request.startingAfter ? `&starting_after=${enc(request.startingAfter)}` : ''}`, z.object({ has_more: z.boolean(), data: z.array(Invoice) })) : { data: [], has_more: false };
  const pending = await env.DB.prepare('SELECT operation_id, created_at FROM billing_admin_operations WHERE scope = ? AND result_json IS NULL AND error_code IS NULL').bind(request.orgId).all<{ operation_id: string; created_at: number }>();
  const workspace = await env.DB.prepare('SELECT billing_plan_override FROM workspaces WHERE id = ?').bind(request.orgId).first<{ billing_plan_override: number }>();
  return OrgBillingResultSchema.parse({ customerId: account.customer_id, subscriptionId: account.subscription_id, status: account.status, offerId: account.offer_id,
    overageEnabled: account.overage_enabled === 1, usagePlanOverride: Boolean(workspace?.billing_plan_override),
    subscriptions: subscriptions.map(sub => ({ id: sub.id, status: sub.status, role: sub.metadata.billing_role ?? 'plan', currency: sub.currency, cancelAtPeriodEnd: sub.cancel_at_period_end, trialEnd: sub.trial_end ?? null, priceIds: sub.items.data.map(item => item.price.id) })),
    invoices: invoices.data.map(invoice => ({ id: invoice.id, status: invoice.status, currency: invoice.currency, total: invoice.total, amountPaid: invoice.amount_paid, amountRemaining: invoice.amount_remaining, chargeId: invoice.charge })),
    nextInvoicePage: invoices.has_more ? invoices.data.at(-1)!.id : null,
    pendingOperations: pending.results.map(row => ({ operationId: row.operation_id, createdAt: row.created_at })),
  });
}
interface Delivery { path: string; fields: Record<string, string>; method?: 'DELETE'; type: BillingMutationResult['resourceType']; customer: string; subscriptionId?: string; recoveryList?: string; targetStatus?: string }
function receipt(request: BillingAdminMutation, delivery: Delivery, value: { id: string; status?: string | undefined; amount?: number | undefined; currency?: string | undefined }): BillingMutationResult {
  return { operationId: request.operationId, resourceId: value.id, resourceType: delivery.type, status: value.status ?? 'updated', ...(value.amount === undefined ? {} : { amountMinor: value.amount }), ...(value.currency ? { currency: value.currency } : {}) };
}
async function prepare(env: Env, request: BillingAdminMutation): Promise<Delivery> {
  const customer = await customerForOrg(env, request.orgId);
  if (request.kind === 'subscription') {
    if (await env.DB.prepare('SELECT 1 FROM billing_trial_operations WHERE workspace_id = ? AND result_json IS NULL AND error_code IS NULL').bind(request.orgId).first()) billingRefusal('billing_trial_grant_pending');
    const account = await refreshBillingAccount(env, request.orgId);
    if (account.subscription_id !== request.subscriptionId) billingRefusal('billing_subscription_not_current');
    const sub = await stripe(env, `subscriptions/${enc(request.subscriptionId)}`, AdminSubscription);
    if (sub.customer !== customer || ['free_record', 'overage'].includes(sub.metadata.billing_role ?? '')) billingRefusal('billing_subscription_not_owned_plan');
    if (!['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status)) billingRefusal('billing_subscription_not_manageable');
    const fields: Record<string, string> = {};
    const delivery: Delivery = { path: `subscriptions/${enc(sub.id)}`, fields, customer, subscriptionId: sub.id, type: 'subscription' };
    if (request.change.type === 'plan') {
      const offerId = request.change.offerId;
      const target = billingConfig(env).offers.find(item => item.id === offerId && item.enabled);
      if (!target || !target.currencies.includes(sub.currency)) billingRefusal('billing_offer_unavailable');
      const price = await readAdminPrice(env, target.priceId); requireLicensedPrice(price);
      if (price.currency !== sub.currency && !Object.hasOwn(price.currency_options ?? {}, sub.currency)) billingRefusal('billing_currency_unavailable');
      if (sub.items.data.length !== 1 || sub.items.data[0]!.quantity !== 1) billingRefusal('billing_subscription_shape_unsupported');
      Object.assign(fields, { 'items[0][id]': sub.items.data[0]!.id, 'items[0][price]': target.priceId, 'items[0][quantity]': '1',
        proration_behavior: request.change.proration, payment_behavior: 'error_if_incomplete', 'metadata[offer_id]': target.id });
      if (request.change.proration !== 'none') fields.proration_date = String(Math.floor(Date.now() / 1000));
    } else if (request.change.type === 'cancel') {
      if (request.change.when === 'now') { delivery.method = 'DELETE'; fields.prorate = 'false'; fields.invoice_now = 'false'; delivery.targetStatus = 'canceled'; }
      else fields.cancel_at_period_end = 'true';
    } else if (request.change.type === 'resume') {
      if (!sub.cancel_at_period_end && sub.cancel_at === null) billingRefusal('billing_subscription_not_canceling');
      if (sub.cancel_at_period_end) fields.cancel_at_period_end = 'false';
      else fields.cancel_at = '';
      fields.proration_behavior = 'none';
    } else {
      if (request.change.couponId) {
        await requirePlanCoupon(env, request.change.couponId, sub.items.data.map(item => item.price.product));
        fields['discounts[0][coupon]'] = request.change.couponId;
      } else fields.discounts = '';
      fields.proration_behavior = 'none';
    }
    return delivery;
  }
  if (request.kind === 'refund') {
    const charge = await stripe(env, `charges/${enc(request.chargeId)}`, z.object({ id: z.string(), customer: z.string().nullable(), amount: z.number(), amount_refunded: z.number(), paid: z.boolean() }));
    if (charge.customer !== customer) billingRefusal('billing_customer_mismatch');
    if (!charge.paid || request.amountMinor > charge.amount - charge.amount_refunded) billingRefusal('billing_refund_amount_invalid');
    return { customer, path: 'refunds', type: 'refund', fields: { charge: charge.id, amount: String(request.amountMinor) }, recoveryList: `refunds?charge=${enc(charge.id)}` };
  }
  const invoice = await ownedInvoice(env, customer, request.invoiceId);
  if (request.correction.type !== 'credit_note') {
    if (invoice.status !== 'open') billingRefusal('billing_invoice_must_be_open');
    return { customer, path: `invoices/${enc(invoice.id)}/${request.correction.type === 'void' ? 'void' : 'mark_uncollectible'}`, fields: {}, type: 'invoice', targetStatus: request.correction.type === 'void' ? 'void' : 'uncollectible' };
  }
  if (!['open', 'paid'].includes(invoice.status ?? '')) billingRefusal('billing_invoice_not_creditable');
  const postPayment = Math.max(0, request.correction.amountMinor - invoice.amount_remaining);
  if (postPayment && request.correction.disposition === 'invoice_balance') billingRefusal('billing_credit_note_post_payment_disposition_required');
  const fields: Record<string, string> = { invoice: invoice.id, amount: String(request.correction.amountMinor), memo: request.reason };
  if (postPayment) fields[request.correction.disposition === 'refund' ? 'refund_amount' : 'credit_amount'] = String(postPayment);
  return { customer, path: 'credit_notes', type: 'credit_note', fields, recoveryList: `credit_notes?invoice=${enc(invoice.id)}` };
}
export async function administerOrgBilling(env: Env, input: BillingAdminMutation) {
  env = await resolveBillingEnvironment(env);
  const request = BillingAdminMutationSchema.parse(input);
  const result = await billingOperation(env, request.orgId, request, {
    prepare: () => prepare(env, request),
    execute: async (delivery, key) => {
      const fields = { ...delivery.fields };
      // The cancel/void endpoints don't accept metadata; their terminal state
      // itself proves completion. Other writes carry a permanent Stripe receipt.
      if (!delivery.targetStatus) { fields['metadata[rally_admin_operation]'] = key; fields['metadata[rally_admin_reason]'] = request.reason; }
      const value = await stripe(env, delivery.path, z.object({ id: z.string(), status: z.string().optional(), amount: z.number().optional(), currency: z.string().optional() }), fields, key, delivery.method);
      return receipt(request, delivery, value);
    },
    recover: async (delivery, key) => {
      if (delivery.recoveryList) {
        let after = '';
        do {
          const page = await stripe(env, `${delivery.recoveryList}&limit=100${after ? `&starting_after=${enc(after)}` : ''}`, z.object({ has_more: z.boolean(), data: z.array(FinancialReceipt) }));
          const found = page.data.find(item => item.metadata.rally_admin_operation === key);
          if (found) return receipt(request, delivery, found);
          after = page.has_more ? page.data.at(-1)!.id : '';
        } while (after);
      } else if (delivery.subscriptionId) {
        const sub = await stripe(env, `subscriptions/${enc(delivery.subscriptionId)}`, AdminSubscription);
        if (sub.customer !== delivery.customer) billingRefusal('billing_customer_mismatch');
        if (sub.metadata.rally_admin_operation === key || (delivery.targetStatus && sub.status === delivery.targetStatus)) return receipt(request, delivery, sub);
      } else {
        const invoice = await ownedInvoice(env, delivery.customer, delivery.path.split('/')[1]!);
        if (invoice.status === delivery.targetStatus) return receipt(request, delivery, { ...invoice, status: invoice.status ?? undefined });
      }
      return null;
    },
  });
  // Receipt commits before local reconciliation. Replaying it repairs a missed
  // reconciliation without replaying a financial write or changing its target.
  if (request.kind === 'subscription') await syncSubscription(env, await customerForOrg(env, request.orgId), request.subscriptionId);
  return result;
}
