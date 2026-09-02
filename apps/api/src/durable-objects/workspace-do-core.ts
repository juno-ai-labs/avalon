import {
  asWorkspaceId,
  WORKSPACE_SYNC_TOPICS,
  WorkspaceIdSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSyncTopicSchema,
  type WorkspaceSyncTopic,
  ProductFeatureFlagKeySchema,
  type ProductFeatureFlagKey,
} from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import {
  assertDurableObjectJurisdiction,
  isWorkspacePlacementAffinityForRegion,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import type { Workstream } from "@rally/contracts";

import type { WorkspaceDO } from "./workspace-do";
import type {
  WorkspaceDirectoryPlannedAutomationRequest,
  WorkspaceDirectoryScheduleTargetsRequest,
  WorkspaceDirectoryScheduleTargetsResult,
} from "./workspace-directory-protocol";
import type {
  WorkspaceNotificationIntentMaintenanceRequest,
  WorkspaceNotificationIntentMaintenanceTarget,
  WorkspaceNotificationIntentReapRequest,
  WorkspaceNotificationIntentReapResult,
} from "./workspace-notification-intent-protocol";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import {
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { resolveClientFeatureFlagsForSubject } from "../services/client-feature-flags";
import { applyDurableObjectSqliteMigrations } from "./sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "./workspace-do-migrations";
import {
  SIDEBAR_LIST_SOURCE_TABLES,
  WORKSPACE_ALARM_SOURCE_TABLES,
  typedRpcOnlyWorkspaceTable,
  workspaceMutationTarget,
  type SidebarList,
} from "./workspace-runtime-sql-guards";
import {
  readAttachment,
} from "./workspace-socket-session";
import {
  workspaceTerminalScheduleTargets,
} from "./workspace-directory-storage";
import {
  ACTIVITY_EVENT_RETENTION_MS,
  reapExpiredWorkspaceActivityEvents,
} from "./workspace-activity-event-storage";
import { epoch } from "./workspace-projection";
import {
  ScheduledDurableObject,
  scheduledAlarmRetryDelay,
  type ScheduledAlarm,
  type ScheduledAlarmOutcome,
} from "./scheduled-alarms";
import {
  observableWorkspaceScheduledAlarmKind,
  WorkspaceAlarmInstrumentation,
  type ObservableWorkspaceScheduledAlarmKind,
  type WorkspaceScheduledAlarmPhase,
} from "./workspace-alarm-instrumentation";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  recordWorkspaceScheduleFailure,
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTargetKind,
} from "../services/workspace-schedule-execution";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { workspaceDOName } from "./names";
import {
  removeLegacyAutomationSchema,
} from "./automation-cutover";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  WorkspaceOpportunityWorkflowInputSchema,
} from "./workspace-opportunity-protocol";
import { WorkspaceProductStorage } from "./workspace-product-storage";
import { WorkspaceProjectStorage } from "./workspace-project-storage";
import { publishProjectDefaultResourceTargets } from "./workspace-project-default-publication";
import {
  json,
  responseToRpcResult,
  type DurableObjectRpcResult,
} from "./rpc-result";
import {
  executeWorkspaceRuntimeSql,
  WorkspaceRuntimeSqlRequestSchema,
  type WorkspaceRuntimeSqlRequest,
  type WorkspaceRuntimeSqlResult,
} from "./workspace-runtime-sql";



const PRODUCT_ALARM_BATCH = 6;
/** How often a workspace rechecks a region that is closed for maintenance. */
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
/** `_internal_durable_alarms` identity for this workspace's opportunity and ranking work. */
const PRODUCT_ALARM_KIND = "product";
const PRODUCT_ALARM_KEY = "workspace";
/** The one-shot entry a migrating object uses to reconcile itself once. */
const SCHEDULE_BOOTSTRAP_ALARM_KIND = "schedule_bootstrap";
/** The kinds `refreshSchedule` reconciles, each dispatched to the schedule runner. */
const WORKSPACE_SCHEDULE_ALARM_KINDS: readonly WorkspaceScheduleTargetKind[] = [
  "schedule",
  "watch",
  "maintenance",
  "terminal",
];

function isWorkspaceScheduleAlarmKind(kind: string): kind is WorkspaceScheduleTargetKind {
  return (WORKSPACE_SCHEDULE_ALARM_KINDS as readonly string[]).includes(kind);
}

function workflowAlreadyExists(error: unknown): boolean {
  return error instanceof Error && /(already exists|duplicate|conflict)/iu.test(error.message);
}

/**
 * The migration runner's component key for this class.
 *
 * One constant because two call sites need the identical value: the runner
 * keys the object's schema ledger by it, and the migration report keys the
 * tracker's component rollup by it. Two literals that drift put an object
 * under a component its own ledger does not use, which shows up as a silent
 * miscount rather than an error.
 */
const MIGRATION_COMPONENT = "workspace_do";

/**
 * `WorkspaceDO`'s constructor, schema migration, alarms, schedule reconciliation,
 * and the identity and storage helpers every other link uses.
 *
 * This is the first link of a chain. `WorkspaceDO` presents a single flat RPC
 * surface — a caller reaches every method as `stub.method(...)` — so the class
 * cannot be broken into collaborators without changing what every caller is
 * written against. It is split across `workspace-do-*.ts` by inheritance
 * instead, which workerd resolves through the prototype chain exactly as it
 * already does for `forceMigration`, defined two links *above* this one on
 * `MigratableDurableObject` and called on a `WORKSPACE_DOS` stub.
 *
 * The order of the links carries no meaning beyond "a link may call the links
 * before it": it is a file split, not a taxonomy. Anything genuinely shared —
 * identity, storage, scheduling — belongs here, in the first link; anything a
 * later link needs from a link after it is declared `abstract` here rather than
 * reached for, and there are two such seams, both below.
 */
export abstract class WorkspaceDoCore extends ScheduledDurableObject<Env> {
  protected readonly state: DurableObjectState;
  protected readonly initialized: Promise<void>;
  /** This object's own `WORKSPACE_DOS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  /** Content-free phase timings for the alarm invocation currently running. */
  private workspaceAlarmInstrumentation: WorkspaceAlarmInstrumentation | null = null;

  /**
   * Push one sidebar list to every subscribed socket, per viewer.
   *
   * Declared here and implemented by the socket link: a write arriving through
   * the generic SQL port invalidates a sidebar list, and that is the only reason
   * this link has to know sockets exist at all.
   */
  protected abstract publishSidebarList(list: SidebarList): void;

  /**
   * The complete object this link is one file of.
   *
   * The self-reference registered above stands in for a `WORKSPACE_DOS` stub, so
   * it is typed as the whole class rather than as this link. Only the last link
   * can answer that, and it answers with `this`; declaring the requirement here
   * is what keeps the registration honest instead of casting it.
   */
  protected abstract selfInstance(): WorkspaceDO;

  // The schedule runner is handed this object as its directory and
  // notification-intent reader. Both are RPC methods on links above this one,
  // and `scheduleContext` below passes `this` for them, so the requirement is
  // declared rather than assumed.
  abstract plannedAutomationWorkstream(
    input: WorkspaceDirectoryPlannedAutomationRequest,
  ): Promise<Workstream | null>;

  abstract workstreamScheduleTargets(
    input: WorkspaceDirectoryScheduleTargetsRequest,
  ): Promise<WorkspaceDirectoryScheduleTargetsResult>;

  abstract notificationIntentMaintenanceTarget(
    input: WorkspaceNotificationIntentMaintenanceRequest,
  ): Promise<WorkspaceNotificationIntentMaintenanceTarget>;

  abstract reapSettledWorkstreamNotificationIntents(
    input: WorkspaceNotificationIntentReapRequest,
  ): Promise<WorkspaceNotificationIntentReapResult>;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the WorkspaceDO for this workspace" reaches
    // the object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.WORKSPACE_DOS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this.selfInstance(),
    });
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      await this.armNextAlarm();
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "WorkspaceDO",
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  /** Trusted Worker compatibility port for WorkspaceDO-owned relational state. */
  async executeRuntimeSql(input: WorkspaceRuntimeSqlRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    try {
      const request = WorkspaceRuntimeSqlRequestSchema.parse(input);
      this.assertWorkspace(request.workspaceId);
      const results = this.runWorkspaceSql(request);
      if (request.statements.some((statement) => {
        const target = workspaceMutationTarget(statement.sql);
        return target !== null && WORKSPACE_ALARM_SOURCE_TABLES.has(target);
      })) {
        this.state.waitUntil(this.refreshSchedule(request.workspaceId).catch((error: unknown) => {
          // Swallowed silently, a failed refresh here leaves a schedule dark
          // until something else reconciles. The alarm's own end-of-drain
          // refresh is the backstop; this line is how anyone finds out the
          // backstop was needed.
          logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
            workspace_id: request.workspaceId,
            code: error instanceof Error ? error.message : "unknown_error",
          });
        }));
      }
      return responseToRpcResult(json({ results }));
    } catch (error) {
      return responseToRpcResult(json({
        error: error instanceof Error ? error.message : "workspace_runtime_sql_failed",
      }, 409));
    }
  }

  /**
   * Workspace-local product scheduler.
   *
   * SQLite decides what is due and fences each claim. The alarm only starts a
   * deterministic Workflow instance; inference and ranking never run in the
   * object's single-threaded request path. A dormant member deliberately leaves
   * a due request parked without another alarm. Their next authenticated read
   * schedules the object again, avoiding an idle per-workspace polling loop.
   */
  /**
   * Hold every due target while this region is closed for maintenance.
   *
   * The frozen D1 snapshot is the authority for this object's tables during an
   * import, and the importer re-verifies every page it sends. Claiming a
   * window, advancing a schedule, or reaping a completed one here would mutate
   * exactly those rows between a page and its retry. Nothing is dropped: every
   * entry keeps its due time and this rechecks on a fixed cadence rather than
   * waiting for the next future target, so a workspace whose whole schedule is
   * already overdue still resumes the moment the region reopens.
   */
  protected override async scheduledAlarmDeferral(now: number): Promise<number | null> {
    const deferral = await this.instrumentWorkspaceAlarmPhase("authority_check", undefined, async () => {
      const authority = await readWorkstreamAuthorityControl(this.env);
      if (authority.phase === "durable_object_open" || authority.phase === "legacy_open") {
        return null;
      }
      return now + MAINTENANCE_RECHECK_MS;
    });
    // A deferred invocation returns from the base before the ordinary final
    // re-arm hook. Close its summary here; the base's direct `setAlarm` is a
    // platform storage span and not scheduled application work.
    if (deferral !== null) this.finishWorkspaceAlarmInstrumentation();
    return deferral;
  }

  protected override armAlarmBeforeDueWork(now: number): Promise<unknown> {
    // This is the first awaited phase after the base has verified migrations,
    // so a fresh recorder here also discards any incomplete recorder left by a
    // continuation the runtime ended before the previous alarm could finish.
    this.workspaceAlarmInstrumentation = new WorkspaceAlarmInstrumentation(this.env);
    return this.instrumentWorkspaceAlarmPhase("recovery_rearm", undefined, async () =>
      super.armAlarmBeforeDueWork(now));
  }

  protected override async armAlarmAfterDueWork(): Promise<unknown> {
    try {
      return await this.instrumentWorkspaceAlarmPhase("final_rearm", undefined, async () =>
        super.armAlarmAfterDueWork());
    } finally {
      this.finishWorkspaceAlarmInstrumentation();
    }
  }

  /**
   * Everything this object wakes for that is not a stored entry.
   *
   * Activity retention and project-default publication are derived from their
   * authoritative rows. Product work, schedules, watches, maintenance passes,
   * and Terminal deadlines are stored entries with their own retry gates.
   */
  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const oldest = this.state.storage.sql.exec<{ created_at: number | null }>(
      `SELECT MIN(created_at) AS created_at FROM workspace_activity_events`,
    ).one().created_at;
    const publication = this.projectStorage().nextDefaultPublicationDueAt();
    return [
      ...(oldest === null ? [] : [Number(oldest) + ACTIVITY_EVENT_RETENTION_MS]),
      ...(publication === null ? [] : [publication]),
    ];
  }

  /**
   * The one thing this object's alarm does that no entry owns.
   *
   * Expired activity events are swept on every wake rather than through an
   * entry: the sweep is idempotent, bounded to 500 rows, and its due time
   * moves with every event this workspace records.
   */
  protected override async runDueAlarmWork(now: number): Promise<void> {
    const workspaceId = this.workspaceId();
    if (workspaceId) {
      await this.instrumentWorkspaceAlarmPhase("project_default_publish", undefined, async () => {
        try {
          await publishProjectDefaultResourceTargets({
            storage: this.projectStorage(),
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "project_default_publication_failed", {
            workspace_id: workspaceId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      });
    }
    await this.instrumentWorkspaceAlarmPhase("activity_reap", undefined, async () => {
      this.reapExpiredActivityEvents(now);
    });
    // Re-derive the whole index before this alarm ends, exactly as the object
    // that used to own it did. A target that just fired has advanced its own
    // canonical row — `runSchedule` writes the next `next_run_at`,
    // `runResourceWatch` the next `next_poll_at`, a bounded maintenance pass
    // can leave rows behind — and it writes them through the local executor,
    // which does not pass the auto-refresh in `executeRuntimeSql`. Without
    // this, the drain settles the one-shot entry it just ran and nothing arms
    // the occurrence that replaced it: a recurring automation fires once and
    // then never again until an unrelated mutation happens to reconcile.
    if (workspaceId) {
      await this.instrumentWorkspaceAlarmPhase("schedule_reconcile", undefined, async () => {
        await this.refreshSchedule(workspaceId);
      });
    }
  }

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome> {
    return this.instrumentWorkspaceAlarmPhase(
      "stored_target",
      observableWorkspaceScheduledAlarmKind(alarm.kind),
      async () => {
        const workspaceId = this.workspaceId();
        if (!workspaceId) return;
        if (alarm.kind === PRODUCT_ALARM_KIND) {
          await this.runProductAlarm(workspaceId);
          return;
        }
        if (alarm.kind === SCHEDULE_BOOTSTRAP_ALARM_KIND) {
          // One-shot, written by the migration that created this index: it exists
          // so an object that has never been asked to reconcile does it once,
          // unprompted. Settling deletes it.
          await this.refreshSchedule(workspaceId);
          return;
        }
        if (!isWorkspaceScheduleAlarmKind(alarm.kind)) {
          throw new Error(`workspace_object_unknown_alarm_kind:${alarm.kind}`);
        }
        return runWorkspaceScheduleTarget(
          this.scheduleContext(workspaceId),
          { kind: alarm.kind, id: alarm.key, dueAt: new Date(alarm.dueAt).toISOString() },
          new Date(),
        );
      },
    );
  }

  /**
   * Time one bounded, content-free phase of this WorkspaceDO alarm.
   *
   * Cloudflare adds the invocation and Durable Object ids itself. Keeping
   * identity out of these fields means a phase row can explain a hot object
   * without copying a workspace id, target key, due time, payload, or error
   * message into Workers Logs or the Global trace export.
   */
  private instrumentWorkspaceAlarmPhase<T>(
    phase: WorkspaceScheduledAlarmPhase,
    alarmKind: ObservableWorkspaceScheduledAlarmKind | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    // Defensive for direct private-method tests and future internal callers;
    // the normal alarm sequence initializes this in armAlarmBeforeDueWork.
    this.workspaceAlarmInstrumentation ??= new WorkspaceAlarmInstrumentation(this.env);
    return this.workspaceAlarmInstrumentation.phase(phase, alarmKind, run);
  }

  private finishWorkspaceAlarmInstrumentation(): void {
    this.workspaceAlarmInstrumentation?.finish();
    this.workspaceAlarmInstrumentation = null;
  }

  protected override onScheduledAlarmFailure(
    alarm: ScheduledAlarm,
    error: unknown,
    attempt: number,
  ): void {
    const workspaceId = this.workspaceId();
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workspace_scheduled_alarm_failed",
      summary: "A workspace alarm target keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the target.",
      attempt,
      fields: {
        workspace_id: workspaceId,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
      },
      error,
    });
    if (!workspaceId || !isWorkspaceScheduleAlarmKind(alarm.kind)) return;
    // The audit row is a regional D1 write and this hook cannot await; the
    // retry gate is already persisted, so losing the record to an eviction
    // costs the operator one line and the product nothing.
    this.state.waitUntil(recordWorkspaceScheduleFailure(
      this.scheduleContext(workspaceId),
      { kind: alarm.kind, id: alarm.key, dueAt: new Date(alarm.dueAt).toISOString() },
      error,
    ).catch(() => undefined));
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workspace_scheduled_alarm_stalled",
      summary: "A workspace alarm target keeps coming back due at the same instant after running: the reap or reconcile named by `alarm_kind` and `alarm_key` is not removing what its due-time query counts. Find the row it counts and why the pass does not move it.",
      attempt,
      fields: {
        workspace_id: this.workspaceId(),
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  /**
   * Reconcile every workspace-wide target into the alarm index.
   *
   * Called after any mutation that can move a due time — a schedule edited, a
   * watch enabled, an outbox row written through the runtime SQL port — and
   * once by the `schedule_bootstrap` entry the alarm migration writes.
   * Reconciling rather than appending is what lets a cancelled schedule take
   * its alarm with it.
   */
  async refreshSchedule(workspaceId: string): Promise<{ alarmAt: string | null }> {
    await this.initialized;
    const parsed = WorkspaceIdSchema.parse(workspaceId);
    // No identity means no workspace rows: every write to this object asserts
    // its identity first, so there is nothing here that could be due.
    if (this.workspaceId() === null) return { alarmAt: null };
    this.assertWorkspace(parsed);
    const targets = await workspaceScheduleTargets(this.scheduleContext(parsed));
    const grouped = new Map<WorkspaceScheduleTargetKind, { key: string; dueAt: number }[]>(
      WORKSPACE_SCHEDULE_ALARM_KINDS.map((kind) => [kind, []]),
    );
    for (const target of targets) {
      grouped.get(target.kind)?.push({ key: target.id, dueAt: Date.parse(target.dueAt) });
    }
    this.state.storage.transactionSync(() => {
      for (const [kind, entries] of grouped) this.scheduledAlarms.reconcile(kind, entries);
    });
    const alarmAt = await this.armNextAlarm();
    return { alarmAt: alarmAt === null ? null : new Date(alarmAt).toISOString() };
  }

  /**
   * Re-derive the Terminal deadlines alone.
   *
   * Only this kind: the other three read tables a directory effect never
   * touches, and a full refresh on the hottest write path this object has
   * would put ten queries behind every directory publish. The source is the
   * same method the full reconcile reads, so there is still one derivation of
   * when a sandbox is due.
   */
  protected async refreshTerminalSchedule(): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    const targets = workspaceTerminalScheduleTargets(this.state.storage);
    await this.reconcileScheduledAlarms(
      "terminal",
      targets.items
        .filter((target) => target.kind === "terminal")
        .map((target) => ({ key: target.workstreamId, dueAt: Date.parse(target.dueAt) }))
        .filter((target) => Number.isFinite(target.dueAt)),
    );
  }

  private scheduleContext(workspaceId: string): WorkspaceScheduleContext {
    return {
      env: this.env,
      workspaceEnv: this.localWorkspaceEnv(workspaceId),
      workspaceId,
      directory: this,
      notificationIntents: this,
    };
  }

  /**
   * This workspace's database, addressed without leaving the object.
   *
   * The moved schedule code speaks `env.DB`, and routing that back through the
   * namespace would have the object call itself. The local executor runs the
   * same statements against its own storage instead.
   */
  private localWorkspaceEnv(workspaceId: string): Env {
    return withWorkspaceRuntimeDatabase(this.env, workspaceId, (statements) =>
      Promise.resolve(this.runWorkspaceSql(WorkspaceRuntimeSqlRequestSchema.parse({
        workspaceId,
        requestId: uuidV7(),
        statements,
      }))));
  }

  /**
   * Every write this object makes to its own product tables, from either
   * direction: the Worker's RPC port and the schedule work that runs inside the
   * alarm. Both go through here so neither can quietly stop pushing.
   *
   * That is not hypothetical. The schedule loop advancing an automation's
   * `next_run_at` after a run is the write with no request behind it, and it
   * reaches these tables through `localWorkspaceEnv` rather than the RPC —
   * exactly the writer a check on the RPC alone would miss.
   */
  private runWorkspaceSql(request: WorkspaceRuntimeSqlRequest): WorkspaceRuntimeSqlResult[] {
    const lists = new Set<SidebarList>();
    for (const statement of request.statements) {
      const typedOnlyTable = typedRpcOnlyWorkspaceTable(statement.sql);
      if (typedOnlyTable) {
        throw new Error(`workspace_runtime_table_requires_typed_rpc:${typedOnlyTable}`);
      }
      const target = workspaceMutationTarget(statement.sql);
      const list = target === null ? undefined : SIDEBAR_LIST_SOURCE_TABLES.get(target);
      if (list) lists.add(list);
    }
    // The counters advance inside the write's own transaction, so a version can
    // never describe rows that rolled back; the publish waits for the commit,
    // so a socket is never sent a list built from rows about to disappear.
    const results = executeWorkspaceRuntimeSql(this.state.storage, request, [...lists]);
    for (const list of lists) this.publishSidebarList(list);
    return results;
  }

  /**
   * Workspace-local product scheduler.
   *
   * SQLite decides what is due and fences each claim. The alarm only starts a
   * deterministic Workflow instance; inference and ranking never run in the
   * object's single-threaded request path. A dormant member deliberately leaves
   * a due request parked without another alarm. Their next authenticated read
   * schedules the object again, avoiding an idle per-workspace polling loop.
   */
  private async runProductAlarm(workspaceId: string): Promise<void> {
    const now = Date.now();
    const product = this.productStorage();
    product.reapCompletedOpportunityWindows(now - 30 * 24 * 60 * 60_000);
    product.reapSettledSuggestedWork(now);
    let launched = 0;

    for (const row of product.dueOpportunityWindows(now, PRODUCT_ALARM_BATCH)) {
      const claim = product.claimOpportunityWindow(row.window_id, now);
      if (!claim) continue;
      const input = WorkspaceOpportunityWorkflowInputSchema.parse({
        kind: "admission",
        region: this.env.AVALON_REGION,
        workspaceId,
        windowId: claim.windowId,
        leaseId: claim.leaseId,
        attempt: claim.attempt,
      });
      try {
        await this.env.WORK_OPPORTUNITY_WORKFLOW.create({
          id: `opportunity-admission-${claim.windowId}-${claim.attempt}`,
          params: input,
        });
      } catch (error) {
        if (!workflowAlreadyExists(error)) throw error;
      }
      launched += 1;
    }

    const dueRankings = product.dueRankingRows(now, PRODUCT_ALARM_BATCH);
    if (dueRankings.length > 0) {
      const ids = dueRankings.map((row) => row.user_id);
      const members = await this.env.DB.prepare(
        `SELECT user_id, last_seen_at FROM workspace_members
          WHERE workspace_id = ? AND status = 'active'
            AND user_id IN (SELECT value FROM json_each(?))`,
      ).bind(workspaceId, JSON.stringify(ids)).all<{ user_id: string; last_seen_at: string | null }>();
      const lastSeen = new Map(members.results.map((row) => [row.user_id, epoch(row.last_seen_at)]));
      const dormantCutoff = now - 7 * 24 * 60 * 60_000;
      const activeCutoff = now - 15 * 60_000;
      const starvedCutoff = now - 30 * 60_000;
      const eligible = dueRankings
        .filter((row) => (lastSeen.get(row.user_id) ?? 0) > dormantCutoff)
        .sort((left, right) => {
          const leftUrgent = (lastSeen.get(left.user_id) ?? 0) > activeCutoff || left.due_at <= starvedCutoff;
          const rightUrgent = (lastSeen.get(right.user_id) ?? 0) > activeCutoff || right.due_at <= starvedCutoff;
          return Number(rightUrgent) - Number(leftUrgent) || left.due_at - right.due_at;
        });
      for (const row of eligible.slice(0, Math.max(0, PRODUCT_ALARM_BATCH - launched))) {
        const claim = product.claimRanking(row.user_id, row.request_seq, now);
        if (!claim) continue;
        const input = WorkspaceOpportunityWorkflowInputSchema.parse({
          kind: "ranking",
          region: this.env.AVALON_REGION,
          workspaceId,
          userId: claim.userId,
          requestSeq: claim.requestSeq,
          leaseId: claim.leaseId,
        });
        try {
          await this.env.WORK_OPPORTUNITY_WORKFLOW.create({
            id: `opportunity-ranking-${workspaceId}-${claim.userId}-${claim.requestSeq}`,
            params: input,
          });
        } catch (error) {
          if (!workflowAlreadyExists(error)) throw error;
        }
        launched += 1;
      }
    }
    // Suppressed when nothing launched: what is left is parked behind a
    // dormant member, and re-arming for an instant already past is the one way
    // this object turns into a polling loop.
    await this.refreshProductAlarm({ suppressPastDue: launched === 0 });
  }

  /**
   * Record and fan out a workspace-owned surface change. This RPC is called by
   * authenticated HTTP mutations and regional background consumers only; the
   * socket itself never lets a desktop manufacture an invalidation.
   */
  async publishSync(
    topics: WorkspaceSyncTopic[],
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const parsed = z.array(WorkspaceSyncTopicSchema).min(1).safeParse(topics);
    if (!parsed.success) throw new Error("invalid_workspace_sync_topics");
    const requested = new Set(parsed.data);
    const ordered = WORKSPACE_SYNC_TOPICS.filter((topic) => requested.has(topic));
    const occurredAtMs = Date.now();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const eventId = uuidV7(occurredAtMs);
    const waterline = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec<{ waterline: number }>(
        `INSERT INTO workspace_sync_events(event_id, topics_json, occurred_at)
         VALUES (?, ?, ?) RETURNING waterline`,
        eventId,
        JSON.stringify(ordered),
        occurredAtMs,
      ).one();
      this.state.storage.sql.exec(
        `DELETE FROM workspace_sync_events WHERE waterline <= ?`,
        row.waterline - 1_024,
      );
      return row.waterline;
    });
    const event = WorkspaceSocketSyncEventSchema.parse({
      type: "workspace_sync",
      eventId,
      waterline,
      occurredAt,
      topics: ordered,
      reason: "change",
    });
    const payload = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      try {
        socket.send(payload);
        socket.serializeAttachment({ ...attachment, lastWaterline: waterline });
      } catch {
        // The hibernation runtime owns close cleanup. A reconnect receives a
        // full invalidation or replays the bounded SQL log.
      }
    }
    return waterline;
  }

  /**
   * Re-evaluate one product flag for every connected person and send the full
   * client contract privately to each socket. The Queue/RPC wake-up carries no
   * value: Flagship remains authoritative, and two members of this workspace
   * may match different targeting rules.
   */
  async notifyProductFeatureFlagChanged(
    flagKey: ProductFeatureFlagKey,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const changedFlag = ProductFeatureFlagKeySchema.parse(flagKey);
    const socketsByUser = new Map<string, WebSocket[]>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      socketsByUser.set(attachment.userId, [
        ...(socketsByUser.get(attachment.userId) ?? []),
        socket,
      ]);
    }
    let sent = 0;
    await Promise.all([...socketsByUser].map(async ([userId, sockets]) => {
      const payload = JSON.stringify(WorkspaceFeatureFlagsEventSchema.parse({
        type: "workspace_feature_flags",
        occurredAt: new Date().toISOString(),
        changedFlag,
        flags: await resolveClientFeatureFlagsForSubject(this.env, { userId, workspaceId }),
      }));
      for (const socket of sockets) {
        try {
          socket.send(payload);
          sent += 1;
        } catch {
          // Hibernation owns cleanup; a reconnect gets a fresh evaluation.
        }
      }
    }));
    return sent;
  }

  /** Pin the workspace identity before any child object can be resolved. */
  async initializeWorkspace(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<void> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
  }

  /**
   * Re-derive the alarm after a typed method moved an outbox due time.
   *
   * `executeRuntimeSql` does this for any facade statement that writes an
   * alarm-source table; a typed method that writes `note_privacy_change_outbox`
   * or `note_resource_deletion_outbox` owes the alarm the same refresh, or the
   * pass those rows are due for never wakes.
   */
  protected refreshScheduleAfterWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      // Swallowed silently, a failed refresh here leaves a schedule dark until
      // something else reconciles; this line is how anyone finds out the
      // alarm's own end-of-drain backstop was needed.
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /**
   * Re-derive the workspace alarm after a typed write to an alarm-source
   * Slack table, exactly as `executeRuntimeSql` does for a generic statement
   * naming one — without it, a job admitted or a prompt retained through a
   * typed method would wait for an unrelated write to arm the alarm that
   * recovers or reaps it. Failures are logged and swallowed for the same
   * reason as there: the alarm's own end-of-drain refresh is the backstop.
   *
   * Callers gate this on an outcome that moved a row. `executeRuntimeSql` could
   * not: it keys on the table names in the SQL text and has no idea whether the
   * statement matched anything, so a losing claim or a stale settlement paid for
   * a full reconcile there. A typed method can see its own refusal, and a
   * refusal changed no due time. Read-only methods never call this at all, and
   * neither does `sweepSlackIngress` — see the comment on it for why.
   */
  protected refreshScheduleAfterSlackWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /**
   * Re-derive the workspace alarm after a memory write left an embedding
   * intent in `memory_index_outbox`.
   *
   * `memory_index_outbox` is on `WORKSPACE_ALARM_SOURCE_TABLES`, so while
   * these writes were generic statements `executeRuntimeSql` armed the
   * `memory_index` maintenance target for them. A typed method gets no such
   * thing for free, and without this a memory written into a quiet workspace
   * would sit unprojected until some unrelated mutation happened to reconcile
   * the schedule. Same `waitUntil`-and-log shape as there: the alarm's own
   * end-of-drain refresh is the backstop, and this line is how anyone finds
   * out the backstop was needed.
   *
   * The outbox claim, completion, and retry methods deliberately do not call
   * this. Their only caller is `processMemoryIndexOutbox`, reached only as the
   * `memory_index` maintenance target — inside this object's own alarm drain,
   * whose statements go through the local executor and never carried the
   * auto-refresh either. A reconcile started there would race the drain's own
   * `schedule_reconcile` with a target list read before the rest of the drain
   * advanced its rows.
   */
  protected refreshScheduleAfterMemoryOutboxWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /**
   * The alarm backstop the generic SQL path gives every `schedules` write.
   *
   * `executeRuntimeSql` re-arms the alarm whenever a routed statement mutates
   * an alarm-source table, because a generic writer has no request to hang the
   * reconcile off. The typed digest writers above would otherwise lose that
   * net: their callers all refresh explicitly today, but a future caller that
   * forgets would leave a schedule row dark until an unrelated wake.
   */
  protected refreshScheduleAfterDigestWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  protected async publishDirectorySync(workspaceId: string): Promise<void> {
    const placementAffinity = this.placementAffinity();
    if (!placementAffinity) throw new Error("workspace_object_placement_affinity_missing");
    await this.publishSync(["workstream_directory"], workspaceId, placementAffinity);
  }

  protected productStorage(): WorkspaceProductStorage {
    return new WorkspaceProductStorage(this.state.storage);
  }

  protected projectStorage(): WorkspaceProjectStorage {
    return new WorkspaceProjectStorage(this.state.storage);
  }

  protected async activeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return Boolean(await this.env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    ).bind(workspaceId, userId).first());
  }

  private reapExpiredActivityEvents(now: number): void {
    reapExpiredWorkspaceActivityEvents(this.state.storage, now);
  }

  /**
   * Point the product entry at the next opportunity window or ranking request.
   *
   * An entry rather than a derived timestamp because the answer depends on the
   * caller: an enqueue wants the instant even if it is already past, while the
   * alarm that launched nothing wants past-due rows left parked. A derived
   * source has no way to carry that distinction, and reading it the wrong way
   * turns a parked window into a wake every millisecond.
   */
  protected async refreshProductAlarm(options: { suppressPastDue?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const productDue = this.productStorage().nextProductAlarmAt(now, options.suppressPastDue === true);
    if (productDue === null) {
      await this.cancelScheduledAlarm(PRODUCT_ALARM_KIND, PRODUCT_ALARM_KEY);
      return;
    }
    await this.scheduleAlarm({
      kind: PRODUCT_ALARM_KIND,
      key: PRODUCT_ALARM_KEY,
      dueAt: Math.max(now + 1, productDue),
    });
  }

  protected assertWorkspace(workspaceId: string): void {
    if (this.workspaceId() !== workspaceId) throw new Error("workspace_object_identity_mismatch");
  }

  protected ensureIdentity(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): void {
    const existing = this.workspaceId();
    if (existing && existing !== workspaceId) throw new Error("workspace_object_identity_mismatch");
    const existingAffinity = this.placementAffinity();
    if (existing) {
      if (existingAffinity !== placementAffinity) {
        throw new Error("workspace_object_placement_affinity_mismatch");
      }
      return;
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      workspaceId,
      this.env.AVALON_REGION,
      placementAffinity,
      now,
      now,
    );
    removeLegacyAutomationSchema(this.state.storage);
    // A workspace born on the new build has no legacy authority to import. It
    // starts past the campaign fence; only carried objects require the
    // explicit audit/import/cleanup RPC before authoring is admitted.
    this.state.storage.sql.exec(
      `INSERT INTO automation_cutover_campaign
         (id, workspace_id, state, source_hash, source_witness_json,
          cursor_json, completed_at, updated_at)
       VALUES (1, ?, 'completed', 'fresh', '{}', '{}', ?, ?)`,
      workspaceId,
      now,
      now,
    );
  }

  protected workspaceId(): string | null {
    return this.state.storage.sql.exec<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.workspace_id ?? null;
  }

  /**
   * This object's own name in `WORKSPACE_DOS`, or `null` before it has one.
   *
   * Memoized because a workspace identity is written once and never changes,
   * and because this is read on every name resolution the object performs.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    let workspaceId: string | null;
    try {
      workspaceId = this.workspaceId();
    } catch {
      // First wake: the identity table does not exist until the constructor's
      // migrations have run, and nothing can address this object by name yet.
      return null;
    }
    if (workspaceId === null) return null;
    this.objectName = workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId));
    return this.objectName;
  }

  protected placementAffinity(): WorkspacePlacementAffinity | null {
    const value = this.state.storage.sql.exec<{ placement_affinity: string | null }>(
      `SELECT placement_affinity FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.placement_affinity;
    return isWorkspacePlacementAffinityForRegion(this.env.AVALON_REGION, value) ? value : null;
  }

  protected latestSyncWaterline(): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT COALESCE(MAX(waterline), 0) AS waterline FROM workspace_sync_events`,
    ).one().waterline;
  }
}
