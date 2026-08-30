import { IdSchema } from "@rally/contracts";
import { z } from "zod";

/**
 * Scoped durable memory — prose items and typed tables — as questions rather
 * than SQL.
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

export const MemoryScopeKindSchema = z.enum(["workstream", "automation", "user", "workspace"]);

// -- Scopes -------------------------------------------------------------------

export const WorkspaceMemoryScopeEnsureRequestSchema = z.object({
  workspaceId: IdSchema,
  /** Used only when the scope does not exist yet; the stored id wins. */
  proposedScopeId: z.string().min(1),
  kind: MemoryScopeKindSchema,
  ownerId: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryScopeSchema = z.object({
  memoryScopeId: z.string().min(1),
  workspaceId: z.string().min(1),
  kind: MemoryScopeKindSchema,
  ownerId: z.string().min(1),
}).strict();

// -- Item reads ---------------------------------------------------------------

export const WorkspaceMemoryFtsSearchRequestSchema = z.object({
  workspaceId: IdSchema,
  /** A prebuilt FTS5 MATCH expression; the service owns tokenization. */
  match: z.string().min(1),
  scopeIds: z.array(z.string().min(1)),
  now: TimestampSchema,
  limit: z.number().int().positive(),
}).strict();

export const WorkspaceMemoryCandidateListSchema = z.object({
  candidates: z.array(z.object({
    memoryItemId: z.string().min(1),
    revision: z.number().int().positive(),
  }).strict()),
}).strict();

export const WorkspaceMemoryCanonicalItemsRequestSchema = z.object({
  workspaceId: IdSchema,
  scopeIds: z.array(z.string().min(1)),
  memoryItemIds: z.array(z.string().min(1)),
  now: TimestampSchema,
}).strict();

export const WorkspaceMemoryItemSchema = z.object({
  memoryItemId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  workspaceId: z.string().min(1),
  scopeKind: MemoryScopeKindSchema,
  text: z.string(),
  revision: z.number().int().positive(),
  expiresAt: z.string().nullable(),
  invalidatedAt: z.string().nullable(),
  updatedAt: z.string(),
}).strict();

export const WorkspaceMemoryItemListSchema = z.object({
  items: z.array(WorkspaceMemoryItemSchema),
}).strict();

export const WorkspaceMemoryAccessRecordRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryItemIds: z.array(z.string().min(1)),
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryItemForWriteRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryItemId: z.string().min(1),
}).strict();

export const WorkspaceMemoryItemForWriteResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("found"), item: WorkspaceMemoryItemSchema }).strict(),
  z.object({ outcome: z.literal("not_found") }).strict(),
]);

// -- Mutation receipts --------------------------------------------------------

export const WorkspaceMemoryReceiptRequestSchema = z.object({
  workspaceId: IdSchema,
  harnessRunId: z.string().min(1),
  receiptId: z.string().min(1),
}).strict();

/**
 * `none` rather than a nullable row: the service compares operation and input
 * hash itself so a mismatched replay keeps raising the service's own error.
 */
export const WorkspaceMemoryReceiptResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("found"),
    operation: z.string(),
    inputHash: z.string(),
    resultJson: z.string(),
  }).strict(),
  z.object({ outcome: z.literal("none") }).strict(),
]);

const MemoryMutationRecordSchema = z.object({
  memoryMutationId: z.string().min(1),
  receiptId: z.string().min(1),
  actorPrincipalJson: JsonTextSchema,
  harnessRunId: z.string().min(1),
  workstreamId: z.string().min(1),
  rationale: z.string(),
  inputHash: z.string().min(1),
  mutationJson: JsonTextSchema,
  resultJson: JsonTextSchema,
}).strict();

// -- Item writes --------------------------------------------------------------

/**
 * The three write outcomes every memory mutation shares.
 *
 * A replayed receipt answers with the original result rather than repeating
 * the write, and a receipt whose payload hash disagrees is a defect the
 * service names. Both are decided inside the same transaction as the write,
 * which is what the D1 batch could not do — it read the receipt, lost the
 * race, and reconstructed the answer from the constraint violation.
 */
export const WorkspaceMemoryAddResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("added") }).strict(),
  z.object({ outcome: z.literal("replayed"), resultJson: z.string() }).strict(),
  z.object({ outcome: z.literal("receipt_mismatch") }).strict(),
]);

export const WorkspaceMemoryWriteResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written") }).strict(),
  z.object({ outcome: z.literal("replayed"), resultJson: z.string() }).strict(),
  z.object({ outcome: z.literal("receipt_mismatch") }).strict(),
  z.object({ outcome: z.literal("revision_conflict") }).strict(),
]);

export const WorkspaceMemoryAddRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryItemId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  text: z.string().min(1),
  expiresAt: z.string().nullable(),
  provenanceJson: JsonTextSchema,
  mutation: MemoryMutationRecordSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryUpdateRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryItemId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  text: z.string().min(1),
  expiresAt: z.string().nullable(),
  mutation: MemoryMutationRecordSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryInvalidateRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryItemId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  reason: z.string().min(1),
  mutation: MemoryMutationRecordSchema,
  at: TimestampSchema,
}).strict();

// -- Embedding outbox ---------------------------------------------------------

export const WorkspaceMemoryOutboxDueRequestSchema = z.object({
  workspaceId: IdSchema,
  now: TimestampSchema,
  limit: z.number().int().positive(),
}).strict();

export const WorkspaceMemoryOutboxRowSchema = z.object({
  outboxId: z.string().min(1),
  memoryItemId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  workspaceId: z.string().min(1),
  revision: z.number().int().positive(),
  operation: z.enum(["upsert", "delete"]),
  attemptCount: z.number().int().nonnegative(),
}).strict();

export const WorkspaceMemoryOutboxDueListSchema = z.object({
  rows: z.array(WorkspaceMemoryOutboxRowSchema),
}).strict();

export const WorkspaceMemoryOutboxClaimRequestSchema = z.object({
  workspaceId: IdSchema,
  outboxId: z.string().min(1),
  leaseToken: z.string().min(1),
  leaseExpiresAt: TimestampSchema,
  now: TimestampSchema,
}).strict();

export const WorkspaceMemoryOutboxClaimResultSchema = z.object({
  claimed: z.boolean(),
}).strict();

export const WorkspaceMemoryOutboxCompleteRequestSchema = z.object({
  workspaceId: IdSchema,
  outboxId: z.string().min(1),
  leaseToken: z.string().min(1),
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryOutboxRetryRequestSchema = z.object({
  workspaceId: IdSchema,
  outboxId: z.string().min(1),
  leaseToken: z.string().min(1),
  availableAt: TimestampSchema,
  lastError: z.string(),
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryProjectionSourceRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryItemId: z.string().min(1),
  memoryScopeId: z.string().min(1),
}).strict();

export const WorkspaceMemoryProjectionSourceResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("found"),
    text: z.string(),
    revision: z.number().int().positive(),
    invalidatedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    scopeKind: MemoryScopeKindSchema,
    scopeOwnerId: z.string().min(1),
  }).strict(),
  z.object({ outcome: z.literal("none") }).strict(),
]);

// -- Tables: reads ------------------------------------------------------------

export const MemoryTableColumnTypeSchema = z.enum([
  "string", "url", "number", "integer", "boolean", "datetime", "date",
]);

export const WorkspaceMemoryTableRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
}).strict();

export const WorkspaceMemoryTableRowSchema = z.object({
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
}).strict();

export const WorkspaceMemoryTableColumnSchema = z.object({
  memoryTableColumnId: z.string().min(1),
  memoryTableId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  valueType: MemoryTableColumnTypeSchema,
  isRequired: z.boolean(),
  isSearchable: z.boolean(),
  position: z.number().int().nonnegative(),
}).strict();

export const WorkspaceMemoryTableResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("found"),
    table: WorkspaceMemoryTableRowSchema,
    columns: z.array(WorkspaceMemoryTableColumnSchema),
  }).strict(),
  z.object({ outcome: z.literal("not_found") }).strict(),
]);

export const WorkspaceMemoryTableSearchRequestSchema = z.object({
  workspaceId: IdSchema,
  scopeIds: z.array(z.string().min(1)),
  /** A prebuilt LIKE pattern, already escaped with `\`; matched NOCASE. */
  like: z.string().min(1),
  limit: z.number().int().positive(),
}).strict();

export const WorkspaceMemoryTableSearchResultSchema = z.object({
  memoryTableIds: z.array(z.string().min(1)),
}).strict();

export const WorkspaceMemoryTableRowRecordSchema = z.object({
  memoryTableRowId: z.string().min(1),
  dataJson: z.string(),
  revision: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
  invalidatedAt: z.string().nullable(),
}).strict();

export const WorkspaceMemoryTableRowsByIdRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  memoryTableRowIds: z.array(z.string().min(1)),
}).strict();

export const WorkspaceMemoryTableRowListSchema = z.object({
  rows: z.array(WorkspaceMemoryTableRowRecordSchema),
}).strict();

// The service resolves column references and value types against the schema it
// already authorized, so a filter arrives here fully normalized: column ids
// from the table's own rows, the physical cell field for each id, and values
// already coerced. The object turns it into SQL without consulting the schema.
const CellFieldSchema = z.enum(["string_value", "number_value", "boolean_value", "temporal_value"]);
const PredicateValueSchema = z.union([z.string(), z.number(), z.null()]);

const NormalizedPredicateSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("exists"), columnId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("not_exists"), columnId: z.string().min(1) }).strict(),
  z.object({
    op: z.literal("in"),
    columnId: z.string().min(1),
    field: CellFieldSchema,
    valuesJson: z.string().min(1),
    negated: z.boolean(),
  }).strict(),
  z.object({
    op: z.literal("between"),
    columnId: z.string().min(1),
    field: CellFieldSchema,
    from: PredicateValueSchema,
    to: PredicateValueSchema,
  }).strict(),
  z.object({
    op: z.literal("like"),
    columnId: z.string().min(1),
    pattern: z.string(),
    negated: z.boolean(),
  }).strict(),
  z.object({
    op: z.literal("compare"),
    columnId: z.string().min(1),
    field: CellFieldSchema,
    comparison: z.enum(["eq", "neq", "gt", "gte", "lt", "lte"]),
    value: PredicateValueSchema,
  }).strict(),
]);

export type WorkspaceMemoryTableFilter =
  | z.infer<typeof NormalizedPredicateSchema>
  | { all: WorkspaceMemoryTableFilter[] }
  | { any: WorkspaceMemoryTableFilter[] };

export const WorkspaceMemoryTableFilterSchema: z.ZodType<WorkspaceMemoryTableFilter> =
  z.lazy(() => z.union([
    NormalizedPredicateSchema,
    z.object({ all: z.array(WorkspaceMemoryTableFilterSchema) }).strict(),
    z.object({ any: z.array(WorkspaceMemoryTableFilterSchema) }).strict(),
  ]));

export const WorkspaceMemoryTableQueryRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  exactRowIds: z.array(z.string().min(1)).nullable(),
  /** A prebuilt FTS5 MATCH expression over `memory_table_rows_fts`, or null. */
  ftsMatch: z.string().min(1).nullable(),
  filter: WorkspaceMemoryTableFilterSchema.nullable(),
  orderBy: z.array(z.object({
    columnId: z.string().min(1),
    field: CellFieldSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict()),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
}).strict();

/**
 * Rows and the table's data revision, read in one object event, so the
 * revision cannot change under the page the way it could when the row read
 * and the revision re-check were two facade round trips.
 */
export const WorkspaceMemoryTableQueryResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("found"),
    dataRevision: z.number().int().nonnegative(),
    rows: z.array(WorkspaceMemoryTableRowRecordSchema),
  }).strict(),
  z.object({ outcome: z.literal("not_found") }).strict(),
]);

// -- Tables: writes -----------------------------------------------------------

const MemoryTableMutationRecordSchema = z.object({
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
}).strict();

export const WorkspaceMemoryTableCreateRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  usageInstructions: z.string(),
  keyColumnIdsJson: JsonTextSchema,
  provenanceJson: JsonTextSchema,
  columns: z.array(z.object({
    memoryTableColumnId: z.string().min(1),
    name: z.string().min(1),
    description: z.string(),
    valueType: MemoryTableColumnTypeSchema,
    isRequired: z.boolean(),
    isSearchable: z.boolean(),
    position: z.number().int().nonnegative(),
  }).strict()).min(1),
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}).strict();

/**
 * `name_exists` carries the standing table's id and writes nothing: whether
 * the schemas match — and therefore whether this is an idempotent reopen or a
 * conflict — is the service's comparison to make, against columns it reads
 * back through `memoryTableWithColumns`.
 */
export const WorkspaceMemoryTableCreateResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("created") }).strict(),
  z.object({ outcome: z.literal("replayed"), resultJson: z.string() }).strict(),
  z.object({ outcome: z.literal("receipt_mismatch") }).strict(),
  z.object({ outcome: z.literal("name_exists"), memoryTableId: z.string().min(1) }).strict(),
]);

export const WorkspaceMemoryTableOpenReceiptRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  memoryScopeId: z.string().min(1),
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}).strict();

const MemoryTableCellSchema = z.object({
  memoryTableColumnId: z.string().min(1),
  valueType: MemoryTableColumnTypeSchema,
  stringValue: z.string().nullable(),
  numberValue: z.number().nullable(),
  booleanValue: z.number().int().min(0).max(1).nullable(),
  temporalValue: z.string().nullable(),
}).strict();

export const WorkspaceMemoryTableInsertRowsRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    naturalKeyHash: z.string().min(1),
    dataJson: JsonTextSchema,
    searchableText: z.string(),
    cells: z.array(MemoryTableCellSchema),
  }).strict()).min(1),
  provenanceJson: JsonTextSchema,
  /** Rows the service dropped as exact duplicates inside one request. */
  duplicateInputCount: z.number().int().nonnegative(),
  mutation: MemoryTableMutationRecordSchema.omit({ resultJson: true }),
  at: TimestampSchema,
}).strict();

/**
 * The result is assembled inside the transaction because only the insert
 * itself knows which rows were new: the audit row must record the same
 * `insertedRows` the caller is told, so the object builds both from the
 * `RETURNING` witnesses rather than letting the service guess.
 */
export const WorkspaceMemoryTableInsertRowsResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("inserted"), resultJson: z.string() }).strict(),
  z.object({ outcome: z.literal("replayed"), resultJson: z.string() }).strict(),
  z.object({ outcome: z.literal("receipt_mismatch") }).strict(),
  z.object({ outcome: z.literal("table_not_found") }).strict(),
]);

export const WorkspaceMemoryTableUpdateRowsRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
    dataJson: JsonTextSchema,
    searchableText: z.string(),
    cells: z.array(MemoryTableCellSchema),
  }).strict()).min(1),
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryTableInvalidateRowsRequestSchema = z.object({
  workspaceId: IdSchema,
  memoryTableId: z.string().min(1),
  rows: z.array(z.object({
    memoryTableRowId: z.string().min(1),
    expectedRevision: z.number().int().positive(),
  }).strict()).min(1),
  reason: z.string().min(1),
  actorPrincipalJson: JsonTextSchema,
  mutation: MemoryTableMutationRecordSchema,
  at: TimestampSchema,
}).strict();

export const WorkspaceMemoryTableWriteResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written") }).strict(),
  z.object({ outcome: z.literal("replayed"), resultJson: z.string() }).strict(),
  z.object({ outcome: z.literal("receipt_mismatch") }).strict(),
  z.object({ outcome: z.literal("table_not_found") }).strict(),
  z.object({ outcome: z.literal("row_not_found") }).strict(),
  z.object({ outcome: z.literal("row_revision_conflict") }).strict(),
]);

// -- Inferred types -----------------------------------------------------------

export type WorkspaceMemoryScopeEnsureRequest = z.infer<typeof WorkspaceMemoryScopeEnsureRequestSchema>;
export type WorkspaceMemoryScope = z.infer<typeof WorkspaceMemoryScopeSchema>;
export type WorkspaceMemoryFtsSearchRequest = z.infer<typeof WorkspaceMemoryFtsSearchRequestSchema>;
export type WorkspaceMemoryCandidateList = z.infer<typeof WorkspaceMemoryCandidateListSchema>;
export type WorkspaceMemoryCanonicalItemsRequest = z.infer<typeof WorkspaceMemoryCanonicalItemsRequestSchema>;
export type WorkspaceMemoryItem = z.infer<typeof WorkspaceMemoryItemSchema>;
export type WorkspaceMemoryItemList = z.infer<typeof WorkspaceMemoryItemListSchema>;
export type WorkspaceMemoryAccessRecordRequest = z.infer<typeof WorkspaceMemoryAccessRecordRequestSchema>;
export type WorkspaceMemoryItemForWriteRequest = z.infer<typeof WorkspaceMemoryItemForWriteRequestSchema>;
export type WorkspaceMemoryItemForWriteResult = z.infer<typeof WorkspaceMemoryItemForWriteResultSchema>;
export type WorkspaceMemoryReceiptRequest = z.infer<typeof WorkspaceMemoryReceiptRequestSchema>;
export type WorkspaceMemoryReceiptResult = z.infer<typeof WorkspaceMemoryReceiptResultSchema>;
export type WorkspaceMemoryAddRequest = z.infer<typeof WorkspaceMemoryAddRequestSchema>;
export type WorkspaceMemoryAddResult = z.infer<typeof WorkspaceMemoryAddResultSchema>;
export type WorkspaceMemoryUpdateRequest = z.infer<typeof WorkspaceMemoryUpdateRequestSchema>;
export type WorkspaceMemoryInvalidateRequest = z.infer<typeof WorkspaceMemoryInvalidateRequestSchema>;
export type WorkspaceMemoryWriteResult = z.infer<typeof WorkspaceMemoryWriteResultSchema>;
export type WorkspaceMemoryOutboxDueRequest = z.infer<typeof WorkspaceMemoryOutboxDueRequestSchema>;
export type WorkspaceMemoryOutboxRow = z.infer<typeof WorkspaceMemoryOutboxRowSchema>;
export type WorkspaceMemoryOutboxDueList = z.infer<typeof WorkspaceMemoryOutboxDueListSchema>;
export type WorkspaceMemoryOutboxClaimRequest = z.infer<typeof WorkspaceMemoryOutboxClaimRequestSchema>;
export type WorkspaceMemoryOutboxClaimResult = z.infer<typeof WorkspaceMemoryOutboxClaimResultSchema>;
export type WorkspaceMemoryOutboxCompleteRequest = z.infer<typeof WorkspaceMemoryOutboxCompleteRequestSchema>;
export type WorkspaceMemoryOutboxRetryRequest = z.infer<typeof WorkspaceMemoryOutboxRetryRequestSchema>;
export type WorkspaceMemoryProjectionSourceRequest = z.infer<typeof WorkspaceMemoryProjectionSourceRequestSchema>;
export type WorkspaceMemoryProjectionSourceResult = z.infer<typeof WorkspaceMemoryProjectionSourceResultSchema>;
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
export type WorkspaceMemoryTableOpenReceiptRequest = z.infer<typeof WorkspaceMemoryTableOpenReceiptRequestSchema>;
export type WorkspaceMemoryTableCell = z.infer<typeof MemoryTableCellSchema>;
export type WorkspaceMemoryTableInsertRowsRequest = z.infer<typeof WorkspaceMemoryTableInsertRowsRequestSchema>;
export type WorkspaceMemoryTableInsertRowsResult = z.infer<typeof WorkspaceMemoryTableInsertRowsResultSchema>;
export type WorkspaceMemoryTableUpdateRowsRequest = z.infer<typeof WorkspaceMemoryTableUpdateRowsRequestSchema>;
export type WorkspaceMemoryTableInvalidateRowsRequest = z.infer<typeof WorkspaceMemoryTableInvalidateRowsRequestSchema>;
export type WorkspaceMemoryTableWriteResult = z.infer<typeof WorkspaceMemoryTableWriteResultSchema>;
