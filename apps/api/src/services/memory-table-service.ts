import type {
  AutomationMemoryTable,
  MemoryTableColumnType,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import { AutomationMemoryTableSchema } from "@rally/contracts";
import { newId, nowIso } from "@rally/db";
import type { HarnessTool, HarnessToolResult } from "@rally/agent-harness";
import { z } from "zod";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import {
  MEMORY_SCOPE_KINDS,
  resolveMemoryAccess,
  writableScope,
  type MemoryScope,
  type MemoryScopeKind,
} from "./memory-service";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

type ColumnType = MemoryTableColumnType;

interface TableRow {
  memory_table_id: string;
  memory_scope_id: string;
  workspace_id: string;
  scope_kind: MemoryScopeKind;
  name: string;
  description: string;
  usage_instructions: string;
  key_column_ids_json: string;
  schema_revision: number;
  data_revision: number;
  last_mutation_id: string | null;
  invalidated_at: string | null;
}

interface ColumnRow {
  memory_table_column_id: string;
  memory_table_id: string;
  name: string;
  description: string;
  value_type: ColumnType;
  is_required: number;
  is_searchable: number;
  position: number;
}

interface AuthorizedTable {
  table: TableRow;
  columns: ColumnRow[];
  scope: MemoryScope;
  keyColumns: ColumnRow[];
}

interface RowRecord {
  memory_table_row_id: string;
  data_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  last_mutation_id: string;
  invalidated_at: string | null;
}

type PredicateOperator =
  | "eq" | "neq" | "in" | "not_in"
  | "gt" | "gte" | "lt" | "lte" | "between"
  | "contains" | "not_contains" | "starts_with" | "ends_with"
  | "is_null" | "is_not_null";

interface FilterPredicate {
  column: string;
  op: PredicateOperator;
  value?: unknown;
}

type FilterNode = FilterPredicate | { all: FilterNode[] } | { any: FilterNode[] };

const ColumnSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  type: z.enum(["string", "url", "number", "integer", "boolean", "datetime", "date"]),
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
}).strict();

const CreateSchema = z.object({
  scopeKind: z.enum(MEMORY_SCOPE_KINDS),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_200),
  usageInstructions: z.string().trim().min(1).max(4_000),
  columns: z.array(ColumnSchema).min(1),
  keyColumns: z.array(z.string().trim().min(1).max(120)).min(1),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const PredicateSchema = z.object({
  column: z.string().min(1),
  op: z.enum([
    "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between",
    "contains", "not_contains", "starts_with", "ends_with", "is_null", "is_not_null",
  ]),
  value: z.unknown().optional(),
}).strict();

const FilterSchema: z.ZodType<FilterNode> = z.lazy(() => z.union([
  PredicateSchema,
  z.object({ all: z.array(FilterSchema) }).strict(),
  z.object({ any: z.array(FilterSchema) }).strict(),
]));

const QuerySchema = z.object({
  memoryTableId: z.string().min(1),
  memoryTableRowIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  search: z.string().trim().min(1).max(2_000).optional(),
  filter: FilterSchema.optional(),
  orderBy: z.array(z.object({
    column: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  }).strict()).optional(),
  select: z.array(z.string().min(1)).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict();

const InsertSchema = z.object({
  memoryTableId: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const UpdateSchema = z.object({
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    values: z.record(z.string(), z.unknown()),
  }).strict()).min(1),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();

const InvalidateSchema = z.object({
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  }).strict()).min(1),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

class MemoryTableToolError extends Error {
  override readonly name = "MemoryTableToolError";

  constructor(
    readonly code: string,
    message: string,
    readonly details: { reason: string },
  ) {
    super(message);
  }
}

function memoryTableRevisionConflict(code = "memory_table_revision_conflict"): MemoryTableToolError {
  return new MemoryTableToolError(
    code,
    "The durable table changed while the mutation was being applied. Query the affected rows again by memoryTableRowIds, copy their current revisions, and rebuild the mutation.",
    {
      reason: "Call table_query with the affected memoryTableRowIds, copy each current row revision, and rebuild the mutation. Do not retry with an old revision.",
    },
  );
}

function memoryTableInsertContention(): MemoryTableToolError {
  return new MemoryTableToolError(
    "memory_table_insert_contention",
    "The durable table kept changing while rows were inserted. Query by the rows' natural-key values, remove rows already present, and retry the missing rows once.",
    {
      reason: "Call table_query with filters for the natural-key values, then call table_insert_rows once with only rows that are still missing.",
    },
  );
}

function isMemoryTableRowRevisionAbort(error: unknown): boolean {
  // The cell-consistency trigger in migration 0037 reports a concurrent row
  // change through SQLite RAISE(ABORT), whose generic error code is not ours.
  return error instanceof Error && error.message.includes("memory_table_row_revision_conflict");
}

const SearchSchema = z.object({ query: z.string().trim().min(1).max(2_000) }).strict();
const DescribeSchema = z.object({ memoryTableId: z.string().min(1) }).strict();

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function d1Changes(result: D1Result<unknown> | undefined): number {
  return Number((result?.meta as { changes?: unknown } | undefined)?.changes ?? 0);
}

function requireReceipt(context: { providerIdempotencyKey?: string }): string {
  const receipt = context.providerIdempotencyKey?.trim();
  if (!receipt) throw new Error("Structured-memory writes require a durable provider idempotency key");
  return receipt;
}

async function deterministicId(prefix: string, ...parts: string[]): Promise<string> {
  return `${prefix}_${await sha256(parts.join("\u001f"))}`;
}

function ftsQuery(value: string): string | null {
  const tokens = value.normalize("NFKC").match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return [...new Set(tokens.map((token) => token.toLocaleLowerCase()))]
    .slice(0, 96)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" OR ");
}

function encodeCursor(offset: number, dataRevision: number): string {
  return btoa(JSON.stringify({ offset, dataRevision })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCursor(cursor: string | undefined): { offset: number; dataRevision: number | null } {
  if (!cursor) return { offset: 0, dataRevision: null };
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))) as {
      offset?: unknown;
      dataRevision?: unknown;
    };
    if (
      !Number.isInteger(parsed.offset) || Number(parsed.offset) < 0
      || !Number.isInteger(parsed.dataRevision) || Number(parsed.dataRevision) < 0
    ) throw new Error("invalid");
    return { offset: Number(parsed.offset), dataRevision: Number(parsed.dataRevision) };
  } catch {
    throw new Error("memory_table_cursor_invalid");
  }
}

function parseDefinitions(value: unknown): AutomationMemoryTable[] {
  const parsed = z.array(AutomationMemoryTableSchema).parse(value ?? []);
  const names = new Set<string>();
  for (const table of parsed) {
    const normalized = table.name.toLocaleLowerCase();
    if (names.has(normalized)) throw new Error("automation_memory_table_name_duplicate");
    names.add(normalized);
  }
  return parsed;
}

export interface MaterializedMemoryTable {
  memoryTableId: string;
  memoryScopeId: string;
  scopeKind: "automation";
  name: string;
  description: string;
  usageInstructions: string;
  keyColumns: string[];
  columns: Array<{
    memoryTableColumnId: string;
    name: string;
    description: string;
    type: ColumnType;
    required: boolean;
    searchable: boolean;
  }>;
}

/** Build statements that run after the subscription insert in the same D1 batch. */
export function buildAutomationMemoryTableStatements(
  env: Env,
  input: {
    workspaceId: string;
    automationSubscriptionId: string;
    definitions: unknown;
    createdByUserId: string;
    createdAt: string;
  },
): { statements: D1PreparedStatement[]; tables: MaterializedMemoryTable[] } {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const definitions = parseDefinitions(input.definitions);
  if (definitions.length === 0) return { statements: [], tables: [] };
  const memoryScopeId = newId();
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO memory_scopes (memory_scope_id, workspace_id, kind, owner_id, created_at)
     VALUES (?, ?, 'automation', ?, ?)`,
  ).bind(
    memoryScopeId,
    input.workspaceId,
    input.automationSubscriptionId,
    input.createdAt,
  )];
  const tables = definitions.map((definition): MaterializedMemoryTable => {
    const memoryTableId = newId();
    const columns = definition.columns.map((column) => ({
      memoryTableColumnId: newId(),
      ...column,
    }));
    const columnsByName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
    const keyColumnIds = definition.keyColumns.map((name) => columnsByName.get(name.toLocaleLowerCase())!.memoryTableColumnId);
    statements.push(env.DB.prepare(
      `INSERT INTO memory_tables
         (memory_table_id, memory_scope_id, workspace_id, name, description,
          usage_instructions, key_column_ids_json, provenance_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      memoryTableId,
      memoryScopeId,
      input.workspaceId,
      definition.name,
      definition.description,
      definition.usageInstructions,
      JSON.stringify(keyColumnIds),
      JSON.stringify({
        source: "automation_draft",
        automationSubscriptionId: input.automationSubscriptionId,
        createdByUserId: input.createdByUserId,
      }),
      input.createdAt,
      input.createdAt,
    ));
    columns.forEach((column, position) => statements.push(env.DB.prepare(
      `INSERT INTO memory_table_columns
         (memory_table_column_id, memory_table_id, name, description, value_type,
          is_required, is_searchable, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      column.memoryTableColumnId,
      memoryTableId,
      column.name,
      column.description,
      column.type,
      column.required ? 1 : 0,
      column.searchable ? 1 : 0,
      position,
      input.createdAt,
    )));
    return {
      memoryTableId,
      memoryScopeId,
      scopeKind: "automation",
      name: definition.name,
      description: definition.description,
      usageInstructions: definition.usageInstructions,
      keyColumns: definition.keyColumns,
      columns,
    };
  });
  return { statements, tables };
}

export async function loadAutomationMemoryTableContext(
  env: Env,
  workspaceId: string,
  automationSubscriptionId: string,
  definitions?: unknown,
): Promise<MaterializedMemoryTable[]> {
  env = withWorkspaceRuntimeDatabase(env, workspaceId);
  const declaredNames = definitions === undefined
    ? null
    : new Set(parseDefinitions(definitions).map((table) => table.name.toLocaleLowerCase()));
  const rows = await env.DB.prepare(
    `SELECT table_def.memory_table_id, table_def.memory_scope_id, table_def.name,
            table_def.description, table_def.usage_instructions,
            table_def.key_column_ids_json
       FROM memory_tables table_def
       JOIN memory_scopes scope ON scope.memory_scope_id = table_def.memory_scope_id
       JOIN automation_subscriptions subscription
         ON subscription.id = scope.owner_id AND subscription.workspace_id = scope.workspace_id
      WHERE table_def.workspace_id = ? AND scope.kind = 'automation'
        AND scope.owner_id = ? AND table_def.invalidated_at IS NULL
      ORDER BY table_def.name COLLATE NOCASE`,
  ).bind(workspaceId, automationSubscriptionId).all<{
    memory_table_id: string;
    memory_scope_id: string;
    name: string;
    description: string;
    usage_instructions: string;
    key_column_ids_json: string;
  }>();
  const result: MaterializedMemoryTable[] = [];
  for (const row of rows.results ?? []) {
    if (declaredNames && !declaredNames.has(row.name.toLocaleLowerCase())) continue;
    const columns = await env.DB.prepare(
      `SELECT memory_table_column_id, name, description, value_type,
              is_required, is_searchable
         FROM memory_table_columns WHERE memory_table_id = ? ORDER BY position`,
    ).bind(row.memory_table_id).all<{
      memory_table_column_id: string;
      name: string;
      description: string;
      value_type: ColumnType;
      is_required: number;
      is_searchable: number;
    }>();
    const materializedColumns = (columns.results ?? []).map((column) => ({
      memoryTableColumnId: column.memory_table_column_id,
      name: column.name,
      description: column.description,
      type: column.value_type,
      required: column.is_required === 1,
      searchable: column.is_searchable === 1,
    }));
    const keyIds = new Set(JSON.parse(row.key_column_ids_json) as string[]);
    result.push({
      memoryTableId: row.memory_table_id,
      memoryScopeId: row.memory_scope_id,
      scopeKind: "automation",
      name: row.name,
      description: row.description,
      usageInstructions: row.usage_instructions,
      keyColumns: materializedColumns.filter((column) => keyIds.has(column.memoryTableColumnId)).map((column) => column.name),
      columns: materializedColumns,
    });
  }
  if (declaredNames && result.length !== declaredNames.size) {
    throw new Error("automation_memory_tables_incomplete");
  }
  return result;
}

function materializedDefinitionMatches(
  table: MaterializedMemoryTable,
  definition: AutomationMemoryTable,
): boolean {
  return table.description === definition.description
    && table.usageInstructions === definition.usageInstructions
    && stableJson(table.keyColumns.map((name) => name.toLocaleLowerCase()))
      === stableJson(definition.keyColumns.map((name) => name.toLocaleLowerCase()))
    && stableJson(table.columns.map((column) => ({
      name: column.name.toLocaleLowerCase(),
      description: column.description,
      type: column.type,
      required: column.required,
      searchable: column.searchable,
    }))) === stableJson(definition.columns.map((column) => ({
      ...column,
      name: column.name.toLocaleLowerCase(),
    })));
}

/** Materialize newly declared tables before an existing subscription adopts a version. */
export async function ensureAutomationMemoryTables(
  env: Env,
  input: {
    workspaceId: string;
    automationSubscriptionId: string;
    definitions: unknown;
    createdByUserId: string;
  },
): Promise<MaterializedMemoryTable[]> {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const definitions = parseDefinitions(input.definitions);
  if (definitions.length === 0) return [];
  let scope = await env.DB.prepare(
    `SELECT memory_scope_id FROM memory_scopes
      WHERE workspace_id = ? AND kind = 'automation' AND owner_id = ?`,
  ).bind(input.workspaceId, input.automationSubscriptionId).first<{ memory_scope_id: string }>();
  if (!scope) {
    const proposedId = newId();
    await env.DB.prepare(
      `INSERT INTO memory_scopes (memory_scope_id, workspace_id, kind, owner_id, created_at)
       VALUES (?, ?, 'automation', ?, ?)
       ON CONFLICT(workspace_id, kind, owner_id) DO NOTHING`,
    ).bind(proposedId, input.workspaceId, input.automationSubscriptionId, nowIso()).run();
    scope = await env.DB.prepare(
      `SELECT memory_scope_id FROM memory_scopes
        WHERE workspace_id = ? AND kind = 'automation' AND owner_id = ?`,
    ).bind(input.workspaceId, input.automationSubscriptionId).first<{ memory_scope_id: string }>();
    if (!scope) throw new Error("automation_memory_scope_creation_failed");
  }
  const existing = await loadAutomationMemoryTableContext(
    env,
    input.workspaceId,
    input.automationSubscriptionId,
  );
  const byName = new Map(existing.map((table) => [table.name.toLocaleLowerCase(), table]));
  for (const definition of definitions) {
    const current = byName.get(definition.name.toLocaleLowerCase());
    if (current) {
      if (!materializedDefinitionMatches(current, definition)) {
        throw new Error(`automation_memory_table_schema_conflict:${definition.name}`);
      }
      continue;
    }
    const at = nowIso();
    const memoryTableId = newId();
    const columns = definition.columns.map((column) => ({ ...column, id: newId() }));
    const columnsByName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
    const keyColumnIds = definition.keyColumns.map((name) => columnsByName.get(name.toLocaleLowerCase())!.id);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO memory_tables
           (memory_table_id, memory_scope_id, workspace_id, name, description,
            usage_instructions, key_column_ids_json, provenance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        memoryTableId,
        scope.memory_scope_id,
        input.workspaceId,
        definition.name,
        definition.description,
        definition.usageInstructions,
        JSON.stringify(keyColumnIds),
        JSON.stringify({
          source: "automation_version",
          automationSubscriptionId: input.automationSubscriptionId,
          createdByUserId: input.createdByUserId,
        }),
        at,
        at,
      ),
      ...columns.map((column, position) => env.DB.prepare(
        `INSERT INTO memory_table_columns
           (memory_table_column_id, memory_table_id, name, description, value_type,
            is_required, is_searchable, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        column.id,
        memoryTableId,
        column.name,
        column.description,
        column.type,
        column.required ? 1 : 0,
        column.searchable ? 1 : 0,
        position,
        at,
      )),
    ]);
  }
  return loadAutomationMemoryTableContext(env, input.workspaceId, input.automationSubscriptionId);
}

async function loadAuthorizedTable(
  env: Env,
  input: WorkstreamWorkflowInput,
  memoryTableId: string,
  requireWritable = false,
): Promise<AuthorizedTable> {
  const scopes = await resolveMemoryAccess(env, input);
  const table = await env.DB.prepare(
    `SELECT table_def.memory_table_id, table_def.memory_scope_id, table_def.workspace_id,
            scope.kind AS scope_kind, table_def.name, table_def.description,
            table_def.usage_instructions, table_def.key_column_ids_json,
            table_def.schema_revision, table_def.data_revision,
            table_def.last_mutation_id, table_def.invalidated_at
       FROM memory_tables table_def
       JOIN memory_scopes scope ON scope.memory_scope_id = table_def.memory_scope_id
      WHERE table_def.memory_table_id = ? AND table_def.workspace_id = ?`,
  ).bind(memoryTableId, input.workspaceId).first<TableRow>();
  if (!table || table.invalidated_at) throw new Error("memory_table_not_found");
  const scope = scopes.find((candidate) => candidate.memoryScopeId === table.memory_scope_id);
  if (!scope) throw new Error("memory_table_not_authorized");
  if (requireWritable && !scope.writable) throw new Error(`memory_scope_not_writable:${scope.kind}`);
  const columnResult = await env.DB.prepare(
    `SELECT memory_table_column_id, memory_table_id, name, description,
            value_type, is_required, is_searchable, position
       FROM memory_table_columns WHERE memory_table_id = ? ORDER BY position`,
  ).bind(memoryTableId).all<ColumnRow>();
  const columns = columnResult.results ?? [];
  const keyIds = new Set(JSON.parse(table.key_column_ids_json) as string[]);
  const keyColumns = columns.filter((column) => keyIds.has(column.memory_table_column_id));
  if (keyColumns.length === 0) throw new Error("memory_table_key_schema_invalid");
  return { table, columns, scope, keyColumns };
}

function publicTable(table: AuthorizedTable) {
  const keyIds = new Set(table.keyColumns.map((column) => column.memory_table_column_id));
  return {
    memoryTableId: table.table.memory_table_id,
    memoryScopeId: table.table.memory_scope_id,
    scopeKind: table.table.scope_kind,
    name: table.table.name,
    description: table.table.description,
    usageInstructions: table.table.usage_instructions,
    schemaRevision: Number(table.table.schema_revision),
    dataRevision: Number(table.table.data_revision),
    keyColumns: table.keyColumns.map((column) => column.name),
    columns: table.columns.map((column) => ({
      memoryTableColumnId: column.memory_table_column_id,
      name: column.name,
      description: column.description,
      type: column.value_type,
      required: column.is_required === 1,
      searchable: column.is_searchable === 1,
      key: keyIds.has(column.memory_table_column_id),
    })),
  };
}

function compactTable(table: AuthorizedTable) {
  return {
    memoryTableId: table.table.memory_table_id,
    memoryScopeId: table.table.memory_scope_id,
    scopeKind: table.table.scope_kind,
    name: table.table.name,
    description: table.table.description,
    keyColumns: table.keyColumns.map((column) => column.name),
  };
}

function columnMap(columns: ColumnRow[]): Map<string, ColumnRow> {
  const result = new Map<string, ColumnRow>();
  for (const column of columns) {
    result.set(column.memory_table_column_id, column);
    result.set(column.name.toLocaleLowerCase(), column);
  }
  return result;
}

function resolveColumn(reference: string, columns: Map<string, ColumnRow>): ColumnRow {
  const column = columns.get(reference) ?? columns.get(reference.toLocaleLowerCase());
  if (!column) throw new Error(`memory_table_unknown_column:${reference}`);
  return column;
}

function normalizeValue(column: ColumnRow, value: unknown): unknown {
  if (value === null) return null;
  switch (column.value_type) {
    case "string":
      if (typeof value !== "string") throw new Error(`memory_table_value_type:${column.name}:string`);
      return value;
    case "url":
      if (typeof value !== "string") throw new Error(`memory_table_value_type:${column.name}:url`);
      try { new URL(value); } catch { throw new Error(`memory_table_value_type:${column.name}:url`); }
      return value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`memory_table_value_type:${column.name}:number`);
      return value;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`memory_table_value_type:${column.name}:integer`);
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw new Error(`memory_table_value_type:${column.name}:boolean`);
      return value;
    case "datetime": {
      if (typeof value !== "string" || !z.string().datetime({ offset: true }).safeParse(value).success) {
        throw new Error(`memory_table_value_type:${column.name}:datetime`);
      }
      return new Date(value).toISOString();
    }
    case "date":
      if (
        typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)
        || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))
        || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
      ) {
        throw new Error(`memory_table_value_type:${column.name}:date`);
      }
      return value;
  }
}

function normalizeValues(
  raw: Record<string, unknown>,
  table: AuthorizedTable,
  options: { patch?: boolean } = {},
): Record<string, unknown> {
  const columns = columnMap(table.columns);
  const normalized: Record<string, unknown> = {};
  for (const [reference, value] of Object.entries(raw)) {
    const column = resolveColumn(reference, columns);
    if (Object.hasOwn(normalized, column.name)) throw new Error(`memory_table_duplicate_column:${column.name}`);
    normalized[column.name] = normalizeValue(column, value);
  }
  if (!options.patch) {
    for (const column of table.columns) {
      if (column.is_required === 1 && (!Object.hasOwn(normalized, column.name) || normalized[column.name] === null)) {
        throw new Error(`memory_table_required_column:${column.name}`);
      }
    }
    for (const column of table.keyColumns) {
      if (!Object.hasOwn(normalized, column.name) || normalized[column.name] === null) {
        throw new Error(`memory_table_key_column:${column.name}`);
      }
    }
  }
  return Object.fromEntries(table.columns
    .filter((column) => Object.hasOwn(normalized, column.name))
    .map((column) => [column.name, normalized[column.name]]));
}

function searchableText(values: Record<string, unknown>, table: AuthorizedTable): string {
  return table.columns
    .filter((column) => column.is_searchable === 1)
    .flatMap((column) => {
      const value = values[column.name];
      return value == null ? [] : [`${column.name}: ${String(value)}`];
    })
    .join("\n");
}

function cellStatement(
  env: Env,
  table: AuthorizedTable,
  rowId: string,
  column: ColumnRow,
  value: unknown,
): D1PreparedStatement | null {
  if (value === null || value === undefined) return null;
  let stringValue: string | null = null;
  let numberValue: number | null = null;
  let booleanValue: number | null = null;
  let temporalValue: string | null = null;
  if (column.value_type === "string" || column.value_type === "url") stringValue = String(value);
  else if (column.value_type === "number" || column.value_type === "integer") numberValue = Number(value);
  else if (column.value_type === "boolean") booleanValue = value ? 1 : 0;
  else temporalValue = String(value);
  return env.DB.prepare(
    `INSERT INTO memory_table_cells
       (memory_table_row_id, memory_table_id, memory_table_column_id, value_type,
        string_value, number_value, boolean_value, temporal_value)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM memory_table_rows
         WHERE memory_table_row_id = ? AND last_mutation_id = ?
      )
     ON CONFLICT(memory_table_row_id, memory_table_column_id) DO UPDATE SET
       value_type = excluded.value_type,
       string_value = excluded.string_value,
       number_value = excluded.number_value,
       boolean_value = excluded.boolean_value,
       temporal_value = excluded.temporal_value`,
  ).bind(
    rowId,
    table.table.memory_table_id,
    column.memory_table_column_id,
    column.value_type,
    stringValue,
    numberValue,
    booleanValue,
    temporalValue,
    rowId,
    table.table.last_mutation_id ?? "",
  );
}

function cellStatements(
  env: Env,
  table: AuthorizedTable,
  rowId: string,
  values: Record<string, unknown>,
  mutationId: string,
): D1PreparedStatement[] {
  const withMarker = { ...table, table: { ...table.table, last_mutation_id: mutationId } } as AuthorizedTable & {
    table: TableRow & { last_mutation_id: string };
  };
  return table.columns.flatMap((column) => {
    const statement = cellStatement(env, withMarker, rowId, column, values[column.name]);
    return statement ? [statement] : [];
  });
}

async function naturalKeyHash(values: Record<string, unknown>, table: AuthorizedTable): Promise<string> {
  return sha256(stableJson(table.keyColumns.map((column) => [column.name, values[column.name]])));
}

async function mutationInputHash(operation: string, args: unknown): Promise<string> {
  return sha256(stableJson({ operation, args }));
}

async function loadMutationReceipt(
  env: Env,
  input: WorkstreamWorkflowInput,
  receiptId: string,
  operation: string,
  inputHash: string,
): Promise<Record<string, unknown> | null> {
  const row = await env.DB.prepare(
    `SELECT operation, input_hash, result_json FROM memory_table_mutations
      WHERE workspace_id = ? AND harness_run_id = ? AND receipt_id = ?`,
  ).bind(input.workspaceId, input.harnessRunId, receiptId).first<{
    operation: string;
    input_hash: string;
    result_json: string;
  }>();
  if (!row) return null;
  if (row.operation !== operation || row.input_hash !== inputHash) {
    throw new Error("memory_table_mutation_receipt_mismatch");
  }
  return JSON.parse(row.result_json) as Record<string, unknown>;
}

function mutationAuditStatement(
  env: Env,
  input: WorkstreamWorkflowInput,
  table: AuthorizedTable,
  args: {
    mutationId: string;
    receiptId: string;
    operation: "create" | "insert_rows" | "update_rows" | "invalidate_rows";
    rationale: string;
    inputHash: string;
    mutation: unknown;
    result: unknown;
  },
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO memory_table_mutations
       (memory_table_mutation_id, receipt_id, memory_table_id, memory_scope_id,
        workspace_id, operation, actor_principal_json, harness_run_id, workstream_id,
        rationale, input_hash, mutation_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    args.mutationId,
    args.receiptId,
    table.table.memory_table_id,
    table.table.memory_scope_id,
    input.workspaceId,
    args.operation,
    JSON.stringify(input.executionPrincipal),
    input.harnessRunId,
    input.workstreamId,
    args.rationale,
    args.inputHash,
    JSON.stringify(args.mutation),
    JSON.stringify(args.result),
    nowIso(),
  );
}

function columnSqlField(column: ColumnRow): string {
  if (column.value_type === "string" || column.value_type === "url") return "string_value";
  if (column.value_type === "number" || column.value_type === "integer") return "number_value";
  if (column.value_type === "boolean") return "boolean_value";
  return "temporal_value";
}

function normalizePredicateValue(column: ColumnRow, value: unknown): unknown {
  const normalized = normalizeValue(column, value);
  return column.value_type === "boolean" && normalized !== null ? normalized ? 1 : 0 : normalized;
}

function compileFilter(
  node: FilterNode,
  columns: Map<string, ColumnRow>,
  bindings: unknown[],
  depth = 0,
): string {
  if (depth > 4) throw new Error("memory_table_filter_too_deep");
  if ("all" in node || "any" in node) {
    const isAll = "all" in node;
    const children = isAll ? node.all : node.any;
    if (children.length === 0) return isAll ? "1 = 1" : "1 = 0";
    return `(${children.map((child) => compileFilter(child, columns, bindings, depth + 1)).join(isAll ? " AND " : " OR ")})`;
  }
  const column = resolveColumn(node.column, columns);
  const field = columnSqlField(column);
  const prefix = `cell.memory_table_row_id = row.memory_table_row_id AND cell.memory_table_column_id = ?`;
  const exists = (condition: string): string => {
    bindings.push(column.memory_table_column_id);
    return `EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND ${condition})`;
  };
  const notExists = (condition: string): string => {
    bindings.push(column.memory_table_column_id);
    return `NOT EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND ${condition})`;
  };
  if (node.op === "is_null") {
    if (node.value !== undefined) throw new Error("memory_table_filter_unary_value_forbidden");
    return notExists("1 = 1");
  }
  if (node.op === "is_not_null") {
    if (node.value !== undefined) throw new Error("memory_table_filter_unary_value_forbidden");
    return exists("1 = 1");
  }
  if (node.value === undefined) throw new Error("memory_table_filter_value_required");
  if (node.op === "in" || node.op === "not_in") {
    if (!Array.isArray(node.value) || node.value.length === 0) throw new Error("memory_table_filter_set_required");
    const values = node.value.map((value) => normalizePredicateValue(column, value));
    const condition = `cell.${field} IN (SELECT value FROM json_each(?))`;
    bindings.push(column.memory_table_column_id, JSON.stringify(values));
    const sql = `${node.op === "not_in" ? "NOT " : ""}EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND ${condition})`;
    return sql;
  }
  if (node.op === "between") {
    if (!node.value || typeof node.value !== "object" || Array.isArray(node.value)) throw new Error("memory_table_filter_range_required");
    const range = node.value as { from?: unknown; to?: unknown };
    const from = normalizePredicateValue(column, range.from);
    const to = normalizePredicateValue(column, range.to);
    bindings.push(column.memory_table_column_id, from, to);
    return `EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND cell.${field} BETWEEN ? AND ?)`;
  }
  if (["contains", "not_contains", "starts_with", "ends_with"].includes(node.op)) {
    if (column.value_type !== "string" && column.value_type !== "url") throw new Error("memory_table_filter_string_operator_required");
    const value = String(normalizePredicateValue(column, node.value))
      .replaceAll("\\", "\\\\")
      .replaceAll("%", "\\%")
      .replaceAll("_", "\\_");
    let pattern: string;
    if (node.op === "starts_with") pattern = `${value}%`;
    else if (node.op === "ends_with") pattern = `%${value}`;
    else pattern = `%${value}%`;
    bindings.push(column.memory_table_column_id, pattern);
    const sql = `EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND cell.string_value LIKE ? ESCAPE '\\' COLLATE NOCASE)`;
    return node.op === "not_contains" ? `NOT ${sql}` : sql;
  }
  const value = normalizePredicateValue(column, node.value);
  const operator = ({
    eq: "=", neq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=",
  } as Partial<Record<PredicateOperator, string>>)[node.op];
  if (!operator) throw new Error("memory_table_filter_operator_invalid");
  const comparison = `cell.${field} ${operator} ?${field === "string_value" ? " COLLATE NOCASE" : ""}`;
  if (node.op === "neq") {
    bindings.push(column.memory_table_column_id, value);
    return `NOT EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND ${comparison})`;
  }
  bindings.push(column.memory_table_column_id, value);
  return `EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${prefix} AND ${comparison})`;
}

async function tableSearch(env: Env, input: WorkstreamWorkflowInput, query: string) {
  const scopes = await resolveMemoryAccess(env, input);
  if (scopes.length === 0) return { query, tables: [] };
  const scopeIds = scopes.map((scope) => scope.memoryScopeId);
  const like = `%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const rows = await env.DB.prepare(
    `SELECT table_def.memory_table_id
       FROM memory_tables table_def
      WHERE table_def.workspace_id = ?
        AND table_def.memory_scope_id IN (${placeholders(scopeIds.length)})
        AND table_def.invalidated_at IS NULL
        AND (table_def.name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR table_def.description LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR table_def.usage_instructions LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY table_def.name COLLATE NOCASE
      LIMIT 20`,
  ).bind(input.workspaceId, ...scopeIds, like, like, like).all<{ memory_table_id: string }>();
  const tables = [];
  for (const row of rows.results ?? []) {
    const table = await loadAuthorizedTable(env, input, row.memory_table_id);
    tables.push(compactTable(table));
  }
  return { query, tables };
}

async function queryTable(env: Env, input: WorkstreamWorkflowInput, raw: unknown) {
  const args = QuerySchema.parse(raw);
  const table = await loadAuthorizedTable(env, input, args.memoryTableId);
  const columns = columnMap(table.columns);
  const selectedColumns = args.select?.map((reference) => resolveColumn(reference, columns)) ?? table.columns;
  const selectedIds = new Set(selectedColumns.map((column) => column.memory_table_column_id));
  if (selectedIds.size !== selectedColumns.length) throw new Error("memory_table_select_duplicate");
  const bindings: unknown[] = [table.table.memory_table_id];
  const where = ["row.memory_table_id = ?", "row.invalidated_at IS NULL"];
  const exactRowIds = args.memoryTableRowIds ? [...new Set(args.memoryTableRowIds)] : [];
  if (exactRowIds.length > 0) {
    where.push(`row.memory_table_row_id IN (${placeholders(exactRowIds.length)})`);
    bindings.push(...exactRowIds);
  }
  if (args.search) {
    const match = ftsQuery(args.search);
    if (!match) return {
      ...compactTable(table),
      dataRevision: Number(table.table.data_revision),
      selectedColumns: selectedColumns.map((column) => column.name),
      rows: [],
      nextCursor: null,
    };
    where.push(`row.rowid IN (
      SELECT rowid FROM memory_table_rows_fts WHERE memory_table_rows_fts MATCH ?
    )`);
    bindings.push(match);
  }
  if (args.filter) where.push(compileFilter(args.filter, columns, bindings));
  const orderBindings: unknown[] = [];
  const order = (args.orderBy ?? []).map((entry) => {
    const column = resolveColumn(entry.column, columns);
    orderBindings.push(column.memory_table_column_id);
    return `(SELECT ordered.${columnSqlField(column)} FROM memory_table_cells ordered
      WHERE ordered.memory_table_row_id = row.memory_table_row_id
        AND ordered.memory_table_column_id = ?) ${entry.direction.toUpperCase()}`;
  });
  order.push("row.updated_at DESC", "row.memory_table_row_id ASC");
  const pageSize = args.pageSize ?? (exactRowIds.length > 0 ? exactRowIds.length : 50);
  const cursor = decodeCursor(args.cursor);
  if (cursor.dataRevision !== null && cursor.dataRevision !== Number(table.table.data_revision)) {
    throw new Error("memory_table_cursor_stale");
  }
  const result = await env.DB.prepare(
    `SELECT row.memory_table_row_id, row.data_json, row.revision,
            row.created_at, row.updated_at, row.last_mutation_id, row.invalidated_at
       FROM memory_table_rows row
      WHERE ${where.join(" AND ")}
      ORDER BY ${order.join(", ")}
      LIMIT ? OFFSET ?`,
  ).bind(...bindings, ...orderBindings, pageSize + 1, cursor.offset).all<RowRecord>();
  const rows = result.results ?? [];
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const currentScopes = await resolveMemoryAccess(env, input);
  if (!currentScopes.some((scope) => scope.memoryScopeId === table.table.memory_scope_id)) {
    throw new Error("memory_table_not_authorized");
  }
  const currentRevision = await env.DB.prepare(
    "SELECT data_revision FROM memory_tables WHERE memory_table_id = ? AND invalidated_at IS NULL",
  ).bind(table.table.memory_table_id).first<{ data_revision: number }>();
  if (!currentRevision || Number(currentRevision.data_revision) !== Number(table.table.data_revision)) {
    throw new Error("memory_table_query_changed_during_read");
  }
  return {
    ...compactTable(table),
    dataRevision: Number(table.table.data_revision),
    selectedColumns: selectedColumns.map((column) => column.name),
    rows: page.map((row) => {
      const values = JSON.parse(row.data_json) as Record<string, unknown>;
      return {
        memoryTableRowId: row.memory_table_row_id,
        revision: Number(row.revision),
        values: Object.fromEntries(selectedColumns.map((column) => [column.name, values[column.name] ?? null])),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
    nextCursor: hasMore
      ? encodeCursor(cursor.offset + pageSize, Number(table.table.data_revision))
      : null,
  };
}

function tableSchemaMatches(table: AuthorizedTable, declaration: z.infer<typeof CreateSchema>): boolean {
  const keyNames = table.keyColumns.map((column) => column.name.toLocaleLowerCase());
  return table.table.description === declaration.description
    && table.table.usage_instructions === declaration.usageInstructions
    && stableJson(keyNames) === stableJson(declaration.keyColumns.map((name) => name.toLocaleLowerCase()))
    && stableJson(table.columns.map((column) => ({
      name: column.name.toLocaleLowerCase(),
      description: column.description,
      type: column.value_type,
      required: column.is_required === 1,
      searchable: column.is_searchable === 1,
    }))) === stableJson(declaration.columns.map((column) => ({ ...column, name: column.name.toLocaleLowerCase() })));
}

async function createTable(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = CreateSchema.parse(raw);
  AutomationMemoryTableSchema.parse({
    name: args.name,
    description: args.description,
    usageInstructions: args.usageInstructions,
    columns: args.columns,
    keyColumns: args.keyColumns,
  });
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("create", args);
  const replay = await loadMutationReceipt(env, input, receiptId, "create", inputHash);
  if (replay) return { output: replay, summary: `Created durable table “${args.name}”`, providerOperationId: String(replay.memoryTableId) };
  const scope = await writableScope(env, input, args.scopeKind);
  const mutationId = await deterministicId("mtm", input.harnessRunId, receiptId);
  const memoryTableId = await deterministicId("mtt", scope.memoryScopeId, args.name.toLocaleLowerCase());
  const existingRow = await env.DB.prepare(
    `SELECT memory_table_id FROM memory_tables
      WHERE memory_scope_id = ? AND name = ? COLLATE NOCASE AND invalidated_at IS NULL`,
  ).bind(scope.memoryScopeId, args.name).first<{ memory_table_id: string }>();
  if (existingRow) {
    const existing = await loadAuthorizedTable(env, input, existingRow.memory_table_id, true);
    if (!tableSchemaMatches(existing, args)) throw new Error("memory_table_name_schema_conflict");
    const result = publicTable(existing);
    await env.DB.prepare(
      `INSERT INTO memory_table_mutations
         (memory_table_mutation_id, receipt_id, memory_table_id, memory_scope_id,
          workspace_id, operation, actor_principal_json, harness_run_id, workstream_id,
          rationale, input_hash, mutation_json, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, 'create', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(harness_run_id, receipt_id) DO NOTHING`,
    ).bind(
      mutationId, receiptId, existing.table.memory_table_id, scope.memoryScopeId,
      input.workspaceId, JSON.stringify(input.executionPrincipal), input.harnessRunId,
      input.workstreamId, args.rationale, inputHash, JSON.stringify(args), JSON.stringify(result), nowIso(),
    ).run();
    return { output: result, summary: `Opened durable table “${args.name}”`, providerOperationId: existing.table.memory_table_id };
  }
  const at = nowIso();
  const columns = args.columns.map((column, index) => ({
    ...column,
    position: index,
    id: `${memoryTableId}:column:${index}`,
  }));
  const byName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
  const keyColumnIds = args.keyColumns.map((name) => byName.get(name.toLocaleLowerCase())!.id);
  const pseudoTable: AuthorizedTable = {
    table: {
      memory_table_id: memoryTableId,
      memory_scope_id: scope.memoryScopeId,
      workspace_id: input.workspaceId,
      scope_kind: scope.kind,
      name: args.name,
      description: args.description,
      usage_instructions: args.usageInstructions,
      key_column_ids_json: JSON.stringify(keyColumnIds),
      schema_revision: 1,
      data_revision: 0,
      last_mutation_id: mutationId,
      invalidated_at: null,
    },
    scope,
    columns: columns.map((column) => ({
      memory_table_column_id: column.id,
      memory_table_id: memoryTableId,
      name: column.name,
      description: column.description,
      value_type: column.type,
      is_required: column.required ? 1 : 0,
      is_searchable: column.searchable ? 1 : 0,
      position: column.position,
    })),
    keyColumns: [],
  };
  pseudoTable.keyColumns = pseudoTable.columns.filter((column) => keyColumnIds.includes(column.memory_table_column_id));
  const result = publicTable(pseudoTable);
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO memory_tables
       (memory_table_id, memory_scope_id, workspace_id, name, description,
        usage_instructions, key_column_ids_json, last_mutation_id, provenance_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    memoryTableId, scope.memoryScopeId, input.workspaceId, args.name, args.description,
    args.usageInstructions, JSON.stringify(keyColumnIds), mutationId,
    JSON.stringify({ source: "agent", harnessRunId: input.harnessRunId, workstreamId: input.workstreamId }), at, at,
  )];
  pseudoTable.columns.forEach((column) => statements.push(env.DB.prepare(
    `INSERT INTO memory_table_columns
       (memory_table_column_id, memory_table_id, name, description, value_type,
        is_required, is_searchable, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    column.memory_table_column_id, memoryTableId, column.name, column.description,
    column.value_type, column.is_required, column.is_searchable, column.position, at,
  )));
  statements.push(mutationAuditStatement(env, input, pseudoTable, {
    mutationId,
    receiptId,
    operation: "create",
    rationale: args.rationale,
    inputHash,
    mutation: args,
    result,
  }));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    const raced = await loadMutationReceipt(env, input, receiptId, "create", inputHash);
    if (raced) return { output: raced, summary: `Created durable table “${args.name}”`, providerOperationId: String(raced.memoryTableId) };
    throw error;
  }
  return { output: result, summary: `Created durable table “${args.name}”`, providerOperationId: memoryTableId };
}

async function insertRows(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = InsertSchema.parse(raw);
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("insert_rows", args);
  const replay = await loadMutationReceipt(env, input, receiptId, "insert_rows", inputHash);
  if (replay) return { output: replay, summary: `Inserted ${Number(replay.insertedCount ?? 0)} new durable rows`, providerOperationId: String(replay.memoryTableMutationId) };
  const table = await loadAuthorizedTable(env, input, args.memoryTableId, true);
  const mutationId = await deterministicId("mtm", input.harnessRunId, receiptId);
  const preparedInput = await Promise.all(args.rows.map(async (rawValues) => {
    const values = normalizeValues(rawValues, table);
    const keyHash = await naturalKeyHash(values, table);
    return {
      rowId: await deterministicId("mtr", table.table.memory_table_id, keyHash),
      keyHash,
      values,
      searchText: searchableText(values, table),
    };
  }));
  const preparedByKey = new Map<string, typeof preparedInput[number]>();
  for (const row of preparedInput) {
    const existing = preparedByKey.get(row.keyHash);
    if (existing && stableJson(existing.values) !== stableJson(row.values)) {
      throw new Error("memory_table_conflicting_natural_key_in_request");
    }
    if (!existing) preparedByKey.set(row.keyHash, row);
  }
  const prepared = [...preparedByKey.values()];
  const at = nowIso();
  const provenance = JSON.stringify({
    source: "agent",
    harnessRunId: input.harnessRunId,
    workstreamId: input.workstreamId,
    executionPrincipal: input.executionPrincipal,
    rationale: args.rationale,
  });
  for (let offset = 0; offset < prepared.length; offset += 40) {
    const chunk = prepared.slice(offset, offset + 40);
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      const current = await env.DB.prepare(
        "SELECT data_revision FROM memory_tables WHERE memory_table_id = ? AND invalidated_at IS NULL",
      ).bind(table.table.memory_table_id).first<{ data_revision: number }>();
      if (!current) throw new Error("memory_table_not_found");
      const statements: D1PreparedStatement[] = [env.DB.prepare(
        `UPDATE memory_tables SET data_revision = data_revision + 1,
             last_mutation_id = ?, updated_at = ?
          WHERE memory_table_id = ? AND data_revision = ? AND invalidated_at IS NULL`,
      ).bind(mutationId, at, table.table.memory_table_id, Number(current.data_revision))];
      for (const row of chunk) {
        statements.push(env.DB.prepare(
          `INSERT INTO memory_table_rows
             (memory_table_row_id, memory_table_id, memory_scope_id, workspace_id,
              natural_key_hash, data_json, searchable_text, provenance_json,
              created_by_mutation_id, last_mutation_id, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM memory_tables WHERE memory_table_id = ? AND last_mutation_id = ?
            )
           ON CONFLICT(memory_table_id, natural_key_hash) DO NOTHING`,
        ).bind(
          row.rowId, table.table.memory_table_id, table.table.memory_scope_id, input.workspaceId,
          row.keyHash, JSON.stringify(row.values), row.searchText, provenance,
          mutationId, mutationId, at, at, table.table.memory_table_id, mutationId,
        ));
        statements.push(...cellStatements(env, table, row.rowId, row.values, mutationId));
      }
      const batch = await env.DB.batch(statements);
      acquired = d1Changes(batch[0]) === 1;
    }
    if (!acquired) throw memoryTableInsertContention();
  }
  const inserted = await env.DB.prepare(
    `SELECT memory_table_row_id, revision, data_json
       FROM memory_table_rows
      WHERE memory_table_id = ? AND created_by_mutation_id = ?
      ORDER BY created_at, memory_table_row_id`,
  ).bind(table.table.memory_table_id, mutationId).all<{
    memory_table_row_id: string;
    revision: number;
    data_json: string;
  }>();
  const insertedRows = (inserted.results ?? []).map((row) => ({
    memoryTableRowId: row.memory_table_row_id,
    revision: Number(row.revision),
    values: JSON.parse(row.data_json) as Record<string, unknown>,
  }));
  const result = {
    memoryTableId: table.table.memory_table_id,
    memoryTableMutationId: mutationId,
    insertedCount: insertedRows.length,
    existingCount: prepared.length - insertedRows.length,
    duplicateInputCount: preparedInput.length - prepared.length,
    insertedRows,
  };
  try {
    await mutationAuditStatement(env, input, table, {
      mutationId,
      receiptId,
      operation: "insert_rows",
      rationale: args.rationale,
      inputHash,
      mutation: { naturalKeyHashes: prepared.map((row) => row.keyHash) },
      result,
    }).run();
  } catch (error) {
    const raced = await loadMutationReceipt(env, input, receiptId, "insert_rows", inputHash);
    if (raced) return { output: raced, summary: `Inserted ${Number(raced.insertedCount ?? 0)} new durable rows`, providerOperationId: String(raced.memoryTableMutationId) };
    throw error;
  }
  return { output: result, summary: `Inserted ${insertedRows.length} new durable rows`, providerOperationId: mutationId };
}

async function loadRowsById(env: Env, tableId: string, rowIds: string[]): Promise<Map<string, RowRecord>> {
  const result = await env.DB.prepare(
    `SELECT memory_table_row_id, data_json, revision, created_at, updated_at,
            last_mutation_id, invalidated_at
       FROM memory_table_rows
      WHERE memory_table_id = ? AND memory_table_row_id IN (${placeholders(rowIds.length)})`,
  ).bind(tableId, ...rowIds).all<RowRecord>();
  return new Map((result.results ?? []).map((row) => [row.memory_table_row_id, row]));
}

async function updateRows(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = UpdateSchema.parse(raw);
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("update_rows", args);
  const replay = await loadMutationReceipt(env, input, receiptId, "update_rows", inputHash);
  if (replay) return { output: replay, summary: `Updated ${Number(replay.updatedCount ?? 0)} durable rows`, providerOperationId: String(replay.memoryTableMutationId) };
  const table = await loadAuthorizedTable(env, input, args.memoryTableId, true);
  const mutationId = await deterministicId("mtm", input.harnessRunId, receiptId);
  const rowIds = args.rows.map((row) => row.memoryTableRowId);
  if (new Set(rowIds).size !== rowIds.length) throw new Error("memory_table_duplicate_row_in_request");
  const currentRows = await loadRowsById(env, table.table.memory_table_id, rowIds);
  const keyNames = new Set(table.keyColumns.map((column) => column.name.toLocaleLowerCase()));
  const prepared = args.rows.map((request) => {
    const current = currentRows.get(request.memoryTableRowId);
    if (!current || current.invalidated_at) throw new Error("memory_table_row_not_found");
    if (current.last_mutation_id !== mutationId && Number(current.revision) !== request.expectedRevision) {
      throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
    }
    const patch = normalizeValues(request.values, table, { patch: true });
    if (Object.keys(patch).length === 0) throw new Error("memory_table_update_empty");
    if (Object.keys(patch).some((name) => keyNames.has(name.toLocaleLowerCase()))) {
      throw new Error("memory_table_key_columns_are_immutable");
    }
    const values = { ...(JSON.parse(current.data_json) as Record<string, unknown>), ...patch };
    normalizeValues(values, table);
    return { request, current, values, searchText: searchableText(values, table) };
  });
  const currentTable = await env.DB.prepare(
    "SELECT data_revision FROM memory_tables WHERE memory_table_id = ? AND invalidated_at IS NULL",
  ).bind(table.table.memory_table_id).first<{ data_revision: number }>();
  if (!currentTable) throw new Error("memory_table_not_found");
  const at = nowIso();
  const result = {
    memoryTableId: table.table.memory_table_id,
    memoryTableMutationId: mutationId,
    updatedCount: prepared.length,
    rows: prepared.map(({ request }) => ({
      memoryTableRowId: request.memoryTableRowId,
      revision: request.expectedRevision + 1,
    })),
  };
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `UPDATE memory_tables SET data_revision = data_revision + 1,
         last_mutation_id = ?, updated_at = ?
      WHERE memory_table_id = ? AND data_revision = ? AND invalidated_at IS NULL`,
  ).bind(mutationId, at, table.table.memory_table_id, Number(currentTable.data_revision))];
  for (const row of prepared) {
    statements.push(env.DB.prepare(
      `UPDATE memory_table_rows
          SET data_json = ?, searchable_text = ?, revision = revision + 1,
              last_mutation_id = ?, updated_at = ?
        WHERE memory_table_row_id = ? AND memory_table_id = ? AND revision = ?
          AND invalidated_at IS NULL
          AND EXISTS (SELECT 1 FROM memory_tables WHERE memory_table_id = ? AND last_mutation_id = ?)`,
    ).bind(
      JSON.stringify(row.values), row.searchText, mutationId, at,
      row.request.memoryTableRowId, table.table.memory_table_id, row.request.expectedRevision,
      table.table.memory_table_id, mutationId,
    ));
    statements.push(env.DB.prepare(
      `DELETE FROM memory_table_cells WHERE memory_table_row_id = ?
        AND EXISTS (SELECT 1 FROM memory_table_rows
          WHERE memory_table_row_id = ? AND last_mutation_id = ?)`,
    ).bind(row.request.memoryTableRowId, row.request.memoryTableRowId, mutationId));
    statements.push(...cellStatements(env, table, row.request.memoryTableRowId, row.values, mutationId));
  }
  statements.push(mutationAuditStatement(env, input, table, {
    mutationId,
    receiptId,
    operation: "update_rows",
    rationale: args.rationale,
    inputHash,
    mutation: { rowIds },
    result,
  }));
  try {
    const batch = await env.DB.batch(statements);
    if (d1Changes(batch[0]) !== 1) throw memoryTableRevisionConflict();
  } catch (error) {
    const raced = await loadMutationReceipt(env, input, receiptId, "update_rows", inputHash);
    if (raced) return { output: raced, summary: `Updated ${Number(raced.updatedCount ?? 0)} durable rows`, providerOperationId: String(raced.memoryTableMutationId) };
    if (isMemoryTableRowRevisionAbort(error)) {
      throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
    }
    throw error;
  }
  return { output: result, summary: `Updated ${prepared.length} durable rows`, providerOperationId: mutationId };
}

async function invalidateRows(
  env: Env,
  input: WorkstreamWorkflowInput,
  raw: unknown,
  context: { providerIdempotencyKey?: string },
): Promise<HarnessToolResult> {
  const args = InvalidateSchema.parse(raw);
  const receiptId = requireReceipt(context);
  const inputHash = await mutationInputHash("invalidate_rows", args);
  const replay = await loadMutationReceipt(env, input, receiptId, "invalidate_rows", inputHash);
  if (replay) return { output: replay, summary: `Invalidated ${Number(replay.invalidatedCount ?? 0)} durable rows`, providerOperationId: String(replay.memoryTableMutationId) };
  const table = await loadAuthorizedTable(env, input, args.memoryTableId, true);
  const mutationId = await deterministicId("mtm", input.harnessRunId, receiptId);
  const rowIds = args.rows.map((row) => row.memoryTableRowId);
  if (new Set(rowIds).size !== rowIds.length) throw new Error("memory_table_duplicate_row_in_request");
  const currentRows = await loadRowsById(env, table.table.memory_table_id, rowIds);
  for (const request of args.rows) {
    const current = currentRows.get(request.memoryTableRowId);
    if (!current || current.invalidated_at) throw new Error("memory_table_row_not_found");
    if (current.last_mutation_id !== mutationId && Number(current.revision) !== request.expectedRevision) {
      throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
    }
  }
  const currentTable = await env.DB.prepare(
    "SELECT data_revision FROM memory_tables WHERE memory_table_id = ? AND invalidated_at IS NULL",
  ).bind(table.table.memory_table_id).first<{ data_revision: number }>();
  if (!currentTable) throw new Error("memory_table_not_found");
  const at = nowIso();
  const result = {
    memoryTableId: table.table.memory_table_id,
    memoryTableMutationId: mutationId,
    invalidatedCount: args.rows.length,
    rows: args.rows.map((row) => ({
      memoryTableRowId: row.memoryTableRowId,
      revision: row.expectedRevision + 1,
    })),
  };
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `UPDATE memory_tables SET data_revision = data_revision + 1,
         last_mutation_id = ?, updated_at = ?
      WHERE memory_table_id = ? AND data_revision = ? AND invalidated_at IS NULL`,
  ).bind(mutationId, at, table.table.memory_table_id, Number(currentTable.data_revision))];
  for (const row of args.rows) statements.push(env.DB.prepare(
    `UPDATE memory_table_rows
        SET revision = revision + 1, invalidated_at = ?, invalidated_by_principal_json = ?,
            invalidation_reason = ?, last_mutation_id = ?, updated_at = ?
      WHERE memory_table_row_id = ? AND memory_table_id = ? AND revision = ?
        AND invalidated_at IS NULL
        AND EXISTS (SELECT 1 FROM memory_tables WHERE memory_table_id = ? AND last_mutation_id = ?)`,
  ).bind(
    at, JSON.stringify(input.executionPrincipal), args.reason, mutationId, at,
    row.memoryTableRowId, table.table.memory_table_id, row.expectedRevision,
    table.table.memory_table_id, mutationId,
  ));
  statements.push(mutationAuditStatement(env, input, table, {
    mutationId,
    receiptId,
    operation: "invalidate_rows",
    rationale: args.reason,
    inputHash,
    mutation: { rowIds },
    result,
  }));
  try {
    const batch = await env.DB.batch(statements);
    if (d1Changes(batch[0]) !== 1) throw memoryTableRevisionConflict();
  } catch (error) {
    const raced = await loadMutationReceipt(env, input, receiptId, "invalidate_rows", inputHash);
    if (raced) return { output: raced, summary: `Invalidated ${Number(raced.invalidatedCount ?? 0)} durable rows`, providerOperationId: String(raced.memoryTableMutationId) };
    if (isMemoryTableRowRevisionAbort(error)) {
      throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
    }
    throw error;
  }
  return { output: result, summary: `Invalidated ${args.rows.length} durable rows`, providerOperationId: mutationId };
}

const filterJsonSchema = { $ref: "#/$defs/filterNode" };
const filterNodeJsonSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        column: { type: "string" },
        op: {
          type: "string",
          enum: [
            "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between",
            "contains", "not_contains", "starts_with", "ends_with", "is_null", "is_not_null",
          ],
        },
        value: {},
      },
      required: ["column", "op"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { all: { type: "array", items: { $ref: "#/$defs/filterNode" } } },
      required: ["all"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: { any: { type: "array", items: { $ref: "#/$defs/filterNode" } } },
      required: ["any"],
    },
  ],
  description: "Closed filter DSL. Unary is_null/is_not_null predicates omit value.",
};

const columnJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    type: { type: "string", enum: ["string", "url", "number", "integer", "boolean", "datetime", "date"] },
    required: { type: "boolean" },
    searchable: { type: "boolean" },
  },
  required: ["name", "description", "type", "required", "searchable"],
};

export function createMemoryTableTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  return [
    {
      definition: {
        name: "search",
        description: "Find structured durable-memory tables across every scope authorized by the host. Scope selectors are not accepted.",
        capability: "table.search",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string" } }, required: ["query"] },
      },
      execute: async (raw) => {
        const args = SearchSchema.parse(raw);
        const result = await tableSearch(env, input, args.query);
        return { output: result, summary: `Found ${result.tables.length} durable tables` };
      },
    },
    {
      definition: {
        name: "describe",
        description: "Read one authorized durable table's schema, natural key, purpose, and usage instructions without loading its rows.",
        capability: "table.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: { type: "object", additionalProperties: false, properties: { memoryTableId: { type: "string" } }, required: ["memoryTableId"] },
      },
      execute: async (raw) => {
        const args = DescribeSchema.parse(raw);
        const table = await loadAuthorizedTable(env, input, args.memoryTableId);
        return { output: publicTable(table), summary: `Described durable table “${table.table.name}”` };
      },
    },
    {
      definition: {
        name: "query",
        description: "Query authorized rows by exact memoryTableRowIds or by typed filters, FTS, ordering, and cursor paging. Use exact IDs to reread rows after a revision conflict.",
        capability: "table.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          $defs: { filterNode: filterNodeJsonSchema },
          properties: {
            memoryTableId: { type: "string" },
            memoryTableRowIds: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } },
            search: { type: "string" },
            filter: filterJsonSchema,
            orderBy: { type: "array", items: { type: "object", additionalProperties: false, properties: { column: { type: "string" }, direction: { type: "string", enum: ["asc", "desc"] } }, required: ["column", "direction"] } },
            select: { type: "array", items: { type: "string" } },
            pageSize: { type: "integer", minimum: 1, maximum: 100 },
            cursor: { type: "string" },
          },
          required: ["memoryTableId"],
        },
      },
      execute: async (raw) => {
        const result = await queryTable(env, input, raw);
        return { output: result, summary: `Read ${result.rows.length} rows from “${result.name}”` };
      },
    },
    {
      definition: {
        name: "create",
        description: "Create a typed durable table in the narrowest host-authorized scope of the requested kind. Natural-key columns make inserts deduplicate safely.",
        capability: "table.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            scopeKind: { type: "string", enum: MEMORY_SCOPE_KINDS },
            name: { type: "string" }, description: { type: "string" }, usageInstructions: { type: "string" },
            columns: { type: "array", items: columnJsonSchema },
            keyColumns: { type: "array", items: { type: "string" } },
            rationale: { type: "string" },
          },
          required: ["scopeKind", "name", "description", "usageInstructions", "columns", "keyColumns", "rationale"],
        },
      },
      execute: (raw, context) => createTable(env, input, raw, context),
    },
    {
      definition: {
        name: "insert_rows",
        description: "Insert rows by natural key, atomically ignoring rows that already exist and returning only rows newly inserted by this call.",
        capability: "table.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: { memoryTableId: { type: "string" }, rows: { type: "array", items: { type: "object" } }, rationale: { type: "string" } },
          required: ["memoryTableId", "rows", "rationale"],
        },
      },
      execute: (raw, context) => insertRows(env, input, raw, context),
    },
    {
      definition: {
        name: "update_rows",
        description: "Patch authorized rows. Copy memoryTableRowId and expectedRevision from table_query; after a revision conflict, call table_query with memoryTableRowIds and rebuild the patch from those exact results. Natural-key columns are immutable.",
        capability: "table.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            memoryTableId: { type: "string" },
            rows: { type: "array", items: { type: "object", additionalProperties: false, properties: { memoryTableRowId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1, description: "Copy revision exactly from table_query for this memoryTableRowId." }, values: { type: "object" } }, required: ["memoryTableRowId", "expectedRevision", "values"] } },
            rationale: { type: "string" },
          },
          required: ["memoryTableId", "rows", "rationale"],
        },
      },
      execute: (raw, context) => updateRows(env, input, raw, context),
    },
    {
      definition: {
        name: "invalidate_rows",
        description: "Reversibly invalidate authorized rows. Copy memoryTableRowId and expectedRevision from table_query; after a revision conflict, call table_query with memoryTableRowIds and retry from those exact results.",
        capability: "table.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            memoryTableId: { type: "string" },
            rows: { type: "array", items: { type: "object", additionalProperties: false, properties: { memoryTableRowId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1, description: "Copy revision exactly from table_query for this memoryTableRowId." } }, required: ["memoryTableRowId", "expectedRevision"] } },
            reason: { type: "string" },
          },
          required: ["memoryTableId", "rows", "reason"],
        },
      },
      execute: (raw, context) => invalidateRows(env, input, raw, context),
    },
  ];
}

export const __memoryTableTesting = {
  compileFilter,
  parseDefinitions,
};
