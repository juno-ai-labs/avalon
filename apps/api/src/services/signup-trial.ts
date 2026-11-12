import { z } from "zod";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import type { BillingAccount } from "./billing";
import { billingConfig } from "./billing-config";
import { addBillingMonths } from "./billing-calendar";
import { stripe, StripeIdSchema } from "./stripe";

const RequestSchema = z.object({ endsAt: z.number(), fields: z.record(z.string(), z.string()) });
export type SignupTrialRequest = z.infer<typeof RequestSchema>;

/** Save the original award before contacting Stripe. Campaign edits and retries
 * cannot move its deadline or change the price of an uncertain create. */
export async function signupTrialRequest(env: Env, account: BillingAccount): Promise<SignupTrialRequest | null> {
  const org = await env.DB.prepare("SELECT created_at, abandoned_at, billing_plan_override FROM workspaces WHERE id = ?")
    .bind(account.workspace_id).first<{ created_at: string; abandoned_at: string | null; billing_plan_override: number }>();
  if (!org || org.abandoned_at || org.billing_plan_override) return null;
  const saved = await env.DB.prepare("SELECT request_json FROM billing_signup_trials WHERE workspace_id = ?")
    .bind(account.workspace_id).first<{ request_json: string }>();
  if (saved) {
    const parsed = RequestSchema.safeParse(JSON.parse(saved.request_json));
    if (!parsed.success) throw new ApiError(500, zodDiagnosticCode(parsed.error, "billing_signup_request")!, "Saved signup trial is invalid");
    return parsed.data;
  }
  const config = billingConfig(env);
  const campaign = config.signupTrial;
  if (!campaign) return null;
  if (Date.parse(org.created_at) < Date.parse(campaign.startsAt)) return null;
  const endsAt = addBillingMonths(Math.floor(Date.parse(org.created_at) / 1000), campaign.months);
  // A delayed recovery must not create a new trial after the original award expired.
  if (endsAt <= Date.now() / 1000 + 172800) return null; // Stripe's minimum explicit trial_end.
  const offer = config.offers.find(item => item.id === campaign.offerId && item.enabled)!;
  const price = await stripe(env, `prices/${encodeURIComponent(offer.priceId)}`, z.object({
    recurring: z.object({ interval: z.string(), interval_count: z.number(), usage_type: z.string() }).nullable(),
  }));
  if (price.recurring?.interval !== "month" || price.recurring.interval_count !== 1 || price.recurring.usage_type !== "licensed")
    throw new ApiError(409, "billing_signup_trial_requires_monthly_price", "Signup trials require a monthly plan");
  const request: SignupTrialRequest = { endsAt, fields: {
    "items[0][price]": offer.priceId, "items[0][quantity]": "1", currency: campaign.currency,
    trial_end: String(endsAt), "trial_settings[end_behavior][missing_payment_method]": "cancel",
    // No address exists at signup. Keep conversion canceled until Stripe says
    // the customer's tax location is usable and a payment method is available.
    cancel_at: String(endsAt), "automatic_tax[enabled]": "false",
    "metadata[workspace_id]": account.workspace_id, "metadata[region]": env.AVALON_REGION,
    "metadata[offer_id]": offer.id, "metadata[paid_subscription]": "true",
    "metadata[signup_trial]": "true", "metadata[signup_trial_conversion_pending]": "true",
    "metadata[overage_enabled]": "false",
  } };
  await env.DB.prepare("INSERT INTO billing_signup_trials(workspace_id, request_json) VALUES (?, ?)")
    .bind(account.workspace_id, JSON.stringify(request)).run();
  return request;
}

/** Called only after paginated Stripe history ruled out an existing paid
 * subscription, including canceled signup trials and a lost create receipt. */
export async function createSignupTrial(env: Env, account: BillingAccount, request: SignupTrialRequest): Promise<string | null> {
  const saved = await env.DB.prepare("SELECT subscription_id FROM billing_signup_trials WHERE workspace_id = ?")
    .bind(account.workspace_id).first<{ subscription_id: string | null }>();
  if (saved?.subscription_id || request.endsAt <= Date.now() / 1000 + 172800) return null;
  const result = await stripe(env, "subscriptions", StripeIdSchema,
    { ...request.fields, customer: account.customer_id! }, `signup-trial:${account.workspace_id}`);
  await recordSignupTrial(env, account.workspace_id, result.id);
  return result.id;
}

export async function recordSignupTrial(env: Env, workspaceId: string, subscriptionId: string): Promise<void> {
  await env.DB.prepare("UPDATE billing_signup_trials SET subscription_id = ? WHERE workspace_id = ? AND subscription_id IS NULL")
    .bind(subscriptionId, workspaceId).run();
}
