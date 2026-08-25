import { z } from "zod";

import { substreamAgentName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import type { WorkstreamRuntimeSqlResult } from "../durable-objects/workstream-runtime-sql";
import { asSubstreamId, asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { splitSqlStatements } from "../lib/sql-statements";
import { uuidV7 } from "../lib/uuid-v7";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { createIdentityObjectPort } from "../runtime/identity-port";
import type { WorkstreamProvisionInput } from "../durable-objects/workstream-identity-storage";

type RuntimeValue = string | number | null;

const REGIONAL_DATABASE = Symbol("workstream-regional-database");
/**
 * Local executors carried on the environment, keyed by substream.
 *
 * A `SubstreamAgent` hands its own storage in as an executor so its SQL never
 * leaves the object. Without this the very next helper to re-derive an
 * execution environment from that one — `launchWorkstreamHarness`, the flag
 * targeting loader, digest settlement — would build a port with no executor and
 * send every statement back through the namespace into the object that issued
 * it. See `lib/durable-object-self.ts` for the general defect.
 */
const LOCAL_EXECUTORS = Symbol("workstream-local-executors");

type LocalExecutorRegistry = ReadonlyMap<string, LocalStatementExecutor>;

function executorKey(workspaceId: string, workstreamId: string, substreamId: string): string {
  return `${workspaceId}:${workstreamId}:${substreamId}`;
}

function carriedExecutors(env: Env): LocalExecutorRegistry {
  return (env as Env & { [LOCAL_EXECUTORS]?: LocalExecutorRegistry })[LOCAL_EXECUTORS]
    ?? new Map();
}

interface BoundStatement {
  sql: string;
  params: RuntimeValue[];
  local: boolean;
}

type LocalStatementExecutor = (
  statements: Array<{ sql: string; params: RuntimeValue[] }>,
) => Promise<WorkstreamRuntimeSqlResult[]>;

const responseSchema = z.object({
  results: z.array(z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    changes: z.number().int().nonnegative(),
  })),
});

const LOCAL_TABLES = [
  "workstream_participants",
  "harness_runs",
  "runs",
  "run_steering",
  "inference_attempts",
  "message_attachments",
  "message_mentions",
  "messages",
  "workstreams",
  "elicitations",
  // The object's own receipt table, not a legacy name: when migration 17
  // retired `tool_invocations` from this list, the dev seed moved to writing
  // `tool_effects` directly — and a statement naming only that table fell
  // through to regional D1, which has not held product tables since 0090.
  // Production readers reach it by also naming `harness_runs`; the entry is
  // what routes a statement that names it alone.
  "tool_effects",
] as const;

const LOCAL_TABLE_PATTERNS = LOCAL_TABLES.map((table) =>
  new RegExp(`\\b(?:FROM|JOIN|UPDATE|INTO)\\s+["\u0060\\[]?${table}\\b`, "iu"));
const LOCAL_TABLE_SET = new Set<string>(LOCAL_TABLES);

function mutationTarget(sql: string): string | null {
  return /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?([\w]+)["`\]]?/iu
    .exec(sql)?.[1]?.toLowerCase() ?? null;
}

/**
 * True when the statement names a table the work-stream object owns, in FROM,
 * JOIN, or write position.
 *
 * Exported for the workspace router: a statement that touches work-stream
 * authority must reach this layer even when it also names workspace tables,
 * because only the work-stream object holds compat views (`_runtime_users`,
 * `_runtime_resources`) for the tables it does not own. The workspace object
 * holds no such views for work-stream tables, so the same statement there is
 * a guaranteed `no such table`.
 */
export function referencesWorkstreamAuthorityTable(sql: string): boolean {
  return LOCAL_TABLE_PATTERNS.some((pattern) => pattern.test(sql));
}

function localStatement(sql: string): boolean {
  const mentionsLocalTable = referencesWorkstreamAuthorityTable(sql);
  const target = mutationTarget(sql);
  if (mentionsLocalTable && target && !LOCAL_TABLE_SET.has(target)) {
    throw new Error("workstream_runtime_cross_authority_statement");
  }
  return mentionsLocalTable;
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
    private readonly substreamId = "0",
    private readonly localExecutor?: LocalStatementExecutor,
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
    if (this.localExecutor) {
      return this.localExecutor(statements.map(({ sql, params }) => ({ sql, params })));
    }
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      this.workspaceId,
      substreamAgentName(
        this.env.AVALON_REGION,
        asWorkspaceId(this.workspaceId),
        asWorkstreamId(this.workstreamId),
        asSubstreamId(this.substreamId),
      ),
    );
    const response = await stub.executeRuntimeSql({
      workspaceId: this.workspaceId,
      workstreamId: this.workstreamId,
      requestId: uuidV7(),
      statements: statements.map(({ sql, params }) => ({ sql, params })),
    });
    if (response.status < 200 || response.status >= 300) {
      const body = rpcResultBody(response) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : "workstream_runtime_sql_failed");
    }
    return responseSchema.parse(rpcResultBody(response)).results;
  }

  async exec(query: string): Promise<D1ExecResult> {
    const statements = splitSqlStatements(query).map((sql) => ({
      sql,
      params: [] as RuntimeValue[],
      local: localStatement(sql),
    }));
    const localCount = statements.filter((statement) => statement.local).length;
    if (localCount !== 0 && localCount !== statements.length) {
      throw new Error("workstream_runtime_cross_authority_transaction");
    }
    if (localCount === 0) return this.env.DB.exec(query);
    await this.executeLocal(statements);
    return { count: statements.length, duration: 0 } as D1ExecResult;
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
  substreamId = "0",
  localExecutor?: LocalStatementExecutor,
): D1Database {
  return new WorkstreamRuntimeDatabase(env, workspaceId, workstreamId, substreamId, localExecutor);
}

/** Preserve every Worker binding while substituting the runtime database port. */
export function withWorkstreamRuntimeDatabase(
  env: Env,
  workspaceId: string,
  workstreamId: string,
  substreamId = "0",
  localExecutor?: LocalStatementExecutor,
): Env {
  const inherited = carriedExecutors(env);
  const key = executorKey(workspaceId, workstreamId, substreamId);
  const executor = localExecutor ?? inherited.get(key);
  const database = workstreamRuntimeDatabase(
    env,
    workspaceId,
    workstreamId,
    substreamId,
    executor,
  );
  const carried: LocalExecutorRegistry = localExecutor
    ? new Map(inherited).set(key, localExecutor)
    : inherited;
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "DB") return database;
      if (property === REGIONAL_DATABASE) return target.DB;
      if (property === LOCAL_EXECUTORS) return carried;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
}

/**
 * Route this work stream's SQL at its own object.
 *
 * Still async, and still separate from `withWorkstreamRuntimeDatabase`: callers
 * await an execution environment, and the two are not interchangeable at a call
 * site that also bootstraps.
 */
export async function workstreamExecutionEnvironment(
  env: Env,
  workspaceId: string,
  workstreamId: string,
): Promise<Env> {
  return withWorkstreamRuntimeDatabase(env, workspaceId, workstreamId);
}

/**
 * Build the regional work-stream identity insert for the schema currently
 * deployed in this region.
 *
 * Migration 0090 is intentionally Worker-first: a destructive D1 migration
 * cannot run under the previous Worker, while the replacement Worker must
 * still be able to create work streams before both regions finish applying
 * the drop. Through 0089 the anchor table has required product columns; after
 * 0090 it has only the three routing columns. The values supplied to the old
 * shape are inert placeholders and are never read as product state.
 */
function finalRegionalWorkstreamAnchorStatement(
  env: Pick<Env, "DB">,
  workspaceId: string,
  workstreamId: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO workstreams (id, workspace_id, do_identity_anchor)
     VALUES (?, ?, 1)
     ON CONFLICT(id) DO NOTHING`,
  ).bind(workstreamId, workspaceId);
}

async function regionalWorkstreamAnchorStatement(
  env: Pick<Env, "DB">,
  workspaceId: string,
  workstreamId: string,
  at: string,
): Promise<{ legacyShape: boolean; statement: D1PreparedStatement }> {
  const legacyShape = await env.DB.prepare(
    `SELECT 1 AS legacy FROM pragma_table_info('workstreams')
      WHERE name = 'title' LIMIT 1`,
  ).first<{ legacy: number }>();
  if (!legacyShape) {
    return {
      legacyShape: false,
      statement: finalRegionalWorkstreamAnchorStatement(env, workspaceId, workstreamId),
    };
  }
  return {
    legacyShape: true,
    statement: env.DB.prepare(
      `INSERT INTO workstreams
         (id, workspace_id, title, objective, origin_type, harness_status,
          next_sequence_number, last_activity_at, created_at, updated_at,
          do_identity_anchor)
       VALUES (?, ?, ?, '', 'ad_hoc', 'idle', 1, ?, ?, ?, 1)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      workstreamId,
      workspaceId,
      `[WorkstreamDO] ${workstreamId}`,
      at,
      at,
      at,
    ),
  };
}

/**
 * Commit an anchor with related route statements across the 0090 rollout.
 * D1 serializes each query, not the schema probe and the later batch together,
 * so 0090 may commit between them. In that one race the legacy insert is
 * re-prepared against the final shape and retried; every other error propagates.
 */
export async function writeRegionalWorkstreamAnchorBatch(
  env: Pick<Env, "DB">,
  input: { workspaceId: string; workstreamId: string; at: string },
  additionalStatements: () => D1PreparedStatement[],
): Promise<void> {
  const anchor = await regionalWorkstreamAnchorStatement(
    env,
    input.workspaceId,
    input.workstreamId,
    input.at,
  );
  try {
    await env.DB.batch([anchor.statement, ...additionalStatements()]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const migrationRemovedLegacyColumns =
      /(?:no such column|has no column named).*title|title.*(?:no such column|has no column named)/iu
        .test(reason);
    if (!anchor.legacyShape || !migrationRemovedLegacyColumns) {
      throw error;
    }
    await env.DB.batch([
      finalRegionalWorkstreamAnchorStatement(env, input.workspaceId, input.workstreamId),
      ...additionalStatements(),
    ]);
  }
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
  const at = new Date().toISOString();
  await writeRegionalWorkstreamAnchorBatch(env, { workspaceId, workstreamId, at }, () => [
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
  const stub = await durableObjectStubForWorkspace(
    env,
    env.SUBSTREAM_AGENTS,
    workspaceId,
    substreamAgentName(env.AVALON_REGION, asWorkspaceId(workspaceId), asWorkstreamId(workstreamId)),
  );
  const response = await stub.bootstrapRuntime({
    workspaceId: asWorkspaceId(workspaceId),
    workstreamId: asWorkstreamId(workstreamId),
    generation: authority.generation,
  });
  if (response.status < 200 || response.status >= 300) {
    const body = rpcResultBody(response) as { error?: unknown } | null;
    throw new Error(typeof body?.error === "string" ? body.error : "workstream_runtime_bootstrap_failed");
  }
  return withWorkstreamRuntimeDatabase(env, workspaceId, workstreamId);
}

/**
 * Write what a system-provisioned work stream is, on the object that owns it.
 *
 * The other half of {@link bootstrapWorkstreamRuntimeEnvironment}: that opens an
 * empty authoritative object, and this says what the work stream is and who can
 * see it. The four producers that create a work stream nobody typed into —
 * automation, a schedule, an activity, a digest — used to write those rows as a
 * routed batch against `_runtime_workstreams` and `_runtime_workstream_participants`.
 *
 * Not `WorkstreamObjectCreationService`, which is the member path: it requires
 * an opening message and produces a first run, and three of these four have
 * neither at creation time.
 */
export async function provisionWorkstreamObject(
  env: Env,
  input: WorkstreamProvisionInput & { workspaceId: string; workstreamId: string },
): Promise<void> {
  await createIdentityObjectPort(env, input.workspaceId, input.workstreamId).provision(input);
}

/** Escape hatch for an explicitly regional half of a cross-authority operation. */
export function regionalDatabase(env: Env): D1Database {
  return (env as Env & { [REGIONAL_DATABASE]?: D1Database })[REGIONAL_DATABASE] ?? env.DB;
}

export const __workstreamRuntimeDatabaseTesting = { localStatement };
