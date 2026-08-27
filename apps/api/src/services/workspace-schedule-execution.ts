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
  ExecutionPrincipalSchema,
  RegionSchema,
  WorkstreamWorkflowInputSchema,
  asWorkspaceId,
  asWorkstreamId,
  type ConnectorPollWorkflowInput,
  type ExecutionPrincipal,
  type Workstream,
  type WorkstreamWorkflowInput,
} from "@rally/contracts";
import { newId } from "@rally/db";

import type { Env } from "../env";
import type {
  WorkspaceDirectoryPlannedAutomationRequest,
  WorkspaceDirectoryScheduleTargetsRequest,
  WorkspaceDirectoryScheduleTargetsResult,
} from "../durable-objects/workspace-directory-protocol";
import type {
  WorkspaceNotificationIntentMaintenanceRequest,
  WorkspaceNotificationIntentMaintenanceTarget,
  WorkspaceNotificationIntentReapRequest,
  WorkspaceNotificationIntentReapResult,
} from "../durable-objects/workspace-notification-intent-protocol";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { uuidV7 } from "../lib/uuid-v7";
import { logStructuredEvent } from "../observability/logger";
import { automationModelOverride, scheduledWorkstreamModelForExisting } from "./agent-model-flags";
import { fireDigestSchedule } from "./digest-run-service";
import { startWorkstreamWorkflow } from "./integrations";
import { processMemoryIndexOutbox } from "./memory-service";
import { processPendingNotePrivacyNotifications } from "./note-privacy-notification-service";
import { reapDeletedNoteObjects } from "./note-resource-cleanup";
import {
  reapDeletedResourceObjects,
  reapExpiredDraftResources,
} from "./resource-object-cleanup";
import { SlackAgentService } from "./slack-agent-service";
import { refreshSlackWorkstreamUnfurls } from "./slack-unfurl-refresh";
import { createTerminalPortFactory } from "./terminal/object-port";
import { parseTerminalRegionConfiguration } from "./terminal/contract";
import { createDaytonaTerminalProvider } from "./terminal/daytona-provider";
import { createTerminalFinalDiffPreserver, reconcileDueTerminalSandbox } from "./terminal/lifecycle";
import { emitProductUsageTelemetry } from "../telemetry/product-usage";
import { recordWorkstreamCreatedTelemetry } from "../telemetry/workstream-creation";
import { WorkstreamEmailRoutingService } from "./workstream-email-routing-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
  workstreamExecutionEnvironment,
} from "./workstream-runtime-database";
import type { ScheduledAlarmOutcome } from "../durable-objects/scheduled-alarms";
import { SLACK_LINK_CHALLENGE_GRACE_MS } from "./slack-agent-service";
import type { TerminalLifecycleTransition } from "./terminal/lifecycle";
import { createHarnessRunObjectPort, createHarnessRunPortFactory } from "../runtime/harness-run-port";
import { createIdentityObjectPort } from "../runtime/identity-port";

/**
 * The directory reads a schedule needs, satisfied without an RPC hop.
 *
 * WorkspaceDO implements this by being itself; anything outside the object
 * passes its stub. Typed structurally so neither side has to import the other.
 */
export interface WorkspaceScheduleDirectory {
  plannedAutomationWorkstream(input: WorkspaceDirectoryPlannedAutomationRequest): Promise<Workstream | null>;
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
}

/** Every kind of thing a workspace alarm can be waiting on. */
export type WorkspaceScheduleTargetKind = "schedule" | "watch" | "maintenance" | "terminal";

export interface WorkspaceScheduleTarget {
  kind: WorkspaceScheduleTargetKind;
  /** A schedule id, a watch id, a maintenance task name, or a work-stream id. */
  id: string;
  /** ISO-8601, as every one of these tables stores its due time. */
  dueAt: string;
}

interface AlarmTargetRow {
  target_kind: WorkspaceScheduleTargetKind;
  id: string;
  due_at: string;
}

interface ScheduleRow {
  id: string;
  workspace_id: string;
  automation_subscription_id: string | null;
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

interface AutomationSourceRow {
  subscription_id: string;
  scope: "personal" | "workspace";
  audience_user_id: string;
  execution_principal_json: string;
  model_override: string | null;
  template_name: string;
  template_description: string;
  instructions: string;
}

interface ResourceWatchRow {
  id: string;
  workspace_id: string;
  connection_id: string;
  next_poll_at: string;
}

interface AutomationRunRow {
  id: string;
  workstream_id: string;
  status: string;
  workflow_instance_id: string | null;
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
  note_objects: async (ctx) => progressedIf(await reapDeletedNoteObjects(ctx.workspaceEnv, ctx.workspaceId)),
  note_privacy: async (ctx) => progressedIf(await processPendingNotePrivacyNotifications(ctx.workspaceEnv)),
  memory_index: async (ctx) => progressedIf(await processMemoryIndexOutbox(ctx.workspaceEnv, 50, ctx.workspaceId)),
  notification_intents: async (ctx) => progressedIf((
    await ctx.notificationIntents.reapSettledWorkstreamNotificationIntents({
      workspaceId: asWorkspaceId(ctx.workspaceId),
      limit: 500,
    })
  ).reapedIntentIds.length),
  slack_ingress: async (ctx) => { await new SlackAgentService(ctx.workspaceEnv).maintainIngress(100, ctx.workspaceId); },
  slack_unfurls: async (ctx) => { await refreshSlackWorkstreamUnfurls(ctx.workspaceEnv, ctx.workspaceId); },
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
 * tables — `workspace_workstream_resource_links` and `connector_connections`
 * among them — and a Node test that runs them needs the object's ledger, not
 * a regional snapshot.
 */
const SCHEDULE_TARGET_QUERIES: readonly { sql: string; scoped: boolean }[] = [
  {
    scoped: true,
    sql: `SELECT 'schedule' AS target_kind, id, next_run_at AS due_at
            FROM schedules
           WHERE workspace_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL`,
  },
  {
    scoped: true,
    sql: `SELECT 'watch' AS target_kind, id, next_poll_at AS due_at
            FROM resource_watches
           WHERE workspace_id = ?1 AND enabled = 1 AND next_poll_at IS NOT NULL`,
  },
  {
    scoped: true,
    sql: `SELECT 'maintenance' AS target_kind, 'resource_objects' AS id, MIN(created_at) AS due_at
            FROM resource_object_deletion_outbox WHERE workspace_id = ?1 HAVING COUNT(*) > 0`,
  },
  {
    scoped: true,
    // Counts exactly what `reapExpiredDraftResources` removes. A draft a work
    // stream has linked is kept on purpose, and counting it here would leave
    // the pass due at an instant it can never move.
    sql: `SELECT 'maintenance' AS target_kind, 'expired_drafts' AS id,
                 strftime('%Y-%m-%dT%H:%M:%SZ', MIN(created_at), '+24 hours', '+1 second') AS due_at
            FROM resources
           WHERE workspace_id = ?1 AND provider = 'avalon_upload'
             AND attachment_status = 'draft'
             AND NOT EXISTS (SELECT 1 FROM workspace_workstream_resource_links link
                              WHERE link.resource_id = resources.id)
           HAVING COUNT(*) > 0`,
  },
  {
    scoped: false,
    sql: `SELECT 'maintenance' AS target_kind, 'note_objects' AS id, MIN(created_at) AS due_at
            FROM note_resource_deletion_outbox HAVING COUNT(*) > 0`,
  },
  {
    scoped: true,
    sql: `SELECT 'maintenance' AS target_kind, 'note_privacy' AS id, MIN(created_at) AS due_at
            FROM note_privacy_change_outbox
           WHERE workspace_id = ?1 AND processed_at IS NULL HAVING COUNT(*) > 0`,
  },
  {
    scoped: true,
    sql: `SELECT 'maintenance' AS target_kind, 'memory_index' AS id,
                 MIN(CASE WHEN status = 'processing' THEN lease_expires_at ELSE available_at END)
                   AS due_at
            FROM memory_index_outbox
           WHERE workspace_id = ?1 AND status != 'completed' HAVING COUNT(*) > 0`,
  },
  {
    // One entry for four tables: `SlackAgentService.maintainIngress` reaps all
    // of them in one pass, so three more entries would schedule three alarms
    // that call the same function. Each arm counts a row at the instant that
    // pass will act on it: a spent link challenge a grace period after it
    // expired or was consumed — the same constant the reap binds — and the
    // rest at their own horizons.
    scoped: true,
    sql: `SELECT 'maintenance' AS target_kind, 'slack_ingress' AS id, MIN(due_at) AS due_at
            FROM (
              SELECT MIN(CASE
                       WHEN status = 'processing' THEN lease_expires_at
                       WHEN status = 'completed' THEN strftime('%Y-%m-%dT%H:%M:%SZ', completed_at, '+30 days', '+1 second')
                       WHEN status = 'failed' AND attempt_count >= 20
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
  {
    // The sweep loads a link only through a connection that is not disabled
    // (`loadDurableObjectStaleUnfurls`), so a disabled connection's links are
    // not counted here either: a row the sweep never loads never advances.
    scoped: false,
    sql: `SELECT 'maintenance' AS target_kind, 'slack_unfurls' AS id,
                 strftime('%Y-%m-%dT%H:%M:%SZ', MIN(link.refreshed_at), '+5 minutes', '+1 second') AS due_at
            FROM slack_unfurled_links link
           WHERE link.shared_at >= datetime('now', '-30 days')
             AND EXISTS (SELECT 1 FROM connector_connections connection
                          WHERE connection.id = link.connection_id AND connection.status <> 'disabled')
           HAVING COUNT(*) > 0`,
  },
];

/**
 * Everything this workspace's alarm is waiting on, with its due instant.
 *
 * The work-stream half comes from the directory rather than from a table here:
 * a Terminal sandbox's deadline is written by the work stream that owns it and
 * republished into `workspace_workstream_directory`, which is the only index
 * the workspace has of when a sandbox is next due.
 */
export async function workspaceScheduleTargets(
  ctx: WorkspaceScheduleContext,
): Promise<WorkspaceScheduleTarget[]> {
  // Run rather than batched: a batch is one transaction, and these are ten
  // independent reads that nothing else depends on being consistent with each
  // other — the alarm re-derives them on every change anyway.
  const workspaceTargets = await Promise.all(
    SCHEDULE_TARGET_QUERIES.map((query) => {
      const statement = ctx.workspaceEnv.DB.prepare(query.sql);
      return (query.scoped ? statement.bind(ctx.workspaceId) : statement).all<AlarmTargetRow>();
    }),
  );
  const [workstreamTargets, notificationTarget] = await Promise.all([
    ctx.directory.workstreamScheduleTargets({ workspaceId: ctx.workspaceId }),
    ctx.notificationIntents.notificationIntentMaintenanceTarget({
      workspaceId: asWorkspaceId(ctx.workspaceId),
    }),
  ]);
  return [
    ...workspaceTargets.flatMap((result) => result.results).map((row) => ({
      kind: row.target_kind,
      id: row.id,
      dueAt: row.due_at,
    })),
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
    await recordScheduleFailure(ctx, target.id, error);
    return;
  }
  if (target.kind === "watch") {
    await recordWatchFailure(ctx, target.id, error);
    return;
  }
  logStructuredEvent(ctx.env, "warn", "workspace_schedule_target_failed", {
    workspace_id: ctx.workspaceId,
    target_kind: target.kind,
    target_id: target.id,
    code: error instanceof Error ? error.message : "unknown_error",
  });
}

/**
 * How long a Terminal deadline the pass could not act on is held.
 *
 * Its due time is `next_terminal_action_at` in the workspace directory, which
 * only the work stream's own directory effect moves, off the Queue. A sandbox
 * a live run holds keeps its deadline until the run settles; a transition this
 * pass just made keeps it until that effect lands. Both re-derive the identical
 * instant, and neither is a stall: a held entry is re-checked rather than
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
 * Advance one work stream's Terminal sandbox to whatever state it is now due
 * for: a warm stop, an archive, or an expiry that preserves the final diff.
 */
async function reconcileTerminalSandbox(
  ctx: WorkspaceScheduleContext,
  workstreamId: string,
  now: Date,
): Promise<ScheduledAlarmOutcome> {
  const configuration = parseTerminalRegionConfiguration(ctx.env);
  if (configuration.capability !== "supported") throw new Error("terminal_provider_unavailable");
  const provider = createDaytonaTerminalProvider(configuration);
  const executionEnv = await workstreamExecutionEnvironment(
    ctx.workspaceEnv,
    ctx.workspaceId,
    workstreamId,
  );
  const port = createTerminalPortFactory(executionEnv);
  const result = await reconcileDueTerminalSandbox(
    createHarnessRunPortFactory(executionEnv),
    port,
    provider,
    ctx.workspaceId,
    workstreamId,
    now,
    createTerminalFinalDiffPreserver(executionEnv, provider, ctx.workspaceId, workstreamId),
  );
  if (result.transition !== "none") {
    logStructuredEvent(ctx.env, "info", "terminal_sandbox_lifecycle_transition", {
      workspace_id: ctx.workspaceId,
      workstream_id: workstreamId,
      transition: result.transition,
    });
  }
  if (result.transition !== "expired") return terminalReconcileOutcome(result.transition);
  const repository = await port(ctx.workspaceId, workstreamId).selectedRepository();
  await emitProductUsageTelemetry(ctx.env, {
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
  }).catch(() => undefined);
  return terminalReconcileOutcome(result.transition);
}

async function runSchedule(
  ctx: WorkspaceScheduleContext,
  schedule: ScheduleRow,
  now: Date,
): Promise<void> {
  const nextRunAt = calculateNextOccurrence(schedule, now);
  const workspaceEnv = ctx.workspaceEnv;

  if (schedule.automation_subscription_id) {
    await startAutomation(ctx, schedule, now);
  } else if (schedule.connector_connection_id) {
    await startConnectorPoll(ctx, schedule);
  } else if (schedule.digest_schedule_id) {
    // The occurrence is identified by the due time, not by this row: several
    // rows carry the same digest at different times of day, and the delivery's
    // uniqueness on (schedule, planned_for) is what makes a retried alarm
    // resolve to the attempt already in flight.
    await fireDigestSchedule(workspaceEnv, {
      scheduleId: schedule.digest_schedule_id,
      workspaceId: schedule.workspace_id,
      plannedFor: schedule.next_run_at,
    });
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

  if (schedule.automation_subscription_id) {
    await workspaceEnv.DB.prepare(
      `UPDATE automation_subscriptions
          SET last_run_at = ?1, next_run_at = ?2, updated_at = ?1
        WHERE id = ?3 AND workspace_id = ?4`
    )
      .bind(now.toISOString(), nextRunAt, schedule.automation_subscription_id, schedule.workspace_id)
      .run();
  }
}

async function startAutomation(
  ctx: WorkspaceScheduleContext,
  schedule: ScheduleRow,
  now: Date,
): Promise<void> {
  const subscriptionId = schedule.automation_subscription_id;
  if (!subscriptionId) throw new Error("missing_automation_subscription");
  const emailRouting = new WorkstreamEmailRoutingService(ctx.env);
  const workspaceEnv = ctx.workspaceEnv;

  const source = await workspaceEnv.DB.prepare(
    `SELECT s.id AS subscription_id,
            s.scope,
            COALESCE(s.owner_user_id, t.owner_user_id) AS audience_user_id,
            s.execution_principal_json,
            s.model_override,
            t.name AS template_name,
            t.description AS template_description,
            tv.instructions
       FROM automation_subscriptions s
       JOIN automation_templates t ON t.id = s.template_id
       JOIN automation_template_versions tv ON tv.id = s.template_version_id
      WHERE s.id = ?1
        AND s.workspace_id = ?2
        AND s.status = 'active'
        AND s.lifecycle_state = 'visible'
      LIMIT 1`
  )
    .bind(subscriptionId, schedule.workspace_id)
    .first<AutomationSourceRow>();
  if (!source) throw new Error("automation_subscription_unavailable");
  const principal = ExecutionPrincipalSchema.parse(JSON.parse(source.execution_principal_json));

  let run = await workspaceEnv.DB.prepare(
    `SELECT id, workstream_id, status, workflow_instance_id
       FROM automation_runs
      WHERE automation_subscription_id = ?1 AND planned_for = ?2
      LIMIT 1`
  )
    .bind(subscriptionId, schedule.next_run_at)
    .first<AutomationRunRow>();

  if (!run) {
    const planned = await ctx.directory.plannedAutomationWorkstream({
      workspaceId: schedule.workspace_id,
      automationSubscriptionId: subscriptionId,
      plannedFor: schedule.next_run_at,
    }).then((workstream) => workstream ? ({
      id: workstream.id,
      automation_run_id: workstream.automationRunId,
    }) : null);

    const workstreamId = planned?.id ?? uuidV7(now.getTime());
    const createdWorkstreamId = planned ? null : workstreamId;
    const runId = uuidV7(now.getTime());
    const timestamp = now.toISOString();
    // A work stream nobody has opened yet has no object; the bootstrap is what
    // makes one, and it is the only reason this branch survives the move off
    // the routed statements. Nothing here reads through the environment any
    // more — every write below addresses its own authority.
    if (!planned) {
      await bootstrapWorkstreamRuntimeEnvironment(workspaceEnv, schedule.workspace_id, workstreamId);
    }

    if (!planned) {
      const emailRoute = await emailRouting.reserve({
        region: ctx.env.AVALON_REGION,
        workspaceId: schedule.workspace_id,
        workstreamId,
      });
      await provisionWorkstreamObject(workspaceEnv, {
        workspaceId: asWorkspaceId(schedule.workspace_id),
        workstreamId: asWorkstreamId(workstreamId),
        title: source.template_name,
        objective: source.template_description || source.instructions,
        scope: source.scope,
        originType: "automation",
        createdByUserId: source.audience_user_id,
        participantUserIds: [source.audience_user_id],
        harnessStatus: "scheduled",
        emailAddress: emailRoute.emailAddress,
        emailRouteStatus: "reserved",
        systemKind: null,
        automationSubscriptionId: subscriptionId,
        automationRunId: null,
        plannedFor: Date.parse(schedule.next_run_at),
        // The automation's pin follows every run it produces, not only the
        // ones `AutomationService.createRun` builds. `ensureHarnessRun` below
        // resolves the model from this row, so writing it here is what makes a
        // scheduled run honour the choice.
        modelOverride: automationModelOverride(ctx.env, source.model_override, {
          workspaceId: schedule.workspace_id,
          automationSubscriptionId: subscriptionId,
        }),
        now: Date.parse(timestamp),
      });
    }

    const inserted = await workspaceEnv.DB.prepare(
      `INSERT OR IGNORE INTO automation_runs (
         id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
         trigger_activity_id, planned_for, started_at, completed_at, status,
         result_summary, workflow_instance_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, 'scheduled', NULL, ?5, ?6, NULL, 'running', NULL, NULL, ?6)`
    )
      .bind(runId, schedule.workspace_id, subscriptionId, workstreamId, schedule.next_run_at, timestamp)
      .run();

    if (changes(inserted) === 0) {
      run = await workspaceEnv.DB.prepare(
        `SELECT id, workstream_id, status, workflow_instance_id
           FROM automation_runs
          WHERE automation_subscription_id = ?1 AND planned_for = ?2
          LIMIT 1`
      )
        .bind(subscriptionId, schedule.next_run_at)
        .first<AutomationRunRow>();
    } else {
      run = {
        id: runId,
        workstream_id: workstreamId,
        status: "running",
        workflow_instance_id: null
      };
      await createIdentityObjectPort(ctx.env, schedule.workspace_id, workstreamId)
        .bindAutomationRun({ automationRunId: runId, now: Date.parse(timestamp) });
      if (createdWorkstreamId) {
        await recordWorkstreamCreatedTelemetry(ctx.env, {
          workspaceId: asWorkspaceId(schedule.workspace_id),
          workstreamId: createdWorkstreamId,
          creationSource: "automation_scheduled",
          principal: principal.type === "user"
            ? { type: "user", userId: principal.userId }
            : { type: "workspace" },
        });
      }
    }
  }

  if (!run) throw new Error("automation_run_claim_failed");
  await emailRouting.ensureWorkstreamAddress({
    region: ctx.env.AVALON_REGION,
    workspaceId: schedule.workspace_id,
    workstreamId: run.workstream_id,
  });
  if (["completed", "failed", "needs_input"].includes(run.status)) return;

  const harnessRunId = await ensureHarnessRun(
  ctx,
    schedule.workspace_id,
    run.workstream_id,
    principal,
    now
  );
  const input: WorkstreamWorkflowInput = WorkstreamWorkflowInputSchema.parse({
    region: RegionSchema.parse(ctx.env.AVALON_REGION),
    workspaceId: schedule.workspace_id,
    workstreamId: run.workstream_id,
    harnessRunId,
    triggerMessageId: null,
    automationSubscriptionId: subscriptionId,
    activityId: null,
    executionPrincipal: principal,
    reason: `Scheduled automation: ${source.template_name}`
  });

  const workflowId = await startWorkstreamWorkflow(workspaceEnv, input);

  await workspaceEnv.DB.prepare(
    `UPDATE automation_runs
        SET workflow_instance_id = ?1, status = 'running', started_at = COALESCE(started_at, ?2)
      WHERE id = ?3 AND workspace_id = ?4`,
  ).bind(workflowId, now.toISOString(), run.id, schedule.workspace_id).run();
  const executionEnv = await workstreamExecutionEnvironment(
    workspaceEnv,
    schedule.workspace_id,
    run.workstream_id,
  );
  await createHarnessRunObjectPort(executionEnv, schedule.workspace_id, run.workstream_id)
    .bindWorkflowInstance({
      runId: harnessRunId,
      workflowInstanceId: workflowId,
      now: now.getTime(),
    });
}

async function ensureHarnessRun(
  ctx: WorkspaceScheduleContext,
  workspaceId: string,
  workstreamId: string,
  executionPrincipal: ExecutionPrincipal,
  now: Date,
): Promise<string> {
  const executionEnv = await workstreamExecutionEnvironment(
    ctx.workspaceEnv,
    workspaceId,
    workstreamId,
  );
  const existing = await executionEnv.DB.prepare(
    `SELECT id
       FROM harness_runs
      WHERE workspace_id = ?1
        AND workstream_id = ?2
        AND origin = 'automation'
        AND parent_tool_call_id IS NULL
        AND status IN ('scheduled', 'running')
      ORDER BY started_at DESC
      LIMIT 1`
  )
    .bind(workspaceId, workstreamId)
    .first<{ id: string }>();
  if (existing) return existing.id;

  const id = uuidV7(now.getTime());
  const model = await scheduledWorkstreamModelForExisting(executionEnv, { workspaceId, workstreamId });
  await createHarnessRunObjectPort(executionEnv, workspaceId, workstreamId).admitRun({
    runId: id,
    origin: "automation",
    executionPrincipalJson: JSON.stringify(executionPrincipal),
    status: "admitted",
    startedAt: now.getTime(),
    model,
    triggerPartId: null,
    parentRunId: null,
    supersedeActive: false,
    expectedLatestRunId: null,
    now: now.getTime(),
  });
  return id;
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

async function recordScheduleFailure(
  ctx: WorkspaceScheduleContext,
  scheduleId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : "unknown scheduler error";
  await ctx.env.DB.prepare(
    `INSERT INTO audit_events (
       id, workspace_id, actor_type, actor_user_id, workstream_id, action,
       target_type, target_id, metadata_json, created_at
     ) VALUES (?1, ?2, 'system', NULL, NULL, 'schedule.failed', 'schedule', ?3, ?4, ?5)`
  )
    .bind(
      uuidV7(),
      ctx.workspaceId,
      scheduleId,
      JSON.stringify({ code: "schedule_execution_failed", message: message.slice(0, 500) }),
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
  await ctx.env.DB.prepare(
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
      JSON.stringify({ code: "resource_watch_poll_failed", message: message.slice(0, 500) }),
      new Date().toISOString()
    )
    .run();
}
