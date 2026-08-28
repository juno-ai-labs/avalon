import { AutomationMemoryTableSchema } from "@rally/contracts";
import { z } from "zod";

import { sha256 } from "../lib/crypto";
import { uuidV7 } from "../lib/uuid-v7";

type SqlValue = string | number | null;
type ColumnType = "string" | "url" | "number" | "integer" | "boolean" | "datetime" | "date";

export const automationMemorySchemaStatements = [
  `CREATE TABLE automation_memory_items (
    memory_item_id TEXT PRIMARY KEY,
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    expires_at INTEGER,
    provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
    invalidated_at INTEGER,
    invalidation_reason TEXT,
    last_mutation_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE INDEX automation_memory_items_active_idx
    ON automation_memory_items(invalidated_at, updated_at DESC, memory_item_id)`,
  // The names below are the ones `recordMutation` actually writes — the
  // members of `OperationSchema` that reach it, which is every write operation
  // and none of the four read ones. An earlier list said `create`,
  // `insert_rows`, `update_rows`, and `invalidate_rows`, dropping the `table_`
  // prefix the operations carry, so every durable-table write failed the
  // constraint and rolled its own transaction back: the table the model had
  // just created disappeared and the run saw a raw constraint error. Only the
  // item operations matched, and only those were tested.
  `ALTER TABLE automation_memory_mutations ADD COLUMN operation TEXT NOT NULL DEFAULT 'legacy'
    CHECK (operation IN ('legacy', 'add', 'update', 'invalidate',
      'table_create', 'table_insert_rows', 'table_update_rows', 'table_invalidate_rows'))`,
  `ALTER TABLE automation_memory_mutations ADD COLUMN receipt_id TEXT`,
  `CREATE UNIQUE INDEX automation_memory_mutations_receipt_idx
    ON automation_memory_mutations(run_id, receipt_id) WHERE receipt_id IS NOT NULL`,
  `ALTER TABLE automation_memory_rows ADD COLUMN invalidated_at INTEGER`,
  `ALTER TABLE automation_memory_rows ADD COLUMN invalidation_reason TEXT`,
] as const;

const FenceSchema = z.object({
  schemaVersion: z.literal(1),
  automationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  runId: z.string().uuid(),
  harnessRunId: z.string().uuid(),
  authorityGeneration: z.number().int().positive(),
}).strict();

const SearchSchema = z.union([
  z.object({ query: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ memoryItemId: z.string().uuid() }).strict(),
]);
const AddSchema = z.object({
  scopeKind: z.literal("automation"),
  text: z.string().trim().min(1).max(16_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
const UpdateItemSchema = z.object({
  memoryItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  text: z.string().trim().min(1).max(16_000),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
const InvalidateItemSchema = z.object({
  memoryItemId: z.string().uuid(),
  expectedRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

const ColumnSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(800),
  type: z.enum(["string", "url", "number", "integer", "boolean", "datetime", "date"]),
  required: z.boolean().default(false),
  searchable: z.boolean().default(false),
}).strict();
const TableCreateSchema = z.object({
  scopeKind: z.literal("automation"),
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1_200),
  usageInstructions: z.string().trim().min(1).max(4_000),
  columns: z.array(ColumnSchema).min(1),
  keyColumns: z.array(z.string().trim().min(1).max(120)).min(1),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
const TableSearchSchema = z.object({ query: z.string().trim().min(1).max(2_000) }).strict();
const TableDescribeSchema = z.object({ memoryTableId: z.string().min(1) }).strict();
const PredicateSchema = z.object({
  column: z.string().min(1),
  op: z.enum([
    "eq", "neq", "in", "not_in", "gt", "gte", "lt", "lte", "between",
    "contains", "not_contains", "starts_with", "ends_with", "is_null", "is_not_null",
  ]),
  value: z.unknown().optional(),
}).strict();
type Filter = z.infer<typeof PredicateSchema> | { all: Filter[] } | { any: Filter[] };
const FilterSchema: z.ZodType<Filter> = z.lazy(() => z.union([
  PredicateSchema,
  z.object({ all: z.array(FilterSchema).min(1) }).strict(),
  z.object({ any: z.array(FilterSchema).min(1) }).strict(),
]));
const TableQuerySchema = z.object({
  memoryTableId: z.string().min(1),
  memoryTableRowIds: z.array(z.string().min(1)).min(1).max(100).optional(),
  search: z.string().trim().min(1).max(2_000).optional(),
  filter: FilterSchema.optional(),
  orderBy: z.array(z.object({ column: z.string().min(1), direction: z.enum(["asc", "desc"]) }).strict()).optional(),
  select: z.array(z.string().min(1)).optional(),
  pageSize: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
}).strict();
const TableInsertSchema = z.object({
  memoryTableId: z.string().min(1),
  rows: z.array(z.record(z.string(), z.unknown())).min(1),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
const TableUpdateSchema = z.object({
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    values: z.record(z.string(), z.unknown()),
  }).strict()).min(1),
  rationale: z.string().trim().min(1).max(2_000),
}).strict();
const TableInvalidateSchema = z.object({
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  }).strict()).min(1),
  reason: z.string().trim().min(1).max(2_000),
}).strict();

const OperationSchema = z.enum([
  "search", "add", "update", "invalidate",
  "table_search", "table_describe", "table_query", "table_create",
  "table_insert_rows", "table_update_rows", "table_invalidate_rows",
]);

export const AutomationMemoryToolRequestSchema = FenceSchema.extend({
  operation: OperationSchema,
  args: z.unknown(),
  providerIdempotencyKey: z.string().min(1).max(300).optional(),
}).strict();

export type AutomationMemoryToolRequest = z.infer<typeof AutomationMemoryToolRequestSchema>;

interface TableRow extends Record<string, SqlValue> {
  table_id: string;
  name: string;
  description: string;
  usage_instructions: string;
  key_columns_json: string;
  schema_revision: number;
  data_revision: number;
}

interface ColumnRow extends Record<string, SqlValue> {
  column_id: string;
  table_id: string;
  name: string;
  description: string;
  value_type: ColumnType;
  is_required: number;
  is_searchable: number;
  position: number;
}

interface LoadedTable {
  table: TableRow;
  columns: ColumnRow[];
  keyColumns: ColumnRow[];
}

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

function epoch(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function publicTable(table: LoadedTable, memoryScopeId = table.table.table_id) {
  const keyIds = new Set(table.keyColumns.map((column) => column.column_id));
  return {
    memoryTableId: table.table.table_id,
    memoryScopeId,
    scopeKind: "automation" as const,
    name: table.table.name,
    description: table.table.description,
    usageInstructions: table.table.usage_instructions,
    schemaRevision: Number(table.table.schema_revision),
    dataRevision: Number(table.table.data_revision),
    keyColumns: table.keyColumns.map((column) => column.name),
    columns: table.columns.map((column) => ({
      memoryTableColumnId: column.column_id,
      name: column.name,
      description: column.description,
      type: column.value_type,
      required: column.is_required === 1,
      searchable: column.is_searchable === 1,
      key: keyIds.has(column.column_id),
    })),
  };
}

function compactTable(table: LoadedTable, memoryScopeId = table.table.table_id) {
  return {
    memoryTableId: table.table.table_id,
    memoryScopeId,
    scopeKind: "automation" as const,
    name: table.table.name,
    description: table.table.description,
    keyColumns: table.keyColumns.map((column) => column.name),
  };
}

function loadTable(storage: DurableObjectStorage, tableId: string): LoadedTable {
  const table = storage.sql.exec<TableRow>(
    `SELECT table_id, name, description, usage_instructions, key_columns_json,
            schema_revision, data_revision
       FROM automation_memory_tables WHERE table_id = ?`, tableId,
  ).toArray()[0];
  if (!table) throw new Error("memory_table_not_found");
  const columns = storage.sql.exec<ColumnRow>(
    `SELECT column_id, table_id, name, description, value_type,
            is_required, is_searchable, position
       FROM automation_memory_columns WHERE table_id = ? ORDER BY position`, tableId,
  ).toArray();
  const keyIds = new Set(JSON.parse(table.key_columns_json) as string[]);
  const keyColumns = columns.filter((column) => keyIds.has(column.column_id));
  if (keyColumns.length === 0) throw new Error("memory_table_key_schema_invalid");
  return { table, columns, keyColumns };
}

function resolveColumn(reference: string, table: LoadedTable): ColumnRow {
  const normalized = reference.toLocaleLowerCase();
  const column = table.columns.find((candidate) => (
    candidate.column_id === reference || candidate.name.toLocaleLowerCase() === normalized
  ));
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
    case "datetime":
      if (typeof value !== "string" || !z.string().datetime({ offset: true }).safeParse(value).success) {
        throw new Error(`memory_table_value_type:${column.name}:datetime`);
      }
      return new Date(value).toISOString();
    case "date": {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
        throw new Error(`memory_table_value_type:${column.name}:date`);
      }
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
        throw new Error(`memory_table_value_type:${column.name}:date`);
      }
      return value;
    }
  }
}

function normalizeValues(raw: Record<string, unknown>, table: LoadedTable, patch = false): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [reference, value] of Object.entries(raw)) {
    const column = resolveColumn(reference, table);
    if (Object.hasOwn(normalized, column.name)) throw new Error(`memory_table_duplicate_column:${column.name}`);
    normalized[column.name] = normalizeValue(column, value);
  }
  if (!patch) {
    for (const column of table.columns) {
      if (column.is_required === 1 && (normalized[column.name] === undefined || normalized[column.name] === null)) {
        throw new Error(`memory_table_required_column:${column.name}`);
      }
      if (!Object.hasOwn(normalized, column.name)) normalized[column.name] = null;
    }
  }
  return Object.fromEntries(table.columns
    .filter((column) => Object.hasOwn(normalized, column.name))
    .map((column) => [column.name, normalized[column.name]]));
}

function mutationReceipt(storage: DurableObjectStorage, runId: string, receiptId: string | undefined) {
  if (!receiptId) throw new Error("Memory writes require a durable provider idempotency key");
  return storage.sql.exec<{ operation: string; input_hash: string; result_json: string }>(
    `SELECT operation, input_hash, result_json FROM automation_memory_mutations
      WHERE run_id = ? AND receipt_id = ?`, runId, receiptId,
  ).toArray()[0] ?? null;
}

async function mutationHash(operation: string, args: unknown): Promise<string> {
  return sha256(stableJson({ operation, args }));
}

function replayOrNull(
  storage: DurableObjectStorage,
  request: AutomationMemoryToolRequest,
  inputHash: string,
): Record<string, unknown> | null {
  const receipt = mutationReceipt(storage, request.runId, request.providerIdempotencyKey);
  if (!receipt) return null;
  if (receipt.operation !== request.operation || receipt.input_hash !== inputHash) {
    throw new Error("memory_mutation_receipt_mismatch");
  }
  return JSON.parse(receipt.result_json) as Record<string, unknown>;
}

function recordMutation(
  storage: DurableObjectStorage,
  request: AutomationMemoryToolRequest,
  inputHash: string,
  result: unknown,
  now: number,
): void {
  storage.sql.exec(
    `INSERT INTO automation_memory_mutations
       (mutation_id, run_id, authority_generation, input_hash, result_json,
        settled_at, operation, receipt_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    uuidV7(now), request.runId, request.authorityGeneration, inputHash,
    JSON.stringify(result), now, request.operation, request.providerIdempotencyKey!,
  );
}

function memoryResult(row: {
  memory_item_id: string;
  text: string;
  revision: number;
  expires_at: number | null;
}, memoryScopeId: string) {
  return {
    memoryItemId: row.memory_item_id,
    memoryScopeId,
    scopeKind: "automation" as const,
    text: row.text,
    revision: Number(row.revision),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  };
}

function evaluateFilter(filter: Filter, values: Record<string, unknown>, table: LoadedTable): boolean {
  if ("all" in filter) return filter.all.every((node) => evaluateFilter(node, values, table));
  if ("any" in filter) return filter.any.some((node) => evaluateFilter(node, values, table));
  const column = resolveColumn(filter.column, table);
  const current = values[column.name];
  if (filter.op === "is_null") return current === null || current === undefined;
  if (filter.op === "is_not_null") return current !== null && current !== undefined;
  if (current === null || current === undefined) return false;
  const comparable = (value: unknown) => typeof value === "string" ? value.toLocaleLowerCase() : value;
  const left = comparable(current);
  if (filter.op === "in" || filter.op === "not_in") {
    if (!Array.isArray(filter.value) || filter.value.length === 0) throw new Error("memory_table_filter_value_invalid");
    const found = filter.value.some((value) => left === comparable(normalizeValue(column, value)));
    return filter.op === "in" ? found : !found;
  }
  if (filter.op === "between") {
    const range = z.object({ from: z.unknown(), to: z.unknown() }).strict().parse(filter.value);
    return compareValues(left, comparable(normalizeValue(column, range.from))) >= 0
      && compareValues(left, comparable(normalizeValue(column, range.to))) <= 0;
  }
  const right = comparable(normalizeValue(column, filter.value));
  switch (filter.op) {
    case "eq": return left === right;
    case "neq": return left !== right;
    case "gt": return compareValues(left, right) > 0;
    case "gte": return compareValues(left, right) >= 0;
    case "lt": return compareValues(left, right) < 0;
    case "lte": return compareValues(left, right) <= 0;
    case "contains": return String(left).includes(String(right));
    case "not_contains": return !String(left).includes(String(right));
    case "starts_with": return String(left).startsWith(String(right));
    case "ends_with": return String(left).endsWith(String(right));
    default: return false;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, { numeric: true });
}

export function materializeAutomationMemoryDefinitions(
  storage: DurableObjectStorage,
  automationId: string,
  definitions: unknown,
  now: number,
): void {
  const parsed = z.array(AutomationMemoryTableSchema).parse(definitions ?? []);
  const names = new Set<string>();
  for (const definition of parsed) {
    // `toLowerCase`, not `toLocaleLowerCase`: this string decides a stored
    // identifier, and the locale-aware form maps `I` to a dotless `ı` under a
    // Turkish locale, so the same definition could name two different tables.
    const normalized = definition.name.toLowerCase();
    if (names.has(normalized)) throw new Error("automation_memory_table_name_duplicate");
    names.add(normalized);
    const existing = storage.sql.exec<{ table_id: string }>(
      `SELECT table_id FROM automation_memory_tables WHERE name = ? COLLATE NOCASE`, definition.name,
    ).toArray()[0];
    if (existing) continue;
    // Derived from the table's name, never from its position in the array.
    // The name is what identity already means here — it is what the lookup
    // above dedupes on, and what a later revision is matched by — while the
    // position is whatever order the compiler happened to emit. A revision
    // that adds a table ahead of an existing one shifts every index after it,
    // so a position-derived id would be handed the id of a table that is still
    // there: a primary-key collision that fails the acceptance of a perfectly
    // legitimate edit, and only for automations that already had memory.
    const tableId = `${automationId}:table:${encodeURIComponent(normalized)}`;
    const columns = definition.columns.map((column, columnIndex) => ({
      ...column,
      columnId: `${tableId}:column:${columnIndex}`,
    }));
    const byName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
    const keyIds = definition.keyColumns.map((name) => {
      const column = byName.get(name.toLocaleLowerCase());
      if (!column) throw new Error(`automation_memory_key_column_missing:${name}`);
      return column.columnId;
    });
    storage.sql.exec(
      `INSERT INTO automation_memory_tables
         (table_id, name, description, usage_instructions, key_columns_json,
          schema_revision, data_revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
      tableId, definition.name, definition.description, definition.usageInstructions,
      JSON.stringify(keyIds), now, now,
    );
    columns.forEach((column, position) => storage.sql.exec(
      `INSERT INTO automation_memory_columns
         (column_id, table_id, name, description, value_type, is_required,
          is_searchable, position)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      column.columnId, tableId, column.name, column.description, column.type,
      column.required ? 1 : 0, column.searchable ? 1 : 0, position,
    ));
  }
}

export function importLegacyAutomationMemory(
  storage: DurableObjectStorage,
  automationId: string,
  definitions: unknown,
  records: Array<{ kind: string; recordId: string; payload: Record<string, unknown> }>,
  now: number,
): void {
  for (const record of records) {
    const payload = record.payload;
    if (record.kind === "item") {
      const itemId = text(payload.memory_item_id, record.recordId);
      storage.sql.exec(
        `INSERT OR IGNORE INTO automation_memory_items
           (memory_item_id, text, revision, expires_at, provenance_json,
            invalidated_at, invalidation_reason, last_mutation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        itemId, text(payload.text), Number(payload.revision ?? 1), epoch(payload.expires_at),
        text(payload.provenance_json, "{}"), epoch(payload.invalidated_at),
        payload.invalidation_reason === null ? null : text(payload.invalidation_reason),
        text(payload.last_mutation_id, `legacy:${itemId}`), epoch(payload.created_at) ?? now,
        epoch(payload.updated_at) ?? now,
      );
    } else if (record.kind === "table") {
      storage.sql.exec(
        `INSERT OR IGNORE INTO automation_memory_tables
           (table_id, name, description, usage_instructions, key_columns_json,
            schema_revision, data_revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        text(payload.memory_table_id, record.recordId), text(payload.name), text(payload.description),
        text(payload.usage_instructions), text(payload.key_column_ids_json, "[]"),
        Number(payload.schema_revision ?? 1), Number(payload.data_revision ?? 0),
        epoch(payload.created_at) ?? now, epoch(payload.updated_at) ?? now,
      );
    } else if (record.kind === "table_column") {
      storage.sql.exec(
        `INSERT OR IGNORE INTO automation_memory_columns
           (column_id, table_id, name, description, value_type, is_required,
            is_searchable, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        text(payload.memory_table_column_id, record.recordId), text(payload.memory_table_id),
        text(payload.name), text(payload.description), text(payload.value_type) as ColumnType,
        Number(payload.is_required ?? 0), Number(payload.is_searchable ?? 0), Number(payload.position ?? 0),
      );
    } else if (record.kind === "table_row") {
      storage.sql.exec(
        `INSERT OR IGNORE INTO automation_memory_rows
           (row_id, table_id, data_json, revision, last_mutation_id,
            created_at, updated_at, invalidated_at, invalidation_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        // Identity comes from the natural key, not the legacy row UUID. The
        // write path computes `${table_id}:row:${natural key hash}` and treats
        // a row as already present only when that id matches, so a row that
        // kept its legacy id was invisible to it: inserting a key the
        // automation had already recorded before the cutover wrote a second
        // row rather than recognising the first. The legacy table stored the
        // hash itself, so nothing is recomputed here.
        `${text(payload.memory_table_id)}:row:${text(payload.natural_key_hash, record.recordId)}`,
        text(payload.memory_table_id),
        text(payload.data_json, "{}"), Number(payload.revision ?? 1),
        text(payload.last_mutation_id, `legacy:${record.recordId}`),
        epoch(payload.created_at) ?? now, epoch(payload.updated_at) ?? now,
        epoch(payload.invalidated_at), payload.invalidation_reason === null ? null : text(payload.invalidation_reason),
      );
    }
  }
  materializeAutomationMemoryDefinitions(storage, automationId, definitions, now);
}

export function readAutomationMemoryBootstrap(storage: DurableObjectStorage, automationId: string) {
  const items = storage.sql.exec<{
    memory_item_id: string;
    text: string;
    revision: number;
    expires_at: number | null;
  }>(`SELECT memory_item_id, text, revision, expires_at
       FROM automation_memory_items
      WHERE invalidated_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY updated_at DESC, memory_item_id LIMIT 10`, Date.now()).toArray()
    .map((row) => memoryResult(row, automationId));
  const tables = storage.sql.exec<TableRow>(
    `SELECT table_id, name, description, usage_instructions, key_columns_json,
            schema_revision, data_revision FROM automation_memory_tables ORDER BY name COLLATE NOCASE`,
  ).toArray().map((row) => publicTable(loadTable(storage, row.table_id), automationId));
  return { items, tables };
}

export async function executeAutomationMemoryTool(
  storage: DurableObjectStorage,
  rawRequest: unknown,
): Promise<{ output: unknown; summary: string; providerOperationId?: string }> {
  const request = AutomationMemoryToolRequestSchema.parse(rawRequest);
  const now = Date.now();
  if (request.operation === "search") {
    const args = SearchSchema.parse(request.args);
    const rows = "memoryItemId" in args
      ? storage.sql.exec<{ memory_item_id: string; text: string; revision: number; expires_at: number | null }>(
          `SELECT memory_item_id, text, revision, expires_at FROM automation_memory_items
            WHERE memory_item_id = ? AND invalidated_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)`, args.memoryItemId, now,
        ).toArray()
      : storage.sql.exec<{ memory_item_id: string; text: string; revision: number; expires_at: number | null }>(
          `SELECT memory_item_id, text, revision, expires_at FROM automation_memory_items
            WHERE invalidated_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
              AND instr(lower(text), lower(?)) > 0
            ORDER BY updated_at DESC, memory_item_id LIMIT 10`, now, args.query,
        ).toArray();
    const output = {
      query: "query" in args ? args.query : null,
      ...("memoryItemId" in args ? { memoryItemId: args.memoryItemId } : {}),
      retrievalMode: "memoryItemId" in args ? "exact" : "fts_only",
      results: rows.map((row) => memoryResult(row, request.automationId)),
    };
    return { output, summary: `Found ${rows.length} durable memor${rows.length === 1 ? "y" : "ies"}` };
  }

  if (request.operation === "add" || request.operation === "update" || request.operation === "invalidate") {
    const args = request.operation === "add" ? AddSchema.parse(request.args)
      : request.operation === "update" ? UpdateItemSchema.parse(request.args)
      : InvalidateItemSchema.parse(request.args);
    const inputHash = await mutationHash(request.operation, args);
    const replay = replayOrNull(storage, request, inputHash);
    if (replay) return {
      output: replay,
      summary: `${request.operation} durable memory`,
      providerOperationId: String(replay.memoryItemId),
    };
    let result: Record<string, unknown>;
    storage.transactionSync(() => {
      if (request.operation === "add") {
        const parsed = AddSchema.parse(args);
        const itemId = uuidV7(now);
        result = {
          memoryItemId: itemId,
          memoryScopeId: request.automationId,
          scopeKind: "automation",
          revision: 1,
          invalidated: false,
        };
        storage.sql.exec(
          `INSERT INTO automation_memory_items
             (memory_item_id, text, revision, expires_at, provenance_json,
              invalidated_at, invalidation_reason, last_mutation_id, created_at, updated_at)
           VALUES (?, ?, 1, ?, ?, NULL, NULL, ?, ?, ?)`,
          itemId, parsed.text, parsed.expiresAt ? Date.parse(parsed.expiresAt) : null,
          JSON.stringify({ runId: request.runId, harnessRunId: request.harnessRunId, rationale: parsed.rationale }),
          request.providerIdempotencyKey!, now, now,
        );
      } else {
        const parsed = request.operation === "update" ? UpdateItemSchema.parse(args) : InvalidateItemSchema.parse(args);
        const row = storage.sql.exec<{ revision: number; invalidated_at: number | null; expires_at: number | null }>(
          `SELECT revision, invalidated_at, expires_at FROM automation_memory_items WHERE memory_item_id = ?`,
          parsed.memoryItemId,
        ).toArray()[0];
        if (!row || row.invalidated_at !== null) throw new Error("memory_item_not_found");
        if (Number(row.revision) !== parsed.expectedRevision) throw new Error("memory_revision_conflict");
        const nextRevision = parsed.expectedRevision + 1;
        if (request.operation === "update") {
          const update = UpdateItemSchema.parse(parsed);
          storage.sql.exec(
            `UPDATE automation_memory_items SET text = ?, revision = ?, expires_at = ?,
                    last_mutation_id = ?, updated_at = ?
              WHERE memory_item_id = ? AND revision = ? AND invalidated_at IS NULL`,
            update.text, nextRevision, update.expiresAt ? Date.parse(update.expiresAt) : row.expires_at,
            request.providerIdempotencyKey!, now, update.memoryItemId, update.expectedRevision,
          );
        } else {
          const invalidation = InvalidateItemSchema.parse(parsed);
          storage.sql.exec(
            `UPDATE automation_memory_items SET revision = ?, invalidated_at = ?, invalidation_reason = ?,
                    last_mutation_id = ?, updated_at = ?
              WHERE memory_item_id = ? AND revision = ? AND invalidated_at IS NULL`,
            nextRevision, now, invalidation.reason, request.providerIdempotencyKey!, now,
            invalidation.memoryItemId, invalidation.expectedRevision,
          );
        }
        result = {
          memoryItemId: parsed.memoryItemId,
          memoryScopeId: request.automationId,
          scopeKind: "automation",
          revision: nextRevision,
          invalidated: request.operation === "invalidate",
        };
      }
      recordMutation(storage, request, inputHash, result!, now);
    });
    return { output: result!, summary: `${request.operation} durable memory`, providerOperationId: String(result!.memoryItemId) };
  }

  if (request.operation === "table_search") {
    const args = TableSearchSchema.parse(request.args);
    const tables = storage.sql.exec<TableRow>(
      `SELECT table_id, name, description, usage_instructions, key_columns_json,
              schema_revision, data_revision FROM automation_memory_tables
        WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(description), lower(?)) > 0
           OR instr(lower(usage_instructions), lower(?)) > 0
        ORDER BY name COLLATE NOCASE LIMIT 20`, args.query, args.query, args.query,
    ).toArray().map((row) => compactTable(loadTable(storage, row.table_id), request.automationId));
    return { output: { query: args.query, tables }, summary: `Found ${tables.length} durable tables` };
  }
  if (request.operation === "table_describe") {
    const args = TableDescribeSchema.parse(request.args);
    const table = loadTable(storage, args.memoryTableId);
    return { output: publicTable(table, request.automationId), summary: `Described durable table “${table.table.name}”` };
  }
  if (request.operation === "table_query") {
    const args = TableQuerySchema.parse(request.args);
    const table = loadTable(storage, args.memoryTableId);
    const selected = args.select?.map((reference) => resolveColumn(reference, table)) ?? table.columns;
    const rowIds = args.memoryTableRowIds ? new Set(args.memoryTableRowIds) : null;
    let rows = storage.sql.exec<{
      row_id: string;
      data_json: string;
      revision: number;
      created_at: number;
      updated_at: number;
    }>(`SELECT row_id, data_json, revision, created_at, updated_at
         FROM automation_memory_rows WHERE table_id = ? AND invalidated_at IS NULL
        ORDER BY updated_at DESC, row_id`, args.memoryTableId).toArray();
    rows = rows.filter((row) => {
      if (rowIds && !rowIds.has(row.row_id)) return false;
      const values = JSON.parse(row.data_json) as Record<string, unknown>;
      if (args.search) {
        const query = args.search.toLocaleLowerCase();
        if (!table.columns.some((column) => column.is_searchable === 1
          && String(values[column.name] ?? "").toLocaleLowerCase().includes(query))) return false;
      }
      return args.filter ? evaluateFilter(args.filter, values, table) : true;
    });
    for (const order of [...(args.orderBy ?? [])].reverse()) {
      const column = resolveColumn(order.column, table);
      rows.sort((left, right) => {
        const leftValue = (JSON.parse(left.data_json) as Record<string, unknown>)[column.name];
        const rightValue = (JSON.parse(right.data_json) as Record<string, unknown>)[column.name];
        const compared = stableJson(leftValue).localeCompare(stableJson(rightValue), undefined, { numeric: true });
        return order.direction === "asc" ? compared : -compared;
      });
    }
    const offset = args.cursor ? Number.parseInt(atob(args.cursor), 10) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error("memory_table_cursor_invalid");
    const pageSize = args.pageSize ?? (rowIds ? rowIds.size : 50);
    const page = rows.slice(offset, offset + pageSize);
    const output = {
      ...compactTable(table, request.automationId),
      dataRevision: Number(table.table.data_revision),
      selectedColumns: selected.map((column) => column.name),
      rows: page.map((row) => {
        const values = JSON.parse(row.data_json) as Record<string, unknown>;
        return {
          memoryTableRowId: row.row_id,
          revision: Number(row.revision),
          values: Object.fromEntries(selected.map((column) => [column.name, values[column.name] ?? null])),
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        };
      }),
      nextCursor: offset + pageSize < rows.length ? btoa(String(offset + pageSize)) : null,
    };
    return { output, summary: `Read ${page.length} rows from “${table.table.name}”` };
  }

  const args = request.operation === "table_create" ? TableCreateSchema.parse(request.args)
    : request.operation === "table_insert_rows" ? TableInsertSchema.parse(request.args)
    : request.operation === "table_update_rows" ? TableUpdateSchema.parse(request.args)
    : TableInvalidateSchema.parse(request.args);
  const inputHash = await mutationHash(request.operation, args);
  const replay = replayOrNull(storage, request, inputHash);
  if (replay) return {
    output: replay,
    summary: `${request.operation} durable table rows`,
    providerOperationId: String(replay.memoryTableMutationId ?? replay.memoryTableId),
  };
  let result: Record<string, unknown> = {};
  if (request.operation === "table_create") {
    const parsed = TableCreateSchema.parse(args);
    const existing = storage.sql.exec<{ table_id: string }>(
      `SELECT table_id FROM automation_memory_tables WHERE name = ? COLLATE NOCASE`, parsed.name,
    ).toArray()[0];
    if (existing) {
      result = publicTable(loadTable(storage, existing.table_id), request.automationId);
      storage.transactionSync(() => recordMutation(storage, request, inputHash, result, now));
    } else {
      const tableId = uuidV7(now);
      const columns = parsed.columns.map((column, index) => ({ ...column, columnId: `${tableId}:column:${index}` }));
      const byName = new Map(columns.map((column) => [column.name.toLocaleLowerCase(), column]));
      const keyIds = parsed.keyColumns.map((name) => byName.get(name.toLocaleLowerCase())?.columnId
        ?? (() => { throw new Error(`automation_memory_key_column_missing:${name}`); })());
      storage.transactionSync(() => {
        storage.sql.exec(
          `INSERT INTO automation_memory_tables
             (table_id, name, description, usage_instructions, key_columns_json,
              schema_revision, data_revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)`,
          tableId, parsed.name, parsed.description, parsed.usageInstructions, JSON.stringify(keyIds), now, now,
        );
        columns.forEach((column, position) => storage.sql.exec(
          `INSERT INTO automation_memory_columns
             (column_id, table_id, name, description, value_type, is_required, is_searchable, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          column.columnId, tableId, column.name, column.description, column.type,
          column.required ? 1 : 0, column.searchable ? 1 : 0, position,
        ));
        result = publicTable(loadTable(storage, tableId), request.automationId);
        recordMutation(storage, request, inputHash, result, now);
      });
    }
  } else if (request.operation === "table_insert_rows") {
    const parsed = TableInsertSchema.parse(args);
    const table = loadTable(storage, parsed.memoryTableId);
    const prepared = await Promise.all(parsed.rows.map(async (row) => {
      const values = normalizeValues(row, table);
      // `[name, value]` pairs, matching what the legacy memory-table service
      // hashed into `memory_table_rows.natural_key_hash`. The import reuses
      // that stored hash verbatim rather than recomputing it, so the two
      // derivations have to agree: a row carried through the cutover must land
      // on the same identity this path would compute for the same key, or
      // re-inserting an imported key writes a second row instead of matching
      // the one already there.
      const naturalKeyHash = await sha256(stableJson(
        table.keyColumns.map((column) => [column.name, values[column.name]]),
      ));
      return { rowId: `${table.table.table_id}:row:${naturalKeyHash}`, naturalKeyHash, values };
    }));
    const inserted: Array<{ memoryTableRowId: string; revision: number; values: Record<string, unknown> }> = [];
    storage.transactionSync(() => {
      for (const row of prepared) {
        const exists = storage.sql.exec<{ row_id: string }>(
          `SELECT row_id FROM automation_memory_rows WHERE table_id = ? AND row_id = ?`,
          table.table.table_id, row.rowId,
        ).toArray()[0];
        if (exists) continue;
        storage.sql.exec(
          `INSERT INTO automation_memory_rows
             (row_id, table_id, data_json, revision, last_mutation_id, created_at, updated_at)
           VALUES (?, ?, ?, 1, ?, ?, ?)`, row.rowId, table.table.table_id,
          JSON.stringify(row.values), request.providerIdempotencyKey!, now, now,
        );
        inserted.push({ memoryTableRowId: row.rowId, revision: 1, values: row.values });
      }
      storage.sql.exec(
        `UPDATE automation_memory_tables SET data_revision = data_revision + 1, updated_at = ? WHERE table_id = ?`,
        now, table.table.table_id,
      );
      result = {
        memoryTableId: table.table.table_id,
        memoryTableMutationId: request.providerIdempotencyKey!,
        insertedCount: inserted.length,
        existingCount: prepared.length - inserted.length,
        duplicateInputCount: 0,
        insertedRows: inserted,
      };
      recordMutation(storage, request, inputHash, result, now);
    });
  } else if (request.operation === "table_update_rows") {
    const parsed = TableUpdateSchema.parse(args);
    const table = loadTable(storage, parsed.memoryTableId);
    const keyNames = new Set(table.keyColumns.map((column) => column.name.toLocaleLowerCase()));
    result = {
      memoryTableId: table.table.table_id,
      memoryTableMutationId: request.providerIdempotencyKey!,
      updatedCount: parsed.rows.length,
      rows: parsed.rows.map((row) => ({
        memoryTableRowId: row.memoryTableRowId,
        revision: row.expectedRevision + 1,
      })),
    };
    storage.transactionSync(() => {
      for (const requested of parsed.rows) {
        const row = storage.sql.exec<{ data_json: string; revision: number }>(
          `SELECT data_json, revision FROM automation_memory_rows
            WHERE row_id = ? AND table_id = ? AND invalidated_at IS NULL`,
          requested.memoryTableRowId, table.table.table_id,
        ).toArray()[0];
        if (!row) throw new Error("memory_table_row_not_found");
        if (Number(row.revision) !== requested.expectedRevision) throw new Error("memory_table_row_revision_conflict");
        const patch = normalizeValues(requested.values, table, true);
        if (Object.keys(patch).length === 0) throw new Error("memory_table_update_empty");
        if (Object.keys(patch).some((name) => keyNames.has(name.toLocaleLowerCase()))) {
          throw new Error("memory_table_key_columns_are_immutable");
        }
        const values = { ...(JSON.parse(row.data_json) as Record<string, unknown>), ...patch };
        normalizeValues(values, table);
        storage.sql.exec(
          `UPDATE automation_memory_rows SET data_json = ?, revision = revision + 1,
                  last_mutation_id = ?, updated_at = ? WHERE row_id = ? AND revision = ?`,
          JSON.stringify(values), request.providerIdempotencyKey!, now,
          requested.memoryTableRowId, requested.expectedRevision,
        );
      }
      storage.sql.exec(
        `UPDATE automation_memory_tables SET data_revision = data_revision + 1, updated_at = ? WHERE table_id = ?`,
        now, table.table.table_id,
      );
      recordMutation(storage, request, inputHash, result, now);
    });
  } else {
    const parsed = TableInvalidateSchema.parse(args);
    const table = loadTable(storage, parsed.memoryTableId);
    result = {
      memoryTableId: table.table.table_id,
      memoryTableMutationId: request.providerIdempotencyKey!,
      invalidatedCount: parsed.rows.length,
      rows: parsed.rows.map((row) => ({
        memoryTableRowId: row.memoryTableRowId,
        revision: row.expectedRevision + 1,
      })),
    };
    storage.transactionSync(() => {
      for (const requested of parsed.rows) {
        const row = storage.sql.exec<{ revision: number }>(
          `SELECT revision FROM automation_memory_rows
            WHERE row_id = ? AND table_id = ? AND invalidated_at IS NULL`,
          requested.memoryTableRowId, table.table.table_id,
        ).toArray()[0];
        if (!row) throw new Error("memory_table_row_not_found");
        if (Number(row.revision) !== requested.expectedRevision) throw new Error("memory_table_row_revision_conflict");
        storage.sql.exec(
          `UPDATE automation_memory_rows
              SET revision = revision + 1, invalidated_at = ?, invalidation_reason = ?,
                  last_mutation_id = ?, updated_at = ?
            WHERE row_id = ? AND revision = ? AND invalidated_at IS NULL`,
          now, parsed.reason, request.providerIdempotencyKey!, now,
          requested.memoryTableRowId, requested.expectedRevision,
        );
      }
      storage.sql.exec(
        `UPDATE automation_memory_tables SET data_revision = data_revision + 1, updated_at = ? WHERE table_id = ?`,
        now, table.table.table_id,
      );
      recordMutation(storage, request, inputHash, result, now);
    });
  }
  return {
    output: result,
    summary: `${request.operation} durable table rows`,
    providerOperationId: String(result.memoryTableMutationId ?? result.memoryTableId),
  };
}
