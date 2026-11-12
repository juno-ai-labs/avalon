import { closeOrganizationBilling as closeWithoutBilling } from "./billing";
import type { GrantOverageCredit, GrantTrialMonths } from "@rally/contracts/billing";
import type { Env } from "../env";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { billingConfig } from "./billing-config";

const coordinator = (env: Env, workspaceId: string) =>
  env.BILLING_COORDINATORS.getByName(
    `${env.AVALON_REGION}:billing:${workspaceId}`,
  );

export const createCheckout = (
  env: Env,
  workspaceId: string,
  offerId: string,
  currency: string,
  overage: boolean,
) =>
  coordinator(env, workspaceId).checkout(
    workspaceId,
    offerId,
    currency,
    overage,
  );
export const createBillingPortal = (env: Env, workspaceId: string) =>
  coordinator(env, workspaceId).portal(workspaceId);
export const closeOrganizationBilling = (
  env: Env,
  workspaceId: string,
  actorUserId: string | null,
) =>
  env.BILLING_CONFIG
    ? coordinator(env, workspaceId).close(workspaceId, actorUserId)
    : closeWithoutBilling(env, workspaceId, actorUserId);

export const grantTrialMonths = (env: Env, workspaceId: string, input: GrantTrialMonths) =>
  coordinator(env, workspaceId).grantTrialMonths(workspaceId, input);

export const grantOverageCredit = (env: Env, workspaceId: string, input: GrantOverageCredit) =>
  coordinator(env, workspaceId).grantCredit(workspaceId, input);
export const expireOverageCredit = (env: Env, workspaceId: string, grantId: string) =>
  coordinator(env, workspaceId).expireCredit(workspaceId, grantId);

export async function syncSubscription(
  env: Env,
  customerId: string,
  subscriptionId: string,
) {
  const account = await env.DB.prepare(
    `SELECT b.workspace_id FROM billing_accounts b
    JOIN workspaces w ON w.id = b.workspace_id WHERE b.customer_id = ? AND w.region = ?`,
  )
    .bind(customerId, env.AVALON_REGION)
    .first<{ workspace_id: string }>();
  if (!account) {
    logWarn(env, "billing_webhook_unowned", { customer_id: customerId });
    return;
  }
  await coordinator(env, account.workspace_id).synchronize(
    account.workspace_id,
    customerId,
    subscriptionId,
  );
}

export async function billingAccountsToSettle(env: Env): Promise<string[]> {
  if (!env.BILLING_CONFIG) return [];
  const sync = billingConfig(env).synchronization;
  const accounts = await env.DB.prepare(
    `SELECT w.id AS workspace_id FROM workspaces w
    LEFT JOIN billing_accounts b ON b.workspace_id = w.id
    WHERE w.region = ? AND (w.abandoned_at IS NULL
      OR (b.customer_id IS NOT NULL AND b.free_subscription_closed = 0 AND ?)
      OR EXISTS (SELECT 1 FROM billing_overage_subscriptions s WHERE s.workspace_id = w.id AND s.closed = 0)
      OR EXISTS (SELECT 1 FROM billing_terms t WHERE t.workspace_id = w.id AND t.final_invoice_finalized = 0))`,
  )
    .bind(env.AVALON_REGION, sync ? 1 : 0)
    .all<{ workspace_id: string }>();
  const ids = new Set(accounts.results.map((row) => row.workspace_id));
  if (sync) {
    // The usage database is regional too. Its outbox survives organization closure
    // and can receive a final queued event after subscription cleanup finishes.
    const pending = await env.USAGE_DB.prepare(
      `SELECT DISTINCT workspace_id FROM billing_usage_hours
      WHERE (error_code IS NULL OR error_code <> 'billing_usage_timestamp_expired')
      AND (confirmed_revision <> revision OR meter_id IS NULL OR meter_id <> CASE organization_pays WHEN 1 THEN ? ELSE ? END)`,
    )
      .bind(sync.organizationMeterId, sync.rallyMeterId)
      .all<{ workspace_id: string }>();
    for (const row of pending.results) ids.add(row.workspace_id);
  }
  return [...ids];
}

export async function settleBillingAccounts(env: Env) {
  for (const workspaceId of await billingAccountsToSettle(env)) {
    try {
      await coordinator(env, workspaceId).settle(workspaceId);
    } catch (error) {
      logWarn(env, "billing_coordinator_failed", {
        workspace_id: workspaceId,
        error_code: diagnosticErrorCode(error, "billing_coordinator_failed"),
      });
    }
  }
}
