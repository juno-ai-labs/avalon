import { z } from "zod";
import { GrantTrialMonthsSchema, TrialMonthsGrantSchema, type GrantTrialMonths, type TrialMonthsGrant } from "@rally/contracts/billing";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { billingConfig, resolveBillingEnvironment } from "./billing-config";
import { refreshBillingAccount, syncSubscription } from "./billing";
import { stripe } from "./stripe";
import { validateOverageMeter } from "./stripe-overages";

// Acacia expands each Discount with its coupon; the transport pins this version.
const Subscription = z.object({
  id: z.string(), customer: z.string(), status: z.string(), current_period_end: z.number(), trial_end: z.number().nullable(),
  cancel_at_period_end: z.boolean(), cancel_at: z.number().nullable(), metadata: z.record(z.string(), z.string()),
  discounts: z.array(z.object({ end: z.number().nullable(), coupon: z.object({
    percent_off: z.number().nullable(), duration: z.enum(["once", "repeating", "forever"]),
    applies_to: z.object({ products: z.array(z.string()) }).optional(),
  }) })),
  items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string(), product: z.string() }) })) }),
});
interface Delivery { subscriptionId: string; customerId: string; previousEnd: number; trialEnd: number }
interface Operation { request_json: string; delivery_json: string; result_json: string | null; error_code: string | null }
const subscription = (env: Env, id: string) => stripe(env, `subscriptions/${encodeURIComponent(id)}?expand[]=discounts`, Subscription);

/** Calendar months clamp to the last day of a shorter target month, in UTC. */
function addMonths(at: number, months: number) {
  const date = new Date(at * 1000); const day = date.getUTCDate();
  date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  if (!Number.isFinite(date.getTime())) throw new ApiError(400, "billing_trial_months_date_invalid", "The requested months exceed supported calendar dates");
  return date.getTime() / 1000;
}

async function planDelivery(env: Env, workspaceId: string, request: GrantTrialMonths): Promise<Delivery> {
  const open = await env.DB.prepare("SELECT 1 FROM workspaces WHERE id = ? AND region = ? AND abandoned_at IS NULL").bind(workspaceId, env.AVALON_REGION).first();
  if (!open) throw new ApiError(404, "billing_account_not_found", "Organization not found");
  const account = await refreshBillingAccount(env, workspaceId);
  if (!account.subscription_id || !account.customer_id)
    throw new ApiError(409, "billing_paid_subscription_required", "Choose a paid plan in Stripe Checkout before granting additional free months");
  const sub = await subscription(env, account.subscription_id);
  const config = billingConfig(env);
  const offer = config.offers.find(item => item.id === account.offer_id && item.plan !== "starter" && sub.items.data.some(line => line.price.id === item.priceId));
  if (!offer || sub.customer !== account.customer_id || sub.items.data.length !== 1 || !["active", "trialing"].includes(sub.status))
    throw new ApiError(409, "billing_trial_subscription_ineligible", "Additional free months require an active or trialing paid plan");
  if (sub.cancel_at_period_end || sub.cancel_at !== null)
    throw new ApiError(409, "billing_trial_subscription_canceling", "Resume the subscription before granting additional free months");
  const price = await stripe(env, `prices/${encodeURIComponent(offer.priceId)}`, z.object({ recurring: z.object({ interval: z.string(), interval_count: z.number(), usage_type: z.string() }).nullable() }));
  if (price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 || price.recurring.usage_type !== "licensed")
    throw new ApiError(409, "billing_trial_requires_monthly_price", "Trial-month grants require a monthly licensed plan price");
  if (account.overage_enabled && (!config.overageCredits || offer.overagePriceId !== config.overageCredits.priceId))
    throw new ApiError(409, "billing_trial_requires_metered_overages", "Configure the separate metered overage price to collect overages during the fee waiver");
  if (account.overage_enabled) await validateOverageMeter(env, config.overageCredits!.priceId, config.overageCredits!.meterId);
  let previousEnd = Math.max(Math.floor(Date.now() / 1000), sub.current_period_end, sub.trial_end ?? 0);
  for (const discount of sub.discounts) {
    if (discount.coupon.percent_off !== 100 || (discount.end !== null && discount.end <= Date.now() / 1000) ||
      (discount.coupon.applies_to && !discount.coupon.applies_to.products.includes(sub.items.data[0]!.price.product))) continue;
    if (discount.coupon.duration !== "repeating" || discount.end === null)
      throw new ApiError(409, "billing_trial_discount_not_extendable", "A full once-only or indefinite fee waiver must be resolved before adding trial months");
    previousEnd = Math.max(previousEnd, discount.end);
  }
  return { subscriptionId: sub.id, customerId: sub.customer, previousEnd, trialEnd: addMonths(previousEnd, request.months) };
}

/** Internal operator write, serialized with checkout and reconciliation. Stripe
 * owns the actual fee-free deadline; D1 stores intent and retry receipts only. */
export async function grantTrialMonths(env: Env, workspaceId: string, input: GrantTrialMonths): Promise<TrialMonthsGrant> {
  env = await resolveBillingEnvironment(env);
  const request = GrantTrialMonthsSchema.parse(input);
  let operation = await env.DB.prepare("SELECT * FROM billing_trial_operations WHERE workspace_id = ? AND operation_id = ?")
    .bind(workspaceId, request.operationId).first<Operation>();
  if (operation && JSON.stringify(request) !== operation.request_json)
    throw new ApiError(409, "billing_trial_operation_conflict", "Reuse the operation ID with the original grant arguments");
  if (operation?.result_json) return TrialMonthsGrantSchema.parse(JSON.parse(operation.result_json));
  if (operation?.error_code) throw new ApiError(409, operation.error_code, "This grant was not applied; inspect billing and use a new operation ID to try again");
  if (!operation) {
    const pending = await env.DB.prepare("SELECT 1 FROM billing_trial_operations WHERE workspace_id = ? AND result_json IS NULL AND error_code IS NULL")
      .bind(workspaceId).first();
    if (pending) throw new ApiError(409, "billing_trial_grant_pending", "Recover the outstanding trial-month grant with its original operation ID before issuing another");
    const delivery = await planDelivery(env, workspaceId, request);
    operation = { request_json: JSON.stringify(request), delivery_json: JSON.stringify(delivery), result_json: null, error_code: null };
    await env.DB.prepare("INSERT INTO billing_trial_operations(workspace_id, operation_id, request_json, delivery_json) VALUES (?, ?, ?, ?)")
      .bind(workspaceId, request.operationId, operation.request_json, operation.delivery_json).run();
  }
  const saved = JSON.parse(operation.delivery_json) as Delivery;
  const fail = async (code: string): Promise<never> => {
    await env.DB.prepare("UPDATE billing_trial_operations SET error_code = ? WHERE workspace_id = ? AND operation_id = ?")
      .bind(code, workspaceId, request.operationId).run();
    throw new ApiError(409, code, "This grant was not applied; inspect billing and retry with a new operation ID");
  };
  const sub = await subscription(env, saved.subscriptionId);
  if (sub.customer !== saved.customerId) return fail("billing_customer_mismatch");
  // The marker and fixed deadline are one Stripe write. A delayed retry cannot
  // add another N months, shorten a later extension, or restart a canceled plan.
  if (sub.metadata.rally_trial_operation_id !== request.operationId && (sub.trial_end ?? 0) < saved.trialEnd) {
    if (!["active", "trialing"].includes(sub.status) || sub.cancel_at_period_end || sub.cancel_at !== null || saved.trialEnd <= Date.now() / 1000)
      return fail("billing_trial_grant_stale");
    try {
      await stripe(env, `subscriptions/${encodeURIComponent(saved.subscriptionId)}`, Subscription, {
        trial_end: String(saved.trialEnd), proration_behavior: "none", "expand[0]": "discounts",
        "metadata[rally_trial_operation_id]": request.operationId,
        "metadata[rally_trial_months]": String(request.months), "metadata[rally_trial_reason]": request.reason,
      }, `trial-months:${workspaceId}:${request.operationId}`);
    } catch (error) {
      // Stripe bounds trial dates (including its maximum trial duration). A
      // definitive parameter refusal has no uncertain write to recover.
      if (error instanceof ApiError && error.code === "stripe_http_400") return fail("billing_trial_grant_rejected");
      throw error;
    }
  }
  // Reconcile immediately: plan allowances and opted-in overages stay active
  // while the base-fee subscription is trialing. Webhooks/cron also repair it.
  await syncSubscription(env, saved.customerId, saved.subscriptionId);
  const result: TrialMonthsGrant = {
    subscriptionId: saved.subscriptionId, months: request.months,
    previousFeeCoveredUntil: new Date(saved.previousEnd * 1000).toISOString(), trialEndsAt: new Date(saved.trialEnd * 1000).toISOString(),
  };
  await env.DB.prepare("UPDATE billing_trial_operations SET result_json = ? WHERE workspace_id = ? AND operation_id = ?")
    .bind(JSON.stringify(result), workspaceId, request.operationId).run();
  return result;
}
