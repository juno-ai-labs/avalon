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

import type { Env } from "../env";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { logStructuredEvent } from "../observability/logger";
import { automationModelOverride, scheduledWorkstreamModelForExisting } from "../services/agent-model-flags";
import { fireDigestSchedule } from "../services/digest-run-service";
import { fireWorkstreamWakeup } from "../services/workstream-service";
import type { WorkstreamWakeupRow } from "../services/workstream-wakeup-service";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import { parseTerminalRegionConfiguration } from "../services/terminal/contract";
import { createDaytonaTerminalProvider } from "../services/terminal/daytona-provider";
import { createTerminalFinalDiffPreserver, reconcileDueTerminalSandbox } from "../services/terminal/lifecycle";

const RefreshRequestSchema = z.object({ workspaceId: IdSchema });
const RETRY_STATES_KEY = "schedulerRetryStates";
const SCHEDULER_RETRY_BASE_MS = 60_000;
const SCHEDULER_RETRY_MAX_MS = 30 * 60_000;

const SchedulerRetryStateSchema = z.object({
  attempt: z.number().int().positive(),
  retryAt: z.number().int().nonnegative()
});
const SchedulerRetryStatesSchema = z.record(z.string(), SchedulerRetryStateSchema);

type SchedulerRetryStates = z.infer<typeof SchedulerRetryStatesSchema>;

interface AlarmTargetRow {
  target_kind: "schedule" | "watch" | "wakeup" | "terminal";
  id: string;
  due_at: string;
}

interface DueTerminalSandboxRow {
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
export class WorkspaceScheduler {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
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
        workspaceId: (await this.state.storage.get<string>("workspaceId")) ?? null,
        alarmAt: (await this.state.storage.getAlarm()) ?? null
      });
    }

    return responseJson({ error: "not_found" }, 404);
  }

  /** RPC-friendly refresh used after every canonical schedule mutation. */
  async refresh(workspaceId: string): Promise<{ alarmAt: string | null }> {
    const parsedWorkspaceId = IdSchema.parse(workspaceId);
    const existing = await this.state.storage.get<string>("workspaceId");
    if (existing && existing !== parsedWorkspaceId) {
      throw new Error("scheduler_workspace_mismatch");
    }
    if (!existing) await this.state.storage.put("workspaceId", parsedWorkspaceId);

    const targets = await this.env.DB.prepare(
      `SELECT 'schedule' AS target_kind, id, next_run_at AS due_at
         FROM schedules
        WHERE workspace_id = ?1 AND enabled = 1 AND next_run_at IS NOT NULL
       UNION ALL
       SELECT 'watch' AS target_kind, id, next_poll_at AS due_at
         FROM resource_watches
        WHERE workspace_id = ?1 AND enabled = 1 AND next_poll_at IS NOT NULL
       UNION ALL
       SELECT 'wakeup' AS target_kind, id, due_at
         FROM workstream_wakeups
        WHERE workspace_id = ?1 AND status = 'pending'
       UNION ALL
       SELECT 'terminal' AS target_kind, workstream_id AS id,
              CASE
                WHEN state IN ('stopping', 'archiving', 'expiring')
                  THEN lifecycle_claim_expires_at
                WHEN expire_due_at IS NOT NULL AND (
                  (state = 'running' AND (warm_stop_due_at IS NULL OR expire_due_at <= warm_stop_due_at))
                  OR (state = 'stopped' AND (archive_due_at IS NULL OR expire_due_at <= archive_due_at))
                  OR state = 'archived'
                ) THEN expire_due_at
                WHEN state = 'running' THEN warm_stop_due_at
                WHEN state = 'stopped' THEN archive_due_at
                ELSE expire_due_at
              END AS due_at
         FROM workstream_sandboxes
        WHERE workspace_id = ?1
          AND provider_sandbox_id IS NOT NULL
          AND state IN ('running', 'stopping', 'stopped', 'archiving', 'archived', 'expiring')
          AND (
            (state IN ('stopping', 'archiving', 'expiring') AND lifecycle_claim_expires_at IS NOT NULL)
            OR
            expire_due_at IS NOT NULL
            OR (state = 'running' AND warm_stop_due_at IS NOT NULL)
            OR (state = 'stopped' AND archive_due_at IS NOT NULL)
          )`
    )
      .bind(parsedWorkspaceId)
      .all<AlarmTargetRow>();

    if (targets.results.length === 0) {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete(RETRY_STATES_KEY);
      return { alarmAt: null };
    }

    const retryStates = await this.loadRetryStates();
    const activeKeys = new Set(targets.results.map((target) => retryStateKey(target.target_kind, target.id)));
    let retryStatesChanged = false;
    for (const key of Object.keys(retryStates)) {
      if (activeKeys.has(key)) continue;
      delete retryStates[key];
      retryStatesChanged = true;
    }

    let earliestEffectiveAt = Number.POSITIVE_INFINITY;
    for (const target of targets.results) {
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

  async alarm(): Promise<void> {
    const workspaceId = await this.state.storage.get<string>("workspaceId");
    if (!workspaceId) return;

    try {
      const now = new Date();
      const retryStates = await this.loadRetryStates();
      let retryStatesChanged = false;
      const [due, dueWatches, dueWakeups, dueTerminalSandboxes] = await Promise.all([
        this.env.DB.prepare(
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
        this.env.DB.prepare(
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
        this.env.DB.prepare(
          `SELECT id, workspace_id, workstream_id, execution_principal_json, prompt,
                  due_at, status, version, created_at
             FROM workstream_wakeups
            WHERE workspace_id = ?1
              AND status = 'pending'
              AND due_at <= ?2
            ORDER BY due_at ASC
            LIMIT 100`
        )
          .bind(workspaceId, now.toISOString())
          .all<WorkstreamWakeupRow>(),
        this.env.DB.prepare(
          `SELECT workstream_id
             FROM workstream_sandboxes
            WHERE workspace_id = ?1
              AND provider_sandbox_id IS NOT NULL
              AND state IN ('running', 'stopping', 'stopped', 'archiving', 'archived', 'expiring')
              AND (
                (state IN ('stopping', 'archiving', 'expiring')
                  AND lifecycle_claim_expires_at IS NOT NULL
                  AND lifecycle_claim_expires_at <= ?2)
                OR
                (state = 'running' AND warm_stop_due_at IS NOT NULL AND warm_stop_due_at <= ?2)
                OR (state = 'stopped' AND archive_due_at IS NOT NULL AND archive_due_at <= ?2)
                OR (expire_due_at IS NOT NULL AND expire_due_at <= ?2)
              )
            ORDER BY COALESCE(expire_due_at, archive_due_at, warm_stop_due_at) ASC
            LIMIT 100`,
        )
          .bind(workspaceId, now.toISOString())
          .all<DueTerminalSandboxRow>()
      ]);

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

      for (const wakeup of dueWakeups.results) {
        const key = retryStateKey("wakeup", wakeup.id);
        if ((retryStates[key]?.retryAt ?? 0) > now.getTime()) continue;
        try {
          await fireWorkstreamWakeup(this.env, wakeup);
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
          const result = await reconcileDueTerminalSandbox(
            this.env.DB,
            terminalProvider,
            workspaceId,
            sandbox.workstream_id,
            now,
            createTerminalFinalDiffPreserver(
              this.env,
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
    const parsed = SchedulerRetryStatesSchema.safeParse(
      await this.state.storage.get(RETRY_STATES_KEY)
    );
    return parsed.success ? { ...parsed.data } : {};
  }

  private async saveRetryStates(retryStates: SchedulerRetryStates): Promise<void> {
    if (Object.keys(retryStates).length === 0) {
      await this.state.storage.delete(RETRY_STATES_KEY);
      return;
    }
    await this.state.storage.put(RETRY_STATES_KEY, retryStates);
  }

  private async runSchedule(schedule: ScheduleRow, now: Date): Promise<void> {
    const nextRunAt = calculateNextOccurrence(schedule, now);

    if (schedule.automation_subscription_id) {
      await this.startAutomation(schedule, now);
    } else if (schedule.connector_connection_id) {
      await this.startConnectorPoll(schedule);
    } else if (schedule.digest_schedule_id) {
      // The occurrence is identified by the due time, not by this row: several
      // rows carry the same digest at different times of day, and the delivery's
      // uniqueness on (schedule, planned_for) is what makes a retried alarm
      // resolve to the attempt already in flight.
      await fireDigestSchedule(this.env, {
        scheduleId: schedule.digest_schedule_id,
        workspaceId: schedule.workspace_id,
        plannedFor: schedule.next_run_at,
      });
    } else {
      throw new Error("unsupported_schedule_target");
    }

    const advanced = await this.env.DB.prepare(
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
      await this.env.DB.prepare(
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

    const source = await this.env.DB.prepare(
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

    let run = await this.env.DB.prepare(
      `SELECT id, workstream_id, status, workflow_instance_id
         FROM automation_runs
        WHERE automation_subscription_id = ?1 AND planned_for = ?2
        LIMIT 1`
    )
      .bind(subscriptionId, schedule.next_run_at)
      .first<AutomationRunRow>();

    if (!run) {
      const planned = await this.env.DB.prepare(
        `SELECT id, automation_run_id
           FROM workstreams
          WHERE workspace_id = ?1
            AND automation_subscription_id = ?2
            AND planned_for = ?3
            AND archived_at IS NULL
          LIMIT 1`
      )
        .bind(schedule.workspace_id, subscriptionId, schedule.next_run_at)
        .first<PlannedWorkstreamRow>();

      const workstreamId = planned?.id ?? crypto.randomUUID();
      const createdWorkstreamId = planned ? null : workstreamId;
      const runId = crypto.randomUUID();
      const timestamp = now.toISOString();

      if (!planned) {
        const emailRoute = await emailRouting.reserve({
          region: this.env.AVALON_REGION,
          workspaceId: schedule.workspace_id,
          workstreamId,
        });
        await this.env.DB.prepare(
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

      const inserted = await this.env.DB.prepare(
        `INSERT OR IGNORE INTO automation_runs (
           id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
           trigger_activity_id, planned_for, started_at, completed_at, status,
           result_summary, workflow_instance_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, 'scheduled', NULL, ?5, ?6, NULL, 'running', NULL, NULL, ?6)`
      )
        .bind(runId, schedule.workspace_id, subscriptionId, workstreamId, schedule.next_run_at, timestamp)
        .run();

      if (changes(inserted) === 0) {
        run = await this.env.DB.prepare(
          `SELECT id, workstream_id, status, workflow_instance_id
             FROM automation_runs
            WHERE automation_subscription_id = ?1 AND planned_for = ?2
            LIMIT 1`
        )
          .bind(subscriptionId, schedule.next_run_at)
          .first<AutomationRunRow>();
        if (createdWorkstreamId && run?.workstream_id !== createdWorkstreamId) {
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
        await this.env.DB.prepare(
          `UPDATE workstreams
              SET automation_run_id = ?1, harness_status = 'running', updated_at = ?2
            WHERE id = ?3 AND workspace_id = ?4`
        )
          .bind(runId, timestamp, workstreamId, schedule.workspace_id)
          .run();
      }
    }

    if (!run) throw new Error("automation_run_claim_failed");
    await emailRouting.ensureWorkstreamAddress({
      region: this.env.AVALON_REGION,
      workspaceId: schedule.workspace_id,
      workstreamId: run.workstream_id,
    });
    if (["completed", "failed", "needs_input"].includes(run.status)) return;

    const principal = ExecutionPrincipalSchema.parse(JSON.parse(source.execution_principal_json));
    const harnessRunId = await this.ensureHarnessRun(
      schedule.workspace_id,
      run.workstream_id,
      principal,
      now
    );
    const workflowId = `automation-${run.id}`;
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

    try {
      await this.env.WORKSTREAM_LOOP_WORKFLOW.create({ id: workflowId, params: input });
    } catch (error) {
      if (!workflowAlreadyExists(error)) throw error;
    }

    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE automation_runs
            SET workflow_instance_id = ?1, status = 'running', started_at = COALESCE(started_at, ?2)
          WHERE id = ?3 AND workspace_id = ?4`
      ).bind(workflowId, now.toISOString(), run.id, schedule.workspace_id),
      this.env.DB.prepare(
        `UPDATE harness_runs SET workflow_instance_id = ?1 WHERE id = ?2 AND workspace_id = ?3`
      ).bind(workflowId, harnessRunId, schedule.workspace_id)
    ]);
  }

  private async ensureHarnessRun(
    workspaceId: string,
    workstreamId: string,
    executionPrincipal: z.infer<typeof ExecutionPrincipalSchema>,
    now: Date
  ): Promise<string> {
    const existing = await this.env.DB.prepare(
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

    const id = crypto.randomUUID();
    const model = await scheduledWorkstreamModelForExisting(this.env, { workspaceId, workstreamId });
    await this.env.DB.prepare(
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
    const connection = await this.env.DB.prepare(
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
    await this.env.DB.prepare(
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
        crypto.randomUUID(),
        schedule.workspace_id,
        schedule.id,
        JSON.stringify({ code: "schedule_execution_failed", message: message.slice(0, 500) }),
        new Date().toISOString()
      )
      .run();
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
        crypto.randomUUID(),
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
        crypto.randomUUID(),
        watch.workspace_id,
        watch.id,
        JSON.stringify({ code: "resource_watch_poll_failed", message: message.slice(0, 500) }),
        new Date().toISOString()
      )
      .run();
  }
}
