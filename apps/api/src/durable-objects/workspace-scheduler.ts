import {
  ConnectorPollWorkflowInputSchema,
  ExecutionPrincipalSchema,
  IdSchema,
  RegionSchema,
  WorkstreamWorkflowInputSchema,
  type ConnectorPollWorkflowInput,
  type WorkstreamWorkflowInput
} from "@avalon/contracts";
import { z } from "zod";
import { newId } from "@avalon/db";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import {
  assertDurableObjectJurisdiction,
  durableObjectStubForWorkspace,
} from "../lib/durable-object-namespace";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { uuidV7 } from "../lib/uuid-v7";
import { logStructuredEvent } from "../observability/logger";
import { automationModelOverride, scheduledWorkstreamModelForExisting } from "../services/agent-model-flags";
import { fireDigestSchedule } from "../services/digest-run-service";
import { processMemoryIndexOutbox } from "../services/memory-service";
import { processPendingNotePrivacyNotifications } from "../services/note-privacy-notification-service";
import { reapDeletedNoteObjects } from "../services/note-resource-cleanup";
import {
  reapDeletedResourceObjects,
  reapExpiredDraftResources,
} from "../services/resource-object-cleanup";
import { startWorkstreamWorkflow } from "../services/integrations";
import { fireWorkstreamWakeup } from "../services/workstream-service";
import { SlackAgentService } from "../services/slack-agent-service";
import { refreshSlackWorkstreamUnfurls } from "../services/slack-unfurl-refresh";
import { reapSettledWorkspaceNotificationIntents } from "../services/workstream-regional-effect-service";
import type { WorkstreamWakeupRow } from "../services/workstream-wakeup-service";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  workstreamExecutionEnvironment,
} from "../services/workstream-runtime-database";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { parseTerminalRegionConfiguration } from "../services/terminal/contract";
import { createDaytonaTerminalProvider } from "../services/terminal/daytona-provider";
import { createTerminalFinalDiffPreserver, reconcileDueTerminalSandbox } from "../services/terminal/lifecycle";
import { recordWorkstreamCreatedTelemetry } from "../telemetry/workstream-creation";
import { emitProductUsageTelemetry } from "../telemetry/product-usage";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { workspaceDOName } from "./names";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

const RefreshRequestSchema = z.object({ workspaceId: IdSchema });
const SCHEDULER_RETRY_BASE_MS = 60_000;
const SCHEDULER_RETRY_MAX_MS = 30 * 60_000;
const MAINTENANCE_RECHECK_MS = 5 * 60_000;

export async function runIsolatedSchedulerMaintenance(
  tasks: readonly (() => Promise<unknown> | unknown)[],
  onRejected: (error: unknown, index: number) => void,
): Promise<void> {
  const results = await Promise.allSettled(tasks.map(async (task) => task()));
  results.forEach((result, index) => {
    if (result.status === "rejected") onRejected(result.reason, index);
  });
}

export const WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workspace scheduler identity and per-target retry gates",
  statements: [
    `CREATE TABLE workspace_scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE scheduler_retry_states (
      target_key TEXT PRIMARY KEY,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      retry_at INTEGER NOT NULL CHECK (retry_at >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX scheduler_retry_due_idx
      ON scheduler_retry_states(retry_at, target_key)`,
  ],
}];

const SchedulerRetryStateSchema = z.object({
  attempt: z.number().int().positive(),
  retryAt: z.number().int().nonnegative()
});
const SchedulerRetryStatesSchema = z.record(z.string(), SchedulerRetryStateSchema);

type SchedulerRetryStates = z.infer<typeof SchedulerRetryStatesSchema>;

interface AlarmTargetRow {
  target_kind: "maintenance" | "schedule" | "watch" | "wakeup" | "terminal";
  id: string;
  due_at: string;
}

interface DueTerminalSandboxRow {
  workstream_id: string;
}

interface DueWakeupWorkstreamRow {
  workstream_id: string;
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

interface PlannedWorkstreamRow {
  id: string;
  automation_run_id: string | null;
}

export interface ScheduleTiming {
  next_run_at: string;
  interval_seconds: number | null;
  rrule: string | null;
  timezone: string;
  created_at: string;
}

export function workspaceSchedulerName(
  region: "global" | "eu",
  workspaceId: string
): string {
  return `${region}:${workspaceId}`;
}

export function schedulerRetryDelay(attempt: number, random = Math.random): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 10);
  const ceiling = Math.min(SCHEDULER_RETRY_MAX_MS, SCHEDULER_RETRY_BASE_MS * 2 ** exponent);
  // Equal jitter prevents many failed workspaces from waking simultaneously,
  // while the cap guarantees a persistent failure is still retried eventually.
  return Math.floor(ceiling / 2 + random() * ceiling / 2);
}

function retryStateKey(kind: AlarmTargetRow["target_kind"], id: string): string {
  return `${kind}:${id}`;
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

function responseJson(body: unknown, status = 200): Response {
  return Response.json(body, { status });
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

/** One serialized alarm coordinator per workspace. */
export class WorkspaceScheduler extends DurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;

  constructor(
    state: DurableObjectState,
    env: Env
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.initialized = state.blockConcurrencyWhile(async () => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS,
        component: "workspace_scheduler",
        workerVersionId: env.APP_VERSION ?? "unknown",
      });
    });
  }

  private workspaceEnv(workspaceId: string): Env {
    return withWorkspaceRuntimeDatabase(this.env, workspaceId);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const url = new URL(request.url);
    if (request.method === "POST" && (url.pathname === "/refresh" || url.pathname === "/")) {
      let input: unknown;
      try {
        input = await request.json();
      } catch {
        return responseJson({ error: "invalid_json" }, 400);
      }

      const parsed = RefreshRequestSchema.safeParse(input);
      if (!parsed.success) return responseJson({ error: "invalid_workspace" }, 400);

      try {
        const result = await this.refresh(parsed.data.workspaceId);
        return responseJson(result);
      } catch (error) {
        return responseJson(
          { error: error instanceof Error ? error.message : "scheduler_refresh_failed" },
          409
        );
      }
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return responseJson({
        workspaceId: this.workspaceId(),
        alarmAt: (await this.state.storage.getAlarm()) ?? null
      });
    }

    return responseJson({ error: "not_found" }, 404);
  }

  /** RPC-friendly refresh used after every canonical schedule mutation. */
  async refresh(workspaceId: string): Promise<{ alarmAt: string | null }> {
    await this.initialized;
    const parsedWorkspaceId = IdSchema.parse(workspaceId);
    const existing = this.workspaceId();
    if (existing && existing !== parsedWorkspaceId) {
      throw new Error("scheduler_workspace_mismatch");
    }
    if (!existing) {
      const now = Date.now();
      this.state.storage.sql.exec(
        `INSERT INTO workspace_scheduler_state(id, workspace_id, created_at, updated_at)
         VALUES (1, ?, ?, ?)`,
        parsedWorkspaceId,
        now,
        now,
      );
    }

    const authority = await readWorkstreamAuthorityControl(this.env);
    const regionalTargets = await this.workspaceEnv(parsedWorkspaceId).DB.prepare(
      `SELECT 'schedule' AS target_kind, id, next_run_at AS due_at
         FROM schedules
        WHERE workspace_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL
       UNION ALL
       SELECT 'watch' AS target_kind, id, next_poll_at AS due_at
         FROM resource_watches
        WHERE workspace_id = ?1 AND enabled = 1 AND next_poll_at IS NOT NULL
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'resource_objects' AS id, MIN(created_at) AS due_at
         FROM resource_object_deletion_outbox WHERE workspace_id = ?1 HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'expired_drafts' AS id,
              datetime(MIN(created_at), '+24 hours') AS due_at
         FROM resources
        WHERE workspace_id = ?1 AND provider = 'avalon_upload'
          AND attachment_status = 'draft' HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'note_objects' AS id, MIN(created_at) AS due_at
         FROM note_resource_deletion_outbox HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'note_privacy' AS id, MIN(created_at) AS due_at
         FROM note_privacy_change_outbox
        WHERE workspace_id = ?1 AND processed_at IS NULL HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'memory_index' AS id,
              MIN(CASE WHEN status = 'processing' THEN lease_expires_at ELSE available_at END) AS due_at
         FROM memory_index_outbox
        WHERE workspace_id = ?1 AND status != 'completed' HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'slack_ingress' AS id,
              MIN(CASE
                WHEN status = 'processing' THEN lease_expires_at
                WHEN status = 'completed' THEN datetime(completed_at, '+30 days')
                WHEN status = 'failed' AND attempt_count >= 20 THEN datetime(updated_at, '+30 days')
                ELSE datetime(updated_at, '+2 minutes') END) AS due_at
         FROM slack_ingress_jobs WHERE workspace_id = ?1 HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'slack_claims' AS id, MIN(lease_expires_at) AS due_at
         FROM slack_agent_thread_claims HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'slack_prompts' AS id, MIN(expires_at) AS due_at
         FROM slack_agent_pending_prompts HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'slack_links' AS id, MIN(expires_at) AS due_at
         FROM slack_link_challenges HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'slack_unfurls' AS id,
              datetime(MIN(refreshed_at), '+5 minutes') AS due_at
         FROM slack_unfurled_links
        WHERE shared_at >= datetime('now', '-30 days') HAVING COUNT(*) > 0
       UNION ALL
       SELECT 'maintenance' AS target_kind, 'notification_intents' AS id,
              datetime(MIN(updated_at), '+30 days') AS due_at
         FROM workstream_notification_intents
        WHERE workspace_id = ?1 AND state IN ('delivered', 'skipped') HAVING COUNT(*) > 0`,
    ).bind(parsedWorkspaceId).all<AlarmTargetRow>();
    const workstreamTargets: AlarmTargetRow[] = authority.phase === "durable_object_open"
      ? (await (await this.workspaceDirectory(parsedWorkspaceId)).workstreamScheduleTargets({
        workspaceId: parsedWorkspaceId,
      })).items.map((target) => ({
        target_kind: target.kind,
        id: target.workstreamId,
        due_at: target.dueAt,
      }))
      : (await this.env.DB.prepare(
        `SELECT 'wakeup' AS target_kind, workstream_id AS id, MIN(due_at) AS due_at
           FROM workstream_wakeups
          WHERE workspace_id = ?1 AND status = 'pending'
          GROUP BY workstream_id
         UNION ALL
         SELECT 'terminal' AS target_kind, workstream_id AS id,
                COALESCE(lifecycle_claim_expires_at, expire_due_at, archive_due_at, warm_stop_due_at) AS due_at
           FROM workstream_sandboxes
          WHERE workspace_id = ?1 AND provider_sandbox_id IS NOT NULL
            AND state IN ('running', 'stopping', 'stopped', 'archiving', 'archived', 'expiring')
            AND COALESCE(lifecycle_claim_expires_at, expire_due_at, archive_due_at, warm_stop_due_at) IS NOT NULL`,
      ).bind(parsedWorkspaceId).all<AlarmTargetRow>()).results;
    const targets = [...regionalTargets.results, ...workstreamTargets];

    if (targets.length === 0) {
      await this.state.storage.deleteAlarm();
      this.state.storage.sql.exec(`DELETE FROM scheduler_retry_states`);
      return { alarmAt: null };
    }

    const retryStates = await this.loadRetryStates();
    const activeKeys = new Set(targets.map((target) => retryStateKey(target.target_kind, target.id)));
    let retryStatesChanged = false;
    for (const key of Object.keys(retryStates)) {
      if (activeKeys.has(key)) continue;
      delete retryStates[key];
      retryStatesChanged = true;
    }

    let earliestEffectiveAt = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      const dueAt = Date.parse(target.due_at);
      if (!Number.isFinite(dueAt)) throw new Error("invalid_next_run_at");
      const retryAt = retryStates[retryStateKey(target.target_kind, target.id)]?.retryAt ?? 0;
      earliestEffectiveAt = Math.min(earliestEffectiveAt, Math.max(dueAt, retryAt));
    }
    if (retryStatesChanged) await this.saveRetryStates(retryStates);

    const alarmAt = Math.max(earliestEffectiveAt, Date.now() + 1_000);
    await this.state.storage.setAlarm(alarmAt);
    return { alarmAt: new Date(alarmAt).toISOString() };
  }

  override async alarm(): Promise<void> {
    await this.initialized;
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;

    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority)) {
      await this.state.storage.setAlarm(Date.now() + MAINTENANCE_RECHECK_MS);
      return;
    }

    try {
      const now = new Date();
      const retryStates = await this.loadRetryStates();
      let retryStatesChanged = false;
      const workspaceDirectory = authority.phase === "durable_object_open"
        ? await this.workspaceDirectory(workspaceId)
        : null;
      const workspaceEnv = this.workspaceEnv(workspaceId);
      const [due, dueWatches, dueWakeups, dueTerminalSandboxes] = await Promise.all([
        workspaceEnv.DB.prepare(
          `SELECT *
             FROM schedules
            WHERE workspace_id = ?1
              AND enabled = 1
              AND next_run_at IS NOT NULL
              AND next_run_at <= ?2
            ORDER BY next_run_at ASC
            LIMIT 100`
        )
          .bind(workspaceId, now.toISOString())
          .all<ScheduleRow>(),
        workspaceEnv.DB.prepare(
          `SELECT id, workspace_id, connection_id, next_poll_at
             FROM resource_watches
            WHERE workspace_id = ?1
              AND enabled = 1
              AND next_poll_at IS NOT NULL
              AND next_poll_at <= ?2
            ORDER BY next_poll_at ASC
            LIMIT 100`
        )
          .bind(workspaceId, now.toISOString())
          .all<ResourceWatchRow>(),
        authority.phase === "durable_object_open"
          ? Promise.resolve({ results: [] as DueWakeupWorkstreamRow[] })
          : this.env.DB.prepare(`SELECT workstream_id
               FROM workstream_wakeups
              WHERE workspace_id = ?1 AND status = 'pending' AND due_at <= ?2
              GROUP BY workstream_id ORDER BY MIN(due_at), workstream_id LIMIT 100`)
          .bind(workspaceId, now.toISOString())
          .all<DueWakeupWorkstreamRow>(),
        workspaceDirectory
          ? workspaceDirectory.dueWorkstreamDirectory({
            workspaceId,
            kind: "terminal",
            through: now.toISOString(),
            limit: 100,
          }).then((ids) => ({ results: ids.map((workstream_id) => ({ workstream_id })) }))
          : this.env.DB.prepare(`SELECT workstream_id
               FROM workstream_sandboxes
              WHERE workspace_id = ?1 AND provider_sandbox_id IS NOT NULL
                AND state IN ('running', 'stopping', 'stopped', 'archiving', 'archived', 'expiring')
                AND COALESCE(lifecycle_claim_expires_at, expire_due_at, archive_due_at, warm_stop_due_at) <= ?2
              ORDER BY COALESCE(lifecycle_claim_expires_at, expire_due_at, archive_due_at, warm_stop_due_at), workstream_id
              LIMIT 100`)
          .bind(workspaceId, now.toISOString())
          .all<DueTerminalSandboxRow>()
      ]);

      // These rows are owned by WorkspaceDO; the scheduler supplies only the
      // alarm/egress execution edge. Each worker is idempotent and retains a
      // failed row, so refresh below re-arms the exact workspace without a
      // fleet-wide D1 scan.
      if (this.env.WORKSPACE_DOS) {
        const maintenanceKinds = [
          "note_object_reaper",
          "resource_object_reaper",
          "draft_resource_reaper",
          "memory_index_outbox",
          "note_privacy_notifications",
          "notification_intent_reaper",
          "slack_ingress",
          "slack_unfurl_refresh",
        ] as const;
        await runIsolatedSchedulerMaintenance([
          () => reapDeletedNoteObjects(workspaceEnv, workspaceId),
          () => reapDeletedResourceObjects(workspaceEnv, workspaceId),
          () => reapExpiredDraftResources(workspaceEnv, workspaceId),
          () => processMemoryIndexOutbox(workspaceEnv, 50, workspaceId),
          () => processPendingNotePrivacyNotifications(workspaceEnv),
          () => reapSettledWorkspaceNotificationIntents(workspaceEnv, workspaceId),
          () => new SlackAgentService(workspaceEnv).maintainIngress(100, workspaceId),
          () => refreshSlackWorkstreamUnfurls(workspaceEnv, workspaceId),
        ], (error, index) => {
          logStructuredEvent(this.env, "warn", "workspace_scheduler_maintenance_failed", {
            workspace_id: workspaceId,
            maintenance_kind: maintenanceKinds[index] ?? "unknown",
            code: error instanceof Error ? error.message : "unknown_error",
          });
        });
      }

      for (const schedule of due.results) {
        const key = retryStateKey("schedule", schedule.id);
        if ((retryStates[key]?.retryAt ?? 0) > now.getTime()) continue;
        try {
          await this.runSchedule(schedule, now);
          if (retryStates[key]) {
            delete retryStates[key];
            retryStatesChanged = true;
          }
        } catch (error) {
          const attempt = (retryStates[key]?.attempt ?? 0) + 1;
          retryStates[key] = {
            attempt,
            retryAt: now.getTime() + schedulerRetryDelay(attempt)
          };
          // Persist the retry gate before writing observability. Even if the
          // audit insert fails, the next alarm cannot fall into a one-second loop.
          await this.saveRetryStates(retryStates);
          retryStatesChanged = false;
          await this.recordScheduleFailure(schedule, error);
        }
      }

      for (const watch of dueWatches.results) {
        const key = retryStateKey("watch", watch.id);
        if ((retryStates[key]?.retryAt ?? 0) > now.getTime()) continue;
        try {
          await this.runResourceWatch(watch, now);
          if (retryStates[key]) {
            delete retryStates[key];
            retryStatesChanged = true;
          }
        } catch (error) {
          const attempt = (retryStates[key]?.attempt ?? 0) + 1;
          retryStates[key] = {
            attempt,
            retryAt: now.getTime() + schedulerRetryDelay(attempt)
          };
          await this.saveRetryStates(retryStates);
          retryStatesChanged = false;
          await this.recordWatchFailure(watch, error);
        }
      }

      for (const dueWorkstream of dueWakeups.results) {
        const executionEnv = await workstreamExecutionEnvironment(
          workspaceEnv,
          workspaceId,
          dueWorkstream.workstream_id,
        );
        const wakeup = await executionEnv.DB.prepare(
          `SELECT id, workspace_id, workstream_id, execution_principal_json, prompt,
                  due_at, status, version, created_at
             FROM workstream_wakeups
            WHERE workspace_id = ? AND workstream_id = ? AND status = 'pending'
              AND due_at <= ? ORDER BY due_at, id LIMIT 1`,
        ).bind(workspaceId, dueWorkstream.workstream_id, now.toISOString())
          .first<WorkstreamWakeupRow>();
        if (!wakeup) continue;
        const key = retryStateKey("wakeup", dueWorkstream.workstream_id);
        if ((retryStates[key]?.retryAt ?? 0) > now.getTime()) continue;
        try {
          await fireWorkstreamWakeup(executionEnv, wakeup);
          if (retryStates[key]) {
            delete retryStates[key];
            retryStatesChanged = true;
          }
        } catch (error) {
          const attempt = (retryStates[key]?.attempt ?? 0) + 1;
          retryStates[key] = {
            attempt,
            retryAt: now.getTime() + schedulerRetryDelay(attempt)
          };
          await this.saveRetryStates(retryStates);
          retryStatesChanged = false;
          await this.recordWakeupFailure(wakeup, error);
        }
      }

      const terminalConfiguration = parseTerminalRegionConfiguration(this.env);
      const terminalProvider = terminalConfiguration.capability === "supported"
        ? createDaytonaTerminalProvider(terminalConfiguration)
        : null;
      for (const sandbox of dueTerminalSandboxes.results) {
        const key = retryStateKey("terminal", sandbox.workstream_id);
        if ((retryStates[key]?.retryAt ?? 0) > now.getTime()) continue;
        try {
          if (!terminalProvider) {
            throw new Error("terminal_provider_unavailable");
          }
          const executionEnv = await workstreamExecutionEnvironment(
            workspaceEnv,
            workspaceId,
            sandbox.workstream_id,
          );
          const result = await reconcileDueTerminalSandbox(
            executionEnv.DB,
            terminalProvider,
            workspaceId,
            sandbox.workstream_id,
            now,
            createTerminalFinalDiffPreserver(
              executionEnv,
              terminalProvider,
              workspaceId,
              sandbox.workstream_id,
            ),
          );
          if (result.transition !== "none") {
            logStructuredEvent(this.env, "info", "terminal_sandbox_lifecycle_transition", {
              workspace_id: workspaceId,
              workstream_id: sandbox.workstream_id,
              transition: result.transition,
            });
          }
          if (result.transition === "expired") {
            const repository = await this.env.DB.prepare(
              `SELECT 1 AS selected FROM workstream_terminal_repositories
               WHERE workspace_id = ? AND workstream_id = ? AND state = 'selected'`,
            ).bind(workspaceId, sandbox.workstream_id).first<{ selected: number }>();
            await emitProductUsageTelemetry(this.env, {
              workspaceId,
              name: "terminal_workspace_terminal",
              properties: {
                workstreamId: sandbox.workstream_id,
                action: "expire",
                result: "success",
                duration: "unknown",
                repositorySelected: repository !== null,
                connectorType: repository ? "github" : "none",
                localFilesRetained: false,
              },
              operationId: sandbox.workstream_id,
              eventId: newId(),
            }).catch(() => undefined);
          }
          if (retryStates[key]) {
            delete retryStates[key];
            retryStatesChanged = true;
          }
        } catch (error) {
          const attempt = (retryStates[key]?.attempt ?? 0) + 1;
          retryStates[key] = {
            attempt,
            retryAt: now.getTime() + schedulerRetryDelay(attempt),
          };
          await this.saveRetryStates(retryStates);
          retryStatesChanged = false;
          logStructuredEvent(this.env, "warn", "terminal_sandbox_lifecycle_failed", {
            workspace_id: workspaceId,
            workstream_id: sandbox.workstream_id,
            attempt,
            code: error instanceof Error ? error.message : "unknown_error",
          });
        }
      }

      if (retryStatesChanged) await this.saveRetryStates(retryStates);
      await this.refresh(workspaceId);
    } catch {
      await this.state.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async loadRetryStates(): Promise<SchedulerRetryStates> {
    await this.initialized;
    const raw = Object.fromEntries(this.state.storage.sql.exec<{
      target_key: string;
      attempt: number;
      retry_at: number;
    }>(`SELECT target_key, attempt, retry_at FROM scheduler_retry_states ORDER BY target_key`)
      .toArray()
      .map((row) => [row.target_key, { attempt: row.attempt, retryAt: row.retry_at }]));
    const parsed = SchedulerRetryStatesSchema.safeParse(raw);
    return parsed.success ? { ...parsed.data } : {};
  }

  private async saveRetryStates(retryStates: SchedulerRetryStates): Promise<void> {
    await this.initialized;
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(`DELETE FROM scheduler_retry_states`);
      for (const [targetKey, retry] of Object.entries(retryStates)) {
        this.state.storage.sql.exec(
          `INSERT INTO scheduler_retry_states(target_key, attempt, retry_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          targetKey,
          retry.attempt,
          retry.retryAt,
          now,
        );
      }
    });
  }

  private workspaceId(): string | null {
    return this.state.storage.sql.exec<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_scheduler_state WHERE id = 1`,
    ).toArray()[0]?.workspace_id ?? null;
  }

  private async runSchedule(schedule: ScheduleRow, now: Date): Promise<void> {
    const nextRunAt = calculateNextOccurrence(schedule, now);
    const workspaceEnv = this.workspaceEnv(schedule.workspace_id);

    if (schedule.automation_subscription_id) {
      await this.startAutomation(schedule, now);
    } else if (schedule.connector_connection_id) {
      await this.startConnectorPoll(schedule);
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

  private async startAutomation(schedule: ScheduleRow, now: Date): Promise<void> {
    const subscriptionId = schedule.automation_subscription_id;
    if (!subscriptionId) throw new Error("missing_automation_subscription");
    const emailRouting = new WorkstreamEmailRoutingService(this.env);
    const authority = await readWorkstreamAuthorityControl(this.env);
    const workspaceEnv = this.workspaceEnv(schedule.workspace_id);

    const source = await workspaceEnv.DB.prepare(
      `SELECT s.id AS subscription_id,
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
      const planned = authority.phase === "durable_object_open"
        ? await (await this.workspaceDirectory(schedule.workspace_id)).plannedWorkstream({
          workspaceId: schedule.workspace_id,
          userId: null,
          automationSubscriptionId: subscriptionId,
          plannedFor: schedule.next_run_at,
        }).then((workstream) => workstream ? ({
          id: workstream.id,
          automation_run_id: workstream.automationRunId,
        }) : null)
        : await this.env.DB.prepare(`SELECT id, automation_run_id
           FROM workstreams
          WHERE workspace_id = ?1
            AND automation_subscription_id = ?2
            AND planned_for = ?3
            AND archived_at IS NULL
          LIMIT 1`)
        .bind(schedule.workspace_id, subscriptionId, schedule.next_run_at)
        .first<PlannedWorkstreamRow>();

      const workstreamId = planned?.id ?? uuidV7(now.getTime());
      const createdWorkstreamId = planned ? null : workstreamId;
      const runId = uuidV7(now.getTime());
      const timestamp = now.toISOString();
      const executionEnv = planned
        ? await workstreamExecutionEnvironment(workspaceEnv, schedule.workspace_id, workstreamId)
        : await bootstrapWorkstreamRuntimeEnvironment(workspaceEnv, schedule.workspace_id, workstreamId);

      if (!planned) {
        const emailRoute = await emailRouting.reserve({
          region: this.env.AVALON_REGION,
          workspaceId: schedule.workspace_id,
          workstreamId,
        });
        await executionEnv.DB.prepare(
          `INSERT INTO workstreams (
             id, workspace_id, title, objective, email_address, email_route_status, origin_type,
             created_by_user_id, automation_subscription_id, automation_run_id,
             planned_for, harness_status, last_activity_at, created_at, updated_at, archived_at,
             model_override
           ) VALUES (?1, ?2, ?3, ?4, ?5, 'reserved', 'automation', NULL, ?6, NULL, ?7,
                     'scheduled', ?8, ?8, ?8, NULL, ?9)`
        )
          .bind(
            workstreamId,
            schedule.workspace_id,
            source.template_name,
            source.template_description || source.instructions,
            emailRoute.emailAddress,
            subscriptionId,
            schedule.next_run_at,
            timestamp,
            // The automation's pin follows every run it produces, not only the
            // ones `AutomationService.createRun` builds. `ensureHarnessRun`
            // below resolves the model from this row, so copying it here is
            // what makes a scheduled run honour the choice.
            automationModelOverride(this.env, source.model_override, {
              workspaceId: schedule.workspace_id,
              automationSubscriptionId: subscriptionId,
            })
          )
          .run();
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
        if (
          authority.phase !== "durable_object_open"
          && createdWorkstreamId
          && run?.workstream_id !== createdWorkstreamId
        ) {
          // A concurrent scheduler won the unique run claim. The losing Global
          // address remains a permanent non-routable reservation tombstone.
          await this.env.DB.prepare(
            `DELETE FROM workstreams
             WHERE id = ? AND workspace_id = ? AND automation_run_id IS NULL`,
          ).bind(createdWorkstreamId, schedule.workspace_id).run();
        }
      } else {
        run = {
          id: runId,
          workstream_id: workstreamId,
          status: "running",
          workflow_instance_id: null
        };
        await executionEnv.DB.prepare(
          `UPDATE workstreams
              SET automation_run_id = ?1, harness_status = 'running', updated_at = ?2
            WHERE id = ?3 AND workspace_id = ?4`
        )
          .bind(runId, timestamp, workstreamId, schedule.workspace_id)
          .run();
        if (createdWorkstreamId) {
          await recordWorkstreamCreatedTelemetry(this.env, {
            workspaceId: schedule.workspace_id,
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
      region: this.env.AVALON_REGION,
      workspaceId: schedule.workspace_id,
      workstreamId: run.workstream_id,
    });
    if (["completed", "failed", "needs_input"].includes(run.status)) return;

    const harnessRunId = await this.ensureHarnessRun(
      schedule.workspace_id,
      run.workstream_id,
      principal,
      now
    );
    const input: WorkstreamWorkflowInput = WorkstreamWorkflowInputSchema.parse({
      region: RegionSchema.parse(this.env.AVALON_REGION),
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
    await executionEnv.DB.prepare(
      `UPDATE harness_runs SET workflow_instance_id = ?1 WHERE id = ?2 AND workspace_id = ?3`,
    ).bind(workflowId, harnessRunId, schedule.workspace_id).run();
  }

  private async ensureHarnessRun(
    workspaceId: string,
    workstreamId: string,
    executionPrincipal: z.infer<typeof ExecutionPrincipalSchema>,
    now: Date
  ): Promise<string> {
    const executionEnv = await workstreamExecutionEnvironment(
      this.workspaceEnv(workspaceId),
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
    await executionEnv.DB.prepare(
      `INSERT INTO harness_runs (
       id, workspace_id, workstream_id, origin, execution_principal_json,
         workflow_instance_id, parent_harness_run_id, status, started_at, completed_at,
         model, usage_json, error_json, created_at
       ) VALUES (?1, ?2, ?3, 'automation', ?4, NULL, NULL, 'scheduled', ?5, NULL,
                 ?6, '{}', NULL, ?5)`
    )
      .bind(
        id,
        workspaceId,
        workstreamId,
        JSON.stringify(executionPrincipal),
        now.toISOString(),
        model
      )
      .run();
    return id;
  }

  private async startConnectorPoll(schedule: ScheduleRow): Promise<void> {
    const connectionId = schedule.connector_connection_id;
    if (!connectionId) throw new Error("missing_connector_connection");

    const input: ConnectorPollWorkflowInput = ConnectorPollWorkflowInputSchema.parse({
      region: RegionSchema.parse(this.env.AVALON_REGION),
      workspaceId: schedule.workspace_id,
      connectionId,
      pollScheduleId: schedule.id
    });
    const workflowId = `poll-${schedule.id}-${Date.parse(schedule.next_run_at)}`;

    try {
      await this.env.CONNECTOR_POLL_WORKFLOW.create({ id: workflowId, params: input });
    } catch (error) {
      if (!workflowAlreadyExists(error)) throw error;
    }
  }

  private async runResourceWatch(watch: ResourceWatchRow, now: Date): Promise<void> {
    const workspaceDatabase = this.workspaceEnv(watch.workspace_id).DB;
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
      region: RegionSchema.parse(this.env.AVALON_REGION),
      workspaceId: watch.workspace_id,
      connectionId: watch.connection_id,
      pollScheduleId: watch.id
    });
    const workflowId = `watch-${watch.id}-${Date.parse(watch.next_poll_at)}`;
    try {
      await this.env.CONNECTOR_POLL_WORKFLOW.create({ id: workflowId, params: input });
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

  private async recordScheduleFailure(schedule: ScheduleRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown scheduler error";
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
         id, workspace_id, actor_type, actor_user_id, workstream_id, action,
         target_type, target_id, metadata_json, created_at
       ) VALUES (?1, ?2, 'system', NULL, NULL, 'schedule.failed', 'schedule', ?3, ?4, ?5)`
    )
      .bind(
        uuidV7(),
        schedule.workspace_id,
        schedule.id,
        JSON.stringify({ code: "schedule_execution_failed", message: message.slice(0, 500) }),
        new Date().toISOString()
      )
      .run();
  }

  private workspaceDirectory(workspaceId: string) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(this.env.AVALON_REGION, workspaceId),
    );
  }

  private async recordWakeupFailure(wakeup: WorkstreamWakeupRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown wake-up error";
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
         id, workspace_id, actor_type, actor_user_id, workstream_id, action,
         target_type, target_id, metadata_json, created_at
       ) VALUES (?1, ?2, 'system', NULL, ?3, 'workstream_wakeup.failed',
                 'workstream_wakeup', ?4, ?5, ?6)`
    )
      .bind(
        uuidV7(),
        wakeup.workspace_id,
        wakeup.workstream_id,
        wakeup.id,
        JSON.stringify({ code: "workstream_wakeup_failed", message: message.slice(0, 500) }),
        new Date().toISOString()
      )
      .run();
  }

  private async recordWatchFailure(watch: ResourceWatchRow, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : "unknown resource watch error";
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
         id, workspace_id, actor_type, actor_user_id, workstream_id, action,
         target_type, target_id, metadata_json, created_at
       ) VALUES (?1, ?2, 'system', NULL, NULL, 'resource_watch.failed',
                 'resource_watch', ?3, ?4, ?5)`
    )
      .bind(
        uuidV7(),
        watch.workspace_id,
        watch.id,
        JSON.stringify({ code: "resource_watch_poll_failed", message: message.slice(0, 500) }),
        new Date().toISOString()
      )
      .run();
  }
}
