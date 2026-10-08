import { asWorkspaceId } from "@rally/contracts";
import {
  deriveOrganizationUsage,
  ORGANIZATION_PAYS,
  PLAN_IDS,
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
import { describeZodIssues, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import type { WorkDeferral } from "../lib/defer";
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logStructuredEvent, logWarn } from "../observability/logger";

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

/** The row's plan, or an error naming why it is not one: `plan` has no CHECK, so the schema is the guard. */
function workspacePlanId(row: WorkspacePlanRow): PlanId {
  const parsed = PlanIdSchema.safeParse(row.plan);
  if (!parsed.success) throw new Error(zodDiagnosticCode(parsed.error, "workspace_plan") ?? "workspace_plan_invalid");
  return parsed.data;
}

/** The plan in force at `?` (a week's end), mapped to its weekly quota. */
const PLAN_QUOTA_SQL = `CASE COALESCE(
    (SELECT plan FROM usage_plan_changes WHERE workspace_id = ? AND effective_at < ? ORDER BY effective_at DESC LIMIT 1),
    (SELECT previous_plan FROM usage_plan_changes WHERE workspace_id = ? AND effective_at >= ? ORDER BY effective_at ASC LIMIT 1),
    ?)
  ${PLAN_IDS.map(() => "WHEN ? THEN ?").join(" ")} END`;
const PLAN_QUOTA_BINDINGS = PLAN_IDS.flatMap((plan) => [plan, weeklyQuotaMicrousd(plan)]);

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
 * be counted. Those two reads only keep the count honest: what guarantees an
 * event is added once is that its rollup increment runs only if its
 * `usage_events` insert did (`changes() = 1`), inside the same transaction,
 * so two batches carrying one event count it once even if they overlap.
 * Costs are only added into totals, never split into overage, so the result
 * does not depend on the order events arrive in.
 */
export async function applyUsageBatch(
  env: Pick<Env, "DB" | "USAGE_DB">,
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
  const seen = await env.USAGE_DB.prepare(
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

  const statements: D1PreparedStatement[] = [];
  for (const event of unique.values()) {
    const workspace = byId.get(event.workspaceId);
    if (!workspace) {
      // A retired or unknown Organization has no ledger to write to.
      outcome.unknownWorkspace += 1;
      continue;
    }
    const plan = workspacePlanId(workspace);
    const createdAtMs = Date.parse(workspace.created_at);
    const occurredAtMs = Date.parse(event.occurredAt);
    const weekStartMs = usageWeekStart(createdAtMs, occurredAtMs);
    const weekStart = new Date(weekStartMs).toISOString();
    const weekEnd = new Date(weekStartMs + WEEK_MS).toISOString();
    const periodStart = new Date(usagePeriod(createdAtMs, occurredAtMs).start).toISOString();
    const organizationPays = ORGANIZATION_PAYS[event.activity];
    statements.push(env.USAGE_DB.prepare(
      `INSERT INTO usage_events (event_id, workspace_id, activity, occurred_at, cost_microusd, organization_pays,
         model, user_id, workstream_id, substream_id, sidekick_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (event_id) DO NOTHING`,
    ).bind(
      event.eventId, event.workspaceId, event.activity, event.occurredAt, event.costMicrousd,
      organizationPays ? 1 : 0, event.model, event.refs.userId ?? null, event.refs.workstreamId ?? null,
      event.refs.substreamId ?? null, event.refs.sidekickId ?? null, receivedAt,
    ));
    // Runs only if the insert above added the event. A new row's quota is
    // the plan in force at the end of its week, read from
    // `usage_plan_changes` inside this statement: the latest change before
    // the week ended, else the plan the first later change replaced, else the
    // plan `DB` holds now. Reading it here rather than from the batch's
    // earlier read is what keeps a late event's past week on that week's plan
    // and a concurrent plan change from being lost. An existing row keeps its
    // quota, which only a plan change rewrites.
    statements.push(env.USAGE_DB.prepare(
      `INSERT INTO usage_rollups (workspace_id, week_start, period_start, quota_microusd, organization_microusd, rally_microusd)
       SELECT ?, ?, ?, ${PLAN_QUOTA_SQL}, ?, ? WHERE changes() = 1
       ON CONFLICT (workspace_id, week_start, period_start) DO UPDATE SET
         organization_microusd = organization_microusd + excluded.organization_microusd,
         rally_microusd = rally_microusd + excluded.rally_microusd`,
    ).bind(
      event.workspaceId, weekStart, periodStart,
      event.workspaceId, weekEnd, event.workspaceId, weekEnd, plan,
      ...PLAN_QUOTA_BINDINGS,
      organizationPays ? event.costMicrousd : 0, organizationPays ? 0 : event.costMicrousd,
    ));
    outcome.applied += 1;
    outcome.perActivity[event.activity] = (outcome.perActivity[event.activity] ?? 0) + 1;
  }
  if (statements.length > 0) await env.USAGE_DB.batch(statements);
  return outcome;
}

async function workspacePlan(
  env: Pick<Env, "DB">,
  workspaceId: string,
  region?: string,
): Promise<{ plan: PlanId; createdAtMs: number } | null> {
  const row = region === undefined
    ? await env.DB.prepare(`SELECT id, plan, created_at FROM workspaces WHERE id = ?`).bind(workspaceId).first<WorkspacePlanRow>()
    : await env.DB.prepare(`SELECT id, plan, created_at FROM workspaces WHERE id = ? AND region = ?`)
      .bind(workspaceId, region).first<WorkspacePlanRow>();
  if (!row) return null;
  return { plan: workspacePlanId(row), createdAtMs: Date.parse(row.created_at) };
}

/**
 * The meter for one Organization: one primary-key read of the workspace and
 * one range read of its rollups, from the week before the current period
 * starts (a week that straddles the boundary) up to now.
 */
export async function readOrganizationUsage(
  env: Pick<Env, "DB" | "USAGE_DB">,
  workspaceId: string,
  nowMs: number,
): Promise<OrganizationUsage | null> {
  const workspace = await workspacePlan(env, workspaceId);
  if (!workspace) return null;
  const period = usagePeriod(workspace.createdAtMs, nowMs);
  const rows = await env.USAGE_DB.prepare(
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
 *
 * The change is recorded in `usage_plan_changes` and the current week's
 * quota rewritten in one `USAGE_DB` transaction, which the consumer's rollup
 * inserts serialize against. `workspaces.plan` in `DB`, which the meter and
 * Ace display, is written after; the two databases are not one transaction,
 * so if that write fails the operator sees the error in Ace and saves again.
 */
export async function setWorkspacePlan(
  env: Pick<Env, "DB" | "USAGE_DB" | "AVALON_REGION">,
  workspaceId: string,
  plan: PlanId,
  nowMs: number,
): Promise<boolean> {
  // Only a workspace this region owns: a row for another region's workspace
  // can sit in the table, and its ledger is not here.
  const workspace = await workspacePlan(env, workspaceId, env.AVALON_REGION);
  if (!workspace) return false;
  const weekStart = new Date(usageWeekStart(workspace.createdAtMs, nowMs)).toISOString();
  const at = new Date(nowMs).toISOString();
  await env.USAGE_DB.batch([
    env.USAGE_DB.prepare(
      `INSERT INTO usage_plan_changes (workspace_id, effective_at, plan, previous_plan) VALUES (?, ?, ?, ?)
       ON CONFLICT (workspace_id, effective_at) DO UPDATE SET plan = excluded.plan`,
    ).bind(workspaceId, at, plan, workspace.plan),
    env.USAGE_DB.prepare(`UPDATE usage_rollups SET quota_microusd = ? WHERE workspace_id = ? AND week_start = ?`)
      .bind(weeklyQuotaMicrousd(plan), workspaceId, weekStart),
  ]);
  await env.DB.prepare(`UPDATE workspaces SET plan = ?, updated_at = ? WHERE id = ?`)
    .bind(plan, at, workspaceId).run();
  return true;
}

/**
 * Send the meter, as it reads now, to every member connected to the
 * Organization, after a plan change moved its quota and overage. Read here
 * rather than handed in, and stamped with when the read started, so that after
 * two quick changes WorkspaceDO can drop whichever push read the earlier plan,
 * in whatever order the two arrive.
 *
 * Post-commit and best effort: the plan has changed, so a failed push is
 * logged and not reported as a failed change. A window that missed it shows
 * the old meter until it next reads one, which every meter surface does when
 * it opens and the desktop does on reconnect.
 */
export async function publishOrganizationUsage(
  env: Env,
  workspaceId: string,
): Promise<void> {
  try {
    const readAtMs = Date.now();
    const usage = await readOrganizationUsage(env, workspaceId, readAtMs);
    if (!usage) return;
    const placementAffinity = await workspacePlacementAffinity(env, workspaceId);
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
      placementAffinity,
    );
    await workspace.publishUsage(usage, new Date(readAtMs).toISOString(), workspaceId, placementAffinity);
  } catch (error) {
    logWarn(env, "usage_publish_failed", {
      workspace_id: workspaceId,
      error_code: diagnosticErrorCode(error, "usage_publish_failed"),
    });
  }
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

/**
 * How long `usage_events` rows stay in D1. Three months, as asked for when the
 * ledger was split into D1 and R2; every row is in the usage lakehouse for
 * good, so this only bounds the D1 copy. It must stay longer than the usage
 * queue's message retention (at most 14 days), or a redelivery could find its
 * row pruned and be counted twice.
 */
export const USAGE_EVENTS_D1_RETENTION_DAYS = 90;

/**
 * Delete `usage_events` rows received before the retention window. Runs on the
 * scheduled tick; the rollups are kept, so the meter never reads these rows.
 */
export async function pruneUsageEvents(env: Pick<Env, "USAGE_DB">, nowMs: number): Promise<number> {
  const cutoff = new Date(nowMs - USAGE_EVENTS_D1_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const result = await env.USAGE_DB.prepare(`DELETE FROM usage_events WHERE received_at < ?`).bind(cutoff).run();
  return result.meta.changes ?? 0;
}
