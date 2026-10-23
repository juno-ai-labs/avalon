import type {
  AutomationMemoryTable,
  MemoryTableColumnType,
  WorkstreamWorkflowInput,
} from "@rally/contracts";
import { AutomationMemoryTableSchema, asWorkspaceId, MEMORY_RECALL_QUERY_LIMIT } from "@rally/contracts";
import { nowIso } from "@rally/db";
import type { HarnessTool, HarnessToolResult } from "@rally/agent-harness";
import { z } from "zod";
import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { sha256 } from "../lib/crypto";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceMemoryReceiptResultSchema,
  WorkspaceMemoryTableCreateResultSchema,
  WorkspaceMemoryTableInsertRowsResultSchema,
  WorkspaceMemoryTableQueryResultSchema,
  WorkspaceMemoryTableResultSchema,
  WorkspaceMemoryTableRowListSchema,
  WorkspaceMemoryTableSearchResultSchema,
  WorkspaceMemoryTableWriteResultSchema,
  type WorkspaceMemoryTableCreateRequest,
  type WorkspaceMemoryTableCreateResult,
  type WorkspaceMemoryTableCell,
  type WorkspaceMemoryTableColumn,
  type WorkspaceMemoryTableFilter,
  type WorkspaceMemoryTableRow,
  type WorkspaceMemoryTableRowRecord,
} from "../durable-objects/workspace-memory-protocol";
import { memoryTableSchemaRecovery, publicMemoryTable } from "../durable-objects/memory-table-definition";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import {
  MEMORY_SCOPE_KINDS,
  ensureScope,
  resolveMemoryAccess,
  writableScope,
  type MemoryScope,
} from "./memory-service";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

type ColumnType = MemoryTableColumnType;

interface AuthorizedTable {
  table: WorkspaceMemoryTableRow;
  columns: WorkspaceMemoryTableColumn[];
  scope: MemoryScope;
  keyColumns: WorkspaceMemoryTableColumn[];
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

const ColumnSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  type: z.enum(["string", "url", "number", "integer", "boolean", "datetime", "date"]),
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
});

const CreateSchema = z.strictObject({
  scopeKind: z.enum(MEMORY_SCOPE_KINDS),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_200),
  usageInstructions: z.string().trim().min(1).max(4_000),
  columns: z.array(ColumnSchema).min(1),
  keyColumns: z.array(z.string().trim().min(1).max(120)).min(1),
  rationale: z.string().trim().min(1).max(2_000),
});

const PredicateSchema = z.strictObject({
  column: z.string().min(1),
  op: z.enum([
    "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between",
    "contains", "not_contains", "starts_with", "ends_with", "is_null", "is_not_null",
  ]),
  value: z.unknown().optional(),
});

const FilterSchema: z.ZodType<FilterNode> = z.lazy(() => z.union([
  PredicateSchema,
  z.strictObject({ all: z.array(FilterSchema) }),
  z.strictObject({ any: z.array(FilterSchema) }),
]));

const QuerySchema = z.strictObject({
  memoryTableId: z.string().min(1),
  memoryTableRowIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  search: z.string().trim().min(1).max(2_000).optional(),
  filter: FilterSchema.optional(),
  orderBy: z.array(z.strictObject({
    column: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  })).optional(),
  select: z.array(z.string().min(1)).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
});

const InsertSchema = z.strictObject({
  memoryTableId: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
  rationale: z.string().trim().min(1).max(2_000),
});

const UpdateSchema = z.strictObject({
  memoryTableId: z.string().min(1),
  rows: z.array(z.strictObject({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    values: z.record(z.string(), z.unknown()),
  })).min(1),
  rationale: z.string().trim().min(1).max(2_000),
});

const InvalidateSchema = z.strictObject({
  memoryTableId: z.string().min(1),
  rows: z.array(z.strictObject({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  })).min(1),
  reason: z.string().trim().min(1).max(2_000),
});

class MemoryTableToolError extends Error {
  override readonly name = "MemoryTableToolError";

  constructor(
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
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

const SearchSchema = z.strictObject({ query: z.string().trim().min(1).max(MEMORY_RECALL_QUERY_LIMIT) });
const DescribeSchema = z.strictObject({ memoryTableId: z.string().min(1) });

/** The WorkspaceDO that owns this workspace's durable-table storage. */
function workspaceMemoryObject(env: Env, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
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

function likePattern(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
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

/**
 * The shape an automation's durable tables are described to a run in.
 *
 * Produced by {@link automationScopeMemoryTables} from whatever lives in the
 * automation's memory scope: the tables its definition declared, created at
 * apply from {@link prepareAutomationMemoryTables}, and any a run made for
 * itself with the `create` tool.
 */
export interface MaterializedMemoryTable {
  memoryTableId: string;
  memoryScopeId: string;
  scopeKind: "sidekick";
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

async function loadAuthorizedTable(
  env: Env,
  input: WorkstreamWorkflowInput,
  memoryTableId: string,
  requireWritable = false,
): Promise<AuthorizedTable> {
  const scopes = await resolveMemoryAccess(env, input);
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const found = WorkspaceMemoryTableResultSchema.parse(await workspace.memoryTableWithColumns({
    workspaceId: input.workspaceId,
    memoryTableId,
  }));
  if (found.outcome !== "found" || found.table.invalidatedAt) {
    throw new Error("memory_table_not_found");
  }
  const scope = scopes.find((candidate) => candidate.memoryScopeId === found.table.memoryScopeId);
  if (!scope) throw new Error("memory_table_not_authorized");
  if (requireWritable && !scope.writable) throw new Error(`memory_scope_not_writable:${scope.kind}`);
  const keyIds = new Set(JSON.parse(found.table.keyColumnIdsJson) as string[]);
  const keyColumns = found.columns.filter((column) => keyIds.has(column.memoryTableColumnId));
  if (keyColumns.length === 0) throw new Error("memory_table_key_schema_invalid");
  return { table: found.table, columns: found.columns, scope, keyColumns };
}

function publicTable(table: AuthorizedTable) {
  return publicMemoryTable(table.table, table.columns);
}

function compactTable(table: AuthorizedTable) {
  return {
    memoryTableId: table.table.memoryTableId,
    memoryScopeId: table.table.memoryScopeId,
    scopeKind: table.table.scopeKind,
    name: table.table.name,
    description: table.table.description,
    keyColumns: table.keyColumns.map((column) => column.name),
  };
}

function columnMap(columns: WorkspaceMemoryTableColumn[]): Map<string, WorkspaceMemoryTableColumn> {
  const result = new Map<string, WorkspaceMemoryTableColumn>();
  for (const column of columns) {
    result.set(column.memoryTableColumnId, column);
    result.set(column.name.toLocaleLowerCase(), column);
  }
  return result;
}

function resolveColumn(
  reference: string,
  columns: Map<string, WorkspaceMemoryTableColumn>,
): WorkspaceMemoryTableColumn {
  const column = columns.get(reference) ?? columns.get(reference.toLocaleLowerCase());
  if (!column) throw new Error(`memory_table_unknown_column:${reference}`);
  return column;
}

function normalizeValue(column: WorkspaceMemoryTableColumn, value: unknown): unknown {
  if (value === null) return null;
  switch (column.valueType) {
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
      if (column.isRequired && (!Object.hasOwn(normalized, column.name) || normalized[column.name] === null)) {
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
    .filter((column) => column.isSearchable)
    .flatMap((column) => {
      const value = values[column.name];
      return value == null ? [] : [`${column.name}: ${String(value)}`];
    })
    .join("\n");
}

/** The typed cell projections for one row's values, nulls omitted. */
function cellsForValues(
  table: AuthorizedTable,
  values: Record<string, unknown>,
): WorkspaceMemoryTableCell[] {
  return table.columns.flatMap((column) => {
    const value = values[column.name];
    if (value === null || value === undefined) return [];
    let stringValue: string | null = null;
    let numberValue: number | null = null;
    let booleanValue: number | null = null;
    let temporalValue: string | null = null;
    if (column.valueType === "string" || column.valueType === "url") stringValue = String(value);
    else if (column.valueType === "number" || column.valueType === "integer") numberValue = Number(value);
    else if (column.valueType === "boolean") booleanValue = value ? 1 : 0;
    else temporalValue = String(value);
    return [{
      memoryTableColumnId: column.memoryTableColumnId,
      valueType: column.valueType,
      stringValue,
      numberValue,
      booleanValue,
      temporalValue,
    }];
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
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const receipt = WorkspaceMemoryReceiptResultSchema.parse(
    await workspace.memoryTableMutationReceipt({
      workspaceId: input.workspaceId,
      harnessRunId: input.harnessRunId,
      receiptId,
    }),
  );
  if (receipt.outcome === "none") return null;
  if (receipt.operation !== operation || receipt.inputHash !== inputHash) {
    throw new Error("memory_table_mutation_receipt_mismatch");
  }
  return JSON.parse(receipt.resultJson) as Record<string, unknown>;
}

function mutationRecord(
  input: WorkstreamWorkflowInput,
  args: {
    mutationId: string;
    receiptId: string;
    operation: "create" | "insert_rows" | "update_rows" | "invalidate_rows";
    rationale: string;
    inputHash: string;
    mutation: unknown;
    result: unknown;
  },
) {
  return {
    memoryTableMutationId: args.mutationId,
    receiptId: args.receiptId,
    operation: args.operation,
    actorPrincipalJson: JSON.stringify(input.executionPrincipal),
    harnessRunId: input.harnessRunId,
    workstreamId: input.parentId,
    rationale: args.rationale,
    inputHash: args.inputHash,
    mutationJson: JSON.stringify(args.mutation),
    resultJson: JSON.stringify(args.result),
  };
}

function columnSqlField(
  column: WorkspaceMemoryTableColumn,
): "string_value" | "number_value" | "boolean_value" | "temporal_value" {
  if (column.valueType === "string" || column.valueType === "url") return "string_value";
  if (column.valueType === "number" || column.valueType === "integer") return "number_value";
  if (column.valueType === "boolean") return "boolean_value";
  return "temporal_value";
}

function normalizePredicateValue(
  column: WorkspaceMemoryTableColumn,
  value: unknown,
): string | number | null {
  const normalized = normalizeValue(column, value);
  if (column.valueType === "boolean" && normalized !== null) return normalized ? 1 : 0;
  return normalized as string | number | null;
}

/**
 * Resolve a model-supplied filter against the authorized schema: column
 * references become column ids, values are coerced to their column's type,
 * and each operator becomes one member of the protocol's closed predicate
 * set. The object compiles the result to SQL without consulting the schema,
 * so every semantic rule — which operators a type accepts, what a unary
 * predicate may carry — is enforced here, where the refusal can name the
 * model's own column reference.
 */
function normalizeFilter(
  node: FilterNode,
  columns: Map<string, WorkspaceMemoryTableColumn>,
  depth = 0,
): WorkspaceMemoryTableFilter {
  if (depth > 4) throw new Error("memory_table_filter_too_deep");
  if ("all" in node || "any" in node) {
    const isAll = "all" in node;
    const children = (isAll ? node.all : node.any)
      .map((child) => normalizeFilter(child, columns, depth + 1));
    return isAll ? { all: children } : { any: children };
  }
  const column = resolveColumn(node.column, columns);
  const columnId = column.memoryTableColumnId;
  const field = columnSqlField(column);
  if (node.op === "is_null" || node.op === "is_not_null") {
    if (node.value !== undefined) throw new Error("memory_table_filter_unary_value_forbidden");
    return { op: node.op === "is_null" ? "not_exists" : "exists", columnId };
  }
  if (node.value === undefined) throw new Error("memory_table_filter_value_required");
  if (node.op === "in" || node.op === "not_in") {
    if (!Array.isArray(node.value) || node.value.length === 0) throw new Error("memory_table_filter_set_required");
    const values = node.value.map((value) => normalizePredicateValue(column, value));
    return {
      op: "in",
      columnId,
      field,
      valuesJson: JSON.stringify(values),
      negated: node.op === "not_in",
    };
  }
  if (node.op === "between") {
    if (!node.value || typeof node.value !== "object" || Array.isArray(node.value)) throw new Error("memory_table_filter_range_required");
    const range = node.value as { from?: unknown; to?: unknown };
    return {
      op: "between",
      columnId,
      field,
      from: normalizePredicateValue(column, range.from),
      to: normalizePredicateValue(column, range.to),
    };
  }
  if (["contains", "not_contains", "starts_with", "ends_with"].includes(node.op)) {
    if (column.valueType !== "string" && column.valueType !== "url") throw new Error("memory_table_filter_string_operator_required");
    const value = likePattern(String(normalizePredicateValue(column, node.value)));
    let pattern: string;
    if (node.op === "starts_with") pattern = `${value}%`;
    else if (node.op === "ends_with") pattern = `%${value}`;
    else pattern = `%${value}%`;
    return { op: "like", columnId, pattern, negated: node.op === "not_contains" };
  }
  if (!["eq", "neq", "gt", "gte", "lt", "lte"].includes(node.op)) {
    throw new Error("memory_table_filter_operator_invalid");
  }
  return {
    op: "compare",
    columnId,
    field,
    comparison: node.op as "eq" | "neq" | "gt" | "gte" | "lt" | "lte",
    value: normalizePredicateValue(column, node.value),
  };
}

/** How many tables one search or one scope listing hands back. */
const MEMORY_TABLE_SEARCH_LIMIT = 20;

async function tableSearch(env: Env, input: WorkstreamWorkflowInput, query: string) {
  const scopes = await resolveMemoryAccess(env, input);
  if (scopes.length === 0) return { query, tables: [] };
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const found = WorkspaceMemoryTableSearchResultSchema.parse(await workspace.searchMemoryTables({
    workspaceId: input.workspaceId,
    scopeIds: scopes.map((scope) => scope.memoryScopeId),
    like: `%${likePattern(query)}%`,
    limit: MEMORY_TABLE_SEARCH_LIMIT,
  }));
  const tables = [];
  for (const memoryTableId of found.memoryTableIds) {
    const table = await loadAuthorizedTable(env, input, memoryTableId);
    tables.push(compactTable(table));
  }
  return { query, tables };
}

async function queryTable(env: Env, input: WorkstreamWorkflowInput, raw: unknown) {
  const args = QuerySchema.parse(raw);
  const table = await loadAuthorizedTable(env, input, args.memoryTableId);
  const columns = columnMap(table.columns);
  const selectedColumns = args.select?.map((reference) => resolveColumn(reference, columns)) ?? table.columns;
  const selectedIds = new Set(selectedColumns.map((column) => column.memoryTableColumnId));
  if (selectedIds.size !== selectedColumns.length) throw new Error("memory_table_select_duplicate");
  const exactRowIds = args.memoryTableRowIds ? [...new Set(args.memoryTableRowIds)] : [];
  let ftsMatch: string | null = null;
  if (args.search) {
    const match = ftsQuery(args.search);
    if (!match) return {
      ...compactTable(table),
      dataRevision: table.table.dataRevision,
      selectedColumns: selectedColumns.map((column) => column.name),
      rows: [],
      nextCursor: null,
    };
    ftsMatch = match;
  }
  const filter = args.filter ? normalizeFilter(args.filter, columns) : null;
  const orderBy = (args.orderBy ?? []).map((entry) => {
    const column = resolveColumn(entry.column, columns);
    return {
      columnId: column.memoryTableColumnId,
      field: columnSqlField(column),
      direction: entry.direction,
    };
  });
  const pageSize = args.pageSize ?? (exactRowIds.length > 0 ? exactRowIds.length : 50);
  const cursor = decodeCursor(args.cursor);
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const result = WorkspaceMemoryTableQueryResultSchema.parse(await workspace.queryMemoryTableRows({
    workspaceId: input.workspaceId,
    memoryTableId: table.table.memoryTableId,
    exactRowIds: exactRowIds.length > 0 ? exactRowIds : null,
    ftsMatch,
    filter,
    orderBy,
    limit: pageSize + 1,
    offset: cursor.offset,
  }));
  if (result.outcome !== "found") throw new Error("memory_table_not_found");
  // The page and this revision were read in one object event, so a cursor is
  // judged against the revision its rows actually came from. The separate
  // `memory_table_query_changed_during_read` failure existed because the read
  // and the re-check were two facade round trips; that window is gone.
  if (cursor.dataRevision !== null && cursor.dataRevision !== result.dataRevision) {
    throw new Error("memory_table_cursor_stale");
  }
  const hasMore = result.rows.length > pageSize;
  const page = result.rows.slice(0, pageSize);
  const currentScopes = await resolveMemoryAccess(env, input);
  if (!currentScopes.some((scope) => scope.memoryScopeId === table.table.memoryScopeId)) {
    throw new Error("memory_table_not_authorized");
  }
  return {
    ...compactTable(table),
    dataRevision: result.dataRevision,
    selectedColumns: selectedColumns.map((column) => column.name),
    rows: page.map((row) => {
      const values = JSON.parse(row.dataJson) as Record<string, unknown>;
      return {
        memoryTableRowId: row.memoryTableRowId,
        revision: row.revision,
        values: Object.fromEntries(selectedColumns.map((column) => [column.name, values[column.name] ?? null])),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    }),
    nextCursor: hasMore
      ? encodeCursor(cursor.offset + pageSize, result.dataRevision)
      : null,
  };
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
  const at = nowIso();
  const columns = args.columns.map((column, index) => ({
    memoryTableColumnId: `${memoryTableId}:column:${index}`,
    memoryTableId,
    name: column.name,
    description: column.description,
    valueType: column.type,
    isRequired: column.required,
    isSearchable: column.searchable,
    position: index,
  }));
  const byName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
  const keyColumnIds = args.keyColumns.map((name) => byName.get(name.toLocaleLowerCase())!.memoryTableColumnId);
  const pseudoTable: AuthorizedTable = {
    table: {
      memoryTableId,
      memoryScopeId: scope.memoryScopeId,
      workspaceId: input.workspaceId,
      scopeKind: scope.kind,
      name: args.name,
      description: args.description,
      usageInstructions: args.usageInstructions,
      keyColumnIdsJson: JSON.stringify(keyColumnIds),
      schemaRevision: 1,
      dataRevision: 0,
      invalidatedAt: null,
    },
    scope,
    columns,
    keyColumns: columns.filter((column) => keyColumnIds.includes(column.memoryTableColumnId)),
  };
  const result = publicTable(pseudoTable);
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryTableCreateResultSchema.parse(await workspace.createMemoryTable({
    workspaceId: input.workspaceId,
    memoryTableId,
    memoryScopeId: scope.memoryScopeId,
    name: args.name,
    description: args.description,
    usageInstructions: args.usageInstructions,
    keyColumnIdsJson: JSON.stringify(keyColumnIds),
    provenanceJson: JSON.stringify({
      source: "agent",
      harnessRunId: input.harnessRunId,
      workstreamId: input.parentId,
    }),
    // The request's column shape is strict and does not carry the table id the
    // object already has; the id-bearing shape above exists for `pseudoTable`.
    columns: columns.map((column) => ({
      memoryTableColumnId: column.memoryTableColumnId,
      name: column.name,
      description: column.description,
      valueType: column.valueType,
      isRequired: column.isRequired,
      isSearchable: column.isSearchable,
      position: column.position,
    })),
    mutation: mutationRecord(input, {
      mutationId, receiptId, operation: "create", rationale: args.rationale,
      inputHash, mutation: args, result,
    }),
    at,
  }));
  if (outcome.outcome === "replayed" || outcome.outcome === "opened") {
    const recorded = JSON.parse(outcome.resultJson) as Record<string, unknown>;
    return { output: recorded, summary: `Opened durable table “${args.name}”`, providerOperationId: String(recorded.memoryTableId) };
  }
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_table_mutation_receipt_mismatch");
  if (outcome.outcome === "schema_conflict") {
    throw new MemoryTableToolError("memory_table_name_schema_conflict",
      `Table “${args.name}” already exists; incompatible fields: ${outcome.fields.join(", ")}.`,
      { memoryTableId: outcome.memoryTableId, fields: outcome.fields, field: outcome.fields[0], retryable: false, reason: memoryTableSchemaRecovery(outcome.memoryTableId) });
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
      rowId: await deterministicId("mtr", table.table.memoryTableId, keyHash),
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
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryTableInsertRowsResultSchema.parse(
    await workspace.insertMemoryTableRows({
      workspaceId: input.workspaceId,
      memoryTableId: table.table.memoryTableId,
      rows: prepared.map((row) => ({
        memoryTableRowId: row.rowId,
        naturalKeyHash: row.keyHash,
        dataJson: JSON.stringify(row.values),
        searchableText: row.searchText,
        cells: cellsForValues(table, row.values),
      })),
      provenanceJson: JSON.stringify({
        source: "agent",
        harnessRunId: input.harnessRunId,
        workstreamId: input.parentId,
        executionPrincipal: input.executionPrincipal,
        rationale: args.rationale,
      }),
      duplicateInputCount: preparedInput.length - prepared.length,
      mutation: {
        memoryTableMutationId: mutationId,
        receiptId,
        operation: "insert_rows",
        actorPrincipalJson: JSON.stringify(input.executionPrincipal),
        harnessRunId: input.harnessRunId,
        workstreamId: input.parentId,
        rationale: args.rationale,
        inputHash,
        mutationJson: JSON.stringify({ naturalKeyHashes: prepared.map((row) => row.keyHash) }),
      },
      at: nowIso(),
    }),
  );
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_table_mutation_receipt_mismatch");
  if (outcome.outcome === "table_not_found") throw new Error("memory_table_not_found");
  const result = JSON.parse(outcome.resultJson) as Record<string, unknown>;
  return {
    output: result,
    summary: `Inserted ${Number(result.insertedCount ?? 0)} new durable rows`,
    providerOperationId: String(result.memoryTableMutationId),
  };
}

async function loadRowsById(
  env: Env,
  workspaceId: string,
  tableId: string,
  rowIds: string[],
): Promise<Map<string, WorkspaceMemoryTableRowRecord>> {
  const workspace = await workspaceMemoryObject(env, workspaceId);
  const result = WorkspaceMemoryTableRowListSchema.parse(await workspace.memoryTableRowsById({
    workspaceId,
    memoryTableId: tableId,
    memoryTableRowIds: rowIds,
  }));
  return new Map(result.rows.map((row) => [row.memoryTableRowId, row]));
}

/** Map a table-write outcome's refusals to the service's own errors. */
function refuseTableWrite(outcome: { outcome: string }): void {
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_table_mutation_receipt_mismatch");
  if (outcome.outcome === "table_not_found") throw new Error("memory_table_not_found");
  if (outcome.outcome === "row_not_found") throw new Error("memory_table_row_not_found");
  if (outcome.outcome === "row_revision_conflict") {
    throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
  }
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
  const currentRows = await loadRowsById(env, input.workspaceId, table.table.memoryTableId, rowIds);
  const keyNames = new Set(table.keyColumns.map((column) => column.name.toLocaleLowerCase()));
  const prepared = args.rows.map((request) => {
    const current = currentRows.get(request.memoryTableRowId);
    if (!current || current.invalidatedAt) throw new Error("memory_table_row_not_found");
    if (current.revision !== request.expectedRevision) {
      throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
    }
    const patch = normalizeValues(request.values, table, { patch: true });
    if (Object.keys(patch).length === 0) throw new Error("memory_table_update_empty");
    if (Object.keys(patch).some((name) => keyNames.has(name.toLocaleLowerCase()))) {
      throw new Error("memory_table_key_columns_are_immutable");
    }
    const values = { ...(JSON.parse(current.dataJson) as Record<string, unknown>), ...patch };
    normalizeValues(values, table);
    return { request, values, searchText: searchableText(values, table) };
  });
  const result = {
    memoryTableId: table.table.memoryTableId,
    memoryTableMutationId: mutationId,
    updatedCount: prepared.length,
    rows: prepared.map(({ request }) => ({
      memoryTableRowId: request.memoryTableRowId,
      revision: request.expectedRevision + 1,
    })),
  };
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryTableWriteResultSchema.parse(
    await workspace.updateMemoryTableRows({
      workspaceId: input.workspaceId,
      memoryTableId: table.table.memoryTableId,
      rows: prepared.map((row) => ({
        memoryTableRowId: row.request.memoryTableRowId,
        expectedRevision: row.request.expectedRevision,
        dataJson: JSON.stringify(row.values),
        searchableText: row.searchText,
        cells: cellsForValues(table, row.values),
      })),
      mutation: mutationRecord(input, {
        mutationId, receiptId, operation: "update_rows", rationale: args.rationale,
        inputHash, mutation: { rowIds }, result,
      }),
      at: nowIso(),
    }),
  );
  if (outcome.outcome === "replayed") {
    const recorded = JSON.parse(outcome.resultJson) as Record<string, unknown>;
    return { output: recorded, summary: `Updated ${Number(recorded.updatedCount ?? 0)} durable rows`, providerOperationId: String(recorded.memoryTableMutationId) };
  }
  refuseTableWrite(outcome);
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
  const currentRows = await loadRowsById(env, input.workspaceId, table.table.memoryTableId, rowIds);
  for (const request of args.rows) {
    const current = currentRows.get(request.memoryTableRowId);
    if (!current || current.invalidatedAt) throw new Error("memory_table_row_not_found");
    if (current.revision !== request.expectedRevision) {
      throw memoryTableRevisionConflict("memory_table_row_revision_conflict");
    }
  }
  const result = {
    memoryTableId: table.table.memoryTableId,
    memoryTableMutationId: mutationId,
    invalidatedCount: args.rows.length,
    rows: args.rows.map((row) => ({
      memoryTableRowId: row.memoryTableRowId,
      revision: row.expectedRevision + 1,
    })),
  };
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const outcome = WorkspaceMemoryTableWriteResultSchema.parse(
    await workspace.invalidateMemoryTableRows({
      workspaceId: input.workspaceId,
      memoryTableId: table.table.memoryTableId,
      rows: args.rows.map((row) => ({
        memoryTableRowId: row.memoryTableRowId,
        expectedRevision: row.expectedRevision,
      })),
      reason: args.reason,
      actorPrincipalJson: JSON.stringify(input.executionPrincipal),
      mutation: mutationRecord(input, {
        mutationId, receiptId, operation: "invalidate_rows", rationale: args.reason,
        inputHash, mutation: { rowIds }, result,
      }),
      at: nowIso(),
    }),
  );
  if (outcome.outcome === "replayed") {
    const recorded = JSON.parse(outcome.resultJson) as Record<string, unknown>;
    return { output: recorded, summary: `Invalidated ${Number(recorded.invalidatedCount ?? 0)} durable rows`, providerOperationId: String(recorded.memoryTableMutationId) };
  }
  refuseTableWrite(outcome);
  return { output: result, summary: `Invalidated ${args.rows.length} durable rows`, providerOperationId: mutationId };
}

const filterJsonSchema = {
  $ref: "#/$defs/filterNode",
  description: "Return only rows matching this condition. One predicate is `{\"column\": \"state\", \"op\": \"eq\", \"value\": \"open\"}`; combine several with `{\"all\": [ … ]}` for and, `{\"any\": [ … ]}` for or, nested at most four levels deep — beyond that the filter is refused. Omit it for every row. A column the table does not have, and a value whose type its column will not take, are both refused with an error naming the column — so call table_describe first and match each column's declared type. What is silent is a well-formed condition nothing satisfies: that returns an empty page, which is an answer about the rows rather than a fault in the filter.",
};
const filterNodeJsonSchema = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {
        column: { type: "string", description: "The column to test, spelled exactly as table_describe gives it." },
        op: {
          type: "string",
          enum: [
            "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between",
            "contains", "not_contains", "starts_with", "ends_with", "is_null", "is_not_null",
          ],
          description: "How to compare. `eq` and `neq` test one value; `in` and `not_in` test a list; `gt`, `gte`, `lt`, and `lte` order it; `between` takes a `from` and a `to` and includes both; `contains`, `not_contains`, `starts_with`, and `ends_with` match text; `is_null` and `is_not_null` take no value at all.",
        },
        value: { description: "What to compare against, shaped by the operator: one value for `eq` and `neq`, a non-empty list for `in` and `not_in`, an object `{\"from\": …, \"to\": …}` for `between` — an array is refused there, and both bounds are required — and nothing at all for `is_null` and `is_not_null`. Match the column's own type: a datetime column wants an ISO 8601 timestamp such as `2026-09-10T00:00:00Z` and a date column a plain `2026-09-10`, and anything else is refused rather than matched against." },
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
    name: { type: "string", description: "The column's name as every later call spells it, for example repository_full_name. Pick it once: renaming a column later is not possible." },
    description: { type: "string", description: "What this column holds, written for a run a year from now that has only the schema to go on, for example \"Owner and repository, as owner/name\"." },
    type: { type: "string", enum: ["string", "url", "number", "integer", "boolean", "datetime", "date"], description: "The column's type, which decides how filters compare it. Use datetime for an ISO 8601 timestamp and date for a plain calendar date; string holds either as text and compares it character by character." },
    required: { type: "boolean", description: "Refuse a row that leaves this column empty. Use it for the columns a row is meaningless without." },
    searchable: { type: "boolean", description: "Include this column in the free-text search that table_query's `search` runs. Set it on the prose columns; a numeric or boolean column gains nothing from it. A table with no searchable column returns nothing for every search, and columns cannot be changed later, so decide it here." },
  },
  required: ["name", "description", "type", "required", "searchable"],
};

export function createMemoryTableTools(env: Env, input: WorkstreamWorkflowInput): HarnessTool[] {
  env = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  const tools: HarnessTool[] = [
    {
      definition: {
        name: "search",
        description: "Find structured durable-memory tables across every scope authorized by the host. Scope selectors are not accepted. query is 1 to 2000 characters.",
        capability: "table.search",
        mode: "read",
        idempotency: "safe",
        // The bounds are declared, not just enforced. `SearchSchema` has always
        // rejected a query outside 1..2000, and the schema the model was shown
        // said only `string` — so the one argument this tool takes could be
        // built out of a long transcript excerpt, pass everything the model
        // could see, and be refused by a bound nothing had told it about.
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            query: {
              type: "string",
              minLength: 1,
              maxLength: MEMORY_RECALL_QUERY_LIMIT,
              description: "What the table would be about, in plain words, for example \"repositories already reviewed\". It matches each table's name, purpose, and usage instructions rather than the rows inside them, so words that only appear in a row find nothing; when no table matches, the answer is an empty list rather than an error.",
            },
          },
          required: ["query"],
        },
      },
      // Not for the length — the declared bound above covers that, and the
      // runtime's own `validateToolArguments` reads it. This is for `.trim()`,
      // which JSON Schema cannot express: `{ query: "   " }` satisfies
      // `minLength: 1` and is refused only by `SearchSchema`. Without the hook
      // the runtime reads that refusal as the tool's own data being bad and
      // tells the model to retry *without changing its arguments*. Item 12 in
      // `docs/agent-tools.md` is the rule.
      validateInput: (raw) => {
        const result = SearchSchema.safeParse(raw);
        return result.success ? null : result.error;
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
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {
            memoryTableId: {
              type: "string",
              description: "The table to describe, as the `memoryTableId` table_search returned for it. The table's name is not its id.",
            },
          },
          required: ["memoryTableId"],
        },
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
        pagination: { cursorParameter: "cursor" },
        description: "Query authorized rows by exact memoryTableRowIds or by typed filters, FTS, ordering, and page-ID paging. Use exact IDs to reread rows after a revision conflict.",
        capability: "table.read",
        mode: "read",
        idempotency: "safe",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          $defs: { filterNode: filterNodeJsonSchema },
          properties: {
            memoryTableId: { type: "string", description: "The table to read, as the `memoryTableId` table_search returned for it." },
            memoryTableRowIds: {
              type: "array",
              minItems: 1,
              maxItems: 100,
              items: { type: "string" },
              description: "Read exactly these rows, as `memoryTableRowId` values an earlier query returned, at most 100. Use it to reread rows after a revision conflict. A row id that no longer exists is simply absent from the result rather than an error, so check that every id you sent came back.",
            },
            search: {
              type: "string",
              description: "Free-text words matched against the columns declared `searchable` at create time, for example \"timeout\". Call table_describe to see which columns those are: a table with none returns nothing for any search, which reads as an empty table rather than a mistake.",
            },
            filter: filterJsonSchema,
            orderBy: {
              type: "array",
              description: "Sort the rows, most significant key first. Omit it for the table's own insertion order.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  column: { type: "string", description: "A column name from table_describe, spelled exactly." },
                  direction: { type: "string", enum: ["asc", "desc"], description: "`asc` for smallest or earliest first, `desc` for largest or most recent first." },
                },
                required: ["column", "direction"],
              },
            },
            select: {
              type: "array",
              items: { type: "string" },
              description: "Return only these columns, spelled as table_describe gives them, for example [\"repository_full_name\", \"reviewed_at\"]. Omit it for every column. `memoryTableRowId` and each row's revision always come back regardless.",
            },
            pageSize: { type: "integer", minimum: 1, maximum: 100, description: "Maximum rows to return in one page. Defaults to 50, or to the number of `memoryTableRowIds` when those are given." },
            cursor: {
              type: "string",
              description: "Continue an earlier query: pass back the exact cursor that call returned, with its other arguments unchanged. Omit it for the first page, and stop when a result returns no cursor. It is an opaque token, not a row number, so never construct or increment one.",
            },
          },
          required: ["memoryTableId"],
        },
      },
      execute: async (raw) => {
        const result = await queryTable(env, input, raw);
        const { nextCursor, ...output } = result;
        const args = QuerySchema.parse(raw);
        return { output, summary: `Read ${result.rows.length} rows from “${result.name}”`,
          pagination: { continuations: nextCursor ? [{ operation: "query", slot: "nextPageId" as const,
            input: { ...args, cursor: nextCursor } }] : [] },
        };
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
            scopeKind: {
              type: "string",
              enum: MEMORY_SCOPE_KINDS,
              description: "How long the table should outlive this run, narrowest first: `workstream` for this thread alone, `sidekick` for future runs of this installed Sidekick, `user` for one person, `workspace` for everyone in the organization. Not every run authorizes every kind; a refusal names the ones this run does have.",
            },
            name: { type: "string", description: "A short name for the table, for example \"Reviewed repositories\". A table already under this name in the chosen scope is reopened when its schema matches: column names, types, required/searchable flags, and ordered key columns. Description, usage instructions, and column descriptions are updated without changing rows or IDs. On a schema conflict, call table_describe with the returned memoryTableId and reuse that schema, or choose a new name and explicitly migrate rows. Do not retry unchanged." },
            description: { type: "string", description: "What the table holds and why it exists, in a sentence or two. This is what table_search matches, so write the words someone would look for." },
            usageInstructions: { type: "string", description: "How a later run should use this table: when to insert, when to update, and what each unusual column means. Write it for a run that has never seen this table and cannot ask you." },
            columns: { type: "array", items: columnJsonSchema, description: "The table's columns, at least one. Columns cannot be added or renamed afterwards, so declare the ones the work will need rather than the minimum for the first row." },
            keyColumns: {
              type: "array",
              items: { type: "string" },
              description: "The columns that together identify one real thing, for example [\"repository_full_name\"]. Rows are deduplicated on them, so two runs inserting the same thing produce one row. Choose values a later run can rebuild from the outside world; a key including a timestamp or a random id deduplicates nothing.",
            },
            rationale: { type: "string", description: "Why this table is being created, in one or two sentences, for the person reviewing what the run did." },
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
          properties: {
            memoryTableId: { type: "string", description: "The table to insert into, as the `memoryTableId` table_search or table_create returned." },
            rows: {
              type: "array",
              items: { type: "object" },
              description: "The rows to insert, each an object keyed by column name exactly as table_describe spells it, for example [{\"repository_full_name\": \"acme/site\", \"reviewed_at\": \"2026-09-10T00:00:00Z\"}]. A key that is not a column is refused. A row whose natural key already exists is skipped rather than duplicated or reported as an error, so the result lists only what this call actually inserted.",
            },
            rationale: { type: "string", description: "Why these rows are being written, in one or two sentences, for the person reviewing what the run did." },
          },
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
            memoryTableId: { type: "string", description: "The table holding these rows, as the `memoryTableId` table_query returned." },
            rows: {
              type: "array",
              description: "The rows to patch, each naming one row and the columns to change on it.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  memoryTableRowId: { type: "string", description: "The row to patch, copied exactly from the latest table_query result." },
                  expectedRevision: { type: "integer", minimum: 1, description: "Copy revision exactly from table_query for this memoryTableRowId." },
                  values: { type: "object", description: "Only the columns to change, keyed by column name as table_describe spells them, for example {\"reviewed_at\": \"2026-09-10T00:00:00Z\"}. Columns left out keep their current values. A natural-key column cannot be changed, and a key that is not a column is refused." },
                },
                required: ["memoryTableRowId", "expectedRevision", "values"],
              },
            },
            rationale: { type: "string", description: "Why these rows are changing, in one or two sentences, for the person reviewing what the run did." },
          },
          required: ["memoryTableId", "rows", "rationale"],
        },
      },
      execute: (raw, context) => updateRows(env, input, raw, context),
    },
    {
      definition: {
        name: "invalidate_rows",
        description: "Retire authorized rows so they stop being returned. This is final for these tools: nothing restores an invalidated row, a later update on one is refused, and its natural key stays taken — so re-inserting the same fact is silently skipped as a duplicate rather than bringing it back. Copy memoryTableRowId and expectedRevision from table_query; after a revision conflict, call table_query with memoryTableRowIds and retry from those exact results.",
        capability: "table.write",
        mode: "write",
        idempotency: "provider_key",
        inputSchema: {
          type: "object", additionalProperties: false,
          properties: {
            memoryTableId: { type: "string", description: "The table holding these rows, as the `memoryTableId` table_query returned." },
            rows: {
              type: "array",
              description: "The rows to invalidate, each named by id and by the revision this call expects it to still be at.",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  memoryTableRowId: { type: "string", description: "The row to invalidate, copied exactly from the latest table_query result." },
                  expectedRevision: { type: "integer", minimum: 1, description: "Copy revision exactly from table_query for this memoryTableRowId." },
                },
                required: ["memoryTableRowId", "expectedRevision"],
              },
            },
            reason: { type: "string", description: "Why these rows no longer hold, in one or two sentences, for the person reviewing what the run did. Nothing here brings a row back, and its natural key stays taken, so be sure before sending this." },
          },
          required: ["memoryTableId", "rows", "reason"],
        },
      },
      execute: (raw, context) => invalidateRows(env, input, raw, context),
    },
  ];
  return tools;
}

export const __memoryTableTesting = {
  normalizeFilter,
};

/**
 * The tables an automation's definition declares, created in its memory scope.
 *
 * Called from the automation's apply, after the revision is accepted. A
 * declaration that no run could find was dead data: the draft asked the model
 * for tables, the definition carried them, and nothing made them. Creation
 * goes through the same object path the `create` tool uses, with the same
 * deterministic table id (scope plus lower-cased name) and a receipt keyed by
 * the automation, its revision, and the table's position, so a replayed apply
 * converges and a table a run already created under that name is reopened
 * when its shape matches and refused when it does not. Nothing here drops a
 * table: a revision that stops declaring one leaves it and its rows in the
 * scope.
 */
export interface AutomationMemoryTablesInput {
  workspaceId: string;
  automationId: string;
  definitionRevision: number;
  runAsUserId: string;
  tables: readonly AutomationMemoryTable[];
}

export interface PreparedAutomationMemoryTable {
  request: WorkspaceMemoryTableCreateRequest;
  legacyInputHash: string;
}

/** Hashes and IDs may yield; every storage decision happens later at commit. */
export async function prepareAutomationMemoryTables(
  input: AutomationMemoryTablesInput & { memoryScopeId: string },
): Promise<PreparedAutomationMemoryTable[]> {
  const harnessRunId = `automation-apply:${input.automationId}:${input.definitionRevision}`;
  const prepared: PreparedAutomationMemoryTable[] = [];
  for (const [index, declared] of input.tables.entries()) {
    const declaration = {
      scopeKind: "sidekick" as const,
      name: declared.name,
      description: declared.description,
      usageInstructions: declared.usageInstructions,
      columns: declared.columns,
      keyColumns: declared.keyColumns,
      rationale: "Declared by the Sidekick's definition",
    };
    const receiptId = `${harnessRunId}:${index}`;
    // The receipt proves that this revision's declaration at this index was
    // materialized, so its hash covers what the definition declared and
    // nothing the platform names. The scope kind and the rationale were
    // renamed once, and a hash that carried them turned every same-revision
    // re-apply — the publication alarm's whole job — into a permanent
    // `receipt_mismatch`. A receipt written before that rename hashed the
    // whole declaration under the old names; it is asked for once more under
    // that hash below, and only a second mismatch is a defect.
    const inputHash = await mutationInputHash("create", {
      name: declared.name,
      description: declared.description,
      usageInstructions: declared.usageInstructions,
      columns: declared.columns,
      keyColumns: declared.keyColumns,
    });
    const legacyInputHash = await mutationInputHash("create", {
      ...declaration,
      scopeKind: "automation",
      rationale: "Declared by the automation's definition",
    });
    const mutationId = await deterministicId("mtm", harnessRunId, receiptId);
    const memoryTableId = await deterministicId("mtt", input.memoryScopeId, declared.name.toLocaleLowerCase());
    const columns = declared.columns.map((column, position) => ({
      memoryTableColumnId: `${memoryTableId}:column:${position}`,
      name: column.name,
      description: column.description,
      valueType: column.type,
      isRequired: column.required,
      isSearchable: column.searchable,
      position,
    }));
    const byName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
    const keyColumnIds = declared.keyColumns.map((name) => byName.get(name.toLocaleLowerCase())!.memoryTableColumnId);
    const mutation = {
      memoryTableMutationId: mutationId,
      receiptId,
      operation: "create" as const,
      actorPrincipalJson: JSON.stringify({ type: "user", userId: input.runAsUserId }),
      harnessRunId,
      workstreamId: input.automationId,
      rationale: declaration.rationale,
      inputHash,
      mutationJson: JSON.stringify(declaration),
      resultJson: JSON.stringify({ memoryTableId, name: declared.name }),
    };
    prepared.push({ legacyInputHash, request: {
      workspaceId: input.workspaceId,
      memoryTableId,
      memoryScopeId: input.memoryScopeId,
      name: declared.name,
      description: declared.description,
      usageInstructions: declared.usageInstructions,
      keyColumnIdsJson: JSON.stringify(keyColumnIds),
      provenanceJson: JSON.stringify({
        source: "automation_definition",
        automationId: input.automationId,
        definitionRevision: input.definitionRevision,
      }),
      columns,
      mutation,
      at: nowIso(),
    } });
  }
  return prepared;
}

/** The same permanent failure and recovery contract for publication and old alarms. */
export function automationMemoryTableResult(
  outcome: WorkspaceMemoryTableCreateResult,
  request: WorkspaceMemoryTableCreateRequest,
  index: number,
): { name: string; memoryTableId: string; outcome: "created" | "opened" } {
  if (outcome.outcome === "receipt_mismatch") {
    throw new ApiError(422, "memory_table_mutation_receipt_mismatch",
      "This table declaration's receipt belongs to different input. Submit a new Sidekick revision; do not retry this revision.",
      { retryable: false, field: `memoryTables.${index}` },
      `memory_table_mutation_receipt_mismatch:memoryTables.${index}`);
  }
  if (outcome.outcome === "schema_conflict") {
    throw new ApiError(422, "sidekick_memory_table_conflict",
      `Table “${request.name}” has incompatible fields: ${outcome.fields.join(", ")}. ${memoryTableSchemaRecovery(outcome.memoryTableId)}`,
      { memoryTableId: outcome.memoryTableId, fields: outcome.fields.map((field) => `memoryTables.${index}.${field}`),
        field: `memoryTables.${index}.${outcome.fields[0]}`, reason: memoryTableSchemaRecovery(outcome.memoryTableId), retryable: false },
      `sidekick_memory_table_conflict:memoryTables.${index}.${outcome.fields[0]}`);
  }
  const memoryTableId = outcome.outcome === "created" ? request.memoryTableId
    : String((JSON.parse(outcome.resultJson) as { memoryTableId: string }).memoryTableId);
  return { name: request.name, memoryTableId, outcome: outcome.outcome === "created" ? "created" : "opened" };
}

/** Materialize through RPC for callers outside the local publication transaction. */
export async function materializeAutomationMemoryTables(env: Env, input: AutomationMemoryTablesInput) {
  if (input.tables.length === 0) return [];
  const scope = await ensureScope(env, input.workspaceId, "sidekick", input.automationId, true);
  const prepared = await prepareAutomationMemoryTables({ ...input, memoryScopeId: scope.memoryScopeId });
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const results = [];
  for (const [index, { request, legacyInputHash }] of prepared.entries()) {
    let outcome = WorkspaceMemoryTableCreateResultSchema.parse(await workspace.createMemoryTable(request));
    if (outcome.outcome === "receipt_mismatch") {
      outcome = WorkspaceMemoryTableCreateResultSchema.parse(await workspace.createMemoryTable({
        ...request, mutation: { ...request.mutation, inputHash: legacyInputHash },
      }));
    }
    results.push(automationMemoryTableResult(outcome, request, index));
  }
  return results;
}

/**
 * Every live table in an automation's memory scope, as a run is told about
 * them: the declared ones apply created, and any a previous run added.
 */
export async function automationScopeMemoryTables(
  env: Env,
  workspaceId: string,
  automationId: string,
): Promise<MaterializedMemoryTable[]> {
  const scope = await ensureScope(env, workspaceId, "sidekick", automationId, true);
  const workspace = await workspaceMemoryObject(env, workspaceId);
  const found = WorkspaceMemoryTableSearchResultSchema.parse(await workspace.searchMemoryTables({
    workspaceId,
    scopeIds: [scope.memoryScopeId],
    like: "%",
    limit: MEMORY_TABLE_SEARCH_LIMIT,
  }));
  const tables: MaterializedMemoryTable[] = [];
  for (const memoryTableId of found.memoryTableIds) {
    const table = await scopeTable(env, workspaceId, scope, memoryTableId);
    if (!table) continue;
    const keyIds = new Set(table.keyColumns.map((column) => column.memoryTableColumnId));
    tables.push({
      memoryTableId: table.table.memoryTableId,
      memoryScopeId: table.table.memoryScopeId,
      scopeKind: "sidekick",
      name: table.table.name,
      description: table.table.description,
      usageInstructions: table.table.usageInstructions,
      keyColumns: table.columns.filter((column) => keyIds.has(column.memoryTableColumnId)).map((column) => column.name),
      columns: table.columns.map((column) => ({
        memoryTableColumnId: column.memoryTableColumnId,
        name: column.name,
        description: column.description,
        type: column.valueType,
        required: column.isRequired,
        searchable: column.isSearchable,
      })),
    });
  }
  return tables;
}

/** A table read within one known scope, without a run's authority to resolve. */
async function scopeTable(
  env: Env,
  workspaceId: string,
  scope: MemoryScope,
  memoryTableId: string,
): Promise<AuthorizedTable | null> {
  const workspace = await workspaceMemoryObject(env, workspaceId);
  const found = WorkspaceMemoryTableResultSchema.parse(await workspace.memoryTableWithColumns({
    workspaceId,
    memoryTableId,
  }));
  if (found.outcome !== "found" || found.table.memoryScopeId !== scope.memoryScopeId) return null;
  const keyIds = new Set(JSON.parse(found.table.keyColumnIdsJson) as string[]);
  const columns = [...found.columns].sort((left, right) => left.position - right.position);
  return {
    table: found.table,
    columns,
    scope,
    keyColumns: columns.filter((column) => keyIds.has(column.memoryTableColumnId)),
  };
}
