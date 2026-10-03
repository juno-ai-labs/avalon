import {
  deriveOrganizationUsage,
  ORGANIZATION_PAYS,
  PlanIdSchema,
  UsageEventSchema,
  usagePeriod,
  usageWeekStart,
  weeklyQuotaMicrousd,
  type MeteredActivity,
  type OrganizationUsage,
  type PlanId,
  type UsageEvent,
} from "@rally/contracts/usage";
import { describeZodIssues } from "@rally/contracts/zod-diagnostics";
import type { Env } from "../env";
import type { WorkDeferral } from "../lib/defer";
import { logStructuredEvent } from "../observability/logger";

/**
 * Usage quota metering: the only producer, the only ledger writer and the only
 * reader. See docs/usage-metering.md.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export type UsageInput = Omit<UsageEvent, "v" | "region">;

type EmitEnv = Pick<Env, "USAGE_QUEUE" | "AVALON_REGION" | "APP_ENV" | "LOG_LEVEL">;

/** Micro-USD from the cents figure the harness and clients report. */
export function costCentsToMicrousd(costCents: number): number {
  return Math.max(0, Math.round(costCents * 10_000));
}

/**
 * Send one usage event in the background. Never awaited and never throws: a
 * failure here must not fail or slow the work it measures (PRD goal 3). A lost
 * event is logged with its cost so the loss is counted, not silent (goal 2).
 */
export function emitUsage(env: EmitEnv, defer: WorkDeferral, input: UsageInput): void {
  // Local and test hosts without the binding skip metering; hosted
  // deployments require it in the env contract.
  if (!env.USAGE_QUEUE) return;
  const parsed = UsageEventSchema.safeParse({ v: 1, region: env.AVALON_REGION, ...input });
  if (!parsed.success) {
    logStructuredEvent(env, "warn", "usage_emit_failed", {
      event_id: input.eventId,
      activity: input.activity,
      cost_microusd: input.costMicrousd,
      reason: `usage_event_invalid:${describeZodIssues(parsed.error)}`,
    });
    return;
  }
  const queue = env.USAGE_QUEUE;
  defer(queue.send(parsed.data, { contentType: "json" }).catch((error: unknown) => {
    logStructuredEvent(env, "warn", "usage_emit_failed", {
      event_id: input.eventId,
      activity: input.activity,
      workspace_id: input.workspaceId,
      cost_microusd: input.costMicrousd,
      reason: error instanceof Error ? `${error.name}:${error.message}` : "usage_queue_send_failed",
    });
  }));
}

interface WorkspacePlanRow {
  id: string;
  plan: string;
  created_at: string;
}

interface RollupDelta {
  workspaceId: string;
  weekStart: string;
  periodStart: string;
  quotaMicrousd: number;
  organizationMicrousd: number;
  rallyMicrousd: number;
}

export interface UsageBatchOutcome {
  applied: number;
  duplicates: number;
  unknownWorkspace: number;
  perActivity: Partial<Record<MeteredActivity, number>>;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Apply a batch of parsed events to the ledger in one D1 transaction.
 *
 * Repeated event IDs inside the batch are dropped first, then IDs already in
 * `usage_events`; without the first step two copies in one batch would both
 * be counted. Costs are only added into totals, never split into overage, so
 * the result does not depend on the order events arrive in.
 */
export async function applyUsageBatch(
  env: Pick<Env, "DB">,
  events: readonly UsageEvent[],
  receivedAt: string,
): Promise<UsageBatchOutcome> {
  const outcome: UsageBatchOutcome = { applied: 0, duplicates: 0, unknownWorkspace: 0, perActivity: {} };
  const unique = new Map<string, UsageEvent>();
  for (const event of events) {
    if (unique.has(event.eventId)) outcome.duplicates += 1;
    else unique.set(event.eventId, event);
  }
  if (unique.size === 0) return outcome;

  const ids = [...unique.keys()];
  const seen = await env.DB.prepare(
    `SELECT event_id FROM usage_events WHERE event_id IN (${placeholders(ids.length)})`,
  ).bind(...ids).all<{ event_id: string }>();
  for (const row of seen.results) {
    unique.delete(row.event_id);
    outcome.duplicates += 1;
  }
  if (unique.size === 0) return outcome;

  const workspaceIds = [...new Set([...unique.values()].map((event) => event.workspaceId))];
  const workspaces = await env.DB.prepare(
    `SELECT id, plan, created_at FROM workspaces WHERE id IN (${placeholders(workspaceIds.length)})`,
  ).bind(...workspaceIds).all<WorkspacePlanRow>();
  const byId = new Map(workspaces.results.map((row) => [row.id, row]));

  const deltas = new Map<string, RollupDelta>();
  const statements: D1PreparedStatement[] = [];
  for (const event of unique.values()) {
    const workspace = byId.get(event.workspaceId);
    if (!workspace) {
      // A retired or unknown Organization has no ledger to write to.
      outcome.unknownWorkspace += 1;
      continue;
    }
    const plan = PlanIdSchema.parse(workspace.plan);
    const createdAtMs = Date.parse(workspace.created_at);
    const occurredAtMs = Date.parse(event.occurredAt);
    const weekStart = new Date(usageWeekStart(createdAtMs, occurredAtMs)).toISOString();
    const periodStart = new Date(usagePeriod(createdAtMs, occurredAtMs).start).toISOString();
    const organizationPays = ORGANIZATION_PAYS[event.activity];
    const key = `${event.workspaceId}|${weekStart}|${periodStart}`;
    const delta = deltas.get(key) ?? {
      workspaceId: event.workspaceId,
      weekStart,
      periodStart,
      quotaMicrousd: weeklyQuotaMicrousd(plan),
      organizationMicrousd: 0,
      rallyMicrousd: 0,
    };
    if (organizationPays) delta.organizationMicrousd += event.costMicrousd;
    else delta.rallyMicrousd += event.costMicrousd;
    deltas.set(key, delta);
    statements.push(env.DB.prepare(
      `INSERT INTO usage_events (event_id, workspace_id, activity, occurred_at, cost_microusd, organization_pays,
         model, user_id, workstream_id, substream_id, sidekick_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
    ).bind(
      event.eventId, event.workspaceId, event.activity, event.occurredAt, event.costMicrousd,
      organizationPays ? 1 : 0, event.model, event.refs.userId ?? null, event.refs.workstreamId ?? null,
      event.refs.substreamId ?? null, event.refs.sidekickId ?? null, receivedAt,
    ));
    outcome.applied += 1;
    outcome.perActivity[event.activity] = (outcome.perActivity[event.activity] ?? 0) + 1;
  }
  for (const delta of deltas.values()) {
    // A new row takes the current plan's quota; an existing row keeps its own,
    // which only a plan change rewrites.
    statements.push(env.DB.prepare(
      `INSERT INTO usage_rollups (workspace_id, week_start, period_start, quota_microusd, organization_microusd, rally_microusd)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, week_start, period_start) DO UPDATE SET
         organization_microusd = organization_microusd + excluded.organization_microusd,
         rally_microusd = rally_microusd + excluded.rally_microusd`,
    ).bind(delta.workspaceId, delta.weekStart, delta.periodStart, delta.quotaMicrousd,
      delta.organizationMicrousd, delta.rallyMicrousd));
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return outcome;
}

async function workspacePlan(env: Pick<Env, "DB">, workspaceId: string): Promise<{ plan: PlanId; createdAtMs: number } | null> {
  const row = await env.DB.prepare(`SELECT id, plan, created_at FROM workspaces WHERE id = ?`)
    .bind(workspaceId).first<WorkspacePlanRow>();
  if (!row) return null;
  return { plan: PlanIdSchema.parse(row.plan), createdAtMs: Date.parse(row.created_at) };
}

/**
 * The meter for one Organization: one primary-key read of the workspace and
 * one range read of its rollups, from the week before the current period
 * starts (a week that straddles the boundary) up to now.
 */
export async function readOrganizationUsage(
  env: Pick<Env, "DB">,
  workspaceId: string,
  nowMs: number,
): Promise<OrganizationUsage | null> {
  const workspace = await workspacePlan(env, workspaceId);
  if (!workspace) return null;
  const period = usagePeriod(workspace.createdAtMs, nowMs);
  const rows = await env.DB.prepare(
    `SELECT week_start, period_start, quota_microusd, organization_microusd
       FROM usage_rollups WHERE workspace_id = ? AND week_start >= ?`,
  ).bind(workspaceId, new Date(period.start - WEEK_MS).toISOString())
    .all<{ week_start: string; period_start: string; quota_microusd: number; organization_microusd: number }>();
  return deriveOrganizationUsage({
    plan: workspace.plan,
    createdAtMs: workspace.createdAtMs,
    nowMs,
    rollups: rows.results.map((row) => ({
      weekStart: Date.parse(row.week_start),
      periodStart: Date.parse(row.period_start),
      quotaMicrousd: row.quota_microusd,
      organizationMicrousd: row.organization_microusd,
    })),
  });
}

/**
 * Move an Organization to a plan. The new quota applies to the current week at
 * once (PRD decision 12); past weeks keep the quota they had.
 */
export async function setWorkspacePlan(
  env: Pick<Env, "DB">,
  workspaceId: string,
  plan: PlanId,
  nowMs: number,
): Promise<boolean> {
  const workspace = await workspacePlan(env, workspaceId);
  if (!workspace) return false;
  const weekStart = new Date(usageWeekStart(workspace.createdAtMs, nowMs)).toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE workspaces SET plan = ?, updated_at = ? WHERE id = ?`)
      .bind(plan, new Date(nowMs).toISOString(), workspaceId),
    env.DB.prepare(`UPDATE usage_rollups SET quota_microusd = ? WHERE workspace_id = ? AND week_start = ?`)
      .bind(weeklyQuotaMicrousd(plan), workspaceId, weekStart),
  ]);
  return true;
}

/**
 * Meter one model call whose cost arrives in cents. A call that reports no cost
 * is logged as `usage_unpriced` rather than recorded at zero: an unpriced
 * activity is a gap to close (docs/usage-metering.md), not a free call.
 */
export function emitInferenceUsage(
  env: EmitEnv,
  defer: WorkDeferral,
  input: Omit<UsageInput, "costMicrousd" | "occurredAt"> & { costCents: number | undefined; occurredAt?: string },
): void {
  const { costCents, occurredAt, ...rest } = input;
  if (costCents === undefined) {
    logStructuredEvent(env, "warn", "usage_unpriced", {
      event_id: input.eventId,
      activity: input.activity,
      workspace_id: input.workspaceId,
      model: input.model ?? undefined,
    });
    return;
  }
  emitUsage(env, defer, {
    ...rest,
    occurredAt: occurredAt ?? new Date().toISOString(),
    costMicrousd: costCentsToMicrousd(costCents),
  });
}
