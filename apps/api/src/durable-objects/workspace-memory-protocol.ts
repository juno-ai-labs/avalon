import { IdSchema } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

/**
 * Scoped durable memory's typed tables, and the scopes they hang off, as
 * questions rather than SQL. The prose half of this file moved to
 * `workspace-memory-facts-protocol.ts` with the agent-memory redesign.
 *
 * The memory services reached these tables through the workspace runtime
 * facade, which routes each statement by the table names it happens to
 * mention and sends anything it does not recognise to the regional database.
 * A typed method cannot be routed to the wrong database, and the mutations
 * below become one critical section each instead of a D1 batch racing its
 * own receipt read.
 *
 * Identifiers here are deliberately not `IdSchema`: memory table, column, row,
 * and mutation ids are deterministic strings (`mtt_<hash>`, `<table>:column:<n>`,
 * `mtr_<hash>`, `mtm_<hash>`), and receipt ids are the harness's provider
 * idempotency keys. Only the workspace id has a uniform shape worth asserting.
 */

const TimestampSchema = z.string().min(1);
const JsonTextSchema = z.string().min(1);

export const MemoryScopeKindSchema = z.enum(["workstream", "sidekick", "user", "workspace"]);

// -- Scopes -------------------------------------------------------------------

export const WorkspaceMemoryScopeEnsureRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  /** Used only when the scope does not exist yet; the stored id wins. */
  proposedScopeId: z.string().min(1),
  kind: MemoryScopeKindSchema,
  ownerId: z.string().min(1),
  at: TimestampSchema,
}));

export const WorkspaceMemoryScopeSchema = deferredZodSchema(() => z.strictObject({
  memoryScopeId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: MemoryScopeKindSchema,
  ownerId: z.string().min(1),
}));

// -- Mutation receipts --------------------------------------------------------

export const WorkspaceMemoryReceiptRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  harnessRunId: z.string().min(1),
  receiptId: z.string().min(1),
}));

/**
 * `none` rather than a nullable row: the service compares operation and input
 * hash itself so a mismatched replay keeps raising the service's own error.
 */
export const WorkspaceMemoryReceiptResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("found"),
    operation: z.string(),
    inputHash: z.string(),
    resultJson: z.string(),
  }),
  z.strictObject({ outcome: z.literal("none") }),
]));

// -- Tables: reads ------------------------------------------------------------

export const MemoryTableColumnTypeSchema = z.enum([
  "string", "url", "number", "integer", "boolean", "datetime", "date",
]);

export const WorkspaceMemoryTableRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
}));

export const WorkspaceMemoryTableRowSchema = deferredZodSchema(() => z.strictObject({
  memoryTableId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  workspaceId: z.string().min(1),
  scopeKind: MemoryScopeKindSchema,
  name: z.string(),
  description: z.string(),
  usageInstructions: z.string(),
  keyColumnIdsJson: z.string(),
  schemaRevision: z.number().int().positive(),
  dataRevision: z.number().int().nonnegative(),
  invalidatedAt: z.string().nullable(),
}));

export const WorkspaceMemoryTableColumnSchema = deferredZodSchema(() => z.strictObject({
  memoryTableColumnId: z.string().min(1),
  memoryTableId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  valueType: MemoryTableColumnTypeSchema,
  isRequired: z.boolean(),
  isSearchable: z.boolean(),
  position: z.number().int().nonnegative(),
}));

export const WorkspaceMemoryTableResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("found"),
    table: WorkspaceMemoryTableRowSchema,
    columns: z.array(WorkspaceMemoryTableColumnSchema),
  }),
  z.strictObject({ outcome: z.literal("not_found") }),
]));

export const WorkspaceMemoryTableSearchRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  scopeIds: z.array(z.string().min(1)),
  /** A prebuilt LIKE pattern, already escaped with `\`; matched NOCASE. */
  like: z.string().min(1),
  limit: z.number().int().positive(),
}));

export const WorkspaceMemoryTableSearchResultSchema = deferredZodSchema(() => z.strictObject({
  memoryTableIds: z.array(z.string().min(1)),
}));

export const WorkspaceMemoryTableRowRecordSchema = deferredZodSchema(() => z.strictObject({
  memoryTableRowId: z.string().min(1),
  dataJson: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  invalidatedAt: z.string().nullable(),
}));

export const WorkspaceMemoryTableRowsByIdRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  memoryTableRowIds: z.array(z.string().min(1)),
}));

export const WorkspaceMemoryTableRowListSchema = deferredZodSchema(() => z.strictObject({
  rows: z.array(WorkspaceMemoryTableRowRecordSchema),
}));

// The service resolves column references and value types against the schema it
// already authorized, so a filter arrives here fully normalized: column ids
// from the table's own rows, the physical cell field for each id, and values
// already coerced. The object turns it into SQL without consulting the schema.
const CellFieldSchema = z.enum(["string_value", "number_value", "boolean_value", "temporal_value"]);
const PredicateValueSchema = deferredZodSchema(() => z.union([z.string(), z.number(), z.null()]));

const NormalizedPredicateSchema = deferredZodSchema(() => z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("exists"), columnId: z.string().min(1) }),
  z.strictObject({ op: z.literal("not_exists"), columnId: z.string().min(1) }),
  z.strictObject({
    op: z.literal("in"),
    columnId: z.string().min(1),
    field: CellFieldSchema,
    valuesJson: z.string().min(1),
    negated: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("between"),
    columnId: z.string().min(1),
    field: CellFieldSchema,
    from: PredicateValueSchema,
    to: PredicateValueSchema,
  }),
  z.strictObject({
    op: z.literal("like"),
    columnId: z.string().min(1),
    pattern: z.string(),
    negated: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("compare"),
    columnId: z.string().min(1),
    field: CellFieldSchema,
    comparison: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    value: PredicateValueSchema,
  }),
]));

export type WorkspaceMemoryTableFilter =
  | z.infer<typeof NormalizedPredicateSchema>
  | { all: WorkspaceMemoryTableFilter[] }
  | { any: WorkspaceMemoryTableFilter[] };

export const WorkspaceMemoryTableFilterSchema: z.ZodType<WorkspaceMemoryTableFilter> =
  z.lazy(() => z.union([
    NormalizedPredicateSchema,
    z.strictObject({ all: z.array(WorkspaceMemoryTableFilterSchema) }),
    z.strictObject({ any: z.array(WorkspaceMemoryTableFilterSchema) }),
  ]));

export const WorkspaceMemoryTableQueryRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  exactRowIds: z.array(z.string().min(1)).nullable(),
  /** A prebuilt FTS5 MATCH expression over `memory_table_rows_fts`, or null. */
  ftsMatch: z.string().min(1).nullable(),
  filter: WorkspaceMemoryTableFilterSchema.nullable(),
  orderBy: z.array(z.strictObject({
    columnId: z.string().min(1),
    field: CellFieldSchema,
    direction: z.enum(["asc", "desc"]),
  })),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}));

/**
 * Rows and the table's data revision, read in one object event, so the
 * revision cannot change under the page the way it could when the row read
 * and the revision re-check were two facade round trips.
 */
export const WorkspaceMemoryTableQueryResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("found"),
    dataRevision: z.number().int().nonnegative(),
    rows: z.array(WorkspaceMemoryTableRowRecordSchema),
  }),
  z.strictObject({ outcome: z.literal("not_found") }),
]));

// -- Tables: writes -----------------------------------------------------------

const MemoryTableMutationRecordSchema = deferredZodSchema(() => z.strictObject({
  memoryTableMutationId: z.string().min(1),
  receiptId: z.string().min(1),
  operation: z.enum(["create", "insert_rows", "update_rows", "invalidate_rows"]),
  actorPrincipalJson: JsonTextSchema,
  harnessRunId: z.string().min(1),
  workstreamId: z.string().min(1),
  rationale: z.string(),
  inputHash: z.string().min(1),
  mutationJson: JsonTextSchema,
  resultJson: JsonTextSchema,
}));

export const WorkspaceMemoryTableCreateRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  usageInstructions: z.string(),
  keyColumnIdsJson: JsonTextSchema,
  provenanceJson: JsonTextSchema,
  columns: z.array(z.strictObject({
    memoryTableColumnId: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    valueType: MemoryTableColumnTypeSchema,
    isRequired: z.boolean(),
    isSearchable: z.boolean(),
    position: z.number().int().nonnegative(),
  })).min(1),
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}));

/** A reopen reconciles metadata and records its receipt in the same transaction. */
export const WorkspaceMemoryTableCreateResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("created") }),
  z.strictObject({ outcome: z.literal("opened"), memoryTableId: z.string().min(1), resultJson: z.string() }),
  z.strictObject({ outcome: z.literal("replayed"), resultJson: z.string() }),
  z.strictObject({ outcome: z.literal("receipt_mismatch") }),
  z.strictObject({ outcome: z.literal("schema_conflict"), memoryTableId: z.string().min(1), fields: z.array(z.string()).min(1) }),
]));

const MemoryTableCellSchema = deferredZodSchema(() => z.strictObject({
  memoryTableColumnId: z.string().min(1),
  valueType: MemoryTableColumnTypeSchema,
  stringValue: z.string().nullable(),
  numberValue: z.number().nullable(),
  booleanValue: z.number().int().min(0).max(1).nullable(),
  temporalValue: z.string().nullable(),
}));

export const WorkspaceMemoryTableInsertRowsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  rows: z.array(z.strictObject({
    memoryTableRowId: z.string().min(1),
    naturalKeyHash: z.string().min(1),
    dataJson: JsonTextSchema,
    searchableText: z.string(),
    cells: z.array(MemoryTableCellSchema),
  })).min(1),
  provenanceJson: JsonTextSchema,
  /** Rows the service dropped as exact duplicates inside one request. */
  duplicateInputCount: z.number().int().nonnegative(),
  mutation: MemoryTableMutationRecordSchema.unwrap().omit({ resultJson: true }),
  at: TimestampSchema,
}));

/**
 * The result is assembled inside the transaction because only the insert
 * itself knows which rows were new: the audit row must record the same
 * `insertedRows` the caller is told, so the object builds both from the
 * `RETURNING` witnesses rather than letting the service guess.
 */
export const WorkspaceMemoryTableInsertRowsResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("inserted"), resultJson: z.string() }),
  z.strictObject({ outcome: z.literal("replayed"), resultJson: z.string() }),
  z.strictObject({ outcome: z.literal("receipt_mismatch") }),
  z.strictObject({ outcome: z.literal("table_not_found") }),
]));

export const WorkspaceMemoryTableUpdateRowsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  rows: z.array(z.strictObject({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    dataJson: JsonTextSchema,
    searchableText: z.string(),
    cells: z.array(MemoryTableCellSchema),
  })).min(1),
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}));

export const WorkspaceMemoryTableInvalidateRowsRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  rows: z.array(z.strictObject({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  })).min(1),
  reason: z.string().min(1),
  actorPrincipalJson: JsonTextSchema,
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}));

export const WorkspaceMemoryTableWriteResultSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("written") }),
  z.strictObject({ outcome: z.literal("replayed"), resultJson: z.string() }),
  z.strictObject({ outcome: z.literal("receipt_mismatch") }),
  z.strictObject({ outcome: z.literal("table_not_found") }),
  z.strictObject({ outcome: z.literal("row_not_found") }),
  z.strictObject({ outcome: z.literal("row_revision_conflict") }),
]));

// -- Inferred types -----------------------------------------------------------

export type WorkspaceMemoryScopeEnsureRequest = z.infer<typeof WorkspaceMemoryScopeEnsureRequestSchema>;
export type WorkspaceMemoryScope = z.infer<typeof WorkspaceMemoryScopeSchema>;
export type WorkspaceMemoryReceiptRequest = z.infer<typeof WorkspaceMemoryReceiptRequestSchema>;
export type WorkspaceMemoryReceiptResult = z.infer<typeof WorkspaceMemoryReceiptResultSchema>;
export type WorkspaceMemoryTableRequest = z.infer<typeof WorkspaceMemoryTableRequestSchema>;
export type WorkspaceMemoryTableRow = z.infer<typeof WorkspaceMemoryTableRowSchema>;
export type WorkspaceMemoryTableColumn = z.infer<typeof WorkspaceMemoryTableColumnSchema>;
export type WorkspaceMemoryTableResult = z.infer<typeof WorkspaceMemoryTableResultSchema>;
export type WorkspaceMemoryTableSearchRequest = z.infer<typeof WorkspaceMemoryTableSearchRequestSchema>;
export type WorkspaceMemoryTableSearchResult = z.infer<typeof WorkspaceMemoryTableSearchResultSchema>;
export type WorkspaceMemoryTableRowRecord = z.infer<typeof WorkspaceMemoryTableRowRecordSchema>;
export type WorkspaceMemoryTableRowsByIdRequest = z.infer<typeof WorkspaceMemoryTableRowsByIdRequestSchema>;
export type WorkspaceMemoryTableRowList = z.infer<typeof WorkspaceMemoryTableRowListSchema>;
export type WorkspaceMemoryTableQueryRequest = z.infer<typeof WorkspaceMemoryTableQueryRequestSchema>;
export type WorkspaceMemoryTableQueryResult = z.infer<typeof WorkspaceMemoryTableQueryResultSchema>;
export type WorkspaceMemoryTableCreateRequest = z.infer<typeof WorkspaceMemoryTableCreateRequestSchema>;
export type WorkspaceMemoryTableCreateResult = z.infer<typeof WorkspaceMemoryTableCreateResultSchema>;
export type WorkspaceMemoryTableCell = z.infer<typeof MemoryTableCellSchema>;
export type WorkspaceMemoryTableInsertRowsRequest = z.infer<typeof WorkspaceMemoryTableInsertRowsRequestSchema>;
export type WorkspaceMemoryTableInsertRowsResult = z.infer<typeof WorkspaceMemoryTableInsertRowsResultSchema>;
export type WorkspaceMemoryTableUpdateRowsRequest = z.infer<typeof WorkspaceMemoryTableUpdateRowsRequestSchema>;
export type WorkspaceMemoryTableInvalidateRowsRequest = z.infer<typeof WorkspaceMemoryTableInvalidateRowsRequestSchema>;
export type WorkspaceMemoryTableWriteResult = z.infer<typeof WorkspaceMemoryTableWriteResultSchema>;
