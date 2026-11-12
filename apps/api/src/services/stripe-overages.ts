import { z } from "zod";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { billingConfig } from "./billing-config";
import { stripe, StripeIdSchema } from "./stripe";

const Meter = z.object({
  id: z.string(), event_name: z.string(), status: z.string(), event_time_window: z.string().nullable(),
  default_aggregation: z.object({ formula: z.string() }),
  customer_mapping: z.object({ type: z.string(), event_payload_key: z.string() }),
  value_settings: z.object({ event_payload_key: z.string() }),
});
const Subscription = z.object({
  id: z.string(), customer: z.string(), status: z.string(), cancel_at_period_end: z.boolean(),
  discounts: z.array(z.unknown()),
  metadata: z.record(z.string(), z.string()),
  items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })) }),
});

export async function validateOverageMeter(env: Env, priceId: string, meterId: string) {
  const reused = await env.DB.prepare("SELECT 1 FROM billing_overages WHERE meter_id = ? AND price_id <> ? LIMIT 1").bind(meterId, priceId).first();
  if (reused) throw new ApiError(503, "billing_overage_credit_meter_reused", "Use a separate meter when changing the overage price");
  const price = await stripe(env, `prices/${encodeURIComponent(priceId)}`, z.object({
    currency: z.string(), unit_amount_decimal: z.string().nullable(), billing_scheme: z.string(),
    transform_quantity: z.unknown().nullable(),
    recurring: z.object({ usage_type: z.string(), interval: z.string(), interval_count: z.number(), meter: z.string().nullable() }).nullable(),
  }));
  if (price.currency !== "usd" || Number(price.unit_amount_decimal) !== 0.0001 || price.billing_scheme !== "per_unit" || price.transform_quantity !== null ||
    price.recurring?.usage_type !== "metered" || price.recurring.interval !== "month" || price.recurring.interval_count !== 1 || price.recurring.meter !== meterId)
    throw new ApiError(503, "billing_overage_credit_price_invalid", "Overage credits require a monthly USD metered price of $0.000001 per unit");
  const meter = await stripe(env, `billing/meters/${encodeURIComponent(meterId)}`, Meter);
  if (meter.status !== "active" || meter.event_time_window !== "hour" || meter.default_aggregation.formula !== "sum" || meter.customer_mapping.type !== "by_id")
    throw new ApiError(503, "billing_overage_credit_meter_invalid", "Overage credits require an active hourly pre-aggregated sum meter");
  const reporting = billingConfig(env).synchronization;
  if (reporting && [reporting.organizationMeterId, reporting.rallyMeterId].includes(meterId))
    throw new ApiError(503, "billing_overage_credit_meter_shared", "Billable overages require a dedicated meter");
  return meter;
}

async function overageSubscription(env: Env, workspaceId: string, customer: string, priceId: string, sourceSubscription: string) {
  await env.DB.prepare("INSERT INTO billing_overage_subscriptions(workspace_id, price_id, generation) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(workspaceId, priceId, crypto.randomUUID()).run();
  let row = (await env.DB.prepare("SELECT generation, subscription_id, closed FROM billing_overage_subscriptions WHERE workspace_id = ? AND price_id = ?")
    .bind(workspaceId, priceId).first<{ generation: string; subscription_id: string | null; closed: number }>())!;
  let subscription = row.subscription_id ? await stripe(env, `subscriptions/${row.subscription_id}`, Subscription) : null;
  if (subscription?.status === "canceled") {
    // A scheduled end is ours. An external cancellation with unsettled usage
    // needs an operator repair rather than silently recreating the canceled bill.
    if (!row.closed) throw new ApiError(409, "billing_overage_subscription_canceled", "The overage subscription was canceled before settlement");
    row = { generation: crypto.randomUUID(), subscription_id: null, closed: 0 };
    await env.DB.prepare("UPDATE billing_overage_subscriptions SET generation = ?, subscription_id = NULL, closed = 0 WHERE workspace_id = ? AND price_id = ?")
      .bind(row.generation, workspaceId, priceId).run();
    subscription = null;
  }
  const receipt = `overage-subscription:${workspaceId}:${row.generation}`;
  if (!subscription) {
    let after = "";
    do {
      const page = await stripe(env, `subscriptions?customer=${customer}&status=all&limit=100${after ? `&starting_after=${after}` : ""}`,
        z.object({ has_more: z.boolean(), data: z.array(Subscription) }));
      subscription = page.data.find((item) => item.metadata.receipt === receipt) ?? null;
      after = page.has_more ? page.data.at(-1)!.id : "";
    } while (after && !subscription);
    if (!subscription) {
      const source = await stripe(env, `subscriptions/${sourceSubscription}`, z.object({ default_payment_method: z.string().nullable() }));
      subscription = await stripe(env, "subscriptions", Subscription, {
        customer, "items[0][price]": priceId, collection_method: "charge_automatically",
        "automatic_tax[enabled]": String(billingConfig(env).automaticTax),
        "metadata[billing_role]": "overage", "metadata[workspace_id]": workspaceId, "metadata[region]": env.AVALON_REGION, "metadata[receipt]": receipt,
        // Whole-hour renewals keep an absolute hourly meter bucket on one invoice.
        "billing_cycle_anchor_config[day_of_month]": "1", "billing_cycle_anchor_config[hour]": "0",
        "billing_cycle_anchor_config[minute]": "0", "billing_cycle_anchor_config[second]": "0",
        ...(source.default_payment_method ? { default_payment_method: source.default_payment_method } : {}),
      }, receipt);
    }
    await env.DB.prepare("UPDATE billing_overage_subscriptions SET subscription_id = ? WHERE workspace_id = ? AND price_id = ?")
      .bind(subscription.id, workspaceId, priceId).run();
  }
  if (subscription.customer !== customer || subscription.metadata.billing_role !== "overage" ||
    subscription.items.data.length !== 1 || subscription.items.data[0]!.price.id !== priceId || subscription.status !== "active")
    throw new ApiError(409, "billing_overage_subscription_invalid", "The overage subscription needs billing operator attention");
  // On CREATE even an empty discounts array inherits customer-level discounts.
  // UPDATE with the empty string explicitly removes them before usage is sent.
  if (subscription.discounts.length) await stripe(env, `subscriptions/${subscription.id}`, StripeIdSchema, { discounts: "" });
  if (subscription.cancel_at_period_end) {
    await stripe(env, `subscriptions/${subscription.id}`, StripeIdSchema, { cancel_at_period_end: "false" });
    await env.DB.prepare("UPDATE billing_overage_subscriptions SET closed = 0 WHERE workspace_id = ? AND price_id = ?").bind(workspaceId, priceId).run();
  }
  return subscription;
}

/** Only settled billable overages enter this meter. Full usage has separate meters. */
export async function reportMeteredOverages(env: Env, workspaceId: string) {
  const pending = await env.DB.prepare(`SELECT o.*, t.customer_id FROM billing_overages o JOIN billing_terms t USING(subscription_id)
    WHERE o.workspace_id = ? AND o.meter_id IS NOT NULL AND o.invoice_item_id IS NULL`).bind(workspaceId).all<{
      subscription_id: string; customer_id: string; price_id: string; meter_id: string; period_start: string; meter_event_at: number | null;
    }>();
  if (!pending.results.length) return;
  const meters = new Map<string, z.infer<typeof Meter>>();
  // Establish the Stripe subscription before assigning a delivery timestamp.
  // Old usage is billed when settled, not backdated into a finalized invoice.
  for (const row of pending.results) {
    if (!meters.has(row.price_id)) {
      meters.set(row.price_id, await validateOverageMeter(env, row.price_id, row.meter_id));
      await overageSubscription(env, workspaceId, row.customer_id, row.price_id, row.subscription_id);
    }
    if (row.meter_event_at === null) await env.DB.prepare("UPDATE billing_overages SET meter_event_at = ? WHERE subscription_id = ? AND period_start = ?")
      .bind(Math.floor(Date.now() / 1000), row.subscription_id, row.period_start).run();
  }
  const hours = await env.DB.prepare(`SELECT o.price_id, o.meter_id, t.customer_id, (o.meter_event_at / 3600) * 3600 AS hour_start,
      MAX(o.meter_event_at) AS event_at, SUM(o.amount_microusd) AS amount
    FROM billing_overages o JOIN billing_terms t USING(subscription_id)
    WHERE o.workspace_id = ? AND o.meter_id IS NOT NULL AND o.meter_event_at IS NOT NULL
    GROUP BY o.price_id, o.meter_id, t.customer_id, hour_start HAVING SUM(o.invoice_item_id IS NULL) > 0`)
    .bind(workspaceId).all<{ price_id: string; meter_id: string; customer_id: string; hour_start: number; event_at: number; amount: number }>();
  for (const hour of hours.results) {
    // Stripe accepts events up to 35 days old. Do not move an uncertain event to
    // a new period, which could charge it twice; surface the financial repair.
    if (hour.event_at < Date.now() / 1000 - 35 * 86400)
      throw new ApiError(409, "billing_overage_event_expired", "An unsettled Stripe overage event needs billing operator reconciliation");
    const meter = meters.get(hour.price_id)!;
    const identifier = crypto.randomUUID();
    await stripe(env, "billing/meter_events", z.object({ identifier: z.string() }), {
      event_name: meter.event_name, identifier, timestamp: String(hour.event_at),
      [`payload[${meter.customer_mapping.event_payload_key}]`]: hour.customer_id,
      [`payload[${meter.value_settings.event_payload_key}]`]: String(hour.amount),
    }, identifier);
    // Hourly pre-aggregation replaces the bucket, so replay after a lost response
    // or D1 failure is safe even after Stripe forgets an idempotency key. No
    // usage-summary comparison gates invoice collection.
    await env.DB.prepare(`UPDATE billing_overages SET invoice_item_id = ? WHERE workspace_id = ? AND price_id = ? AND meter_id = ?
      AND meter_event_at >= ? AND meter_event_at < ?`).bind(`meter:${hour.meter_id}:${hour.hour_start}`, workspaceId, hour.price_id, hour.meter_id, hour.hour_start, hour.hour_start + 3600).run();
  }
}

/** Once all consent terms finish, let Stripe invoice and cancel at period end.
 * Its normal automatic-finalization delay lets asynchronous meter events land. */
export async function closeSettledOverageSubscriptions(env: Env, workspaceId: string) {
  const unfinished = await env.DB.prepare("SELECT 1 FROM billing_terms WHERE workspace_id = ? AND final_invoice_finalized = 0").bind(workspaceId).first();
  if (unfinished) return;
  const rows = await env.DB.prepare("SELECT price_id, subscription_id FROM billing_overage_subscriptions WHERE workspace_id = ? AND closed = 0 AND subscription_id IS NOT NULL")
    .bind(workspaceId).all<{ price_id: string; subscription_id: string }>();
  for (const row of rows.results) {
    const subscription = await stripe(env, `subscriptions/${row.subscription_id}`, Subscription);
    if (subscription.status !== "canceled" && !subscription.cancel_at_period_end)
      await stripe(env, `subscriptions/${row.subscription_id}`, StripeIdSchema, { cancel_at_period_end: "true" });
    await env.DB.prepare("UPDATE billing_overage_subscriptions SET closed = 1 WHERE workspace_id = ? AND price_id = ?").bind(workspaceId, row.price_id).run();
  }
}
