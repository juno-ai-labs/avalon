import { weeklyQuotaMicrousd, usageWeekStart, usageWeekEnd, PlanIdSchema } from "@rally/contracts/usage";
import type { Env } from "../env";
import { ApiError, asApiError } from "../lib/api-error";
import { billingConfig } from "./billing-config";

let configuration: { raw: string; value: ReturnType<typeof billingConfig> } | undefined;

export const isUsageAllowanceExhausted = (error: unknown): boolean => asApiError(error)?.code === "usage_allowance_exhausted";

/** Admit new paid work against the recorded ledger. In-flight provider work
 * can finish; the queue still records its actual cost once. No Stripe call is
 * made on the inference path. */
export async function requireUsageAllowance(env: Pick<Env, "DB" | "USAGE_DB" | "BILLING_CONFIG">, workspaceId: string): Promise<void> {
  if (!env.BILLING_CONFIG) return;
  if (configuration?.raw !== env.BILLING_CONFIG) configuration = { raw: env.BILLING_CONFIG, value: billingConfig(env) };
  const config = configuration.value;
  const now = Date.now();
  if (!config.enforceUsageLimits) return;
  const [org, usage] = await Promise.all([env.DB.prepare(`SELECT w.plan, w.created_at, w.billing_plan_override,
    b.status, b.trial_ends_at, b.overage_enabled, b.overage_started_at, b.payment_method_ready
    FROM workspaces w LEFT JOIN billing_accounts b ON b.workspace_id = w.id WHERE w.id = ?`)
    .bind(workspaceId).first<{
      plan: string; created_at: string; billing_plan_override: number; status: string | null;
      trial_ends_at: number | null; overage_enabled: number | null; overage_started_at: number | null; payment_method_ready: number | null;
    }>(),
    env.USAGE_DB.prepare(`SELECT week_start, SUM(organization_microusd) AS spent FROM usage_rollups
      WHERE workspace_id = ? AND week_start = (SELECT MAX(week_start) FROM usage_rollups WHERE workspace_id = ? AND week_start <= ?)
      GROUP BY week_start`).bind(workspaceId, workspaceId, new Date(now).toISOString()).first<{ week_start: string; spent: number }>(),
  ]);
  if (!org) throw new ApiError(404, "billing_account_not_found", "Organization not found");
  const trialExpiredWithoutPayment = org.status === "trialing" && (org.trial_ends_at ?? 0) <= now / 1000 && !org.payment_method_ready;
  const subscribed = ["active", "trialing"].includes(org.status ?? "") && !trialExpiredWithoutPayment;
  if (subscribed && org.overage_enabled === 1 && org.payment_method_ready === 1 && org.overage_started_at !== null) return;
  const parsed = PlanIdSchema.safeParse(subscribed || org.billing_plan_override ? org.plan : config.unpaidPlan);
  if (!parsed.success) throw new ApiError(500, "billing_plan_invalid", "Organization plan is invalid");
  const plan = parsed.data;
  const week = new Date(usageWeekStart(Date.parse(org.created_at), now)).toISOString();
  if (usage?.week_start === week && usage.spent >= weeklyQuotaMicrousd(plan))
    throw new ApiError(403, "usage_allowance_exhausted", "Your organization's included usage is used up. An administrator can add billing details and enable overages in Organization settings, or wait for the weekly allowance to reset.", { retryAfterSeconds: Math.max(1, Math.ceil((usageWeekEnd(Date.parse(org.created_at), now) - now) / 1000)) });
}
