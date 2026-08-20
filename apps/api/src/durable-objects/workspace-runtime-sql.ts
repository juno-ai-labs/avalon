import { z } from "zod";

const WorkspaceSqlValueSchema = z.union([z.string(), z.number(), z.null()]);

const WorkspaceSqlStatementSchema = z.object({
  sql: z.string().min(1).max(100_000),
  params: z.array(WorkspaceSqlValueSchema).max(500),
}).strict();

export const WorkspaceRuntimeSqlRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  requestId: z.string().uuid(),
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
): WorkspaceRuntimeSqlResult[] {
  const identity = first(storage.sql.exec<{ workspace_id: string }>(
    `SELECT workspace_id FROM workspace_identity WHERE id = 1`,
  ));
  if (!identity || identity.workspace_id !== request.workspaceId) {
    throw new Error("workspace_runtime_identity_mismatch");
  }

  return storage.transactionSync(() => request.statements.map((statement) => {
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
      changes: cursor.rowsWritten,
    };
  }));
}
