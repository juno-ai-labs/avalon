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
    const cursor = storage.sql.exec<Record<string, SqlStorageValue>>(
      statement.sql,
      ...statement.params,
    );
    const rows = cursor.toArray().map((row) => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value]),
    ) as Record<string, string | number | null>);
    return {
      columns: rows.length === 0 ? [] : Object.keys(rows[0]!),
      rows,
      changes: cursor.rowsWritten,
    };
  }));
}
