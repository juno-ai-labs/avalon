import { z } from "zod";

import { workstreamRoomName } from "../durable-objects/workstream-room";
import type { WorkstreamRuntimeSqlResult } from "../durable-objects/workstream-runtime-sql";
import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import { readWorkstreamAuthorityControl } from "./workstream-authority";

type RuntimeValue = string | number | null;

const REGIONAL_DATABASE = Symbol("workstream-regional-database");

interface BoundStatement {
  sql: string;
  params: RuntimeValue[];
  local: boolean;
}

const responseSchema = z.object({
  results: z.array(z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    changes: z.number().int().nonnegative(),
  })),
});

const LOCAL_TABLES = [
  "workstream_sandboxes",
  "sandbox_tasks",
  "sandbox_imported_resources",
  "terminal_publication_grants",
  "workstream_terminal_repositories",
  "repository_publications",
  "workstream_participants",
  "harness_runs",
  "harness_run_scopes",
  "harness_run_memory_contexts",
  "harness_run_plugin_activations",
  "harness_run_lifecycle_events",
  "inference_attempts",
  "attachment_tool_receipts",
  "message_attachments",
  "message_mentions",
  "messages",
  "workstreams",
  "tool_invocations",
  "tool_invocation_checkpoints",
  "elicitations",
  "workstream_context_compactions",
  "workstream_wakeups",
  "workstream_plugin_activation_hints",
  "workstream_resource_inventory_revisions",
  "workstream_description_refreshes",
  "hypersight_configuration_versions",
  "hypersight_user_preferences",
  "workstream_resources",
  "hypersight_block_runs",
] as const;

function localStatement(sql: string): boolean {
  return LOCAL_TABLES.some((table) => new RegExp(`\\b${table}\\b`, "iu").test(sql));
}

function d1Result<T>(result: WorkstreamRuntimeSqlResult): D1Result<T> {
  return {
    success: true,
    results: result.rows as T[],
    meta: {
      changes: result.changes,
      duration: 0,
      last_row_id: 0,
      rows_read: result.rows.length,
      rows_written: result.changes,
      changed_db: result.changes > 0,
      size_after: 0,
    },
  } as D1Result<T>;
}

class WorkstreamRuntimePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: WorkstreamRuntimeDatabase,
    readonly statement: BoundStatement,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const params = values.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      throw new Error("workstream_runtime_bind_value_unsupported");
    });
    return new WorkstreamRuntimePreparedStatement(
      this.database,
      { ...this.statement, params },
    );
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const result = await this.database.execute(this.statement);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result<T>(await this.database.execute(this.statement));
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return d1Result<T>(await this.database.execute(this.statement));
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const result = await this.database.execute(this.statement);
    const values = result.rows.map((row) => result.columns.map((column) => row[column]));
    return options?.columnNames
      ? [result.columns, ...values as T[]]
      : values as T[];
  }
}

class WorkstreamRuntimeDatabase implements D1Database {
  constructor(
    private readonly env: Env,
    private readonly workspaceId: string,
    private readonly workstreamId: string,
  ) {}

  prepare(sql: string): D1PreparedStatement {
    return new WorkstreamRuntimePreparedStatement(this, {
      sql,
      params: [],
      local: localStatement(sql),
    });
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const bound = statements.map((statement) => {
      if (!(statement instanceof WorkstreamRuntimePreparedStatement)) {
        throw new Error("workstream_runtime_foreign_statement");
      }
      return statement.statement;
    });
    const localCount = bound.filter((statement) => statement.local).length;
    if (localCount !== 0 && localCount !== bound.length) {
      throw new Error("workstream_runtime_cross_authority_transaction");
    }
    if (localCount === 0) {
      return this.env.DB.batch(bound.map((statement) =>
        this.env.DB.prepare(statement.sql).bind(...statement.params))) as Promise<D1Result<T>[]>;
    }
    return (await this.executeLocal(bound)).map((result) => d1Result<T>(result));
  }

  async execute(statement: BoundStatement): Promise<WorkstreamRuntimeSqlResult> {
    if (!statement.local) {
      const result = await this.env.DB.prepare(statement.sql).bind(...statement.params).all();
      return {
        columns: result.results.length === 0 ? [] : Object.keys(result.results[0] as object),
        rows: result.results as Array<Record<string, string | number | null>>,
        changes: Number(result.meta.changes ?? 0),
      };
    }
    const [result] = await this.executeLocal([statement]);
    if (!result) throw new Error("workstream_runtime_result_missing");
    return result;
  }

  private async executeLocal(statements: BoundStatement[]): Promise<WorkstreamRuntimeSqlResult[]> {
    const namespace = durableObjectNamespaceForRegion(
      this.env.WORKSTREAM_ROOMS,
      this.env.AVALON_REGION,
      this.env.APP_ENV,
    );
    const stub = namespace.get(namespace.idFromName(workstreamRoomName(
      this.env.AVALON_REGION,
      this.workspaceId,
      this.workstreamId,
    )));
    const response = await stub.fetch("https://workstream-object/internal/runtime-sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: this.workspaceId,
        workstreamId: this.workstreamId,
        requestId: crypto.randomUUID(),
        statements: statements.map(({ sql, params }) => ({ sql, params })),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : "workstream_runtime_sql_failed");
    }
    return responseSchema.parse(await response.json()).results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    const statements = query.split(";").map((entry) => entry.trim()).filter(Boolean);
    const results = await Promise.all(statements.map((sql) => this.execute({
      sql,
      params: [],
      local: localStatement(sql),
    })));
    return {
      count: results.length,
      duration: 0,
    } as D1ExecResult;
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("workstream_runtime_dump_unsupported"));
  }

  withSession(): D1DatabaseSession {
    throw new Error("workstream_runtime_sessions_unsupported");
  }
}

/** D1-compatible router: local work-stream SQL goes to its DO, regional SQL stays in D1. */
export function workstreamRuntimeDatabase(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): D1Database {
  return new WorkstreamRuntimeDatabase(env, workspaceId, workstreamId);
}

/** Preserve every Worker binding while substituting the runtime database port. */
export function withWorkstreamRuntimeDatabase(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Env {
  const database = workstreamRuntimeDatabase(env, workspaceId, workstreamId);
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "DB") return database;
      if (property === REGIONAL_DATABASE) return target.DB;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/** Use object-local SQL only after the regional cutover fence is open. */
export async function workstreamExecutionEnvironment(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<Env> {
  const authority = await readWorkstreamAuthorityControl(env);
  return authority.phase === "durable_object_open"
    ? withWorkstreamRuntimeDatabase(env, workspaceId, workstreamId)
    : env;
}

/**
 * Reserve the regional identity/routing anchor and open an empty normalized
 * object for a system producer that will populate it through the runtime SQL
 * compatibility port.
 */
export async function bootstrapWorkstreamRuntimeEnvironment(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<Env> {
  const authority = await readWorkstreamAuthorityControl(env);
  if (authority.phase !== "durable_object_open") return env;
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO workstreams
         (id, workspace_id, title, objective, origin_type, created_by_user_id,
          harness_status, next_sequence_number, last_activity_at, created_at,
          updated_at, do_identity_anchor)
       VALUES (?, ?, ?, '', 'ad_hoc', NULL, 'idle', 1, ?, ?, ?, 1)`,
    ).bind(workstreamId, workspaceId, `[WorkstreamDO] ${workstreamId}`, at, at, at),
    env.DB.prepare(
      `INSERT OR IGNORE INTO workstream_authority_routes
         (workspace_id, workstream_id, generation, object_name, state, stage_index,
          source_cursor, source_fence_sequence, source_hash, target_hash,
          row_counts_json, imported_at, verified_at, activated_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0, 0, 'created_in_do', 'created_in_do',
               '{}', ?, ?, ?, ?)`,
    ).bind(
      workspaceId,
      workstreamId,
      authority.generation,
      `${env.AVALON_REGION}:${workspaceId}:${workstreamId}`,
      at,
      at,
      at,
      at,
    ),
  ]);
  const namespace = durableObjectNamespaceForRegion(
    env.WORKSTREAM_ROOMS,
    env.AVALON_REGION,
    env.APP_ENV,
  );
  const stub = namespace.get(namespace.idFromName(workstreamRoomName(
    env.AVALON_REGION,
    workspaceId,
    workstreamId,
  )));
  const response = await stub.fetch("https://workstream-object/internal/runtime-bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId, workstreamId, generation: authority.generation }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "workstream_runtime_bootstrap_failed");
  }
  return withWorkstreamRuntimeDatabase(env, workspaceId, workstreamId);
}

/** Escape hatch for an explicitly regional half of a cross-authority operation. */
export function regionalDatabase(env: Env): D1Database {
  return (env as Env & { [REGIONAL_DATABASE]?: D1Database })[REGIONAL_DATABASE] ?? env.DB;
}

export const __workstreamRuntimeDatabaseTesting = { localStatement };
