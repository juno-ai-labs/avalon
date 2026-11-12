import { z } from "zod";
import { GrantOverageCreditSchema, type BillingCredits, type GrantOverageCredit, type OverageCredit } from "@rally/contracts/billing";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { billingAccount } from "./billing";
import { billingConfig, resolveBillingEnvironment } from "./billing-config";
import { ensureStripeCustomer } from "./stripe-billing-sync";
import { stripe } from "./stripe";
import { validateOverageMeter } from "./stripe-overages";

const Money = z.object({ type: z.literal("monetary"), monetary: z.object({ currency: z.string(), value: z.number().int() }) });
const Grant = z.object({
  id: z.string(), customer: z.string(), amount: Money,
  effective_at: z.number(), expires_at: z.number().nullable(), voided_at: z.number().nullish(),
  applicability_config: z.object({ scope: z.object({ prices: z.array(z.object({ id: z.string().nullable() })).nullish() }) }),
  metadata: z.record(z.string(), z.string()),
});
// List envelopes may contain grants in other currencies, which are unrelated.
const GrantPage = z.object({ has_more: z.boolean(), data: z.array(Grant) });

async function listGrants(env: Env, customer: string) {
  const grants: z.infer<typeof Grant>[] = [];
  let after = "";
  do {
    const page = await stripe(env, `billing/credit_grants?customer=${encodeURIComponent(customer)}&limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`, GrantPage);
    for (const value of page.data) {
      if (value.customer === customer && value.amount.monetary.currency === "usd") grants.push(value);
    }
    after = page.has_more ? page.data.at(-1)!.id : "";
  } while (after);
  return grants;
}

async function creditView(env: Env, grant: z.infer<typeof Grant>): Promise<OverageCredit> {
  const balance = await stripe(env, `billing/credit_balance_summary?customer=${encodeURIComponent(grant.customer)}&filter[type]=credit_grant&filter[credit_grant]=${encodeURIComponent(grant.id)}`,
    z.object({ balances: z.array(z.object({ available_balance: Money })) }));
  return {
    id: grant.id, amountCents: grant.amount.monetary.value,
    availableCents: balance.balances.reduce((sum, item) => sum + (item.available_balance.monetary.currency === "usd" ? item.available_balance.monetary.value : 0), 0),
    effectiveAt: new Date(grant.effective_at * 1000).toISOString(),
    expiresAt: grant.expires_at === null ? null : new Date(grant.expires_at * 1000).toISOString(), voided: grant.voided_at != null,
  };
}

async function overagePrices(env: Env, workspaceId: string) {
  const config = billingConfig(env).overageCredits;
  const prices = new Set(config ? [config.priceId] : []);
  const rows = await env.DB.prepare("SELECT price_id FROM billing_overage_subscriptions WHERE workspace_id = ?").bind(workspaceId).all<{ price_id: string }>();
  for (const row of rows.results) prices.add(row.price_id);
  const requests = await env.DB.prepare("SELECT request_json FROM billing_credit_operations WHERE workspace_id = ?").bind(workspaceId).all<{ request_json: string }>();
  for (const row of requests.results) prices.add((JSON.parse(row.request_json) as { priceId: string }).priceId);
  return prices;
}
function scopedToOverages(grant: z.infer<typeof Grant>, prices: Set<string>) {
  const scope = grant.applicability_config.scope.prices;
  return Boolean(scope?.length && scope.every((price) => price.id !== null && prices.has(price.id)));
}

/** Read the financial authority directly. This never provisions a customer. */
export async function readOverageCredits(env: Env, workspaceId: string): Promise<BillingCredits> {
  env = await resolveBillingEnvironment(env);
  const empty: BillingCredits = { enabled: Boolean(env.BILLING_CONFIG && billingConfig(env).overageCredits), currency: "usd", availableCents: 0, grants: [] };
  if (!env.BILLING_CONFIG) return empty;
  const account = await env.DB.prepare("SELECT b.customer_id FROM billing_accounts b JOIN workspaces w ON w.id = b.workspace_id WHERE b.workspace_id = ? AND w.region = ?")
    .bind(workspaceId, env.AVALON_REGION).first<{ customer_id: string | null }>();
  if (!account?.customer_id) return empty;
  const prices = await overagePrices(env, workspaceId);
  if (!prices.size) return empty;
  const grants = [];
  for (const grant of await listGrants(env, account.customer_id)) {
    if (scopedToOverages(grant, prices)) grants.push(await creditView(env, grant));
  }
  return { ...empty, enabled: empty.enabled || grants.length > 0, grants, availableCents: grants.reduce((sum, grant) => sum + grant.availableCents, 0) };
}

/** Operator-only, inside the organization actor. Persist intent before Stripe. */
export async function grantOverageCredit(env: Env, workspaceId: string, input: GrantOverageCredit): Promise<OverageCredit> {
  env = await resolveBillingEnvironment(env);
  const request = GrantOverageCreditSchema.parse(input);
  const account = await billingAccount(env, workspaceId);
  const existing = await env.DB.prepare("SELECT request_json, stripe_grant_id FROM billing_credit_operations WHERE workspace_id = ? AND operation_id = ?")
    .bind(workspaceId, request.operationId).first<{ request_json: string; stripe_grant_id: string | null }>();
  let saved: { request: GrantOverageCredit; priceId: string; meterId: string };
  if (existing) {
    saved = JSON.parse(existing.request_json) as typeof saved;
    if (JSON.stringify(saved.request) !== JSON.stringify(request)) throw new ApiError(409, "billing_credit_operation_conflict", "Reuse the operation ID with the original grant arguments");
  } else {
    const open = await env.DB.prepare("SELECT 1 FROM workspaces WHERE id = ? AND region = ? AND abandoned_at IS NULL").bind(workspaceId, env.AVALON_REGION).first();
    if (!open) throw new ApiError(404, "billing_account_not_found", "Organization not found");
    const config = billingConfig(env);
    if (!config.overageCredits || !config.offers.some((offer) => offer.overagePriceId === config.overageCredits!.priceId))
      throw new ApiError(409, "billing_overage_credits_unavailable", "Configure a metered overage price before granting credits");
    const now = Date.now();
    const expiresAt = Math.floor(Date.parse(request.expiresAt) / 1000) * 1000;
    if (expiresAt <= now) throw new ApiError(400, "billing_credit_expiry_past", "expiresAt must be in the future");
    // Credits must expire within two calendar years; clamp leap day to February 28.
    // Check only new intents so retries retain the original financial terms.
    const latestExpiry = new Date(now);
    latestExpiry.setUTCFullYear(latestExpiry.getUTCFullYear() + 2);
    if (latestExpiry.getUTCMonth() !== new Date(now).getUTCMonth()) latestExpiry.setUTCDate(0);
    if (Date.parse(request.expiresAt) > latestExpiry.getTime()) throw new ApiError(400, "billing_credit_expiry_too_late", "expiresAt must be within two calendar years");
    await validateOverageMeter(env, config.overageCredits.priceId, config.overageCredits.meterId);
    saved = { request, ...config.overageCredits };
    await env.DB.prepare("INSERT INTO billing_credit_operations(workspace_id, operation_id, request_json) VALUES (?, ?, ?)")
      .bind(workspaceId, request.operationId, JSON.stringify(saved)).run();
  }
  const customer = await ensureStripeCustomer(env, account);
  const receipt = `overage-credit:${env.AVALON_REGION}:${workspaceId}:${request.operationId}`;
  // Metadata lookup outlives Stripe's 24-hour idempotency retention.
  let grant = existing?.stripe_grant_id
    ? await stripe(env, `billing/credit_grants/${encodeURIComponent(existing.stripe_grant_id)}`, Grant)
    : (await listGrants(env, customer)).find((item) => item.metadata.receipt === receipt);
  grant ??= await stripe(env, "billing/credit_grants", Grant, {
    customer, category: "promotional", name: "Rally overage credit",
    "amount[type]": "monetary", "amount[monetary][currency]": "usd", "amount[monetary][value]": String(request.amountCents),
    "applicability_config[scope][prices][0][id]": saved.priceId,
    "metadata[receipt]": receipt, "metadata[workspace_id]": workspaceId, "metadata[region]": env.AVALON_REGION,
    "metadata[reason]": request.reason,
    expires_at: String(Math.floor(Date.parse(request.expiresAt) / 1000)),
  }, receipt);
  await env.DB.prepare("UPDATE billing_credit_operations SET stripe_grant_id = ? WHERE workspace_id = ? AND operation_id = ?")
    .bind(grant.id, workspaceId, request.operationId).run();
  return creditView(env, grant);
}

/** Expire only the unused balance. Already finalized invoices remain unchanged. */
export async function expireOverageCredit(env: Env, workspaceId: string, grantId: string): Promise<OverageCredit> {
  env = await resolveBillingEnvironment(env);
  const account = await billingAccount(env, workspaceId, true);
  const grant = await stripe(env, `billing/credit_grants/${encodeURIComponent(grantId)}`, Grant);
  if (grant.customer !== account.customer_id || grant.amount.monetary.currency !== "usd" || !scopedToOverages(grant, await overagePrices(env, workspaceId)))
    throw new ApiError(404, "billing_credit_not_found", "Overage credit not found for this organization");
  if (grant.voided_at != null || (grant.expires_at !== null && grant.expires_at <= Date.now() / 1000)) return creditView(env, grant);
  return creditView(env, await stripe(env, `billing/credit_grants/${encodeURIComponent(grantId)}/expire`, Grant, {}, `expire:${grantId}`));
}
