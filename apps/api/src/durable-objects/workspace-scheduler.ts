/**
 * The workspace scheduler, after its work moved into WorkspaceDO.
 *
 * This object used to own one alarm per workspace and everything behind it:
 * due schedules, resource watches, maintenance sweeps, Terminal deadlines. All
 * of that now runs in WorkspaceDO — the object that already owns every table
 * those targets live in — through `_internal_durable_alarms` and the shared base in
 * `scheduled-alarms.ts`. See `docs/durable-object-alarms.md`.
 *
 * The class remains for exactly one reason: **objects deployed before that
 * change still have alarms armed.** A Durable Object class cannot be deleted
 * without a Wrangler `deleted_classes` migration, and deleting it while alarms
 * are pending would discard them — every workspace whose next automation was
 * armed here would silently stop firing. So each surviving alarm fires once
 * more, hands its workspace to WorkspaceDO to reconcile, and clears itself.
 * Once the fleet has drained, this class and its `WORKSPACE_SCHEDULERS`
 * binding can go in a change that does nothing else.
 *
 * `refresh` is kept on the same signature for the same reason: a Worker
 * mid-deploy may still hold a stub to it.
 */
import { IdSchema, WorkspaceIdSchema, asWorkspaceId, type WorkspaceId } from "@avalon/contracts";
import { z } from "zod";
import { DurableObject } from "cloudflare:workers";

import type { Env } from "../env";
import {
  assertDurableObjectJurisdiction,
  durableObjectStubForWorkspace,
} from "../lib/durable-object-namespace";
import { logStructuredEvent } from "../observability/logger";
import { workspaceDOName } from "./names";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import { latestMigrationVersion, withMigrationReport } from "./migration-reporting";

const RefreshRequestSchema = z.object({ workspaceId: IdSchema });

/**
 * Unchanged, and unchangeable: every deployed object's `_sql_schema_migrations`
 * holds a hash of these exact statements. The tables they create are no longer
 * read for scheduling — only `workspace_scheduler_state`, to learn which
 * workspace a surviving alarm belongs to.
 */
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
  ],
}];

export function workspaceSchedulerName(
  region: "global" | "eu",
  workspaceId: string
): string {
  return `${region}:${workspaceId}`;
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
const MIGRATION_COMPONENT = "workspace_scheduler";

function responseJson(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

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
      await withMigrationReport({
        state,
        env,
        component: MIGRATION_COMPONENT,
        className: "WorkspaceScheduler",
        latestVersion: latestMigrationVersion(WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS),
      }, () => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_SCHEDULER_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
    });
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
        return responseJson(await this.refresh(parsed.data.workspaceId));
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

  /** Hand the request to the object that now owns the workspace's alarm. */
  async refresh(workspaceId: string): Promise<{ alarmAt: string | null }> {
    await this.initialized;
    const parsedWorkspaceId = WorkspaceIdSchema.parse(workspaceId);
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
    return this.forward(parsedWorkspaceId);
  }

  /**
   * The last thing a surviving alarm does.
   *
   * Reconcile first, then drop this object's alarm and its retry gates. If the
   * forward throws, the alarm is deliberately left armed: the Durable Objects
   * runtime retries a throwing handler, and a workspace that failed to hand
   * over is one whose schedule would otherwise stop here.
   */
  override async alarm(): Promise<void> {
    await this.initialized;
    const workspaceId = this.workspaceId();
    if (!workspaceId) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const result = await this.forward(workspaceId);
    logStructuredEvent(this.env, "info", "workspace_scheduler_alarm_handed_over", {
      workspace_id: workspaceId,
      alarm_at: result.alarmAt,
    });
    this.state.storage.sql.exec(`DELETE FROM scheduler_retry_states`);
    await this.state.storage.deleteAlarm();
  }

  private async forward(workspaceId: WorkspaceId): Promise<{ alarmAt: string | null }> {
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      workspaceId,
      workspaceDOName(this.env.AVALON_REGION, workspaceId),
    );
    return workspace.refreshSchedule(workspaceId);
  }

  private workspaceId(): WorkspaceId | null {
    const stored = this.state.storage.sql.exec<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_scheduler_state WHERE id = 1`,
    ).toArray()[0]?.workspace_id ?? null;
    return stored === null ? null : asWorkspaceId(stored);
  }
}
