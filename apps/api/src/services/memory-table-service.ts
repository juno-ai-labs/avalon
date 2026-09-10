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
  type WorkspaceMemoryTableCell,
  type WorkspaceMemoryTableColumn,
  type WorkspaceMemoryTableFilter,
  type WorkspaceMemoryTableRow,
  type WorkspaceMemoryTableRowRecord,
} from "../durable-objects/workspace-memory-protocol";
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
 * apply by {@link materializeAutomationMemoryTables}, and any a run made for
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
  const keyIds = new Set(table.keyColumns.map((column) => column.memoryTableColumnId));
  return {
    memoryTableId: table.table.memoryTableId,
    memoryScopeId: table.table.memoryScopeId,
    scopeKind: table.table.scopeKind,
    name: table.table.name,
    description: table.table.description,
    usageInstructions: table.table.usageInstructions,
    schemaRevision: table.table.schemaRevision,
    dataRevision: table.table.dataRevision,
    keyColumns: table.keyColumns.map((column) => column.name),
    columns: table.columns.map((column) => ({
      memoryTableColumnId: column.memoryTableColumnId,
      name: column.name,
      description: column.description,
      type: column.valueType,
      required: column.isRequired,
      searchable: column.isSearchable,
      key: keyIds.has(column.memoryTableColumnId),
    })),
  };
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

function tableSchemaMatches(table: AuthorizedTable, declaration: z.infer<typeof CreateSchema>): boolean {
  const keyNames = table.keyColumns.map((column) => column.name.toLocaleLowerCase());
  return table.table.description === declaration.description
    && table.table.usageInstructions === declaration.usageInstructions
    && stableJson(keyNames) === stableJson(declaration.keyColumns.map((name) => name.toLocaleLowerCase()))
    && stableJson(table.columns.map((column) => ({
      name: column.name.toLocaleLowerCase(),
      description: column.description,
      type: column.valueType,
      required: column.isRequired,
      searchable: column.isSearchable,
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
  if (outcome.outcome === "replayed") {
    const recorded = JSON.parse(outcome.resultJson) as Record<string, unknown>;
    return { output: recorded, summary: `Created durable table “${args.name}”`, providerOperationId: String(recorded.memoryTableId) };
  }
  if (outcome.outcome === "receipt_mismatch") throw new Error("memory_table_mutation_receipt_mismatch");
  if (outcome.outcome === "name_exists") {
    const existing = await loadAuthorizedTable(env, input, outcome.memoryTableId, true);
    if (!tableSchemaMatches(existing, args)) throw new Error("memory_table_name_schema_conflict");
    const opened = publicTable(existing);
    await workspace.recordMemoryTableOpenReceipt({
      workspaceId: input.workspaceId,
      memoryTableId: existing.table.memoryTableId,
      memoryScopeId: scope.memoryScopeId,
      mutation: mutationRecord(input, {
        mutationId, receiptId, operation: "create", rationale: args.rationale,
        inputHash, mutation: args, result: opened,
      }),
      at: nowIso(),
    });
    return { output: opened, summary: `Opened durable table “${args.name}”`, providerOperationId: existing.table.memoryTableId };
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
          properties: { query: { type: "string", minLength: 1, maxLength: MEMORY_RECALL_QUERY_LIMIT } },
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
export async function materializeAutomationMemoryTables(
  env: Env,
  input: {
    workspaceId: string;
    automationId: string;
    definitionRevision: number;
    runAsUserId: string;
    tables: readonly AutomationMemoryTable[];
  },
): Promise<Array<{ name: string; memoryTableId: string; outcome: "created" | "opened" }>> {
  if (input.tables.length === 0) return [];
  const scope = await ensureScope(env, input.workspaceId, "sidekick", input.automationId, true);
  const workspace = await workspaceMemoryObject(env, input.workspaceId);
  const harnessRunId = `automation-apply:${input.automationId}:${input.definitionRevision}`;
  const results: Array<{ name: string; memoryTableId: string; outcome: "created" | "opened" }> = [];
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
    const memoryTableId = await deterministicId("mtt", scope.memoryScopeId, declared.name.toLocaleLowerCase());
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
    const create = async (hash: string) => WorkspaceMemoryTableCreateResultSchema.parse(await workspace.createMemoryTable({
      workspaceId: input.workspaceId,
      memoryTableId,
      memoryScopeId: scope.memoryScopeId,
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
      mutation: { ...mutation, inputHash: hash },
      at: nowIso(),
    }));
    let outcome = await create(inputHash);
    if (outcome.outcome === "receipt_mismatch") outcome = await create(legacyInputHash);
    if (outcome.outcome === "receipt_mismatch") throw new Error("memory_table_mutation_receipt_mismatch");
    if (outcome.outcome === "name_exists") {
      const existing = await scopeTable(env, input.workspaceId, scope, outcome.memoryTableId);
      if (!existing || !tableSchemaMatches(existing, declaration)) {
        throw new ApiError(
          422,
          "sidekick_memory_table_conflict",
          `A durable table named "${declared.name}" already exists in this automation's memory with a different shape`,
        );
      }
      results.push({ name: declared.name, memoryTableId: outcome.memoryTableId, outcome: "opened" });
      continue;
    }
    results.push({ name: declared.name, memoryTableId, outcome: outcome.outcome === "replayed" ? "opened" : "created" });
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
