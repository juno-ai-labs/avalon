import { runtimeDeferral } from "../lib/defer";
/**
 * What a workspace's alarm actually runs.
 *
 * These functions were the body of a separate per-workspace scheduler Durable
 * Object, deleted in the same change that moved them here. They are plain
 * functions over a context because the object that arms the alarm is now
 * WorkspaceDO — the object that already owns every table they read. The
 * scheduler had to reach those tables through routed SQL and the work-stream
 * directory through an RPC hop; running in-object turns both into local reads,
 * and removes the window in which a schedule row and the alarm meant to fire it
 * lived in two different objects.
 *
 * Nothing here decides *when* to run: `workspaceScheduleTargets` reports what
 * is due and `runWorkspaceScheduleTarget` runs exactly one target. The single
 * alarm, the retry gates, and the drain belong to `scheduled-alarms.ts`.
 *
 * `docs/durable-object-alarms.md` covers the scheduling half;
 * `docs/architecture.md` covers automations, digests, and connector polling.
 */
import {
  ConnectorPollWorkflowInputSchema,
  RegionSchema,
  asWorkspaceId,
  type ConnectorPollWorkflowInput,
} from "@rally/contracts";
import { newId } from "@rally/db";
import { z } from "zod";

import type { ScheduledAlarmOutcome } from "../durable-objects/scheduled-alarms";
import type {
  WorkspaceDirectoryScheduleTargetsRequest,
  WorkspaceDirectoryScheduleTargetsResult,
} from "../durable-objects/workspace-directory-protocol";
import type {
  WorkspaceNotificationIntentMaintenanceRequest,
  WorkspaceNotificationIntentMaintenanceTarget,
  WorkspaceNotificationIntentReapRequest,
  WorkspaceNotificationIntentReapResult,
} from "../durable-objects/workspace-notification-intent-protocol";
import { SLACK_INGRESS_ATTEMPT_LIMIT } from "../durable-objects/workspace-slack-protocol";
import type { Env } from "../env";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logStructuredEvent } from "../observability/logger";
import { createHarnessRunPortFactory } from "../runtime/harness-run-port";
import { emitProductUsageTelemetry } from "../telemetry/product-usage";
import {
  reapDeletedResourceObjects,
  reapExpiredDraftResources,
} from "./resource-object-cleanup";
import { backfillResourceSlugs } from "./resource-slug";
import { SLACK_LINK_CHALLENGE_GRACE_MS, SlackAgentService } from "./slack-agent-service";
import { parseTerminalRegionConfiguration } from "./terminal/contract";
import type { TerminalLifecycleTransition } from "./terminal/lifecycle";
import { createTerminalFinalDiffPreserver, reconcileDueTerminalSandbox } from "./terminal/lifecycle";
import { createTerminalPortFactory } from "./terminal/object-port";
import { createTerminalProviderRpcClient } from "./terminal/provider-rpc-client";

/**
 * The directory reads a schedule needs, satisfied without an RPC hop.
 *
 * WorkspaceDO implements this by being itself; anything outside the object
 * passes its stub. Typed structurally so neither side has to import the other.
 */
export interface WorkspaceScheduleDirectory {
  workstreamScheduleTargets(
    input: WorkspaceDirectoryScheduleTargetsRequest,
  ): Promise<WorkspaceDirectoryScheduleTargetsResult>;
}

export interface WorkspaceScheduleNotificationIntents {
  notificationIntentMaintenanceTarget(
    input: WorkspaceNotificationIntentMaintenanceRequest,
  ): Promise<WorkspaceNotificationIntentMaintenanceTarget>;
  reapSettledWorkstreamNotificationIntents(
    input: WorkspaceNotificationIntentReapRequest,
  ): Promise<WorkspaceNotificationIntentReapResult>;
}

export interface WorkspaceScheduleContext {
  /** The regional environment: audit events, Workflows, telemetry, authority. */
  env: Env;
  /** The same environment with `DB` pointed at this workspace's database. */
  workspaceEnv: Env;
  workspaceId: string;
  directory: WorkspaceScheduleDirectory;
  notificationIntents: WorkspaceScheduleNotificationIntents;
  /**
   * The conversations of one work stream whose Terminal deadline has come
   * due, earliest first. The directory carries one deadline per work stream;
   * the work stream's own object knows which of its conversations it is.
   */
  dueTerminalSubstreams(workstreamId: string, through: Date): Promise<string[]>;
}

/** Every kind of thing a workspace alarm can be waiting on. */
export type WorkspaceScheduleTargetKind = "schedule" | "watch" | "maintenance" | "terminal";

export const WORKSPACE_SCHEDULE_ALARM_KINDS: readonly WorkspaceScheduleTargetKind[] = [
  "schedule", "watch", "maintenance", "terminal",
];

/** Every compatibility-port source declares its complete set, including cascades. */
export const WORKSPACE_ALARM_SOURCE_KINDS: ReadonlyMap<string, readonly WorkspaceScheduleTargetKind[]> = new Map([
  ["schedules", ["schedule"]],
  ["resource_watches", ["watch"]],
  ["resources", ["maintenance", "watch"]],
  ["resource_versions", ["maintenance"]],
  ["resource_object_deletion_outbox", ["maintenance"]],
  ["slack_ingress_jobs", ["maintenance"]],
  ["slack_agent_thread_claims", ["maintenance"]],
  ["slack_agent_pending_prompts", ["maintenance"]],
  ["slack_link_challenges", ["maintenance"]],
]);

export interface WorkspaceScheduleTarget {
  kind: WorkspaceScheduleTargetKind;
  /** A schedule id, a watch id, a maintenance task name, or a work-stream id. */
  id: string;
  /** ISO-8601, as every one of these tables stores its due time. */
  dueAt: string;
}

interface AlarmTargetRow {
  id: string;
  due_at: string;
}

interface ScheduleRow {
  id: string;
  workspace_id: string;
  connector_connection_id: string | null;
  digest_schedule_id: string | null;
  schedule_type: string;
  rrule: string | null;
  interval_seconds: number | null;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface ResourceWatchRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  next_poll_at: string;
}

export interface ScheduleTiming {
  next_run_at: string;
  interval_seconds: number | null;
  rrule: string | null;
  timezone: string;
  created_at: string;
}

export function calculateNextOccurrence(schedule: ScheduleTiming, now: Date): string | null {
  const dueAt = Date.parse(schedule.next_run_at);
  if (!Number.isFinite(dueAt)) throw new Error("invalid_next_run_at");

  if (schedule.interval_seconds !== null) {
    if (schedule.interval_seconds < 60) throw new Error("invalid_interval_seconds");
    const intervalMs = schedule.interval_seconds * 1_000;
    const elapsed = Math.max(0, now.getTime() - dueAt);
    const intervals = Math.floor(elapsed / intervalMs) + 1;
    return new Date(dueAt + intervals * intervalMs).toISOString();
  }

  if (schedule.rrule) {
    const next = nextRRuleOccurrence(
      schedule.rrule,
      schedule.timezone,
      new Date(schedule.created_at),
      new Date(Math.max(now.getTime(), dueAt)),
    );
    return next?.toISOString() ?? null;
  }

  return null;
}

function changes(result: D1Result<unknown>): number {
  return result.meta.changes ?? 0;
}

function workflowAlreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("duplicate") ||
    message.includes("conflict")
  );
}

/**
 * The workspace-wide maintenance passes, each its own alarm target.
 *
 * One entry per *task*, not per table: the Slack pass reaps ingress jobs,
 * thread claims, pending prompts, and link challenges together, so those four
 * tables contribute one due time between them. Splitting them would schedule
 * three alarms that all run the same function.
 */
/**
 * What a pass tells the alarm's stall check, which holds an entry that is due
 * again at the identical instant after it ran.
 *
 * Every bounded pass reports progress by the rows it retired: each takes its
 * oldest rows a batch at a time, and a backlog sharing one second re-derives
 * the same instant until the backlog is gone — progress the instant cannot
 * show, and a pass that is working would otherwise be held and reported as
 * stalled. The two Slack sweeps deliberately say nothing, so the identical
 * instant is read as the stall it is: the unfurl pass advances every unchanged
 * card on every run and the ingress pass re-enqueues a stale job without
 * touching its row, so either would claim progress forever against a source
 * it never moves.
 */
const progressedIf = (retired: number): ScheduledAlarmOutcome => (retired > 0 ? { progressed: true } : undefined);

const MAINTENANCE_TASKS: Record<string, (ctx: WorkspaceScheduleContext) => Promise<ScheduledAlarmOutcome>> = {
  resource_objects: async (ctx) => progressedIf(await reapDeletedResourceObjects(ctx.workspaceEnv, ctx.workspaceId)),
  expired_drafts: async (ctx) => progressedIf(await reapExpiredDraftResources(ctx.workspaceEnv, ctx.workspaceId)),
  resource_slugs: async (ctx) => progressedIf(await backfillResourceSlugs(ctx.workspaceEnv, ctx.workspaceId)),
  notification_intents: async (ctx) => progressedIf((
    await ctx.notificationIntents.reapSettledWorkstreamNotificationIntents({
      workspaceId: asWorkspaceId(ctx.workspaceId),
      limit: 500,
    })
  ).reapedIntentIds.length),
  slack_ingress: async (ctx) => { await new SlackAgentService(ctx.workspaceEnv).maintainIngress(ctx.workspaceId, 100); },
  // A Thread's Slack card was refreshed here; Threads are retired (plan step
  // C-2). An entry armed before that finds nothing, and the next reconcile
  // drops it, since no query below names it.
  slack_unfurls: async () => {},
};

/**
 * One query per target family, deliberately not one compound SELECT.
 *
 * They were a single `UNION ALL` until workerd rejected it with "too many terms
 * in compound SELECT": object-local SQLite caps the number of arms far below
 * the count this needs, and the cap is not something a schema change can lift.
 * A batch of small statements costs one round trip either way, and each arm's
 * failure now names the table it came from.
 *
 * `scoped` marks the queries that filter on the workspace id; the rest read
 * tables whose every row already belongs to this object's workspace, and
 * binding a parameter they do not reference is an error, not a no-op.
 *
 * Every derived due time is emitted through `strftime` rather than `datetime`.
 * `datetime()` returns `YYYY-MM-DD HH:MM:SS`, which `Date.parse` reads as
 * *local* time — harmless on a Worker, which runs in UTC, and a silent
 * hours-wide shift anywhere else that parses one of these.
 *
 * Every derived instant is also rounded *up* to the next whole second.
 * `strftime` drops the milliseconds a `nowIso()` column carries, so an alarm
 * that fires in the 999 ms before the pass's own cutoff finds nothing due,
 * comes back at the identical instant, and — since the stall gate — is held
 * for a backoff step and reported for it. A second late is the cheaper error.
 *
 * Each arm counts exactly the rows its pass will act on, with the same
 * predicates the pass applies. These statements run against the object's own
 * tables — `canvas_artifacts` and `connector_connections`
 * among them — and a Node test that runs them needs the object's ledger, not
 * a regional snapshot.
 */
export const SCHEDULE_TARGET_QUERIES: readonly { kind: WorkspaceScheduleTargetKind; sql: string; scoped: boolean }[] = [
  {
    kind: "schedule",
    scoped: true,
    sql: `SELECT id, next_run_at AS due_at
            FROM schedules
           WHERE workspace_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL`,
  },
  {
    kind: "watch",
    scoped: true,
    sql: `SELECT id, next_poll_at AS due_at
            FROM resource_watches
           WHERE workspace_id = ?1 AND enabled = 1 AND next_poll_at IS NOT NULL`,
  },
  {
    kind: "maintenance",
    scoped: true,
    sql: `SELECT 'resource_objects' AS id, MIN(created_at) AS due_at
            FROM resource_object_deletion_outbox pending
           WHERE pending.workspace_id = ?1
             -- One lookup per column, each on its partial index (migration
             -- 78). Every row here is this workspace's, and naming workspace_id
             -- in these lookups lets the planner scan every version instead.
             AND (pending.cleanup_eligible = 1
               OR EXISTS (SELECT 1 FROM resources WHERE content_ref = pending.object_ref)
               OR EXISTS (SELECT 1 FROM resources WHERE model_content_ref = pending.object_ref)
               OR EXISTS (SELECT 1 FROM resource_versions WHERE content_ref = pending.object_ref)
               OR EXISTS (SELECT 1 FROM resource_versions WHERE model_content_ref = pending.object_ref))
          HAVING COUNT(*) > 0`,
  },
  {
    kind: "maintenance",
    scoped: true,
    // Counts exactly what `reapWorkspaceExpiredDraftResources` removes. A
    // draft a Canvas holds as an artifact is kept on purpose, and counting it here would leave
    // the pass due at an instant it can never move. The `'+24 hours'` below is
    // DRAFT_ATTACHMENT_TTL_HOURS in the object's own
    // `durable-objects/workspace-resources-storage.ts`, spelled in SQL on this
    // side of the authority boundary — the two must move together, or the
    // alarm fires for drafts the reap will not take.
    sql: `SELECT 'expired_drafts' AS id,
                 strftime('%Y-%m-%dT%H:%M:%SZ', MIN(created_at), '+24 hours', '+1 second') AS due_at
            FROM resources
           WHERE workspace_id = ?1 AND provider = 'avalon_upload'
             AND attachment_status = 'draft'
             AND NOT EXISTS (SELECT 1 FROM canvas_artifacts link
                              WHERE link.resource_id = resources.id)
             AND NOT EXISTS (SELECT 1 FROM pending_attachment_reservations reservation
                              WHERE reservation.resource_id = resources.id)
           HAVING COUNT(*) > 0`,
  },
  {
    kind: "maintenance",
    scoped: true,
    // Aliases cannot be minted in SQL, so a resource created before the column
    // existed — or whose creation path could not finish its own allocation —
    // waits here. Counts exactly the rows the pass names.
    sql: `SELECT 'resource_slugs' AS id, MIN(created_at) AS due_at
            FROM resources WHERE workspace_id = ?1 AND slug IS NULL HAVING COUNT(*) > 0`,
  },
  {
    kind: "maintenance",
    // One entry for four tables: `SlackAgentService.maintainIngress` reaps all
    // of them in one pass, so three more entries would schedule three alarms
    // that call the same function. Each arm counts a row at the instant that
    // pass will act on it: a spent link challenge a grace period after it
    // expired or was consumed — the same constant the reap binds — and the
    // rest at their own horizons.
    scoped: true,
    sql: `SELECT 'slack_ingress' AS id, MIN(due_at) AS due_at
            FROM (
              SELECT MIN(CASE
                       WHEN status = 'processing' THEN lease_expires_at
                       WHEN status = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%SZ', completed_at, '+30 days', '+1 second')
                       WHEN status = 'failed' AND attempt_count >= ${SLACK_INGRESS_ATTEMPT_LIMIT}
                         THEN strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+30 days', '+1 second')
                       ELSE strftime('%Y-%m-%dT%H:%M:%SZ', updated_at, '+2 minutes', '+1 second') END) AS due_at
                FROM slack_ingress_jobs WHERE workspace_id = ?1
              UNION ALL SELECT MIN(lease_expires_at) FROM slack_agent_thread_claims
              UNION ALL SELECT MIN(expires_at) FROM slack_agent_pending_prompts
              UNION ALL SELECT strftime('%Y-%m-%dT%H:%M:%SZ',
                                        MIN(MIN(COALESCE(consumed_at, expires_at), expires_at)),
                                        '+${SLACK_LINK_CHALLENGE_GRACE_MS / 1_000} seconds', '+1 second')
                          FROM slack_link_challenges
            ) HAVING MIN(due_at) IS NOT NULL`,
  },
];

/**
 * Everything this workspace's alarm is waiting on, with its due instant.
 *
 * The work-stream half comes from the directory rather than from a table here:
 * a Terminal sandbox's deadline is written by the work stream that owns it and
 * republished into `channels`, which is the only index
 * the workspace has of when a sandbox is next due.
 */
export async function workspaceScheduleTargets(
  ctx: WorkspaceScheduleContext,
  kinds: readonly WorkspaceScheduleTargetKind[] = WORKSPACE_SCHEDULE_ALARM_KINDS,
): Promise<WorkspaceScheduleTarget[]> {
  // Run rather than batched: a batch is one transaction, and these are ten
  // independent reads that nothing else depends on being consistent with each
  // other — the alarm re-derives them on every change anyway.
  const workspaceTargets = await Promise.all(
    SCHEDULE_TARGET_QUERIES.filter((query) => kinds.includes(query.kind)).map(async (query) => {
      const statement = ctx.workspaceEnv.DB.prepare(query.sql);
      const result = await (query.scoped ? statement.bind(ctx.workspaceId) : statement).all<AlarmTargetRow>();
      return result.results.map((row) => ({ kind: query.kind, id: row.id, dueAt: row.due_at }));
    }),
  );
  const [workstreamTargets, notificationTarget] = await Promise.all([
    kinds.includes("terminal")
      ? ctx.directory.workstreamScheduleTargets({ workspaceId: ctx.workspaceId })
      : { items: [] },
    kinds.includes("maintenance")
      ? ctx.notificationIntents.notificationIntentMaintenanceTarget({ workspaceId: asWorkspaceId(ctx.workspaceId) })
      : { dueAt: null },
  ]);
  return [
    ...workspaceTargets.flat(),
    ...workstreamTargets.items.map((target) => ({
      kind: target.kind as WorkspaceScheduleTargetKind,
      id: target.workstreamId,
      dueAt: target.dueAt,
    })),
    ...(notificationTarget.dueAt === null ? [] : [{
      kind: "maintenance" as const,
      id: "notification_intents",
      dueAt: notificationTarget.dueAt,
    }]),
  ].filter((target): target is WorkspaceScheduleTarget => Number.isFinite(Date.parse(target.dueAt)));
}

/**
 * Run exactly one due target.
 *
 * Throwing is how a target asks to be retried: the caller holds the failure
 * against that target alone, so a broken automation cannot stop a digest in
 * the same workspace from being delivered.
 */
export async function runWorkspaceScheduleTarget(
  ctx: WorkspaceScheduleContext,
  target: WorkspaceScheduleTarget,
  now: Date,
): Promise<ScheduledAlarmOutcome> {
  if (target.kind === "maintenance") {
    const task = MAINTENANCE_TASKS[target.id];
    if (!task) throw new Error(`unknown_workspace_maintenance_task:${target.id}`);
    return task(ctx);
  }

  if (target.kind === "schedule") {
    const schedule = await ctx.workspaceEnv.DB.prepare(
      `SELECT * FROM schedules WHERE id = ?1 AND workspace_id = ?2 AND enabled = 1`,
    ).bind(target.id, ctx.workspaceId).first<ScheduleRow>();
    // Disabled or deleted between the reconcile and the alarm. The next
    // reconcile drops the entry; running nothing is the correct outcome.
    if (!schedule) return;
    await runSchedule(ctx, schedule, now);
    return;
  }

  if (target.kind === "watch") {
    const watch = await ctx.workspaceEnv.DB.prepare(
      `SELECT id, workspace_id, connection_id, next_poll_at
         FROM resource_watches
        WHERE id = ?1 AND workspace_id = ?2 AND enabled = 1 AND next_poll_at IS NOT NULL`,
    ).bind(target.id, ctx.workspaceId).first<ResourceWatchRow>();
    if (!watch) return;
    await runResourceWatch(ctx, watch, now);
    return;
  }

  return reconcileTerminalSandbox(ctx, target.id, now);
}

/**
 * Write the operator-visible record of a target that failed.
 *
 * Audit events, not logs: a schedule that stops firing is a product-visible
 * fault, and the audit trail is where a person looking at one workspace can
 * see it without a log query.
 */
export async function recordWorkspaceScheduleFailure(
  ctx: WorkspaceScheduleContext,
  target: WorkspaceScheduleTarget,
  error: unknown,
): Promise<void> {
  if (target.kind === "schedule") {
    runtimeDeferral(recordScheduleFailure(ctx, target.id, error));
    return;
  }
  if (target.kind === "watch") {
    runtimeDeferral(recordWatchFailure(ctx, target.id, error));
    return;
  }
  logStructuredEvent(ctx.env, "warn", "workspace_schedule_target_failed", {
    workspace_id: ctx.workspaceId,
    target_kind: target.kind,
    target_id: target.id,
    // The row keeps the message, which a target here throws as a code. A
    // stored row that no longer parses is the exception, and it is composed
    // the way the schedule and watch rows compose theirs above.
    code: error instanceof z.ZodError
      ? diagnosticErrorCode(error, "workspace_schedule_target_failed")
      : error instanceof Error ? error.message : "unknown_error",
  });
}

/**
 * How long a Terminal deadline the pass could not act on is held.
 *
 * Its due time is `next_terminal_action_at` in the workspace directory, which
 * only the work stream's own directory effect moves, off the Queue. A sandbox
 * a live run holds keeps its deadline until the run settles; a transition this
 * pass just made keeps it until that effect lands; a transition another pass
 * has claimed keeps it until that claim settles or lapses. Each re-derives the
 * identical instant, and none is a stall: a held entry is re-checked rather than
 * counted, and the first reconcile after the directory moves clears the hold.
 */
const TERMINAL_HELD_SANDBOX_RECHECK_MS = 60_000;
const TERMINAL_DIRECTORY_CATCHUP_MS = 30_000;

/** What the alarm's stall check is told after one Terminal lifecycle pass. */
export function terminalReconcileOutcome(transition: TerminalLifecycleTransition): ScheduledAlarmOutcome {
  if (transition === "deferred") return { waitMs: TERMINAL_HELD_SANDBOX_RECHECK_MS };
  if (transition === "none") return;
  return { waitMs: TERMINAL_DIRECTORY_CATCHUP_MS };
}

/**
 * Advance every due Terminal sandbox under one work stream to whatever state
 * it is now due for: a warm stop, an archive, or an expiry that preserves the
 * final diff.
 *
 * A work stream's directory entry is the earliest deadline of its
 * conversations, so one due entry can mean several due sandboxes — the main
 * conversation's and a side thread's — and each is its own object's row,
 * reconciled on its own. The strictest outcome wins: a sandbox this pass had
 * to hold decides the re-check for the entry, whatever the others did.
 */
async function reconcileTerminalSandbox(
  ctx: WorkspaceScheduleContext,
  workstreamId: string,
  now: Date,
): Promise<ScheduledAlarmOutcome> {
  const configuration = parseTerminalRegionConfiguration(ctx.env);
  if (configuration.capability !== "supported") throw new Error("terminal_provider_unavailable");
  // Disposed when the pass ends: WorkspaceDO never ends the context that would
  // release the provider session for it.
  const provider = createTerminalProviderRpcClient(ctx.env.TERMINAL_PROVIDER, configuration);
  try {
    // A work stream created before conversations reported their own deadlines
    // lists none; its sandbox, if any, is the main conversation's.
    const due = await ctx.dueTerminalSubstreams(workstreamId, now);
    const substreams = due.length > 0 ? due : ["0"];
    let outcome: ScheduledAlarmOutcome = undefined;
    for (const substreamId of substreams) {
      outcome = soonerTerminalOutcome(
        outcome,
        await reconcileConversationTerminalSandbox(ctx, provider, workstreamId, substreamId, now),
      );
    }
    return outcome;
  } finally {
    provider[Symbol.dispose]();
  }
}

/** The outcome that re-checks first; a Terminal pass only ever answers with a wait. */
function soonerTerminalOutcome(
  current: ScheduledAlarmOutcome,
  next: ScheduledAlarmOutcome,
): ScheduledAlarmOutcome {
  if (!next || !("waitMs" in next)) return current;
  if (!current || !("waitMs" in current)) return next;
  return next.waitMs < current.waitMs ? next : current;
}

async function reconcileConversationTerminalSandbox(
  ctx: WorkspaceScheduleContext,
  provider: ReturnType<typeof createTerminalProviderRpcClient>,
  workstreamId: string,
  substreamId: string,
  now: Date,
): Promise<ScheduledAlarmOutcome> {
  const executionEnv = ctx.workspaceEnv;
  // Provider observation is not this pass's: each conversation's object runs
  // its own on its own alarm. This pass is lifecycle only, and it reads the
  // row once, inside `reconcileDueTerminalSandbox`.
  const port = createTerminalPortFactory(executionEnv, undefined, substreamId);
  const terminal = port(ctx.workspaceId, workstreamId);
  const result = await reconcileDueTerminalSandbox(
    createHarnessRunPortFactory(executionEnv),
    port,
    provider,
    ctx.workspaceId,
    workstreamId,
    now,
    createTerminalFinalDiffPreserver(executionEnv, provider, ctx.workspaceId, workstreamId, substreamId),
    undefined,
    substreamId,
  );
  if (result.lostSandbox) {
    // A deleted workspace is a loss someone should see, not a routine transition.
    logStructuredEvent(ctx.env, "warn", "terminal_sandbox_retired_after_loss", {
      workspace_id: ctx.workspaceId,
      workstream_id: workstreamId,
      substream_id: substreamId,
      transition: result.transition,
    });
  }
  if (result.transition !== "none") {
    logStructuredEvent(ctx.env, "info", "terminal_sandbox_lifecycle_transition", {
      workspace_id: ctx.workspaceId,
      workstream_id: workstreamId,
      substream_id: substreamId,
      transition: result.transition,
    });
  }
  if (result.transition === "none") {
    // The entry came due with nothing due behind it, so the deadline the
    // directory holds is stale: one left by the version that projected the
    // observation deadline. Nothing else would move it, so republish it; the
    // object skips a projection whose hash has not moved. Rollout scaffolding,
    // removable with `republishDeadline` (see when there). The pass still
    // reports as a stall, deliberately: a deadline this cannot correct keeps
    // backing off and keeps being reported rather than polling quietly.
    await terminal.republishDeadline();
    return terminalReconcileOutcome(result.transition);
  }
  if (result.transition !== "expired") return terminalReconcileOutcome(result.transition);
  const repository = await terminal.selectedRepository();
  emitProductUsageTelemetry(ctx.env, {
    workspaceId: asWorkspaceId(ctx.workspaceId),
    name: "terminal_workspace_terminal",
    properties: {
      workstreamId,
      action: "expire",
      result: "success",
      duration: "unknown",
      repositorySelected: repository !== null,
      connectorType: repository ? "github" : "none",
      localFilesRetained: false,
    },
    operationId: workstreamId,
    eventId: newId(),
  });
  return terminalReconcileOutcome(result.transition);
}

async function runSchedule(
  ctx: WorkspaceScheduleContext,
  schedule: ScheduleRow,
  now: Date,
): Promise<void> {
  const nextRunAt = calculateNextOccurrence(schedule, now);
  const workspaceEnv = ctx.workspaceEnv;

  if (schedule.connector_connection_id) {
    await startConnectorPoll(ctx, schedule);
  } else if (schedule.digest_schedule_id) {
    // Digests were retired (plan step C-2); a row written before that sends
    // nothing and is advanced as before until the C-7 migration drops it.
  } else {
    throw new Error("unsupported_schedule_target");
  }

  const advanced = await workspaceEnv.DB.prepare(
    `UPDATE schedules
        SET last_run_at = ?1,
            next_run_at = ?2,
            enabled = ?3,
            version = version + 1,
            updated_at = ?1
      WHERE id = ?4
        AND workspace_id = ?5
        AND version = ?6
        AND next_run_at = ?7`
  )
    .bind(
      now.toISOString(),
      nextRunAt,
      nextRunAt ? 1 : 0,
      schedule.id,
      schedule.workspace_id,
      schedule.version,
      schedule.next_run_at
    )
    .run();

  if (changes(advanced) === 0) {
    // A concurrent edit won the version check. It is canonical and its writer
    // will refresh this scheduler, so do not overwrite it with stale state.
    return;
  }

}

async function startConnectorPoll(
  ctx: WorkspaceScheduleContext,
  schedule: ScheduleRow,
): Promise<void> {
  const connectionId = schedule.connector_connection_id;
  if (!connectionId) throw new Error("missing_connector_connection");

  const input: ConnectorPollWorkflowInput = ConnectorPollWorkflowInputSchema.parse({
    region: RegionSchema.parse(ctx.env.AVALON_REGION),
    workspaceId: schedule.workspace_id,
    connectionId,
    pollScheduleId: schedule.id
  });
  const workflowId = `poll-${schedule.id}-${Date.parse(schedule.next_run_at)}`;

  try {
    await ctx.env.CONNECTOR_POLL_WORKFLOW.create({ id: workflowId, params: input });
  } catch (error) {
    if (!workflowAlreadyExists(error)) throw error;
  }
}

async function runResourceWatch(
  ctx: WorkspaceScheduleContext,
  watch: ResourceWatchRow,
  now: Date,
): Promise<void> {
  const workspaceDatabase = ctx.workspaceEnv.DB;
  const connection = await workspaceDatabase.prepare(
    `SELECT config_json
       FROM connector_connections
      WHERE id = ?1 AND workspace_id = ?2 AND status <> 'disabled'
      LIMIT 1`
  )
    .bind(watch.connection_id, watch.workspace_id)
    .first<{ config_json: string }>();
  if (!connection) throw new Error("resource_watch_connection_unavailable");

  const input: ConnectorPollWorkflowInput = ConnectorPollWorkflowInputSchema.parse({
    region: RegionSchema.parse(ctx.env.AVALON_REGION),
    workspaceId: watch.workspace_id,
    connectionId: watch.connection_id,
    pollScheduleId: watch.id
  });
  const workflowId = `watch-${watch.id}-${Date.parse(watch.next_poll_at)}`;
  try {
    await ctx.env.CONNECTOR_POLL_WORKFLOW.create({ id: workflowId, params: input });
  } catch (error) {
    if (!workflowAlreadyExists(error)) throw error;
  }

  let intervalSeconds = 900;
  try {
    const config = JSON.parse(connection.config_json) as Record<string, unknown>;
    if (typeof config.intervalSeconds === "number" && config.intervalSeconds >= 300) {
      intervalSeconds = config.intervalSeconds;
    }
  } catch {
    // Preserve the conservative default for malformed legacy configuration.
  }
  const nextPollAt = new Date(now.getTime() + intervalSeconds * 1_000).toISOString();
  await workspaceDatabase.prepare(
    `UPDATE resource_watches
        SET next_poll_at = ?1, updated_at = ?2
      WHERE id = ?3 AND workspace_id = ?4 AND next_poll_at = ?5 AND enabled = 1`
  )
    .bind(nextPollAt, now.toISOString(), watch.id, watch.workspace_id, watch.next_poll_at)
    .run();
}

/**
 * The code an operator-visible failure record carries.
 *
 * A target's audit row keeps its own constant and the thrown message beside
 * it. A stored row that no longer parses — a schedule's or a watch's
 * `ConnectorPollWorkflowInputSchema`, built from the row itself — is the
 * exception: its message is a JSON blob, and the field it names is what an
 * operator filters on, so it rides behind the constant the way
 * `diagnosticErrorCode` composes it everywhere else.
 */
function scheduleFailureCode(error: unknown, constant: string): string {
  return error instanceof z.ZodError ? diagnosticErrorCode(error, constant) : constant;
}

async function recordScheduleFailure(
  ctx: WorkspaceScheduleContext,
  scheduleId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown scheduler error";
  await ctx.env.AUDIT_DB.prepare(
    `INSERT INTO audit_events (
       id, workspace_id, actor_type, actor_user_id, workstream_id, action,
       target_type, target_id, metadata_json, created_at
     ) VALUES (?1, ?2, 'system', NULL, NULL, 'schedule.failed', 'schedule', ?3, ?4, ?5)`
  )
    .bind(
      uuidV7(),
      ctx.workspaceId,
      scheduleId,
      JSON.stringify({ code: scheduleFailureCode(error, "schedule_execution_failed"), message: message.slice(0, 500) }),
      new Date().toISOString()
    )
    .run();
}

async function recordWatchFailure(
  ctx: WorkspaceScheduleContext,
  watchId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown resource watch error";
  await ctx.env.AUDIT_DB.prepare(
    `INSERT INTO audit_events (
       id, workspace_id, actor_type, actor_user_id, workstream_id, action,
       target_type, target_id, metadata_json, created_at
     ) VALUES (?1, ?2, 'system', NULL, NULL, 'resource_watch.failed',
               'resource_watch', ?3, ?4, ?5)`
  )
    .bind(
      uuidV7(),
      ctx.workspaceId,
      watchId,
      JSON.stringify({ code: scheduleFailureCode(error, "resource_watch_poll_failed"), message: message.slice(0, 500) }),
      new Date().toISOString()
    )
    .run();
}
