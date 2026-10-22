import { z } from "zod";
import { AUTHORIZATION_STORAGE_TABLES } from '../durable-objects/authorization-storage';

import { workspaceDOName } from "../durable-objects/names";
import { rpcResultBody } from "../durable-objects/rpc-result";
import type { WorkspaceRuntimeSqlResult } from "../durable-objects/workspace-runtime-sql";
import { asWorkspaceId } from "@rally/contracts";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { splitSqlStatements } from "../lib/sql-statements";
import { uuidV7 } from "../lib/uuid-v7";

type RuntimeValue = string | number | null;

const REGIONAL_DATABASE = Symbol("workspace-regional-database");
/**
 * Local executors carried on the environment, keyed by workspace.
 *
 * WorkspaceDO hands its own storage in as an executor so its SQL never leaves
 * the object. Without this the very next helper to re-derive an execution
 * environment from that one — and several do — would build a port with no
 * executor and send every statement back through the namespace into the object
 * that issued it. See `lib/durable-object-self.ts` for the general defect.
 */
const LOCAL_EXECUTORS = Symbol("workspace-local-executors");

type LocalExecutorRegistry = ReadonlyMap<string, LocalStatementExecutor>;

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
) => Promise<WorkspaceRuntimeSqlResult[]>;

const responseSchema = z.object({
  results: z.array(z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
    changes: z.number().int().nonnegative(),
  })),
});

/** Tables whose only live authority is the WorkspaceDO SQLite database. */
export const WORKSPACE_LOCAL_TABLES = [
  "sidekick_delegations", "sidekick_delegation_receipts", "sidekick_delegation_preparations", "sidekick_claim_access",
  ...AUTHORIZATION_STORAGE_TABLES,
  "search_authorization_push", "search_authorization_keys", "search_authorization_dependencies",
  "resource_search_versions",
  "connector_connections",
  "webhook_receipts",
  "connector_oauth_attempts",
  "external_user_identities",
  "workspace_connector_events",
  "workspace_connector_event_people",
  "workspace_connector_event_ingress_receipts",
  "workspace_connector_event_latest_content",
  "slack_agent_policies",
  "slack_delivery_preferences",
  "slack_user_links",
  // Typed WorkspaceDO methods now, and named in that file's
  // `WORKSPACE_TYPED_RPC_ONLY_TABLES`. They stay listed here so an accidental
  // generic statement reaches the object and is refused by name, rather than
  // falling through to regional D1 as a misleading `no such table`.
  "slack_agent_contexts",
  "slack_agent_feedback",
  "slack_agent_sessions",
  "external_conversation_bindings",
  // Still executed generically, deliberately: the schedule's alarm-target
  // derivation reads these tables' due times through the object's local
  // executor, alongside the other alarm sources.
  "slack_agent_thread_claims",
  "slack_ingress_jobs",
  "slack_link_challenges",
  "slack_agent_pending_prompts",
  "slack_unfurled_links",
  "workspace_sandbox_network_policies",
  "workspace_sandbox_network_domains",
  "workspace_sandbox_network_policy_mutations",
  // WorkspaceDO migration 22. No statement names it through this facade any
  // more — the work stream summary's origin-label read became
  // `automationOriginLabel` on WorkspaceDO — but the entry stays, because
  // while it was missing that read took this router's regional fallthrough
  // and answered `no such table: automation_directory` from D1: a 500 on
  // every attempt to open an automation's run work stream. Listed here the
  // statement reaches the object, and `WORKSPACE_TYPED_RPC_ONLY_TABLES`
  // there refuses it by name rather than executing it.
  "automation_directory",
  // Typed only, like the directory beside it: the conversation tools' scope.
  "sidekick_conversation_attachments",
  "automation_subscriptions",
  "automation_runs",
  "automation_delivery_targets",
  "automation_email_receipts",
  "automation_email_rate_windows",
  "automation_resources",
  // WorkspaceDO migration 28. The site-publish path writes it through this
  // facade, and the revocation walk reads it inside the object. Listed for the
  // reason `automation_directory` above is: a table missing here takes the
  // regional fallthrough and answers `no such table` from D1, which for this
  // one would mean every directory publish failing after its bytes had already
  // landed in the bucket.
  "artifact_registry",
  // The digest domain reaches these through typed WorkspaceDO methods now.
  // One routed statement remains — the settings read that joins
  // `digest_delivery_targets` to `connector_connections` for display names —
  // and the entries stay regardless, so an accidental generic statement is
  // routed to the object that has the tables rather than answered
  // `no such table` by D1.
  "digest_schedules",
  "digest_schedule_times",
  "digest_delivery_targets",
  "digest_deliveries",
  // Shared: digest-owned rows are written through the typed digest methods,
  // while the workspace scheduler and the connector-poll paths still route
  // their statements here.
  "schedules",
  "resources",
  "resource_versions",
  "resource_watches",
  "resource_object_deletion_outbox",
  "pending_attachment_reservations",
  "memory_scopes",
  "memory_facts",
  "memory_facts_fts",
  "memory_fact_receipts",
  "memory_sweep_receipts",
  "memory_tables",
  "memory_table_columns",
  "memory_table_rows",
  "memory_table_rows_fts",
  "memory_table_cells",
  "memory_table_mutations",
  // Kept in the router so an accidental generic statement reaches WorkspaceDO
  // rather than falling through to regional D1 as a misleading `no such table`.
  // Whether the object then refuses it or executes it depends on
  // `WORKSPACE_TYPED_RPC_ONLY_TABLES` over there: the notification-intent and
  // transcription tables are named in that list and are refused; the pin and
  // work-stream-email tables are not, and still execute.
  "workstream_notification_intents",
  "workspace_workstream_pins",
  "workstream_email_receipts",
  "realtime_transcription_ticket_receipts",
  "realtime_transcription_sessions",
  // Impersonation authority is reachable only through typed WorkspaceDO RPC.
  // Keeping it in the router prevents an accidental generic statement from
  // falling through to regional D1 as a misleading missing-table failure.
  "workspace_impersonation_relationships",
] as const;

const WORKSPACE_LOCAL_TABLE_PATTERNS = WORKSPACE_LOCAL_TABLES.map((table) => ({
  table,
  pattern: new RegExp(`\\b${table}\\b`, "iu"),
}));

/**
 * Identity, tenancy, routing, and audit tables held outside WorkspaceDO.
 *
 * WorkspaceDO holds product state and nothing else, so a statement that names
 * one of these alongside a local table is asking two databases one question.
 * The list is deliberately short and explicit rather than "everything not in
 * `WORKSPACE_LOCAL_TABLES`": the object also holds tables that list does not
 * name — `channels`, `work_opportunities`,
 * `workspace_activity_events` and their neighbours — and treating those as
 * regional would refuse statements that are correct today.
 *
 * These are the ones a workspace-local query actually reaches for: the person
 * behind a connector identity, and the membership that says they still belong
 * here. `slackUserIsLinked` joined `slack_user_links` to `workspace_members`
 * and was routed into an object with no such table, which surfaced as
 * `no such table: workspace_members` on every Slack run-outcome delivery in
 * production rather than as anything naming the boundary it crossed.
 */
const WORKSPACE_EXTERNAL_TABLES = [
  "users",
  "workspaces",
  "workspace_members",
  "workspace_invitations",
  "sessions",
  "audit_events", // AUDIT_DB remains a separate authority after regional retirement.
  "platform_workspace_bindings",
] as const;

const WORKSPACE_EXTERNAL_TABLE_PATTERNS = WORKSPACE_EXTERNAL_TABLES.map((table) => ({
  table,
  // The boundaries keep each name to itself: `workspaces` would otherwise
  // match inside `workspace_members`, and `sessions` inside
  // `slack_agent_sessions`.
  //
  // What they do not do is tell a table name from any other bare word in the
  // statement. This matches the whole text, so a column alias
  // (`COUNT(*) AS sessions`), a string literal (`WHERE scope = 'workspaces'`),
  // or a CTE by one of these names would be refused as cross-authority even
  // though the statement only touches local tables — and the error would read
  // like the boundary bug rather than like the typo it is. Nothing under
  // `apps/api/src` does that today. The alternative is parsing SQL here, which
  // is a great deal of machinery to protect a name nobody has used yet; if one
  // appears, rename the alias rather than teaching this to parse.
  pattern: new RegExp(`\\b${table}\\b`, "iu"),
}));

function localStatement(sql: string): boolean {
  const localTables = WORKSPACE_LOCAL_TABLE_PATTERNS
    .filter(({ pattern }) => pattern.test(sql))
    .map(({ table }) => table);
  if (localTables.length === 0) return false;

  // A regional mutation must never be routed into WorkspaceDO merely because
  // its SELECT/subquery happens to name a local table. That SQL is a cross-
  // authority join and cannot execute correctly in either database.
  // `OR IGNORE` and its siblings are part of the verb, on UPDATE as well as on
  // INSERT. Reading them as the table name is not a near miss: the router then
  // refuses every conflict-tolerant update as a cross-authority statement, and
  // the error names `or` rather than anything a reader could act on.
  const writeTarget = /^\s*(?:(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+([\w"]+)/iu
    .exec(sql)?.[1]?.replaceAll('"', "").toLowerCase();
  if (writeTarget && !WORKSPACE_LOCAL_TABLES.some((table) => table === writeTarget)) {
    throw new Error(`workspace_runtime_cross_authority_statement:${writeTarget}`);
  }

  // The same rule for a read. A SELECT that joins a local table to a regional
  // one has no correct destination either, and until now it was sent here and
  // failed as `no such table` — a message that names the column the object
  // lacks rather than the boundary the query crossed, which is how one sat in
  // production being retried. Refusing it at the router says which table put
  // the statement on the wrong side.
  const regionalTable = WORKSPACE_EXTERNAL_TABLE_PATTERNS
    .find(({ pattern }) => pattern.test(sql))?.table;
  if (regionalTable) {
    throw new Error(`workspace_runtime_cross_authority_statement:${regionalTable}`);
  }
  return true;
}

function d1Result<T>(result: WorkspaceRuntimeSqlResult): D1Result<T> {
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

class WorkspaceRuntimePreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly database: WorkspaceRuntimeDatabase,
    readonly statement: BoundStatement,
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    const params = values.map((value) => {
      if (value === null || typeof value === "string" || typeof value === "number") return value;
      throw new Error("workspace_runtime_bind_value_unsupported");
    });
    return new WorkspaceRuntimePreparedStatement(this.database, { ...this.statement, params });
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
    return options?.columnNames ? [result.columns, ...values as T[]] : values as T[];
  }
}

class WorkspaceRuntimeDatabase implements D1Database {
  constructor(
    private readonly env: Env,
    private readonly workspaceId: string,
    private readonly localExecutor?: LocalStatementExecutor,
  ) {}

  prepare(sql: string): D1PreparedStatement {
    return new WorkspaceRuntimePreparedStatement(this, { sql, params: [], local: localStatement(sql) });
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const bound = statements.map((statement) => {
      if (!(statement instanceof WorkspaceRuntimePreparedStatement)) {
        throw new Error("workspace_runtime_foreign_statement");
      }
      return statement.statement;
    });
    const localCount = bound.filter((statement) => statement.local).length;
    if (localCount !== 0 && localCount !== bound.length) {
      throw new Error("workspace_runtime_cross_authority_transaction");
    }
    if (localCount === 0) {
      return this.env.DB.batch(bound.map((statement) =>
        this.env.DB.prepare(statement.sql).bind(...statement.params))) as Promise<D1Result<T>[]>;
    }
    return (await this.executeLocal(bound)).map((result) => d1Result<T>(result));
  }

  async execute(statement: BoundStatement): Promise<WorkspaceRuntimeSqlResult> {
    if (!statement.local) {
      const result = await this.env.DB.prepare(statement.sql).bind(...statement.params).all();
      return {
        columns: result.results.length === 0 ? [] : Object.keys(result.results[0] as object),
        rows: result.results as Array<Record<string, string | number | null>>,
        changes: Number(result.meta.changes ?? 0),
      };
    }
    const [result] = await this.executeLocal([statement]);
    if (!result) throw new Error("workspace_runtime_result_missing");
    return result;
  }

  private async executeLocal(statements: BoundStatement[]): Promise<WorkspaceRuntimeSqlResult[]> {
    if (this.localExecutor) {
      return this.localExecutor(statements.map(({ sql, params }) => ({ sql, params })));
    }
    const stub = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.workspaceId)),
    );
    const response = await stub.executeRuntimeSql({
      workspaceId: this.workspaceId,
      requestId: uuidV7(),
      statements: statements.map(({ sql, params }) => ({ sql, params })),
    });
    if (response.status < 200 || response.status >= 300) {
      const body = rpcResultBody(response) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : "workspace_runtime_sql_failed");
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
      throw new Error("workspace_runtime_cross_authority_transaction");
    }
    if (localCount === 0) return this.env.DB.exec(query);
    await this.executeLocal(statements);
    return { count: statements.length, duration: 0 } as D1ExecResult;
  }

  dump(): Promise<ArrayBuffer> {
    return Promise.reject(new Error("workspace_runtime_dump_unsupported"));
  }

  withSession(): D1DatabaseSession {
    throw new Error("workspace_runtime_sessions_unsupported");
  }
}

/** D1-compatible router: workspace product SQL goes to WorkspaceDO; control SQL stays in D1. */
export function workspaceRuntimeDatabase(
  env: Env,
  workspaceId: string,
  localExecutor?: LocalStatementExecutor,
): D1Database {
  return new WorkspaceRuntimeDatabase(env, workspaceId, localExecutor);
}

/** Preserve every binding while substituting the workspace-authority database port. */
export function withWorkspaceRuntimeDatabase(
  env: Env,
  workspaceId: string,
  localExecutor?: LocalStatementExecutor,
): Env {
  const inherited = carriedExecutors(env);
  const executor = localExecutor ?? inherited.get(workspaceId);
  // Focused unit environments and maintenance utilities may intentionally omit
  // the namespace. Production cannot reach this path because the environment
  // contract requires WORKSPACE_DOS before request dispatch.
  if (!env.WORKSPACE_DOS && !executor) return env;
  const database = workspaceRuntimeDatabase(env, workspaceId, executor);
  const carried: LocalExecutorRegistry = localExecutor
    ? new Map(inherited).set(workspaceId, localExecutor)
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
 * Escape hatch for explicitly global/regional control-plane SQL.
 *
 * This peels off the WorkspaceDO compatibility port and returns the regional
 * binding it wrapped. Work-stream product authority is no longer represented
 * as a database overlay, so there is no second SQL router to unwrap or bypass.
 */
export function workspaceRegionalDatabase(env: Env): D1Database {
  return (env as Env & { [REGIONAL_DATABASE]?: D1Database })[REGIONAL_DATABASE] ?? env.DB;
}

export const __workspaceRuntimeDatabaseTesting = { localStatement };
