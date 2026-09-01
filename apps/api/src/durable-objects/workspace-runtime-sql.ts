import { STRICT_UUID_PATTERN } from "@rally/contracts/uuid-validation";
import { z } from "zod/v3";

const WorkspaceSqlValueSchema = z.union([z.string(), z.number().finite(), z.null()]);

const WorkspaceSqlStatementSchema = z.object({
  sql: z.string().min(1).max(100_000),
  params: z.array(WorkspaceSqlValueSchema).max(500),
}).strict();

export const WorkspaceRuntimeSqlRequestSchema = z.object({
  workspaceId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  requestId: z.string().regex(STRICT_UUID_PATTERN, "Invalid UUID"),
  statements: z.array(WorkspaceSqlStatementSchema).min(1).max(100),
}).strict();

export type WorkspaceRuntimeSqlRequest = z.infer<typeof WorkspaceRuntimeSqlRequestSchema>;

export interface WorkspaceRuntimeSqlResult {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  changes: number;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

/**
 * Execute one trusted Worker operation atomically in the owning WorkspaceDO.
 *
 * The public surface is typed native RPC. SQL never crosses a client or
 * connector boundary; it is the compatibility port used while the existing
 * regional repositories are moved behind object-local authority.
 */
export function executeWorkspaceRuntimeSql(
  storage: DurableObjectStorage,
  request: WorkspaceRuntimeSqlRequest,
  /**
   * Sidebar lists whose counter this batch advances, in the same transaction
   * as the write that earns it.
   *
   * Same transaction rather than after it, because a counter that can lag its
   * own write is worse than no counter: the next push would carry a version
   * the client has already applied and be dropped as a duplicate, losing a
   * real change silently.
   */
  advanceSidebarLists: readonly string[] = [],
): WorkspaceRuntimeSqlResult[] {
  const identity = first(storage.sql.exec<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_identity WHERE id = 1`,
  ));
  if (!identity || identity.workspace_id !== request.workspaceId) {
    throw new Error("workspace_runtime_identity_mismatch");
  }

  return storage.transactionSync(() => {
    const results = request.statements.map((statement) => {
      let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
      try {
        cursor = storage.sql.exec<Record<string, SqlStorageValue>>(
          statement.sql,
          ...statement.params,
        );
      } catch (error) {
        // The statement is the diagnosis: a SQLite limit or schema defect
        // surfaces here as a bare error with no way to tell whose SQL — the
        // workstream-side executor learned this during the transcript-routing
        // incident, and this one produced an anonymous "too many terms in
        // compound SELECT" the same week.
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `workspace_runtime_statement_failed: ${reason} :: ${statement.sql.slice(0, 300)}`,
          { cause: error },
        );
      }
      const rows = cursor.toArray() as Array<Record<string, string | number | null>>;
      return {
        columns: rows.length === 0 ? [] : Object.keys(rows[0]!),
        rows,
        // This intentionally preserves workerd's physical-write metric. It is
        // not SQLite's logical `changes()` count: index and trigger writes can
        // make one row report more than one. Callers that need a mutation
        // outcome use RETURNING or a typed object port; see
        // docs/durable-object-sqlite.md.
        changes: cursor.rowsWritten,
      };
    });
    for (const list of new Set(advanceSidebarLists)) {
      storage.sql.exec(
        `UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = ?`,
        list,
      );
    }
    return results;
  });
}
