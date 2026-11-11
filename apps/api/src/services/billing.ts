import { z } from 'zod';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { billingConfig } from './billing-config';
import { stripe, StripeIdSchema, StripeUrlSchema } from './stripe';
import { publishOrganizationUsage, readOrganizationUsage, setWorkspacePlan } from './usage-metering';

export interface BillingAccount {
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  checkout_id: string | null;
  status: string;
  offer_id: string | null;
  currency: string | null;
  trial_started_at: number;
  trial_ends_at: number;
  trial_extended: number;
  overage_enabled: number;
  overage_started_at: number | null;
}
const DAY = 86400;
export async function billingAccount(env: Env, workspaceId: string): Promise<BillingAccount> {
  const config = billingConfig(env);
  await env.DB.prepare(`INSERT INTO billing_accounts (workspace_id, trial_started_at, trial_ends_at)
    SELECT id, unixepoch(created_at), unixepoch(created_at) + ? FROM workspaces WHERE id = ? AND region = ?
    ON CONFLICT(workspace_id) DO NOTHING`).bind(config.trialDays * DAY, workspaceId, env.AVALON_REGION).run();
  // Joining is evidence of a real team. The promotion is earned once, never reset by leaving/rejoining.
  await env.DB.prepare(`UPDATE billing_accounts SET trial_extended = 1,
    trial_ends_at = MAX(trial_ends_at, trial_started_at + ?)
    WHERE workspace_id = ? AND trial_extended = 0 AND subscription_id IS NULL
    AND trial_ends_at > ? AND (SELECT COUNT(*) FROM workspace_members
      WHERE workspace_id = ? AND status = 'active' AND access_class = 'member') >= ?`)
    .bind(config.teamTrialDays * DAY, workspaceId, Math.floor(Date.now() / 1000), workspaceId, config.teamTrialMembers).run();
  const account = await env.DB.prepare('SELECT * FROM billing_accounts WHERE workspace_id = ?').bind(workspaceId).first<BillingAccount>();
  if (!account) throw new ApiError(404, 'billing_account_not_found', 'Organization not found');
  return account;
}

// Serialize checkout and reconciliation per account. A crashed request releases after
// five minutes (Stripe requests normally finish in seconds); callers retry a conflict.
async function withBillingLock<T>(env: Env, workspaceId: string, work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const claimed = await env.DB.prepare(`UPDATE billing_accounts SET sync_token = ?, sync_until = ?
    WHERE workspace_id = ? AND sync_until < ? RETURNING workspace_id`).bind(token, now + 300_000, workspaceId, now).first();
  if (!claimed) throw new ApiError(409, 'billing_busy', 'Billing is updating; please retry');
  try { return await work(); }
  finally { await env.DB.prepare('UPDATE billing_accounts SET sync_until = 0 WHERE workspace_id = ? AND sync_token = ?').bind(workspaceId, token).run(); }
}

export async function createCheckout(env: Env, workspaceId: string, offerId: string, currency: string, overage: boolean) {
  const config = billingConfig(env);
  const offer = config.offers.find((o) => o.id === offerId && o.enabled);
  if (!offer || !offer.currencies.includes(currency)) throw new ApiError(400, 'billing_offer_unavailable', 'This plan or currency is unavailable');
  if (overage && (!offer.overagePriceId || currency !== 'usd')) throw new ApiError(400, 'billing_overage_unavailable', 'Overage billing is unavailable for this plan or currency');
  await billingAccount(env, workspaceId);
  return withBillingLock(env, workspaceId, async () => {
    const account = await billingAccount(env, workspaceId);
    if (account.subscription_id) throw new ApiError(409, 'billing_subscription_exists', 'Manage the existing subscription in the billing portal');
    if (account.checkout_id) {
      const session = await stripe(env, `checkout/sessions/${account.checkout_id}`, z.object({ status: z.string(), url: z.string().nullable() }));
      if (session.status === 'open') {
        if (account.offer_id !== offerId || account.currency !== currency || Boolean(account.overage_enabled) !== overage) {
          throw new ApiError(409, 'billing_checkout_pending', 'Complete or let the existing checkout expire before choosing another offer');
        }
        return { url: session.url };
      }
      if (session.status === 'complete') throw new ApiError(409, 'billing_sync_pending', 'Payment is being synchronized; please retry shortly');
    }
    let customerId = account.customer_id;
    if (!customerId) {
      const customer = await stripe(env, 'customers', StripeIdSchema, { 'metadata[workspace_id]': workspaceId, 'metadata[region]': env.AVALON_REGION }, `customer:${workspaceId}`);
      customerId = customer.id;
      await env.DB.prepare('UPDATE billing_accounts SET customer_id = ? WHERE workspace_id = ?').bind(customerId, workspaceId).run();
    }
    // Recover external effects if a previous request reached Stripe but died
    // before saving the session ID. Stripe's idempotency cache lasts only 24h.
    const subscriptions = await stripe(env, `subscriptions?customer=${customerId}&status=all&limit=100`,
      z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) }));
    const existingSubscription = subscriptions.data.find((item) => !['canceled', 'incomplete_expired'].includes(item.status));
    if (existingSubscription) {
      await env.DB.prepare('UPDATE billing_accounts SET subscription_id = ?, status = ? WHERE workspace_id = ?')
        .bind(existingSubscription.id, existingSubscription.status, workspaceId).run();
      throw new ApiError(409, 'billing_subscription_exists', 'Manage the existing subscription in the billing portal');
    }
    let after = '';
    do {
      const sessions = await stripe(env, `checkout/sessions?customer=${customerId}&limit=100${after ? `&starting_after=${after}` : ''}`,
        z.object({ has_more: z.boolean(), data: z.array(z.object({ id: z.string(), status: z.string(), url: z.string().nullable(), currency: z.string().nullable(), metadata: z.record(z.string(), z.string()).nullable() })) }));
      const pending = sessions.data.find((item) => item.status === 'open');
      if (pending) {
        if (pending.metadata?.offer_id !== offerId || pending.currency !== currency || pending.metadata.overage_enabled !== String(overage)) {
          throw new ApiError(409, 'billing_checkout_pending', 'Complete or let the existing checkout expire before choosing another offer');
        }
        await env.DB.prepare('UPDATE billing_accounts SET checkout_id = ?, offer_id = ?, currency = ?, overage_enabled = ? WHERE workspace_id = ?')
          .bind(pending.id, offerId, currency, overage ? 1 : 0, workspaceId).run();
        return { url: pending.url };
      }
      after = sessions.has_more ? sessions.data.at(-1)!.id : '';
    } while (after);
    const fields: Record<string, string> = {
      mode: 'subscription', customer: customerId, currency,
      'metadata[offer_id]': offerId, 'metadata[overage_enabled]': String(overage),
      'line_items[0][price]': offer.priceId, 'line_items[0][quantity]': '1',
      success_url: config.returnUrl, cancel_url: config.returnUrl,
      'automatic_tax[enabled]': String(config.automaticTax),
      'tax_id_collection[enabled]': 'true', billing_address_collection: 'required',
      'customer_update[address]': 'auto', 'customer_update[name]': 'auto',
      'subscription_data[metadata][workspace_id]': workspaceId,
      'subscription_data[metadata][offer_id]': offer.id,
      'subscription_data[metadata][overage_enabled]': String(overage),
    };
    if (offer.couponId) fields['discounts[0][coupon]'] = offer.couponId;
    else fields.allow_promotion_codes = 'true';
    // Stripe requires trial_end to be at least 48 hours in the future.
    if (account.trial_ends_at > Date.now() / 1000) fields['subscription_data[trial_end]'] = String(Math.max(account.trial_ends_at, Math.floor(Date.now() / 1000) + 172801));
    const session = await stripe(env, 'checkout/sessions', StripeUrlSchema, fields,
      `checkout:${workspaceId}:${account.checkout_id ?? 'first'}:${offerId}:${currency}:${overage}`);
    await env.DB.prepare(`UPDATE billing_accounts SET checkout_id = ?, offer_id = ?, currency = ?, overage_enabled = ? WHERE workspace_id = ?`)
      .bind(session.id, offerId, currency, overage ? 1 : 0, workspaceId).run();
    return { url: session.url };
  });
}

export async function createBillingPortal(env: Env, workspaceId: string) {
  const account = await billingAccount(env, workspaceId);
  if (!account.customer_id) throw new ApiError(409, 'billing_customer_missing', 'Choose a plan first');
  return stripe(env, 'billing_portal/sessions', StripeUrlSchema, { customer: account.customer_id, return_url: billingConfig(env).returnUrl });
}

export const SubscriptionSchema = z.object({
  id: z.string(), customer: z.string(), status: z.string(), currency: z.string(),
  metadata: z.record(z.string(), z.string()),
  items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })) }),
});

/** Re-fetch current Stripe state under a lock: an old webhook cannot restore an old plan. */
export async function syncSubscription(env: Env, customerId: string, subscriptionId: string) {
  const account = await env.DB.prepare('SELECT * FROM billing_accounts WHERE customer_id = ?').bind(customerId).first<BillingAccount>();
  if (!account) throw new ApiError(409, 'billing_customer_unknown', 'Billing customer is not synchronized');
  await withBillingLock(env, account.workspace_id, async () => {
    const subscription = await stripe(env, `subscriptions/${subscriptionId}`, SubscriptionSchema);
    if (subscription.customer !== customerId) throw new ApiError(409, 'billing_customer_mismatch', 'Subscription customer does not match');
    if (account.subscription_id && account.subscription_id !== subscriptionId) return;
    const offer = billingConfig(env).offers.find((o) => subscription.items.data.some((item) => item.price.id === o.priceId));
    if (!offer) throw new ApiError(409, 'billing_price_unknown', 'Subscription price is not configured');
    if (subscription.status === 'active' || subscription.status === 'trialing') {
      if (!await setWorkspacePlan(env, account.workspace_id, offer.plan, Date.now())) throw new ApiError(409, 'billing_region_mismatch', 'Organization is in another region');
    }
    await env.DB.prepare(`UPDATE billing_accounts SET subscription_id = ?, status = ?, offer_id = ?, currency = ?,
      overage_started_at = CASE WHEN overage_enabled = 1 AND ? = 'active' THEN COALESCE(overage_started_at, ?) ELSE overage_started_at END WHERE workspace_id = ?`)
      .bind(subscription.id, subscription.status, offer.id, subscription.currency, subscription.status, Math.floor(Date.now() / 1000), account.workspace_id).run();
    await publishOrganizationUsage(env, account.workspace_id);
  });
}

/** Snapshot a closed ledger period and attach it to the next invoice. Retries use
 * the stored quantity and Stripe key; an uncertain result is never recomputed. */
export async function billClosedOverage(env: Env, workspaceId: string, now = Date.now()) {
  await withBillingLock(env, workspaceId, async () => {
    const account = await billingAccount(env, workspaceId);
    if (!account.overage_enabled || account.status !== 'active' || account.currency !== 'usd' || !account.customer_id) return;
    const offer = billingConfig(env).offers.find((o) => o.id === account.offer_id);
    if (!offer?.overagePriceId) return;
    const startsAt = Math.max(account.trial_ends_at, account.overage_started_at ?? Math.floor(now / 1000)) * 1000;
    const settledThrough = now - billingConfig(env).settlementDelayDays * DAY * 1000;
    const last = await env.DB.prepare('SELECT MAX(period_end) AS last_end FROM billing_overages WHERE workspace_id = ?')
      .bind(workspaceId).first<{ last_end: string | null }>();
    let cursor = last?.last_end ? Date.parse(last.last_end) : startsAt;
    while (cursor < settledThrough) {
      const usage = await readOrganizationUsage(env, workspaceId, cursor);
      if (!usage) return;
      const end = Date.parse(usage.overage.periodEndsAt);
      if (end > settledThrough) break;
      // The partial activation period is free; never charge pre-consent usage.
      if (Date.parse(usage.overage.periodStart) >= startsAt) {
        await env.DB.prepare(`INSERT INTO billing_overages (workspace_id, period_start, period_end, amount_microusd, price_id)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(workspaceId, usage.overage.periodStart,
            usage.overage.periodEndsAt, usage.overage.amountMicrousd, offer.overagePriceId).run();
      }
      cursor = end;
    }
    const pending = await env.DB.prepare(`SELECT * FROM billing_overages WHERE workspace_id = ? AND invoice_item_id IS NULL`)
      .bind(workspaceId).all<{ period_start: string; amount_microusd: number; price_id: string }>();
    for (const row of pending.results) {
      if (row.amount_microusd === 0) {
        await env.DB.prepare('UPDATE billing_overages SET invoice_item_id = ? WHERE workspace_id = ? AND period_start = ?').bind('zero', workspaceId, row.period_start).run();
        continue;
      }
      // List all invoice items to recover an uncertain result even beyond Stripe's
      // 24-hour idempotency retention; metadata is the permanent receipt.
      const receipt = `overage:${workspaceId}:${row.period_start}`;
      let after = '';
      let existing: string | undefined;
      do {
        const page = await stripe(env, `invoiceitems?customer=${account.customer_id}&limit=100${after ? `&starting_after=${after}` : ''}`,
          z.object({ has_more: z.boolean(), data: z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.string()) })) }));
        existing = page.data.find((item) => item.metadata.receipt === receipt)?.id;
        after = page.has_more ? page.data.at(-1)!.id : '';
      } while (after && !existing);
      const item = existing ? { id: existing } : await stripe(env, 'invoiceitems', StripeIdSchema, {
        customer: account.customer_id, subscription: account.subscription_id!, price: row.price_id,
        quantity: String(row.amount_microusd), 'metadata[receipt]': receipt,
        description: `Rally usage beyond shared quota — period starting ${row.period_start}`,
      }, receipt);
      await env.DB.prepare('UPDATE billing_overages SET invoice_item_id = ? WHERE workspace_id = ? AND period_start = ?')
        .bind(item.id, workspaceId, row.period_start).run();
    }
  });
}
