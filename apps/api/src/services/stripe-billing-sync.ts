import { z } from "zod";
import {
  PLANS,
  PlanIdSchema,
  weeklyQuotaMicrousd,
} from "@rally/contracts/usage";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import type { BillingAccount } from "./billing";
import { billingConfig, resolveBillingEnvironment } from "./billing-config";
import { stripe, StripeIdSchema } from "./stripe";

const HOUR = 3600;
// Stripe's documented event-ingestion boundary, not a product retention limit.
const STRIPE_HISTORY_SECONDS = 35 * 86400;
const MetadataSchema = z.record(z.string(), z.string());
const CustomerSchema = z.object({ id: z.string(), metadata: MetadataSchema });
const FreeSubscriptionSchema = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  trial_end: z.number().nullable().optional(),
  metadata: MetadataSchema,
  items: z.object({
    data: z.array(
      z.object({ price: z.object({ unit_amount: z.number().nullable() }) }),
    ),
  }),
});

/** Called inside the Organization billing actor. Discovery survives a lost create receipt. */
export async function ensureStripeCustomer(
  env: Env,
  account: BillingAccount,
): Promise<string> {
  env = await resolveBillingEnvironment(env);
  if (account.customer_id) return account.customer_id;
  let customerId: string | undefined;
  // Metadata search avoids an account-wide scan on every first checkout.
  const query = `metadata['workspace_id']:'${account.workspace_id.replace(/['\\]/g, "")}' AND metadata['region']:'${env.AVALON_REGION}'`;
  const page = await stripe(
    env,
    `customers/search?query=${encodeURIComponent(query)}&limit=100`,
    z.object({ data: z.array(CustomerSchema) }),
  );
  customerId = page.data.find(
    (customer) =>
      customer.metadata.workspace_id === account.workspace_id &&
      customer.metadata.region === env.AVALON_REGION,
  )?.id;
  if (!customerId) {
    const customer = await stripe(
      env,
      "customers",
      StripeIdSchema,
      {
        "metadata[workspace_id]": account.workspace_id,
        "metadata[region]": env.AVALON_REGION,
      },
      `customer:${account.workspace_id}`,
    );
    customerId = customer.id;
  }
  await env.DB.prepare(
    "UPDATE billing_accounts SET customer_id = ? WHERE workspace_id = ?",
  )
    .bind(customerId, account.workspace_id)
    .run();
  return customerId;
}

/** Retain award history, but release Stripe's active-subscription currency lock.
 * The durable marker also prevents cron from recreating a free subscription
 * while the administrator is completing Checkout in another currency. */
export async function archiveStripeFreeSubscription(
  env: Env,
  account: BillingAccount,
) {
  env = await resolveBillingEnvironment(env);
  if (!account.customer_id) return;
  if (!billingConfig(env).synchronization && !account.free_subscription_id) {
    await env.DB.prepare(
      "UPDATE billing_accounts SET free_subscription_closed = 1 WHERE workspace_id = ?",
    )
      .bind(account.workspace_id)
      .run();
    return;
  }
  let after = "";
  do {
    const page = await stripe(
      env,
      `subscriptions?customer=${account.customer_id}&status=all&limit=100${after ? `&starting_after=${after}` : ""}`,
      z.object({
        has_more: z.boolean(),
        data: z.array(FreeSubscriptionSchema),
      }),
    );
    for (const free of page.data) {
      if (
        free.metadata.billing_role !== "free_record" ||
        free.metadata.workspace_id !== account.workspace_id
      )
        continue;
      if (!["canceled", "incomplete_expired"].includes(free.status))
        await stripe(
          env,
          `subscriptions/${free.id}`,
          StripeIdSchema,
          undefined,
          undefined,
          "DELETE",
        );
      await env.DB.prepare(
        "UPDATE billing_accounts SET free_subscription_id = ? WHERE workspace_id = ?",
      )
        .bind(free.id, account.workspace_id)
        .run();
    }
    after = page.has_more ? page.data.at(-1)!.id : "";
  } while (after);
  await env.DB.prepare(
    "UPDATE billing_accounts SET free_subscription_closed = 1 WHERE workspace_id = ?",
  )
    .bind(account.workspace_id)
    .run();
}

/**
 * A zero-price subscription records the no-card trial independently of a paid
 * checkout. Its role excludes it from paid subscription/first-paid eligibility.
 * Stripe stores earned awards even when the initial sync happens after expiry.
 */
export async function synchronizeStripeProfile(
  env: Env,
  account: BillingAccount,
) {
  env = await resolveBillingEnvironment(env);
  const config = billingConfig(env);
  const sync = config.synchronization;
  if (!sync) return;
  const workspace = await env.DB.prepare(
    "SELECT name, plan, created_at, abandoned_at FROM workspaces WHERE id = ?",
  )
    .bind(account.workspace_id)
    .first<{
      name: string;
      plan: string;
      created_at: string;
      abandoned_at: string | null;
    }>();
  if (!workspace)
    throw new ApiError(
      404,
      "billing_workspace_missing",
      "Organization not found",
    );
  const customerId = await ensureStripeCustomer(env, account);
  const parsedPlan = PlanIdSchema.safeParse(workspace.plan);
  if (!parsedPlan.success)
    throw new ApiError(
      409,
      zodDiagnosticCode(parsedPlan.error, "billing_workspace_plan")!,
      "Organization plan is invalid",
    );
  const plan = parsedPlan.data;
  const awardEnd = account.trial_extended
    ? account.team_trial_ends_at
    : account.trial_base_ends_at;
  const awards = {
    workspace_id: account.workspace_id,
    region: env.AVALON_REGION,
    billing_role: "free_record",
    trial_started_at: String(account.trial_started_at),
    base_trial_ends_at: String(account.trial_base_ends_at),
    team_trial_ends_at: String(account.team_trial_ends_at),
    team_trial_members: String(account.team_trial_members),
    team_trial_awarded: String(Boolean(account.trial_extended)),
    awarded_trial_ends_at: String(awardEnd),
  };
  let free = account.free_subscription_id
    ? await stripe(
        env,
        `subscriptions/${account.free_subscription_id}`,
        FreeSubscriptionSchema,
      )
    : null;
  if (!free) {
    let after = "";
    do {
      const page = await stripe(
        env,
        `subscriptions?customer=${customerId}&status=all&limit=100${after ? `&starting_after=${after}` : ""}`,
        z.object({
          has_more: z.boolean(),
          data: z.array(FreeSubscriptionSchema),
        }),
      );
      free =
        page.data.find(
          (subscription) =>
            subscription.metadata.billing_role === "free_record" &&
            subscription.metadata.workspace_id === account.workspace_id,
        ) ?? null;
      after = page.has_more ? page.data.at(-1)!.id : "";
    } while (after && !free);
  }
  const now = Math.floor(Date.now() / 1000);
  if (
    !free &&
    !workspace.abandoned_at &&
    !account.subscription_id &&
    !account.free_subscription_closed
  ) {
    const price = await stripe(
      env,
      `prices/${sync.freePriceId}`,
      z.object({
        unit_amount: z.number().nullable(),
        billing_scheme: z.string(),
        recurring: z
          .object({
            usage_type: z.string(),
            interval: z.string(),
            interval_count: z.number(),
          })
          .nullable(),
      }),
    );
    if (
      price.unit_amount !== 0 ||
      price.billing_scheme !== "per_unit" ||
      price.recurring?.usage_type !== "licensed" ||
      price.recurring.interval !== "month" ||
      price.recurring.interval_count !== 1
    ) {
      throw new ApiError(
        503,
        "billing_free_price_invalid",
        "Billing synchronization requires a zero-price monthly subscription",
      );
    }
    free = await stripe(
      env,
      "subscriptions",
      FreeSubscriptionSchema,
      {
        customer: customerId,
        "items[0][price]": sync.freePriceId,
        "items[0][quantity]": "1",
        ...(awardEnd > now ? { trial_end: String(awardEnd) } : {}),
        "trial_settings[end_behavior][missing_payment_method]":
          "create_invoice",
        ...Object.fromEntries(
          Object.entries(awards).map(([key, value]) => [
            `metadata[${key}]`,
            value,
          ]),
        ),
      },
      `free-record:${account.workspace_id}`,
    );
  }
  if (workspace.abandoned_at) {
    if (free && !["canceled", "incomplete_expired"].includes(free.status)) {
      await stripe(
        env,
        `subscriptions/${free.id}`,
        StripeIdSchema,
        undefined,
        undefined,
        "DELETE",
      );
    }
    await env.DB.prepare(
      "UPDATE billing_accounts SET free_subscription_closed = 1 WHERE workspace_id = ?",
    )
      .bind(account.workspace_id)
      .run();
  }
  if (free) {
    if (
      free.customer !== customerId ||
      free.metadata.billing_role !== "free_record" ||
      free.metadata.workspace_id !== account.workspace_id
    ) {
      throw new ApiError(
        409,
        "billing_free_record_mismatch",
        "Stripe trial record does not match the Organization",
      );
    }
    if (
      free.items.data.length !== 1 ||
      free.items.data[0]!.price.unit_amount !== 0
    ) {
      throw new ApiError(
        409,
        "billing_free_price_changed",
        "The Stripe trial record must remain free",
      );
    }
    const newAward = account.trial_award_synced_end !== awardEnd;
    if (
      Object.entries(awards).some(
        ([key, value]) => free!.metadata[key] !== value,
      ) ||
      (newAward && awardEnd > now && free.trial_end !== awardEnd)
    ) {
      free = await stripe(
        env,
        `subscriptions/${free.id}`,
        FreeSubscriptionSchema,
        {
          ...Object.fromEntries(
            Object.entries(awards).map(([key, value]) => [
              `metadata[${key}]`,
              value,
            ]),
          ),
          ...(newAward &&
          awardEnd > now &&
          ["active", "trialing"].includes(free.status)
            ? { trial_end: String(awardEnd), proration_behavior: "none" }
            : {}),
        },
        `trial-award:${free.id}:${awardEnd}`,
      );
    }
    // Awards come from membership policy once; subsequent Stripe trial-date
    // edits are authoritative and refresh the local checkout cache.
    await env.DB.prepare(
      `UPDATE billing_accounts SET free_subscription_id = ?, trial_award_synced_end = ?, trial_ends_at = ? WHERE workspace_id = ?`,
    )
      .bind(free.id, awardEnd, free.trial_end ?? awardEnd, account.workspace_id)
      .run();
  }
  const metadata = {
    ...awards,
    billing_role: "organization",
    plan,
    included_usage_microusd: String(PLANS[plan].includedUsageUsd * 1_000_000),
    weekly_allowance_microusd: String(weeklyQuotaMicrousd(plan)),
    quota_anchor_at: workspace.created_at,
    trial_ends_at: String(free?.trial_end ?? awardEnd),
    free_subscription_id: free?.id ?? "",
    paid_subscription_id: account.subscription_id ?? "",
    overage_enabled: String(Boolean(account.overage_enabled)),
    available_pilot_coupon_id: config.pilotCouponId ?? "",
    organization_meter_id: sync.organizationMeterId,
    rally_meter_id: sync.rallyMeterId,
  };
  const customer = await stripe(env, `customers/${customerId}`, CustomerSchema);
  // Stripe unsets a metadata key when its submitted value is empty.
  if (
    Object.entries(metadata).some(
      ([key, value]) => (customer.metadata[key] ?? "") !== value,
    )
  ) {
    await stripe(env, `customers/${customerId}`, StripeIdSchema, {
      name: workspace.name,
      ...Object.fromEntries(
        Object.entries(metadata).map(([key, value]) => [
          `metadata[${key}]`,
          value,
        ]),
      ),
    });
  }
  if (!free)
    await env.DB.prepare(
      "UPDATE billing_accounts SET trial_award_synced_end = ? WHERE workspace_id = ?",
    )
      .bind(awardEnd, account.workspace_id)
      .run();
}

const MeterSchema = z.object({
  id: z.string(),
  event_name: z.string(),
  event_time_window: z.string().nullable(),
  status: z.string(),
  default_aggregation: z.object({ formula: z.string() }),
  customer_mapping: z.object({
    type: z.string(),
    event_payload_key: z.string(),
  }),
  value_settings: z.object({ event_payload_key: z.string() }),
});
interface UsageHour {
  hour_start: number;
  organization_pays: number;
  amount_microusd: number;
  revision: number;
  meter_id: string | null;
  sent_revision: number;
  confirmed_revision: number;
}

/** Runs inside the organization billing actor, independently of collection. */
export async function synchronizeStripeUsage(
  env: Env,
  account: BillingAccount,
) {
  env = await resolveBillingEnvironment(env);
  const sync = billingConfig(env).synchronization;
  if (!sync || !account.customer_id) return;
  const rows = await env.USAGE_DB.prepare(
    `SELECT * FROM billing_usage_hours WHERE workspace_id = ?
    AND (error_code IS NULL OR error_code <> 'billing_usage_timestamp_expired')
    AND (confirmed_revision <> revision OR meter_id IS NULL OR meter_id <> CASE organization_pays WHEN 1 THEN ? ELSE ? END)
    ORDER BY hour_start, organization_pays`,
  )
    .bind(account.workspace_id, sync.organizationMeterId, sync.rallyMeterId)
    .all<UsageHour>();
  if (rows.results.length === 0) return;
  const meters = new Map<number, z.infer<typeof MeterSchema>>();
  for (const [payer, id] of [
    [1, sync.organizationMeterId],
    [0, sync.rallyMeterId],
  ] as const) {
    if (!rows.results.some((row) => row.organization_pays === payer)) continue;
    const meter = await stripe(env, `billing/meters/${id}`, MeterSchema);
    if (
      meter.event_time_window !== "hour" ||
      meter.default_aggregation.formula !== "sum" ||
      meter.status !== "active" ||
      meter.customer_mapping.type !== "by_id"
    ) {
      throw new ApiError(
        503,
        "billing_usage_meter_invalid",
        "Billing synchronization requires active hourly pre-aggregated sum meters",
      );
    }
    meters.set(payer, meter);
  }
  const now = Math.floor(Date.now() / 1000);
  for (const row of rows.results) {
    const meter = meters.get(row.organization_pays)!;
    const key = [
      account.workspace_id,
      row.hour_start,
      row.organization_pays,
    ] as const;
    try {
      if (row.hour_start < now - STRIPE_HISTORY_SECONDS) {
        await env.USAGE_DB.prepare(
          "UPDATE billing_usage_hours SET error_code = ? WHERE workspace_id = ? AND hour_start = ? AND organization_pays = ?",
        )
          .bind("billing_usage_timestamp_expired", ...key)
          .run();
        logWarn(env, "billing_usage_timestamp_expired", {
          workspace_id: account.workspace_id,
          hour_start: row.hour_start,
        });
        continue;
      }
      // Future-dated clock skew waits for its hour; never move an event to a
      // different hour simply to satisfy the provider's ingestion window.
      if (row.hour_start > now) continue;
      if (row.sent_revision !== row.revision || row.meter_id !== meter.id) {
        // Replacement-by-hour supplies replay safety. A fresh event identifier
        // avoids depending on how long Stripe retains an earlier identifier.
        const identifier = crypto.randomUUID();
        await stripe(
          env,
          "billing/meter_events",
          z.object({ identifier: z.string() }),
          {
            event_name: meter.event_name,
            identifier,
            timestamp: String(row.hour_start),
            [`payload[${meter.customer_mapping.event_payload_key}]`]:
              account.customer_id,
            [`payload[${meter.value_settings.event_payload_key}]`]: String(
              row.amount_microusd,
            ),
          },
          identifier,
        );
        await env.USAGE_DB.prepare(
          `UPDATE billing_usage_hours SET meter_id = ?, sent_revision = ?, confirmed_revision = 0, last_sent_at = ?, error_code = NULL
          WHERE workspace_id = ? AND hour_start = ? AND organization_pays = ? AND revision = ?`,
        )
          .bind(meter.id, row.revision, now, ...key, row.revision)
          .run();
      }
      // Acceptance is asynchronous. A successful POST is not a reconciliation
      // receipt; read the independently aggregated Stripe value before confirming.
      const summaries = await stripe(
        env,
        `billing/meters/${meter.id}/event_summaries?customer=${account.customer_id}&start_time=${row.hour_start}&end_time=${row.hour_start + HOUR}&value_grouping_window=hour&limit=100`,
        z.object({
          has_more: z.boolean(),
          data: z.array(z.object({ aggregated_value: z.number() })),
        }),
      );
      const matches =
        !summaries.has_more &&
        summaries.data.reduce(
          (sum, value) => sum + value.aggregated_value,
          0,
        ) === row.amount_microusd;
      await env.USAGE_DB.prepare(
        `UPDATE billing_usage_hours SET confirmed_revision = ?, confirmed_at = ?, error_code = ?
        WHERE workspace_id = ? AND hour_start = ? AND organization_pays = ? AND revision = ? AND meter_id = ?`,
      )
        .bind(
          matches ? row.revision : 0,
          matches ? now : null,
          matches ? null : "billing_usage_unreconciled",
          ...key,
          row.revision,
          meter.id,
        )
        .run();
    } catch (error) {
      const code = diagnosticErrorCode(error, "billing_usage_sync_failed");
      await env.USAGE_DB.prepare(
        "UPDATE billing_usage_hours SET error_code = ? WHERE workspace_id = ? AND hour_start = ? AND organization_pays = ?",
      )
        .bind(code, ...key)
        .run();
      logWarn(env, "billing_usage_sync_failed", {
        workspace_id: account.workspace_id,
        hour_start: row.hour_start,
        error_code: code,
      });
    }
  }
}
