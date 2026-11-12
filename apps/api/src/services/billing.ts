import { z } from "zod";
import { reportMeteredOverages, closeSettledOverageSubscriptions } from "./stripe-overages";
import {
  weeklyQuotaMicrousd,
  usageWeekStart,
  type PlanId,
} from "@rally/contracts/usage";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { billingConfig } from "./billing-config";
import { stripe, StripeIdSchema, StripeUrlSchema } from "./stripe";
import {
  publishOrganizationUsage,
  readOrganizationUsage,
  setWorkspacePlan,
} from "./usage-metering";
import {
  ensureStripeCustomer,
  archiveStripeFreeSubscription,
  synchronizeStripeProfile,
  synchronizeStripeUsage,
} from "./stripe-billing-sync";

export interface BillingAccount {
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  free_subscription_id: string | null;
  free_subscription_closed: number;
  trial_award_synced_end: number | null;
  checkout_generation: string;
  checkout_request_json: string | null;
  status: string;
  offer_id: string | null;
  currency: string | null;
  trial_started_at: number;
  trial_ends_at: number;
  trial_base_ends_at: number;
  team_trial_ends_at: number;
  team_trial_members: number;
  trial_extended: number;
  overage_enabled: number;
  overage_started_at: number | null;
}
const DAY = 86400;
export const hasLiveSubscription = (account: BillingAccount) =>
  Boolean(account.subscription_id) &&
  !["canceled", "incomplete_expired"].includes(account.status);
export async function billingAccount(
  env: Env,
  workspaceId: string,
  includeClosed = false,
): Promise<BillingAccount> {
  const config = billingConfig(env);
  await env.DB.prepare(
    `INSERT INTO billing_accounts (workspace_id, checkout_generation, trial_started_at, trial_ends_at,
    trial_base_ends_at, team_trial_ends_at, team_trial_members)
    SELECT id, ?, unixepoch(created_at), unixepoch(created_at) + ?, unixepoch(created_at) + ?, unixepoch(created_at) + ?, ?
    FROM workspaces WHERE id = ? AND region = ? AND (abandoned_at IS NULL OR ?)
    ON CONFLICT(workspace_id) DO NOTHING`,
  )
    .bind(
      crypto.randomUUID(),
      config.trialDays * DAY,
      config.trialDays * DAY,
      config.teamTrialDays * DAY,
      config.teamTrialMembers,
      workspaceId,
      env.AVALON_REGION,
      includeClosed ? 1 : 0,
    )
    .run();
  // Counts are recorded when members qualify and survive later departures.
  await env.DB.prepare(
    `UPDATE billing_accounts SET trial_extended = 1,
    trial_ends_at = MAX(trial_ends_at, team_trial_ends_at)
    WHERE workspace_id = ? AND trial_extended = 0 AND subscription_id IS NULL
      AND EXISTS (SELECT 1 FROM billing_team_qualifications q
        WHERE q.workspace_id = billing_accounts.workspace_id
          AND q.qualified_at < trial_base_ends_at AND q.members >= team_trial_members)`,
  )
    .bind(workspaceId)
    .run();
  const account = await env.DB.prepare(
    "SELECT * FROM billing_accounts WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first<BillingAccount>();
  if (!account)
    throw new ApiError(
      404,
      "billing_account_not_found",
      "Organization not found",
    );
  return account;
}

export const SubscriptionSchema = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  currency: z.string(),
  start_date: z.number().optional(),
  ended_at: z.number().nullable().optional(),
  trial_end: z.number().nullable().optional(),
  default_payment_method: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()),
  items: z.object({
    data: z.array(
      z.object({
        price: z.object({
          id: z.string(),
          unit_amount: z.number().nullable().optional(),
        }),
      }),
    ),
  }),
});
type Subscription = z.infer<typeof SubscriptionSchema>;

/** All production callers run inside the account actor. Price metadata disambiguates shared-price offers. */
async function reconcileSubscription(
  env: Env,
  account: BillingAccount,
  subscription: Subscription,
) {
  if (subscription.customer !== account.customer_id)
    throw new ApiError(
      409,
      "billing_customer_mismatch",
      "Subscription customer does not match",
    );
  const config = billingConfig(env);
  const candidates = config.offers.filter((o) =>
    subscription.items.data.some((item) => item.price.id === o.priceId),
  );
  const offer =
    candidates.find((o) => o.id === subscription.metadata.offer_id) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!offer)
    throw new ApiError(
      409,
      candidates.length ? "billing_offer_ambiguous" : "billing_price_unknown",
      "Subscription offer is not configured unambiguously",
    );
  // A checkout can complete while the team award is being earned. Reconcile the
  // Stripe trial too, so opening an older hosted page cannot shorten the award.
  const pilot = Boolean(subscription.metadata.pilot_coupon_id);
  if (
    !pilot &&
    subscription.status === "trialing" &&
    account.trial_ends_at > (subscription.trial_end ?? 0)
  ) {
    subscription = await stripe(
      env,
      `subscriptions/${subscription.id}`,
      SubscriptionSchema,
      { trial_end: String(account.trial_ends_at), proration_behavior: "none" },
      `trial:${subscription.id}:${account.trial_ends_at}`,
    );
  }
  const paid =
    subscription.status === "active" || subscription.status === "trialing";
  const overage =
    subscription.metadata.overage_enabled === "true" &&
    subscription.currency === "usd" &&
    Boolean(offer.overagePriceId);
  const now = Math.floor(Date.now() / 1000);
  const eligible = overage && paid;
  const open = await env.DB.prepare(
    `SELECT starts_at, price_id FROM billing_intervals
    WHERE subscription_id = ? AND ends_at IS NULL`,
  )
    .bind(subscription.id)
    .first<{ starts_at: number; price_id: string }>();
  if (open && (!eligible || open.price_id !== offer.overagePriceId)) {
    await closeBillableInterval(
      env,
      account.workspace_id,
      subscription.id,
      subscription.status === "canceled" ? (subscription.ended_at ?? now) : now,
      billingConfig(env).offers.find((o) => o.id === account.offer_id)?.plan ??
        offer.plan,
    );
  }
  let startedAt: number | null = null;
  if (eligible) {
    const prior = await env.DB.prepare(
      `SELECT starts_at FROM billing_terms WHERE subscription_id = ?`,
    )
      .bind(subscription.id)
      .first();
    startedAt =
      open && open.price_id === offer.overagePriceId
        ? open.starts_at
        : prior
          ? now
          : (subscription.start_date ?? now);
    await env.DB.prepare(
      `INSERT INTO billing_terms(subscription_id, workspace_id, customer_id, price_id, starts_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(
        subscription.id,
        account.workspace_id,
        subscription.customer,
        offer.overagePriceId!,
        startedAt,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO billing_intervals(subscription_id, starts_at, price_id)
      VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(subscription.id, startedAt, offer.overagePriceId!)
      .run();
  }
  await reconcileCancellation(env, subscription, offer.plan);
  const plan = paid ? offer.plan : config.unpaidPlan;
  const workspacePlan = await env.DB.prepare(
    "SELECT plan, billing_plan_override FROM workspaces WHERE id = ?",
  )
    .bind(account.workspace_id)
    .first<{ plan: string; billing_plan_override: number }>();
  if (!workspacePlan?.billing_plan_override && workspacePlan?.plan !== plan) {
    if (
      !(await setWorkspacePlan(env, account.workspace_id, plan, Date.now()))
    ) {
      throw new ApiError(
        409,
        "billing_region_mismatch",
        "Organization is in another region",
      );
    }
  }
  await env.DB.prepare(
    `UPDATE billing_accounts SET subscription_id = ?, status = ?, offer_id = ?, currency = ?,
    overage_enabled = ?, overage_started_at = ? WHERE workspace_id = ?`,
  )
    .bind(
      subscription.id,
      subscription.status,
      offer.id,
      subscription.currency,
      overage ? 1 : 0,
      startedAt,
      account.workspace_id,
    )
    .run();
  await publishOrganizationUsage(env, account.workspace_id);
}

async function closeBillableInterval(
  env: Env,
  workspaceId: string,
  subscriptionId: string,
  cutoff: number,
  plan: PlanId,
) {
  const workspace = await env.DB.prepare(
    "SELECT created_at FROM workspaces WHERE id = ?",
  )
    .bind(workspaceId)
    .first<{ created_at: string }>();
  const week = new Date(
    usageWeekStart(Date.parse(workspace!.created_at), cutoff * 1000 - 1),
  ).toISOString();
  const rollup = await env.USAGE_DB.prepare(
    `SELECT quota_microusd FROM usage_rollups
    WHERE workspace_id = ? AND week_start = ? ORDER BY period_start DESC LIMIT 1`,
  )
    .bind(workspaceId, week)
    .first<{ quota_microusd: number }>();
  await env.DB.prepare(
    `UPDATE billing_intervals SET ends_at = ?, cutoff_quota_microusd = ?
    WHERE subscription_id = ? AND ends_at IS NULL`,
  )
    .bind(
      cutoff,
      rollup?.quota_microusd ?? weeklyQuotaMicrousd(plan),
      subscriptionId,
    )
    .run();
}

/** A paid invoice is activation evidence, including zero-total pilot/trial invoices.
 * An incomplete unpaid subscription has none. */
async function recoverCanceledTerms(env: Env, subscription: Subscription) {
  if (
    subscription.status !== "canceled" ||
    subscription.metadata.billing_role === "free_record" ||
    subscription.metadata.overage_enabled !== "true" ||
    subscription.currency !== "usd"
  )
    return;
  if (
    await env.DB.prepare(
      "SELECT 1 FROM billing_terms WHERE subscription_id = ?",
    )
      .bind(subscription.id)
      .first()
  )
    return;
  const account = await env.DB.prepare(
    "SELECT workspace_id FROM billing_accounts WHERE customer_id = ?",
  )
    .bind(subscription.customer)
    .first<{ workspace_id: string }>();
  const candidates = billingConfig(env).offers.filter((o) =>
    subscription.items.data.some((i) => i.price.id === o.priceId),
  );
  const offer =
    candidates.find((o) => o.id === subscription.metadata.offer_id) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  if (!account || !offer?.overagePriceId) return;
  let after = "";
  const activationFloor = subscription.start_date ?? 0;
  let activation: number | null = null;
  do {
    const page = await stripe(
      env,
      `invoices?subscription=${subscription.id}&status=paid&limit=100${after ? `&starting_after=${after}` : ""}`,
      z.object({
        has_more: z.boolean(),
        data: z.array(
          z.object({
            id: z.string(),
            lines: z.object({
              data: z.array(
                z.object({
                  type: z.string(),
                  period: z.object({ start: z.number(), end: z.number() }),
                }),
              ),
            }),
          }),
        ),
      }),
    );
    for (const invoice of page.data)
      for (const line of invoice.lines.data) {
        // A paid zero-dollar trial invoice also proves that opted-in usage began.
        // Incomplete unpaid subscriptions still have no paid invoice evidence.
        if (
          line.type === "subscription" &&
          line.period.start >= activationFloor &&
          line.period.end > line.period.start &&
          line.period.start < (subscription.ended_at ?? Infinity)
        )
          activation = Math.min(activation ?? Infinity, line.period.start);
      }
    after = page.has_more ? page.data.at(-1)!.id : "";
  } while (after);
  if (activation !== null)
    await env.DB.prepare(
      `INSERT INTO billing_terms(subscription_id, workspace_id, customer_id, price_id, starts_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
      .bind(
        subscription.id,
        account.workspace_id,
        subscription.customer,
        offer.overagePriceId,
        activation,
      )
      .run();
}

/** Old cancellations close their own terms without changing current entitlement. */
async function reconcileCancellation(
  env: Env,
  subscription: Subscription,
  plan?: PlanId,
) {
  if (subscription.status !== "canceled") return;
  await recoverCanceledTerms(env, subscription);
  const term = await env.DB.prepare(
    `SELECT t.workspace_id, t.cutoff_quota_microusd, w.created_at
    FROM billing_terms t JOIN workspaces w ON w.id = t.workspace_id WHERE t.subscription_id = ?`,
  )
    .bind(subscription.id)
    .first<{
      workspace_id: string;
      cutoff_quota_microusd: number | null;
      created_at: string;
    }>();
  if (!term) return;
  const candidates = billingConfig(env).offers.filter((offer) =>
    subscription.items.data.some(({ price }) => price.id === offer.priceId),
  );
  const offer =
    candidates.find((offer) => offer.id === subscription.metadata.offer_id) ??
    (candidates.length === 1 ? candidates[0] : undefined);
  const cutoff = subscription.ended_at ?? Math.floor(Date.now() / 1000);
  const week = new Date(
    usageWeekStart(Date.parse(term.created_at), cutoff * 1000 - 1),
  ).toISOString();
  const rollup = await env.USAGE_DB.prepare(
    `SELECT quota_microusd FROM usage_rollups
    WHERE workspace_id = ? AND week_start = ? ORDER BY period_start DESC LIMIT 1`,
  )
    .bind(term.workspace_id, week)
    .first<{ quota_microusd: number }>();
  const quota =
    term.cutoff_quota_microusd ??
    rollup?.quota_microusd ??
    (plan || offer ? weeklyQuotaMicrousd(plan ?? offer!.plan) : null);
  if (quota === null)
    throw new ApiError(
      409,
      "billing_price_unknown",
      "Retain the canceled subscription offer for settlement",
    );
  await env.DB.prepare(
    `UPDATE billing_terms SET ends_at = COALESCE(ends_at, ?),
    cutoff_quota_microusd = COALESCE(cutoff_quota_microusd, ?)
    WHERE subscription_id = ?`,
  )
    .bind(cutoff, quota, subscription.id)
    .run();
  await env.DB.prepare(
    `UPDATE billing_intervals SET ends_at = ?, cutoff_quota_microusd = ?
    WHERE subscription_id = ? AND ends_at IS NULL`,
  )
    .bind(cutoff, quota, subscription.id)
    .run();
}

// Pagination uses Stripe's published maximum page size (100), not an account cap.
async function subscriptionHistory(env: Env, customerId: string) {
  const config = billingConfig(env);
  let hasPaidSubscription = false;
  let live: Subscription | null = null;
  let after = "";
  do {
    const page = await stripe(
      env,
      `subscriptions?customer=${customerId}&status=all&limit=100${after ? `&starting_after=${after}` : ""}`,
      z.object({ has_more: z.boolean(), data: z.array(SubscriptionSchema) }),
    );
    live ??=
      page.data.find(
        (item) =>
          !["free_record", "overage"].includes(item.metadata.billing_role ?? "") &&
          !["canceled", "incomplete_expired"].includes(item.status),
      ) ?? null;
    for (const subscription of page.data)
      await reconcileCancellation(env, subscription);
    // A canceled pilot still counts, including its zero-dollar invoices. An
    // expired incomplete payment never activated a subscription. Unknown retired
    // prices count as paid; keep their catalog entries for reconciliation.
    hasPaidSubscription ||= page.data.some(
      (item) =>
        !["free_record", "overage"].includes(item.metadata.billing_role ?? "") &&
        item.status !== "incomplete_expired" &&
        (Boolean(item.metadata.pilot_coupon_id) ||
          item.metadata.paid_subscription === "true" ||
          item.items.data.some(({ price }) =>
            price.unit_amount === 0
              ? false
              : price.unit_amount != null
                ? true
                : !config.offers.some(
                    (offer) =>
                      offer.priceId === price.id && offer.plan === "starter",
                  ),
          )),
    );
    after = page.has_more ? page.data.at(-1)!.id : "";
  } while (after);
  return { live, hasPaidSubscription };
}

async function refreshBillingState(env: Env, account: BillingAccount) {
  if (!account.customer_id) {
    await reconcileUnpaidPlan(env, account.workspace_id);
    return { ...account, hasPaidSubscription: false };
  }
  const history = await subscriptionHistory(env, account.customer_id);
  const subscription =
    history.live ??
    (hasLiveSubscription(account)
      ? await stripe(
          env,
          `subscriptions/${account.subscription_id}`,
          SubscriptionSchema,
        )
      : null);
  if (subscription) await reconcileSubscription(env, account, subscription);
  else await reconcileUnpaidPlan(env, account.workspace_id);
  const { hasPaidSubscription } = history;
  return {
    ...(await billingAccount(env, account.workspace_id)),
    hasPaidSubscription,
  };
}

async function reconcileUnpaidPlan(env: Env, workspaceId: string) {
  const workspace = await env.DB.prepare(
    "SELECT plan, billing_plan_override FROM workspaces WHERE id = ?",
  )
    .bind(workspaceId)
    .first<{ plan: string; billing_plan_override: number }>();
  const plan = billingConfig(env).unpaidPlan;
  if (
    workspace &&
    !workspace.billing_plan_override &&
    workspace.plan !== plan
  ) {
    await setWorkspacePlan(env, workspaceId, plan, Date.now());
    await publishOrganizationUsage(env, workspaceId);
  }
}

export async function refreshBillingAccount(env: Env, workspaceId: string) {
  await billingAccount(env, workspaceId);
  return refreshBillingState(env, await billingAccount(env, workspaceId));
}

const OpenSessionsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      currency: z.string(),
      metadata: z.record(z.string(), z.string()),
    }),
  ),
});
const openSessions = (env: Env, customerId: string) =>
  stripe(
    env,
    `checkout/sessions?customer=${customerId}&status=open&limit=1`,
    OpenSessionsSchema,
  );

const CheckoutRequestSchema = z.object({
  key: z.string(),
  fields: z.record(z.string(), z.string()),
});
async function sendCheckoutRequest(
  env: Env,
  workspaceId: string,
  request: z.infer<typeof CheckoutRequestSchema>,
) {
  try {
    return await stripe(
      env,
      "checkout/sessions",
      StripeUrlSchema,
      request.fields,
      request.key,
    );
  } catch (error) {
    // A validation rejection never created a session. Let corrected catalog
    // configuration start a new attempt; transport/5xx/409 outcomes stay pending.
    if (
      error instanceof ApiError &&
      error.code === "stripe_http_400" &&
      error.diagnosticCode?.includes(":invalid_request_error")
    )
      await env.DB.prepare(
        "UPDATE billing_accounts SET checkout_request_json = NULL, checkout_generation = ? WHERE workspace_id = ?",
      )
        .bind(crypto.randomUUID(), workspaceId)
        .run();
    throw error;
  }
}

export async function createCheckout(
  env: Env,
  workspaceId: string,
  offerId: string,
  currency: string,
  overage: boolean,
) {
  const config = billingConfig(env);
  const offer = config.offers.find((o) => o.id === offerId && o.enabled);
  if (!offer || !offer.currencies.includes(currency))
    throw new ApiError(
      400,
      "billing_offer_unavailable",
      "This plan or currency is unavailable",
    );
  if (overage && (!offer.overagePriceId || currency !== "usd"))
    throw new ApiError(
      400,
      "billing_overage_unavailable",
      "Overage billing is unavailable for this plan or currency",
    );
  await billingAccount(env, workspaceId);
  const workspace = await env.DB.prepare(
    "SELECT abandoned_at FROM workspaces WHERE id = ?",
  )
    .bind(workspaceId)
    .first<{ abandoned_at: string | null }>();
  if (!workspace || workspace.abandoned_at)
    throw new ApiError(
      409,
      "billing_workspace_closed",
      "Organization is closed",
    );
  const initial = await billingAccount(env, workspaceId);
  const customerId = await ensureStripeCustomer(env, initial);
  const account = await refreshBillingState(env, {
    ...initial,
    customer_id: customerId,
  });
  // Recovery applies the plan too, then takes the administrator straight to management.
  if (hasLiveSubscription(account)) {
    await env.DB.prepare(
      "UPDATE billing_accounts SET checkout_request_json = NULL WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    return createBillingPortal(env, workspaceId);
  }
  const pilotCouponId =
    !account.hasPaidSubscription && offer.plan !== "starter"
      ? config.pilotCouponId
      : undefined;
  const trialEndsAt =
    pilotCouponId || account.hasPaidSubscription ? 0 : account.trial_ends_at;
  let pending = (await openSessions(env, customerId)).data[0];
  if (account.checkout_request_json) {
    const outstanding = CheckoutRequestSchema.parse(
      JSON.parse(account.checkout_request_json),
    );
    if (!pending) {
      // Replay the exact outstanding request even if the administrator now
      // wants different terms. Stripe may still be processing its first send.
      const recovered = await sendCheckoutRequest(
        env,
        workspaceId,
        outstanding,
      );
      pending = {
        ...recovered,
        currency: outstanding.fields.currency!,
        metadata: Object.fromEntries(
          Object.entries(outstanding.fields)
            .filter(([key]) => key.startsWith("metadata["))
            .map(([key, value]) => [key.slice(9, -1), value]),
        ),
      };
    }
    await env.DB.prepare(
      "UPDATE billing_accounts SET checkout_request_json = NULL, checkout_generation = ? WHERE workspace_id = ?",
    )
      .bind(crypto.randomUUID(), workspaceId)
      .run();
  }
  if (pending) {
    if (
      pending.metadata.offer_id === offerId &&
      pending.currency === currency &&
      pending.metadata.overage_enabled === String(overage) &&
      (pending.metadata.pilot_coupon_id ?? "") === (pilotCouponId ?? "") &&
      Number(pending.metadata.trial_ends_at) >= trialEndsAt
    )
      return { url: pending.url };
    await stripe(
      env,
      `checkout/sessions/${pending.id}/expire`,
      StripeIdSchema,
      {},
      `expire:${pending.id}`,
    );
    await env.DB.prepare(
      "UPDATE billing_accounts SET checkout_generation = ? WHERE workspace_id = ?",
    )
      .bind(crypto.randomUUID(), workspaceId)
      .run();
  }
  await archiveStripeFreeSubscription(env, account);
  // The persisted generation identifies this attempt. An uncertain Stripe
  // response recovers through the open-session query before another write.
  const attempt = await env.DB.prepare(
    "SELECT checkout_generation FROM billing_accounts WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .first<{ checkout_generation: string }>();
  if (pilotCouponId) {
    // A two-month coupon on an annual price would waive the entire annual
    // invoice. The pilot is for monthly subscriptions only.
    const price = await stripe(
      env,
      `prices/${offer.priceId}`,
      z.object({
        recurring: z
          .object({ interval: z.string(), interval_count: z.number() })
          .nullable(),
      }),
    );
    if (
      price.recurring?.interval !== "month" ||
      price.recurring.interval_count !== 1
    ) {
      throw new ApiError(
        409,
        "billing_pilot_requires_monthly_price",
        "The pilot offer requires a monthly subscription price",
      );
    }
  }
  const fields: Record<string, string> = {
    mode: "subscription",
    customer: customerId,
    currency,
    payment_method_collection: "always",
    "metadata[offer_id]": offerId,
    "metadata[overage_enabled]": String(overage),
    "metadata[trial_ends_at]": String(trialEndsAt),
    "line_items[0][price]": offer.priceId,
    "line_items[0][quantity]": "1",
    success_url: config.returnUrl,
    cancel_url: config.returnUrl,
    "automatic_tax[enabled]": String(config.automaticTax),
    "tax_id_collection[enabled]": "true",
    billing_address_collection: "required",
    "customer_update[address]": "auto",
    "customer_update[name]": "auto",
    "subscription_data[metadata][workspace_id]": workspaceId,
    "subscription_data[metadata][offer_id]": offer.id,
    "subscription_data[metadata][paid_subscription]": String(
      offer.plan !== "starter",
    ),
    "subscription_data[metadata][overage_enabled]": String(overage),
  };
  if (pilotCouponId) {
    fields["discounts[0][coupon]"] = pilotCouponId;
    fields["metadata[pilot_coupon_id]"] = pilotCouponId;
    fields["subscription_data[metadata][pilot_coupon_id]"] = pilotCouponId;
  } else if (offer.couponId) fields["discounts[0][coupon]"] = offer.couponId;
  else fields.allow_promotion_codes = "true";
  // Stripe requires trial_end at least 48 hours ahead. Use a stable duration
  // near expiry so retries do not change an idempotent request's parameters.
  if (trialEndsAt > Date.now() / 1000 + 172800)
    fields["subscription_data[trial_end]"] = String(trialEndsAt);
  else if (trialEndsAt > Date.now() / 1000)
    fields["subscription_data[trial_period_days]"] = "2";
  const request = {
    fields,
    key: `checkout:${workspaceId}:${attempt!.checkout_generation}`,
  };
  await env.DB.prepare(
    "UPDATE billing_accounts SET checkout_request_json = ? WHERE workspace_id = ?",
  )
    .bind(JSON.stringify(request), workspaceId)
    .run();
  const session = await sendCheckoutRequest(env, workspaceId, request);
  // The next new checkout (after expiration/cancellation) must not reuse this
  // session's idempotency key. Lost writes recover through Stripe's open list.
  await env.DB.prepare(
    "UPDATE billing_accounts SET checkout_generation = ?, checkout_request_json = NULL WHERE workspace_id = ?",
  )
    .bind(crypto.randomUUID(), workspaceId)
    .run();
  return { url: session.url };
}

export async function createBillingPortal(env: Env, workspaceId: string) {
  const account = await billingAccount(env, workspaceId);
  if (!account.customer_id)
    throw new ApiError(409, "billing_customer_missing", "Choose a plan first");
  return stripe(env, "billing_portal/sessions", StripeUrlSchema, {
    customer: account.customer_id,
    return_url: billingConfig(env).returnUrl,
  });
}

export async function syncSubscription(
  env: Env,
  customerId: string,
  subscriptionId: string,
) {
  const account = await env.DB.prepare(
    `SELECT b.* FROM billing_accounts b JOIN workspaces w ON w.id = b.workspace_id
    WHERE b.customer_id = ? AND w.region = ?`,
  )
    .bind(customerId, env.AVALON_REGION)
    .first<BillingAccount>();
  if (!account) {
    logWarn(env, "billing_webhook_unowned", { customer_id: customerId });
    return;
  }
  const current = await billingAccount(env, account.workspace_id);
  const subscription = await stripe(
    env,
    `subscriptions/${subscriptionId}`,
    SubscriptionSchema,
  );
  if (subscription.customer !== current.customer_id) {
    throw new ApiError(
      409,
      "billing_customer_mismatch",
      "Subscription customer does not match",
    );
  }
  if (subscription.metadata.billing_role === "overage") return;
  if (subscription.metadata.billing_role === "free_record") {
    await synchronizeStripeProfile(env, current);
    return;
  }
  await reconcileCancellation(env, subscription);
  if (current.subscription_id && current.subscription_id !== subscriptionId) {
    // Old cancellation deliveries must not downgrade a later subscription.
    if (
      hasLiveSubscription(current) ||
      ["canceled", "incomplete_expired"].includes(subscription.status)
    )
      return;
  }
  await reconcileSubscription(env, current, subscription);
}

/** Closing and checkout share ownership until membership is removed. */
export async function withOrganizationBillingClosure<T>(
  env: Env,
  workspaceId: string,
  close: () => Promise<T>,
): Promise<T> {
  const closed = await env.DB.prepare(
    `SELECT w.abandoned_at, b.workspace_id AS account_id
    FROM workspaces w LEFT JOIN billing_accounts b ON b.workspace_id = w.id
    WHERE w.id = ? AND w.region = ?`,
  )
    .bind(workspaceId, env.AVALON_REGION)
    .first<{ abandoned_at: string | null; account_id: string | null }>();
  if (closed?.abandoned_at && !closed.account_id) return close();
  if (!env.BILLING_CONFIG) {
    const existing = await env.DB.prepare(
      "SELECT customer_id FROM billing_accounts WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .first<{ customer_id: string | null }>();
    if (existing?.customer_id)
      throw new ApiError(
        409,
        "billing_closure_blocked",
        "Restore billing configuration and cancel billing before closing this organization",
      );
    return close();
  }
  await billingAccount(env, workspaceId);
  const account = await refreshBillingState(
    env,
    await billingAccount(env, workspaceId),
  );
  if (
    hasLiveSubscription(account) ||
    account.checkout_request_json ||
    (account.customer_id &&
      (await openSessions(env, account.customer_id)).data.length)
  ) {
    throw new ApiError(
      409,
      "billing_closure_blocked",
      "Cancel the subscription or pending checkout before closing this organization",
    );
  }
  const result = await close();
  // Closing must not depend on reporting configuration. Retry cleanup in cron.
  if (account.customer_id) {
    try {
      await synchronizeStripeProfile(env, account);
    } catch (error) {
      logWarn(env, "billing_profile_cleanup_failed", {
        workspace_id: workspaceId,
        error_code: diagnosticErrorCode(
          error,
          "billing_profile_cleanup_failed",
        ),
      });
    }
  }
  return result;
}

interface BillingTerm {
  subscription_id: string;
  customer_id: string;
  price_id: string;
  starts_at: number;
  ends_at: number | null;
  cutoff_quota_microusd: number | null;
  final_invoice_id: string | null;
  final_invoice_finalized: number;
}

/** A canceled subscription retains its own terms and cutoff even after re-subscription. */
export async function billClosedOverage(
  env: Env,
  workspaceId: string,
  now = Date.now(),
) {
  const terms = await env.DB.prepare(
    "SELECT * FROM billing_terms WHERE workspace_id = ?",
  )
    .bind(workspaceId)
    .all<BillingTerm>();
  for (const term of terms.results) {
    if (term.final_invoice_id) {
      if (!term.final_invoice_finalized)
        await finalizeCanceledOverage(env, term);
      continue;
    }
    const startsAt = term.starts_at * 1000;
    const cutoff = term.ends_at === null ? null : term.ends_at * 1000;
    const settledThrough =
      now - billingConfig(env).settlementDelayDays * DAY * 1000;
    const last = await env.DB.prepare(
      "SELECT MAX(period_end) AS last_end FROM billing_overages WHERE subscription_id = ?",
    )
      .bind(term.subscription_id)
      .first<{ last_end: string | null }>();
    let cursor = last?.last_end ? Date.parse(last.last_end) : startsAt;
    while (cursor < settledThrough && (cutoff === null || cursor < cutoff)) {
      const periodUsage = await readOrganizationUsage(env, workspaceId, cursor);
      if (!periodUsage) break;
      const periodStart = periodUsage.overage.periodStart;
      const naturalEnd = Date.parse(periodUsage.overage.periodEndsAt);
      const end = Math.min(naturalEnd, cutoff ?? naturalEnd);
      if (end > settledThrough) break;
      // Each new activation/resumption waives its partial period. At most one
      // interval can own a period's start; later resumptions cannot bill a gap.
      const interval = await env.DB.prepare(
        `SELECT ends_at, cutoff_quota_microusd, price_id FROM billing_intervals
        WHERE subscription_id = ? AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)
        ORDER BY starts_at DESC LIMIT 1`,
      )
        .bind(
          term.subscription_id,
          Date.parse(periodStart) / 1000,
          Date.parse(periodStart) / 1000,
        )
        .first<{
          ends_at: number | null;
          cutoff_quota_microusd: number | null;
          price_id: string;
        }>();
      const intervalEnd =
        interval?.ends_at === null || !interval
          ? null
          : interval.ends_at * 1000;
      const usage =
        intervalEnd !== null && intervalEnd < naturalEnd
          ? await readOrganizationUsage(env, workspaceId, cursor, {
              at: intervalEnd,
              quotaMicrousd: interval!.cutoff_quota_microusd!,
            })
          : periodUsage;
      if (Date.parse(periodStart) >= startsAt) {
        await env.DB.prepare(
          `INSERT INTO billing_overages(workspace_id, subscription_id, period_start, period_end, amount_microusd, price_id, meter_id)
          VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        )
          .bind(
            workspaceId,
            term.subscription_id,
            periodStart,
            new Date(end).toISOString(),
            interval ? usage!.overage.amountMicrousd : 0,
            interval?.price_id ?? term.price_id,
            billingConfig(env).overageCredits?.priceId === (interval?.price_id ?? term.price_id)
              ? billingConfig(env).overageCredits!.meterId : null,
          )
          .run();
      }
      cursor = end;
    }
    const pending = await env.DB.prepare(
      "SELECT * FROM billing_overages WHERE subscription_id = ? AND invoice_item_id IS NULL AND (meter_id IS NULL OR amount_microusd = 0)",
    )
      .bind(term.subscription_id)
      .all<{
        period_start: string;
        period_end: string;
        amount_microusd: number;
        price_id: string;
      }>();
    for (const row of pending.results) {
      let itemId = "zero";
      if (row.amount_microusd > 0) {
        const receipt = `overage:${term.subscription_id}:${row.period_start}`;
        let after = "";
        let existing: string | undefined;
        do {
          const page = await stripe(
            env,
            `invoiceitems?customer=${term.customer_id}&created[gte]=${Math.floor(Date.parse(row.period_end) / 1000)}&limit=100${after ? `&starting_after=${after}` : ""}`,
            z.object({
              has_more: z.boolean(),
              data: z.array(
                z.object({
                  id: z.string(),
                  metadata: z.record(z.string(), z.string()),
                }),
              ),
            }),
          );
          existing = page.data.find(
            (item) => item.metadata.receipt === receipt,
          )?.id;
          after = page.has_more ? page.data.at(-1)!.id : "";
        } while (after && !existing);
        const item = existing
          ? { id: existing }
          : await stripe(
              env,
              "invoiceitems",
              StripeIdSchema,
              {
                customer: term.customer_id,
                ...(cutoff === null
                  ? { subscription: term.subscription_id }
                  : {}),
                price: row.price_id,
                quantity: String(row.amount_microusd),
                "metadata[receipt]": receipt,
                discountable: "false",
                description: `Rally usage beyond shared quota — period starting ${row.period_start}`,
              },
              receipt,
            );
        itemId = item.id;
      }
      await env.DB.prepare(
        "UPDATE billing_overages SET invoice_item_id = ? WHERE subscription_id = ? AND period_start = ?",
      )
        .bind(itemId, term.subscription_id, row.period_start)
        .run();
    }
    await reportMeteredOverages(env, workspaceId);
    if (cutoff !== null && cutoff <= settledThrough) {
      const legacy = await env.DB.prepare("SELECT 1 FROM billing_overages WHERE subscription_id = ? AND meter_id IS NULL AND amount_microusd > 0").bind(term.subscription_id).first();
      const native = billingConfig(env).overageCredits?.priceId === term.price_id || await env.DB.prepare("SELECT 1 FROM billing_overages WHERE subscription_id = ? AND meter_id IS NOT NULL").bind(term.subscription_id).first();
      if (native && !legacy) await env.DB.prepare("UPDATE billing_terms SET final_invoice_finalized = 1 WHERE subscription_id = ?").bind(term.subscription_id).run();
      else await finalizeCanceledOverage(env, term);
    }
  }
  await closeSettledOverageSubscriptions(env, workspaceId);
}

async function finalizeCanceledOverage(env: Env, term: BillingTerm) {
  const receipt = `final-overage:${term.subscription_id}`;
  let invoiceId = term.final_invoice_id;
  if (!invoiceId) {
    let after = "";
    do {
      const page = await stripe(
        env,
        `invoices?customer=${term.customer_id}&created[gte]=${term.ends_at}&limit=100${after ? `&starting_after=${after}` : ""}`,
        z.object({
          has_more: z.boolean(),
          data: z.array(
            z.object({
              id: z.string(),
              metadata: z.record(z.string(), z.string()),
            }),
          ),
        }),
      );
      invoiceId =
        page.data.find((item) => item.metadata.receipt === receipt)?.id ?? null;
      after = page.has_more ? page.data.at(-1)!.id : "";
    } while (after && !invoiceId);
    if (!invoiceId) {
      const subscription = await stripe(
        env,
        `subscriptions/${term.subscription_id}`,
        SubscriptionSchema,
      );
      const invoice = await stripe(
        env,
        "invoices",
        StripeIdSchema,
        {
          customer: term.customer_id,
          collection_method: "charge_automatically",
          auto_advance: "false",
          // Includes pending items left behind when Stripe canceled the subscription.
          pending_invoice_items_behavior: "include",
          "metadata[receipt]": receipt,
          "automatic_tax[enabled]": String(billingConfig(env).automaticTax),
          ...(subscription.default_payment_method
            ? { default_payment_method: subscription.default_payment_method }
            : {}),
        },
        receipt,
      );
      invoiceId = invoice.id;
    }
    await env.DB.prepare(
      "UPDATE billing_terms SET final_invoice_id = ? WHERE subscription_id = ?",
    )
      .bind(invoiceId, term.subscription_id)
      .run();
  }
  const invoice = await stripe(
    env,
    `invoices/${invoiceId}`,
    z.object({ status: z.string() }),
  );
  if (invoice.status === "draft")
    await stripe(
      env,
      `invoices/${invoiceId}/finalize`,
      StripeIdSchema,
      { auto_advance: "true" },
      `finalize:${invoiceId}`,
    );
  await env.DB.prepare(
    "UPDATE billing_terms SET final_invoice_finalized = 1 WHERE subscription_id = ?",
  )
    .bind(term.subscription_id)
    .run();
}

/** Run inside the organization's BillingCoordinatorDO. Reporting never gates collection. */
export async function settleBillingAccount(env: Env, workspaceId: string) {
  await billingAccount(env, workspaceId, true);
  try {
    await refreshBillingAccount(env, workspaceId);
    await billClosedOverage(env, workspaceId);
  } catch (error) {
    logWarn(env, "billing_settlement_failed", {
      workspace_id: workspaceId,
      error_code: diagnosticErrorCode(error, "billing_settlement_failed"),
    });
  }
  if (!billingConfig(env).synchronization) return;
  // A broken free-price/profile configuration must not strand the usage outbox.
  for (const synchronize of [
    synchronizeStripeProfile,
    synchronizeStripeUsage,
  ]) {
    try {
      await synchronize(env, await billingAccount(env, workspaceId));
    } catch (error) {
      logWarn(env, "billing_synchronization_failed", {
        workspace_id: workspaceId,
        error_code: diagnosticErrorCode(
          error,
          "billing_synchronization_failed",
        ),
      });
    }
  }
}

/** The membership fence is committed inside the same actor as Checkout. */
export async function closeOrganizationBilling(
  env: Env,
  workspaceId: string,
  actorUserId: string | null,
) {
  return withOrganizationBillingClosure(env, workspaceId, async () => {
    if (actorUserId === null) {
      const at = new Date().toISOString();
      await env.DB.prepare(
        `UPDATE workspaces SET abandoned_at = ?, updated_at = ?
        WHERE id = ? AND region = ? AND abandoned_at IS NULL`,
      )
        .bind(at, at, workspaceId, env.AVALON_REGION)
        .run();
      return;
    }
    const at = new Date().toISOString();
    const abandonment = await env.DB.batch([
      env.DB.prepare(
        `UPDATE workspaces SET abandoned_at = ?, updated_at = ?
           WHERE id = ? AND abandoned_at IS NULL
             AND EXISTS (
               SELECT 1 FROM workspace_members actor
               WHERE actor.workspace_id = workspaces.id AND actor.user_id = ?
                 AND actor.status = 'active'
             )
             AND 1 = (
               SELECT COUNT(*) FROM workspace_members active_member
               WHERE active_member.workspace_id = workspaces.id
                 AND active_member.status = 'active'
             )`,
      ).bind(at, at, workspaceId, actorUserId),
      env.DB.prepare(
        `UPDATE workspace_members SET status = 'suspended'
           WHERE workspace_id = ? AND user_id = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM workspaces
               WHERE id = ? AND abandoned_at = ?
             )`,
      ).bind(workspaceId, actorUserId, workspaceId, at),
      env.DB.prepare(
        `UPDATE workspace_invitations SET revoked_at = ?
           WHERE workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM workspaces
               WHERE id = ? AND abandoned_at = ?
             )`,
      ).bind(at, workspaceId, workspaceId, at),
    ]);

    if (Number(abandonment[0]?.meta?.changes ?? 0) !== 1)
      throw new ApiError(
        409,
        "membership_changed",
        "The organization membership changed while closing it. Check it and try again.",
      );
  });
}
