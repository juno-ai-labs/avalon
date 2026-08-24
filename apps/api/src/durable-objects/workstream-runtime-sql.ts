import { z } from "zod";

import { workstreamImportHash } from "./workstream-import-hash";
import type { WorkstreamObjectProductService } from "./workstream-object-product";

const RuntimeValueSchema = z.union([z.string(), z.number(), z.null()]);
const RuntimeStatementSchema = z.object({
  sql: z.string().min(1).max(100_000),
  params: z.array(RuntimeValueSchema).max(500),
}).strict();

export const WorkstreamRuntimeSqlRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
  harnessRunId: z.string().uuid().nullable().optional(),
  requestId: z.string().uuid(),
  statements: z.array(RuntimeStatementSchema).min(1).max(100),
}).strict();

export type WorkstreamRuntimeSqlRequest = z.infer<typeof WorkstreamRuntimeSqlRequestSchema>;

export interface WorkstreamRuntimeSqlResult {
  columns: string[];
  rows: Array<Record<string, string | number | null>>;
  changes: number;
}

const TABLE_REWRITES = [
  ["harness_run_lifecycle_events", "_runtime_run_lifecycle_events"],
  ["message_attachments", "_runtime_message_attachments"],
  ["message_mentions", "_runtime_message_mentions"],
  ["workstream_participants", "_runtime_workstream_participants"],
  ["users", "_runtime_users"],
  ["inference_attempts", "_runtime_inference_attempts"],
  ["harness_runs", "_runtime_harness_runs"],
  ["elicitations", "_runtime_elicitations"],
  ["messages", "_runtime_messages"],
  ["workstreams", "_runtime_workstreams"],
] as const;

function insertTarget(sql: string): string | null {
  return /^\s*INSERT(?:\s+OR\s+\w+)?\s+INTO\s+["`[]?([\w]+)["`\]]?/iu.exec(sql)?.[1]?.toLowerCase() ?? null;
}

function mutationTarget(sql: string): string | null {
  return insertTarget(sql)
    ?? /^\s*UPDATE\s+["`[]?([\w]+)["`\]]?/iu.exec(sql)?.[1]?.toLowerCase()
    ?? /^\s*DELETE\s+FROM\s+["`[]?([\w]+)["`\]]?/iu.exec(sql)?.[1]?.toLowerCase()
    ?? null;
}

function targetsRuntimeCompatibilityView(sql: string): boolean {
  const target = mutationTarget(sql);
  return TABLE_REWRITES.some(([, view]) => view === target);
}

function stripViewUpsert(sql: string): string {
  const conflictAt = sql.search(/\s+ON\s+CONFLICT(?:\s*\([^)]*\))?\s+DO\s+(?:NOTHING|UPDATE\s+SET)/iu);
  if (conflictAt < 0) return sql;
  const conflictTail = sql.slice(conflictAt);
  const returningAt = conflictTail.search(/\s+RETURNING\b/iu);
  return returningAt < 0
    ? sql.slice(0, conflictAt).trimEnd()
    : `${sql.slice(0, conflictAt).trimEnd()}${conflictTail.slice(returningAt)}`;
}

/**
 * Translate the legacy runtime table vocabulary to the normalized object-local
 * compatibility views. The views have INSTEAD OF triggers; no compatibility
 * table stores a second copy of product data.
 */
export function rewriteWorkstreamRuntimeSql(input: string): string {
  if (
    /^\s*UPDATE\s+workstreams\s+SET\s+next_sequence_number\s*=\s*next_sequence_number\s*\+\s*1\s*,\s*updated_at\s*=\s*\?/iu.test(input)
    && /RETURNING\s+next_sequence_number\s*-\s*1\s+AS\s+sequence_number\s*$/iu.test(input)
  ) {
    return `UPDATE workstream
               SET next_sequence_number = next_sequence_number + 1,
                   updated_at = CAST((julianday(?) - 2440587.5) * 86400000 AS INTEGER)
             WHERE workstream_key = ? AND parent_workspace_key = ?
             RETURNING next_sequence_number - 1 AS sequence_number`;
  }
  const insert = insertTarget(input);
  const insertsIntoCompatibilityView = TABLE_REWRITES.some(([legacy]) => legacy === insert);
  let sql = input;
  for (const [legacy, view] of TABLE_REWRITES) {
    sql = sql.replace(new RegExp(`\\b${legacy}\\b`, "giu"), view);
  }
  // SQLite does not implement UPSERT syntax on a view. Each compatibility
  // trigger applies the equivalent conflict policy to its normalized table.
  return insertsIntoCompatibilityView ? stripViewUpsert(sql) : sql;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

function assertionHash(request: WorkstreamRuntimeSqlRequest): string {
  return workstreamImportHash({
    workspaceId: request.workspaceId,
    workstreamId: request.workstreamId,
    statements: request.statements,
  });
}

/** Execute one Workflow step atomically inside the owning WorkstreamDO. */
export async function executeWorkstreamRuntimeSql(
  storage: DurableObjectStorage,
  product: WorkstreamObjectProductService,
  request: WorkstreamRuntimeSqlRequest,
): Promise<{ requestHash: string; results: WorkstreamRuntimeSqlResult[] }> {
  const identity = first(storage.sql.exec<{
    workstream_key: string;
    parent_workspace_key: string;
    authority_mode: string;
  }>(
    `SELECT workstream_key, parent_workspace_key, authority_mode FROM workstream WHERE id = 1`,
  ));
  if (
    !identity
    || identity.workstream_key !== request.workstreamId
    || identity.parent_workspace_key !== request.workspaceId
  ) throw new Error("workstream_runtime_identity_mismatch");
  if (identity.authority_mode !== "authoritative") {
    throw new Error("workstream_runtime_authority_fenced");
  }

  // `workstream_wakeups` is deliberately not in this pattern any more. Wake-ups
  // reach the object through `/internal/scheduling`, which runs its mutating
  // operations inside `commitRuntimeMutation` itself, so a wake-up's directory
  // effect is published where the wake-up is written. Leaving the name here
  // would be a rule for statements that can no longer arrive.
  const affectsDirectory = request.statements.some((statement) =>
    /\b(?:workstreams|messages|workstream_participants)\b/iu
      .test(statement.sql));
  const committed = await product.commitRuntimeMutation(
    (sql) => {
      const results: WorkstreamRuntimeSqlResult[] = [];
      for (const statement of request.statements) {
        sql.exec(`UPDATE _runtime_statement_changes SET changes = 0 WHERE id = 1`);
        const rewrittenSql = rewriteWorkstreamRuntimeSql(statement.sql);
        let cursor: SqlStorageCursor<Record<string, SqlStorageValue>>;
        try {
          cursor = sql.exec<Record<string, SqlStorageValue>>(
            rewrittenSql,
            ...statement.params,
          );
        } catch (error) {
          // The statement is the diagnosis. Without it, a rewrite or compat-view
          // defect surfaces as a bare SQLite error with no way to tell which of
          // a batch's statements — or whose SQL — produced it.
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `workstream_runtime_statement_failed: ${reason} :: ${statement.sql.slice(0, 300)}`,
            { cause: error },
          );
        }
        const rows = cursor.toArray() as Array<Record<string, string | number | null>>;
        const counted = first(sql.exec<{ changes: number }>(
          `SELECT changes FROM _runtime_statement_changes WHERE id = 1`,
        ))?.changes ?? 0;
        // workerd's cursor counts every row an INSTEAD OF trigger touched,
        // including the bookkeeping row and projections. The compatibility
        // trigger's explicit counter records the legacy statement's semantic
        // effect and is therefore authoritative for view mutations. Direct
        // normalized-table statements have no such counter and keep the native
        // row count.
        const changes = targetsRuntimeCompatibilityView(rewrittenSql)
          ? counted
          : Math.max(cursor.rowsWritten, counted);
        results.push({
          columns: rows.length === 0 ? [] : Object.keys(rows[0]!),
          rows,
          changes,
        });
      }
      return results;
    },
    affectsDirectory,
  );
  return { requestHash: assertionHash(request), results: committed };
}
