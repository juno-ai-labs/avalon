import { z } from 'zod';
import { weeklyQuotaMicrousd, PlanIdSchema } from '@rally/contracts/usage';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { diagnosticErrorCode, logWarn } from '../observability/logger';
import { billingConfig } from './billing-config';
import { stripe, StripeIdSchema, StripeUrlSchema } from './stripe';
import { publishOrganizationUsage, readOrganizationUsage, setWorkspacePlan } from './usage-metering';
import { ensureStripeCustomer, synchronizeStripeProfile, synchronizeStripeUsage } from './stripe-billing-sync';

export interface BillingAccount {
  workspace_id: string;
  customer_id: string | null;
  subscription_id: string | null;
  free_subscription_id: string | null;
  trial_award_synced_end: number | null;
  checkout_generation: string;
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
export const hasLiveSubscription = (account: BillingAccount) => Boolean(account.subscription_id) && !['canceled', 'incomplete_expired'].includes(account.status);
export async function billingAccount(env: Env, workspaceId: string): Promise<BillingAccount> {
  const config = billingConfig(env);
  await env.DB.prepare(`INSERT INTO billing_accounts (workspace_id, checkout_generation, trial_started_at, trial_ends_at,
    trial_base_ends_at, team_trial_ends_at, team_trial_members)
    SELECT id, ?, unixepoch(created_at), unixepoch(created_at) + ?, unixepoch(created_at) + ?, unixepoch(created_at) + ?, ?
    FROM workspaces WHERE id = ? AND region = ? AND abandoned_at IS NULL
    ON CONFLICT(workspace_id) DO NOTHING`).bind(crypto.randomUUID(), config.trialDays * DAY,
      config.trialDays * DAY, config.teamTrialDays * DAY, config.teamTrialMembers, workspaceId, env.AVALON_REGION).run();
  // Bootstrap eligibility from durable join times, even when the first read is after day 14.
  // Subsequent membership transitions award it in the same transaction via D1 triggers.
  await env.DB.prepare(`UPDATE billing_accounts SET trial_extended = 1, trial_ends_at = MAX(trial_ends_at, team_trial_ends_at)
    WHERE workspace_id = ? AND trial_extended = 0 AND subscription_id IS NULL
    AND (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = ? AND m.status = 'active'
      AND m.access_class = 'member' AND unixepoch(m.joined_at) < trial_base_ends_at) >= team_trial_members`)
    .bind(workspaceId, workspaceId).run();
  const account = await env.DB.prepare('SELECT * FROM billing_accounts WHERE workspace_id = ?').bind(workspaceId).first<BillingAccount>();
  if (!account) throw new ApiError(404, 'billing_account_not_found', 'Organization not found');
  return account;
}

// An ownership claim, not a timed lease. Never steal it from a slow Stripe request.
// If a Worker is terminated, an operator may clear the token only after fencing
// the old invocation (see docs/stripe-billing.md). A guessed timeout is unsafe.
export async function withBillingLock<T>(env: Env, workspaceId: string, work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE billing_accounts SET sync_token = ?
    WHERE workspace_id = ? AND sync_token IS NULL RETURNING workspace_id`).bind(token, workspaceId).first();
  if (!claimed) throw new ApiError(409, 'billing_busy', 'Billing is updating; please retry');
  try { return await work(); }
  finally { await env.DB.prepare('UPDATE billing_accounts SET sync_token = NULL WHERE workspace_id = ? AND sync_token = ?').bind(workspaceId, token).run(); }
}

export const SubscriptionSchema = z.object({
  id: z.string(), customer: z.string(), status: z.string(), currency: z.string(),
  ended_at: z.number().nullable().optional(), trial_end: z.number().nullable().optional(),
  default_payment_method: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()),
  items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string(), unit_amount: z.number().nullable().optional() }) })) }),
});
type Subscription = z.infer<typeof SubscriptionSchema>;

/** All callers hold the account claim. Price metadata disambiguates shared-price offers. */
async function reconcileSubscription(env: Env, account: BillingAccount, subscription: Subscription) {
  if (subscription.customer !== account.customer_id) throw new ApiError(409, 'billing_customer_mismatch', 'Subscription customer does not match');
  const config = billingConfig(env);
  const candidates = config.offers.filter((o) => subscription.items.data.some((item) => item.price.id === o.priceId));
  const offer = candidates.find((o) => o.id === subscription.metadata.offer_id) ?? (candidates.length === 1 ? candidates[0] : undefined);
  if (!offer) throw new ApiError(409, candidates.length ? 'billing_offer_ambiguous' : 'billing_price_unknown', 'Subscription offer is not configured unambiguously');
  // A checkout can complete while the team award is being earned. Reconcile the
  // Stripe trial too, so opening an older hosted page cannot shorten the award.
  const pilot = Boolean(subscription.metadata.pilot_coupon_id);
  if (!pilot && subscription.status === 'trialing' && account.trial_ends_at > (subscription.trial_end ?? 0)) {
    subscription = await stripe(env, `subscriptions/${subscription.id}`, SubscriptionSchema,
      { trial_end: String(account.trial_ends_at), proration_behavior: 'none' }, `trial:${subscription.id}:${account.trial_ends_at}`);
  }
  const paid = subscription.status === 'active' || subscription.status === 'trialing';
  const overage = subscription.metadata.overage_enabled === 'true' && subscription.currency === 'usd' && Boolean(offer.overagePriceId);
  const now = Math.floor(Date.now() / 1000);
  const same = account.subscription_id === subscription.id;
  const startedAt = overage && subscription.status === 'active' ? (same ? account.overage_started_at : null) ?? now : same ? account.overage_started_at : null;
  if (overage && startedAt !== null) {
    await env.DB.prepare(`INSERT INTO billing_terms(subscription_id, workspace_id, customer_id, price_id, starts_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(subscription.id, account.workspace_id,
        subscription.customer, offer.overagePriceId!, pilot ? startedAt : Math.max(account.trial_ends_at, startedAt)).run();
  }
  if (subscription.status === 'canceled') {
    const workspace = await env.DB.prepare('SELECT plan FROM workspaces WHERE id = ?').bind(account.workspace_id).first<{ plan: string }>();
    await env.DB.prepare(`UPDATE billing_terms SET ends_at = COALESCE(ends_at, ?), cutoff_quota_microusd = COALESCE(cutoff_quota_microusd, ?)
      WHERE subscription_id = ?`).bind(subscription.ended_at ?? now,
        weeklyQuotaMicrousd(PlanIdSchema.parse(workspace!.plan)), subscription.id).run();
  }
  const plan = paid ? offer.plan : config.unpaidPlan;
  const workspacePlan = await env.DB.prepare('SELECT plan FROM workspaces WHERE id = ?').bind(account.workspace_id).first<{ plan: string }>();
  if (workspacePlan?.plan !== plan && !await setWorkspacePlan(env, account.workspace_id, plan, Date.now())) throw new ApiError(409, 'billing_region_mismatch', 'Organization is in another region');
  await env.DB.prepare(`UPDATE billing_accounts SET subscription_id = ?, status = ?, offer_id = ?, currency = ?,
    overage_enabled = ?, overage_started_at = ? WHERE workspace_id = ?`)
    .bind(subscription.id, subscription.status, offer.id, subscription.currency, overage ? 1 : 0, startedAt, account.workspace_id).run();
  await publishOrganizationUsage(env, account.workspace_id);
}

// Pagination uses Stripe's published maximum page size (100), not an account cap.
async function subscriptionHistory(env: Env, customerId: string) {
  const config = billingConfig(env);
  let hasPaidSubscription = false;
  let after = '';
  do {
    const page = await stripe(env, `subscriptions?customer=${customerId}&status=all&limit=100${after ? `&starting_after=${after}` : ''}`,
      z.object({ has_more: z.boolean(), data: z.array(SubscriptionSchema) }));
    const live = page.data.find((item) => item.metadata.billing_role !== 'free_record' && !['canceled', 'incomplete_expired'].includes(item.status));
    // A canceled pilot still counts, including its zero-dollar invoices. An
    // expired incomplete payment never activated a subscription. Unknown retired
    // prices count as paid; keep their catalog entries for reconciliation.
    hasPaidSubscription ||= page.data.some((item) => item.metadata.billing_role !== 'free_record' && item.status !== 'incomplete_expired' && (
      Boolean(item.metadata.pilot_coupon_id) || item.metadata.paid_subscription === 'true' ||
      item.items.data.some(({ price }) => price.unit_amount === 0 ? false : price.unit_amount != null ? true :
        !config.offers.some((offer) => offer.priceId === price.id && offer.plan === 'starter'))));
    if (live) return { live, hasPaidSubscription };
    after = page.has_more ? page.data.at(-1)!.id : '';
  } while (after);
  return { live: null, hasPaidSubscription };
}

async function refreshUnderLock(env: Env, account: BillingAccount) {
  if (billingConfig(env).synchronization) account = { ...account, customer_id: await ensureStripeCustomer(env, account) };
  if (!account.customer_id) return { ...account, hasPaidSubscription: false };
  const { live, hasPaidSubscription } = await subscriptionHistory(env, account.customer_id);
  if (live) await reconcileSubscription(env, account, live);
  else if (hasLiveSubscription(account)) {
    await reconcileSubscription(env, account, await stripe(env, `subscriptions/${account.subscription_id}`, SubscriptionSchema));
  }
  const refreshed = await billingAccount(env, account.workspace_id);
  await synchronizeStripeProfile(env, refreshed);
  return { ...await billingAccount(env, account.workspace_id), hasPaidSubscription };
}

export async function refreshBillingAccount(env: Env, workspaceId: string) {
  await billingAccount(env, workspaceId);
  return withBillingLock(env, workspaceId, async () => refreshUnderLock(env, await billingAccount(env, workspaceId)));
}

const OpenSessionsSchema = z.object({ data: z.array(z.object({ id: z.string(), url: z.string(), currency: z.string(), metadata: z.record(z.string(), z.string()) })) });
const openSessions = (env: Env, customerId: string) => stripe(env,
  `checkout/sessions?customer=${customerId}&status=open&limit=1`, OpenSessionsSchema);

export async function createCheckout(env: Env, workspaceId: string, offerId: string, currency: string, overage: boolean) {
  const config = billingConfig(env);
  const offer = config.offers.find((o) => o.id === offerId && o.enabled);
  if (!offer || !offer.currencies.includes(currency)) throw new ApiError(400, 'billing_offer_unavailable', 'This plan or currency is unavailable');
  if (overage && (!offer.overagePriceId || currency !== 'usd')) throw new ApiError(400, 'billing_overage_unavailable', 'Overage billing is unavailable for this plan or currency');
  await billingAccount(env, workspaceId);
  return withBillingLock(env, workspaceId, async () => {
    const workspace = await env.DB.prepare('SELECT abandoned_at FROM workspaces WHERE id = ?').bind(workspaceId).first<{ abandoned_at: string | null }>();
    if (!workspace || workspace.abandoned_at) throw new ApiError(409, 'billing_workspace_closed', 'Organization is closed');
    const account = await refreshUnderLock(env, await billingAccount(env, workspaceId));
    // Recovery applies the plan too, then takes the administrator straight to management.
    if (hasLiveSubscription(account)) return createBillingPortal(env, workspaceId);
    const pilotCouponId = !account.hasPaidSubscription && offer.plan !== 'starter' ? config.pilotCouponId : undefined;
    const trialEndsAt = pilotCouponId || account.hasPaidSubscription ? 0 : account.trial_ends_at;
    let customerId = account.customer_id;
    if (!customerId) {
      const customer = await stripe(env, 'customers', StripeIdSchema, { 'metadata[workspace_id]': workspaceId, 'metadata[region]': env.AVALON_REGION }, `customer:${workspaceId}`);
      customerId = customer.id;
      await env.DB.prepare('UPDATE billing_accounts SET customer_id = ? WHERE workspace_id = ?').bind(customerId, workspaceId).run();
    }
    const pending = (await openSessions(env, customerId)).data[0];
    if (pending) {
      if (pending.metadata.offer_id !== offerId || pending.currency !== currency || pending.metadata.overage_enabled !== String(overage)) {
        throw new ApiError(409, 'billing_checkout_pending', 'Complete or let the existing checkout expire before choosing another offer');
      }
      if ((pending.metadata.pilot_coupon_id ?? '') === (pilotCouponId ?? '') && Number(pending.metadata.trial_ends_at) >= trialEndsAt) return { url: pending.url };
      await stripe(env, `checkout/sessions/${pending.id}/expire`, StripeIdSchema, {}, `expire:${pending.id}`);
      await env.DB.prepare('UPDATE billing_accounts SET checkout_generation = ? WHERE workspace_id = ?').bind(crypto.randomUUID(), workspaceId).run();
    }
    // The persisted generation identifies this attempt. An uncertain Stripe
    // response recovers through the open-session query before another write.
    const attempt = await env.DB.prepare('SELECT checkout_generation FROM billing_accounts WHERE workspace_id = ?').bind(workspaceId).first<{ checkout_generation: string }>();
    if (pilotCouponId) {
      // A two-month coupon on an annual price would waive the entire annual
      // invoice. The pilot is for monthly subscriptions only.
      const price = await stripe(env, `prices/${offer.priceId}`, z.object({ recurring: z.object({ interval: z.string(), interval_count: z.number() }).nullable() }));
      if (price.recurring?.interval !== 'month' || price.recurring.interval_count !== 1) {
        throw new ApiError(409, 'billing_pilot_requires_monthly_price', 'The pilot offer requires a monthly subscription price');
      }
    }
    const fields: Record<string, string> = {
      mode: 'subscription', customer: customerId, currency,
      payment_method_collection: 'always',
      'metadata[offer_id]': offerId, 'metadata[overage_enabled]': String(overage), 'metadata[trial_ends_at]': String(trialEndsAt),
      'line_items[0][price]': offer.priceId, 'line_items[0][quantity]': '1',
      success_url: config.returnUrl, cancel_url: config.returnUrl,
      'automatic_tax[enabled]': String(config.automaticTax),
      'tax_id_collection[enabled]': 'true', billing_address_collection: 'required',
      'customer_update[address]': 'auto', 'customer_update[name]': 'auto',
      'subscription_data[metadata][workspace_id]': workspaceId,
      'subscription_data[metadata][offer_id]': offer.id,
      'subscription_data[metadata][paid_subscription]': String(offer.plan !== 'starter'),
      'subscription_data[metadata][overage_enabled]': String(overage),
    };
    if (pilotCouponId) {
      fields['discounts[0][coupon]'] = pilotCouponId;
      fields['metadata[pilot_coupon_id]'] = pilotCouponId;
      fields['subscription_data[metadata][pilot_coupon_id]'] = pilotCouponId;
    }
    else if (offer.couponId) fields['discounts[0][coupon]'] = offer.couponId;
    else fields.allow_promotion_codes = 'true';
    // Stripe requires trial_end at least 48 hours ahead. Use a stable duration
    // near expiry so retries do not change an idempotent request's parameters.
    if (trialEndsAt > Date.now() / 1000 + 172800) fields['subscription_data[trial_end]'] = String(trialEndsAt);
    else if (trialEndsAt > Date.now() / 1000) fields['subscription_data[trial_period_days]'] = '2';
    const session = await stripe(env, 'checkout/sessions', StripeUrlSchema, fields,
      `checkout:${workspaceId}:${attempt!.checkout_generation}:${offerId}:${currency}:${overage}:${trialEndsAt}:${account.subscription_id ?? 'first'}:${pilotCouponId ?? 'none'}`);
    // The next new checkout (after expiration/cancellation) must not reuse this
    // session's idempotency key. Lost writes recover through Stripe's open list.
    await env.DB.prepare('UPDATE billing_accounts SET checkout_generation = ? WHERE workspace_id = ?').bind(crypto.randomUUID(), workspaceId).run();
    return { url: session.url };
  });
}

export async function createBillingPortal(env: Env, workspaceId: string) {
  const account = await billingAccount(env, workspaceId);
  if (!account.customer_id) throw new ApiError(409, 'billing_customer_missing', 'Choose a plan first');
  return stripe(env, 'billing_portal/sessions', StripeUrlSchema, { customer: account.customer_id, return_url: billingConfig(env).returnUrl });
}

export async function syncSubscription(env: Env, customerId: string, subscriptionId: string) {
  const account = await env.DB.prepare(`SELECT b.* FROM billing_accounts b JOIN workspaces w ON w.id = b.workspace_id
    WHERE b.customer_id = ? AND w.region = ?`).bind(customerId, env.AVALON_REGION).first<BillingAccount>();
  if (!account) { logWarn(env, 'billing_webhook_unowned', { customer_id: customerId }); return; }
  await withBillingLock(env, account.workspace_id, async () => {
    const current = await billingAccount(env, account.workspace_id);
    const subscription = await stripe(env, `subscriptions/${subscriptionId}`, SubscriptionSchema);
    if (subscription.metadata.billing_role === 'free_record') {
      await synchronizeStripeProfile(env, current);
      return;
    }
    if (current.subscription_id && current.subscription_id !== subscriptionId) {
      // Old cancellation deliveries must not downgrade a later subscription.
      if (hasLiveSubscription(current) || ['canceled', 'incomplete_expired'].includes(subscription.status)) return;
    }
    await reconcileSubscription(env, current, subscription);
  });
}

/** Closing and checkout share ownership until membership is removed. */
export async function withOrganizationBillingClosure<T>(env: Env, workspaceId: string, close: () => Promise<T>): Promise<T> {
  if (!env.BILLING_CONFIG) {
    const existing = await env.DB.prepare('SELECT customer_id FROM billing_accounts WHERE workspace_id = ?').bind(workspaceId).first<{ customer_id: string | null }>();
    if (existing?.customer_id) throw new ApiError(409, 'billing_closure_blocked', 'Restore billing configuration and cancel billing before closing this organization');
    return close();
  }
  await billingAccount(env, workspaceId);
  return withBillingLock(env, workspaceId, async () => {
    const account = await refreshUnderLock(env, await billingAccount(env, workspaceId));
    if (hasLiveSubscription(account) || (account.customer_id && (await openSessions(env, account.customer_id)).data.length)) {
      throw new ApiError(409, 'billing_closure_blocked', 'Cancel the subscription or pending checkout before closing this organization');
    }
    return close();
  });
}

interface BillingTerm {
  subscription_id: string; customer_id: string; price_id: string; starts_at: number;
  ends_at: number | null; cutoff_quota_microusd: number | null; final_invoice_id: string | null;
}

/** A canceled subscription retains its own terms and cutoff even after re-subscription. */
export async function billClosedOverage(env: Env, workspaceId: string, now = Date.now()) {
  await withBillingLock(env, workspaceId, async () => {
    const terms = await env.DB.prepare('SELECT * FROM billing_terms WHERE workspace_id = ?').bind(workspaceId).all<BillingTerm>();
    for (const term of terms.results) {
      const startsAt = term.starts_at * 1000;
      const cutoff = term.ends_at === null ? null : term.ends_at * 1000;
      const settledThrough = now - billingConfig(env).settlementDelayDays * DAY * 1000;
      const last = await env.DB.prepare('SELECT MAX(period_end) AS last_end FROM billing_overages WHERE subscription_id = ?')
        .bind(term.subscription_id).first<{ last_end: string | null }>();
      let cursor = last?.last_end ? Date.parse(last.last_end) : startsAt;
      while (cursor < settledThrough && (cutoff === null || cursor < cutoff)) {
        const usage = await readOrganizationUsage(env, workspaceId, cursor,
          cutoff !== null && cutoff <= settledThrough ? { at: cutoff, quotaMicrousd: term.cutoff_quota_microusd! } : undefined);
        if (!usage) break;
        const naturalEnd = Date.parse(usage.overage.periodEndsAt);
        const end = Math.min(naturalEnd, cutoff ?? naturalEnd);
        if (end > settledThrough) break;

        // Preserve the free partial activation period. A cancellation tail in a
        // later period is charged only through the recorded Stripe ended_at.
        if (Date.parse(usage.overage.periodStart) >= startsAt) {
          await env.DB.prepare(`INSERT INTO billing_overages(workspace_id, subscription_id, period_start, period_end, amount_microusd, price_id)
            VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).bind(workspaceId, term.subscription_id,
              usage.overage.periodStart, new Date(end).toISOString(), usage.overage.amountMicrousd, term.price_id).run();
        }
        cursor = end;
      }
      const pending = await env.DB.prepare('SELECT * FROM billing_overages WHERE subscription_id = ? AND invoice_item_id IS NULL')
        .bind(term.subscription_id).all<{ period_start: string; period_end: string; amount_microusd: number; price_id: string }>();
      for (const row of pending.results) {
        let itemId = 'zero';
        if (row.amount_microusd > 0) {
          const receipt = `overage:${term.subscription_id}:${row.period_start}`;
          let after = '';
          let existing: string | undefined;
          do {
            const page = await stripe(env, `invoiceitems?customer=${term.customer_id}&created[gte]=${Math.floor(Date.parse(row.period_end) / 1000)}&limit=100${after ? `&starting_after=${after}` : ''}`,
              z.object({ has_more: z.boolean(), data: z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.string()) })) }));
            existing = page.data.find((item) => item.metadata.receipt === receipt)?.id;
            after = page.has_more ? page.data.at(-1)!.id : '';
          } while (after && !existing);
          const item = existing ? { id: existing } : await stripe(env, 'invoiceitems', StripeIdSchema, {
            customer: term.customer_id, ...(cutoff === null ? { subscription: term.subscription_id } : {}), price: row.price_id,
            quantity: String(row.amount_microusd), 'metadata[receipt]': receipt, discountable: 'false',
            description: `Rally usage beyond shared quota — period starting ${row.period_start}`,
          }, receipt);
          itemId = item.id;
        }
        await env.DB.prepare('UPDATE billing_overages SET invoice_item_id = ? WHERE subscription_id = ? AND period_start = ?')
          .bind(itemId, term.subscription_id, row.period_start).run();
      }
      if (cutoff !== null && cutoff <= settledThrough) await finalizeCanceledOverage(env, term);
    }
  });
}

async function finalizeCanceledOverage(env: Env, term: BillingTerm) {
  const receipt = `final-overage:${term.subscription_id}`;
  let invoiceId = term.final_invoice_id;
  if (!invoiceId) {
    let after = '';
    do {
      const page = await stripe(env, `invoices?customer=${term.customer_id}&created[gte]=${term.ends_at}&limit=100${after ? `&starting_after=${after}` : ''}`,
        z.object({ has_more: z.boolean(), data: z.array(z.object({ id: z.string(), metadata: z.record(z.string(), z.string()) })) }));
      invoiceId = page.data.find((item) => item.metadata.receipt === receipt)?.id ?? null;
      after = page.has_more ? page.data.at(-1)!.id : '';
    } while (after && !invoiceId);
    if (!invoiceId) {
      const subscription = await stripe(env, `subscriptions/${term.subscription_id}`, SubscriptionSchema);
      const invoice = await stripe(env, 'invoices', StripeIdSchema, {
        customer: term.customer_id, collection_method: 'charge_automatically', auto_advance: 'false',
        // Includes pending items left behind when Stripe canceled the subscription.
        pending_invoice_items_behavior: 'include', 'metadata[receipt]': receipt,
        'automatic_tax[enabled]': String(billingConfig(env).automaticTax),
        ...(subscription.default_payment_method ? { default_payment_method: subscription.default_payment_method } : {}),
      }, receipt);
      invoiceId = invoice.id;
    }
    await env.DB.prepare('UPDATE billing_terms SET final_invoice_id = ? WHERE subscription_id = ?').bind(invoiceId, term.subscription_id).run();
  }
  const invoice = await stripe(env, `invoices/${invoiceId}`, z.object({ status: z.string() }));
  if (invoice.status === 'draft') await stripe(env, `invoices/${invoiceId}/finalize`, StripeIdSchema, { auto_advance: 'true' }, `finalize:${invoiceId}`);
}

export async function settleBillingAccounts(env: Env) {
  if (!env.BILLING_CONFIG) return;
  const synchronization = billingConfig(env).synchronization;
  const accounts = synchronization
    ? await env.DB.prepare(`SELECT w.id AS workspace_id FROM workspaces w LEFT JOIN billing_accounts b ON b.workspace_id = w.id
        WHERE w.region = ? AND (w.abandoned_at IS NULL OR b.customer_id IS NOT NULL)`).bind(env.AVALON_REGION).all<{ workspace_id: string }>()
    : await env.DB.prepare('SELECT DISTINCT workspace_id FROM billing_terms').all<{ workspace_id: string }>();
  for (const account of accounts.results) {
    if (synchronization) {
      try {
        await billingAccount(env, account.workspace_id);
        await withBillingLock(env, account.workspace_id, async () => {
          const refreshed = await refreshUnderLock(env, await billingAccount(env, account.workspace_id));
          await synchronizeStripeUsage(env, refreshed);
        });
      } catch (error) {
        logWarn(env, 'billing_synchronization_failed', { workspace_id: account.workspace_id, error_code: diagnosticErrorCode(error, 'billing_synchronization_failed') });
      }
    }
    try { await billClosedOverage(env, account.workspace_id); }
    catch (error) {
      logWarn(env, 'billing_settlement_failed', { workspace_id: account.workspace_id, error_code: diagnosticErrorCode(error, 'billing_settlement_failed') });
    }
  }
}
