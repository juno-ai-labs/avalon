import { IdSchema, WorkspaceIdSchema, asWorkspaceId } from "@rally/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { assertDurableObjectJurisdiction, durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { parseRpcInput } from "../lib/rpc-input";
import { logInfo } from "../observability/logger";
import { ReceiveChildEffectsRequestSchema, type ReceiveChildEffectsRequest } from "./conversation-parent-object";
import { WORKSTREAM_ROLE, type LegacyParentRole } from "./conversation-parent-role";
import {
  LEGACY_PARENT_EXPORT_TABLES,
  LegacyParentExportSchema,
  type LegacyParentExport,
  type LegacyRow,
} from "./hosted-parent-import";
import { InternallyInspectableDurableObject } from "./internally-inspectable-durable-object";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import { workspaceDOName, workstreamDOName } from "./names";
import { applyDurableObjectSqliteMigrations } from "./sqlite-migrations";

export { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "./workstream-do-schema";
export { workstreamDOName };

/** The close code that tells a control socket to reconnect: the object restarted as something else. */
const PARENT_MOVED_CLOSE_CODE = 1012;

const ExportRequestSchema = z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema });

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * A Channel's legacy parent object, kept deployed only so its rows can move.
 *
 * Channel and Space parents now live in the Organization's `WorkspaceDO`
 * (`docs/hosted-conversation-parents.md`). What is left here is what the move
 * needs and nothing else:
 *
 * - `exportParentState` hands every row to the Organization object and freezes
 *   this one, in one transaction. A second call returns the same rows.
 * - `receiveChildEffects` forwards to the Organization object, for a Queue
 *   message an older consumer addressed here during the rollout.
 * - Fleet operations — the migration tracker's forced wake and engineering
 *   inspection — keep working, because they are how an operator confirms the
 *   move finished.
 *
 * Nothing here writes a product row. Once every Organization reports no
 * pending import, a follow-up change deletes this class.
 */
export class WorkstreamDO extends InternallyInspectableDurableObject<Env> {
  private readonly initialized: Promise<void>;
  /** True for an object that never held a parent: no schema, nothing to export. */
  private empty = false;

  constructor(
    state: DurableObjectState,
    env: Env,
    protected readonly role: LegacyParentRole = WORKSTREAM_ROLE,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.initialized = this.initializeDurableObject(async () => {
      // An object nobody ever created is asked for its rows when a parent id
      // the Organization knew was never provisioned. Applying the ledger would
      // turn that question into a stored object; it has nothing to say either way.
      this.empty = state.storage.sql.exec(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_sql_schema_migrations'",
      ).toArray().length === 0;
      if (this.empty) return;
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: role.migration.migrations,
        component: role.migration.component,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
    });
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return { ...this.role.migration };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  /**
   * Every row this parent holds, and the freeze that makes it the last copy.
   *
   * One transaction: the moved marker and the read commit together, so there is
   * no moment in which a row exists here that the export did not carry. The
   * sockets close with a code the clients reconnect on, to the route that now
   * reaches the Organization object.
   */
  async exportParentState(input: z.infer<typeof ExportRequestSchema>): Promise<LegacyParentExport> {
    await this.initialized;
    const request = parseRpcInput(ExportRequestSchema, input, "export_parent_state");
    if (this.empty) return LegacyParentExportSchema.parse({ found: false, parentId: null, tables: {} });
    const sql = this.ctx.storage.sql;
    const exported = this.ctx.storage.transactionSync(() => {
      const metadata = sql.exec<{ workspace_id: string; workstream_id: string }>(
        "SELECT workspace_id, workstream_id FROM workstream_metadata WHERE id = 1",
      ).toArray()[0];
      if (metadata && (metadata.workspace_id !== request.workspaceId || metadata.workstream_id !== request.parentId)) {
        throw new Error("parent_export_identity_mismatch");
      }
      sql.exec(
        `INSERT OR IGNORE INTO parent_authority_moved (id, workspace_id, parent_id, moved_at) VALUES (1, ?, ?, ?)`,
        request.workspaceId, request.parentId, Date.now(),
      );
      const present = new Set(sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      ).toArray().map((row) => row.name));
      const tables: Record<string, LegacyRow[]> = {};
      for (const table of LEGACY_PARENT_EXPORT_TABLES) {
        if (!present.has(table)) continue;
        tables[table] = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM ${table}`).toArray()
          .map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [
            column,
            value instanceof ArrayBuffer ? null : value,
          ])));
      }
      return { found: metadata !== undefined, parentId: metadata?.workstream_id ?? null, tables };
    });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(PARENT_MOVED_CLOSE_CODE, "This conversation moved; reconnect");
      } catch {
        // Already closing.
      }
    }
    await this.ctx.storage.deleteAlarm();
    logInfo(this.env, "legacy_parent_exported", {
      workspace_id: request.workspaceId,
      parent_id: request.parentId,
      parent_kind: this.role.kind,
      found: exported.found,
      rows: Object.values(exported.tables).reduce((total, rows) => total + rows.length, 0),
    });
    return LegacyParentExportSchema.parse(exported);
  }

  /** A child effect an older consumer sent here goes to the Organization object that hosts this parent. */
  async receiveChildEffects(input: ReceiveChildEffectsRequest): Promise<{ accepted: { messageId: string; payloadHash: string }[] }> {
    await this.initialized;
    const request = parseRpcInput(ReceiveChildEffectsRequestSchema, input, "receive_child_effects");
    const envelope = request.envelopes[0];
    if (!envelope) throw new Error("conversation_effects_empty");
    const workspace = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, envelope.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(envelope.workspaceId)));
    return workspace.receiveChildEffects(request);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, role: `${this.role.kind}-legacy`, databaseBytes: this.ctx.storage.sql.databaseSize });
    }
    // Every other door moved to the Organization object, including the
    // control socket. A 410 tells a caller that reached this by an old route
    // that asking again here will never work.
    return json({ error: "conversation_parent_moved" }, 410);
  }

  override webSocketMessage(socket: WebSocket): void {
    socket.close(PARENT_MOVED_CLOSE_CODE, "This conversation moved; reconnect");
  }

  override webSocketClose(): void {
    // Nothing is held for a socket here any more.
  }

  override webSocketError(): void {
    // The client reconnects to the Organization object.
  }

  /** An alarm armed before the move has nothing left to do. */
  override async alarm(): Promise<void> {
    await this.initialized;
  }
}
