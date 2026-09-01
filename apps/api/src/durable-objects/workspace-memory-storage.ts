import {
  WorkspaceMemoryAddResultSchema,
  WorkspaceMemoryCandidateListSchema,
  WorkspaceMemoryItemForWriteResultSchema,
  WorkspaceMemoryItemListSchema,
  WorkspaceMemoryOutboxClaimResultSchema,
  WorkspaceMemoryOutboxDueListSchema,
  WorkspaceMemoryProjectionSourceResultSchema,
  WorkspaceMemoryReceiptResultSchema,
  WorkspaceMemoryScopeSchema,
  WorkspaceMemoryTableCreateResultSchema,
  WorkspaceMemoryTableInsertRowsResultSchema,
  WorkspaceMemoryTableQueryResultSchema,
  WorkspaceMemoryTableResultSchema,
  WorkspaceMemoryTableRowListSchema,
  WorkspaceMemoryTableSearchResultSchema,
  WorkspaceMemoryTableWriteResultSchema,
  WorkspaceMemoryWriteResultSchema,
  type WorkspaceMemoryAddRequest,
  type WorkspaceMemoryAddResult,
  type WorkspaceMemoryAccessRecordRequest,
  type WorkspaceMemoryCandidateList,
  type WorkspaceMemoryCanonicalItemsRequest,
  type WorkspaceMemoryFtsSearchRequest,
  type WorkspaceMemoryInvalidateRequest,
  type WorkspaceMemoryItemForWriteRequest,
  type WorkspaceMemoryItemForWriteResult,
  type WorkspaceMemoryItemList,
  type WorkspaceMemoryOutboxClaimRequest,
  type WorkspaceMemoryOutboxClaimResult,
  type WorkspaceMemoryOutboxCompleteRequest,
  type WorkspaceMemoryOutboxDueList,
  type WorkspaceMemoryOutboxDueRequest,
  type WorkspaceMemoryOutboxRetryRequest,
  type WorkspaceMemoryProjectionSourceRequest,
  type WorkspaceMemoryProjectionSourceResult,
  type WorkspaceMemoryReceiptRequest,
  type WorkspaceMemoryReceiptResult,
  type WorkspaceMemoryScope,
  type WorkspaceMemoryScopeEnsureRequest,
  type WorkspaceMemoryTableCreateRequest,
  type WorkspaceMemoryTableCreateResult,
  type WorkspaceMemoryTableFilter,
  type WorkspaceMemoryTableInsertRowsRequest,
  type WorkspaceMemoryTableInsertRowsResult,
  type WorkspaceMemoryTableInvalidateRowsRequest,
  type WorkspaceMemoryTableOpenReceiptRequest,
  type WorkspaceMemoryTableQueryRequest,
  type WorkspaceMemoryTableQueryResult,
  type WorkspaceMemoryTableRequest,
  type WorkspaceMemoryTableResult,
  type WorkspaceMemoryTableRowList,
  type WorkspaceMemoryTableRowsByIdRequest,
  type WorkspaceMemoryTableSearchRequest,
  type WorkspaceMemoryTableSearchResult,
  type WorkspaceMemoryTableUpdateRowsRequest,
  type WorkspaceMemoryTableWriteResult,
  type WorkspaceMemoryUpdateRequest,
  type WorkspaceMemoryWriteResult,
} from "./workspace-memory-protocol";

/**
 * Every caller-supplied id list is bound as one JSON parameter and expanded
 * with `json_each`, never as `IN (?, ?, …)`: object SQLite refuses a statement
 * with more than 100 bound parameters, and the row-id lists here are sized by
 * the model's request rather than by this module.
 */
const inJsonList = (column: string): string =>
  `${column} IN (SELECT value FROM json_each(?))`;

interface MutationRecord {
  memoryMutationId?: string;
  memoryTableMutationId?: string;
  receiptId: string;
  actorPrincipalJson: string;
  harnessRunId: string;
  workstreamId: string;
  rationale: string;
  inputHash: string;
  mutationJson: string;
  resultJson?: string;
}

type ReceiptRow = {
  operation: string;
  input_hash: string;
  result_json: string;
}

function receiptFor(
  storage: DurableObjectStorage,
  table: "memory_mutations" | "memory_table_mutations",
  workspaceId: string,
  harnessRunId: string,
  receiptId: string,
): ReceiptRow | undefined {
  return storage.sql.exec<ReceiptRow>(
    `SELECT operation, input_hash, result_json FROM ${table}
      WHERE receipt_id = ? AND workspace_id = ? AND harness_run_id = ?`,
    receiptId,
    workspaceId,
    harnessRunId,
  ).toArray()[0];
}

/**
 * The replay decision shared by every memory write: a standing receipt with
 * the same operation and payload hash answers with its recorded result, and
 * one with a different payload is a defect the caller names. Returns `null`
 * when the write should proceed.
 */
function settledReceipt(
  receipt: ReceiptRow | undefined,
  operation: string,
  inputHash: string,
): { outcome: "replayed"; resultJson: string } | { outcome: "receipt_mismatch" } | null {
  if (!receipt) return null;
  if (receipt.operation !== operation || receipt.input_hash !== inputHash) {
    return { outcome: "receipt_mismatch" };
  }
  return { outcome: "replayed", resultJson: receipt.result_json };
}

// -- Scopes -------------------------------------------------------------------

/** Create the scope if it is missing and answer with the stored row either way. */
export function ensureWorkspaceMemoryScope(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryScopeEnsureRequest,
): WorkspaceMemoryScope {
  return storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO memory_scopes (memory_scope_id, workspace_id, kind, owner_id, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, kind, owner_id) DO NOTHING`,
      request.proposedScopeId,
      request.workspaceId,
      request.kind,
      request.ownerId,
      request.at,
    );
    const row = storage.sql.exec<{
      memory_scope_id: string;
      workspace_id: string;
      kind: WorkspaceMemoryScope["kind"];
      owner_id: string;
    }>(
      `SELECT memory_scope_id, workspace_id, kind, owner_id
         FROM memory_scopes
        WHERE workspace_id = ? AND kind = ? AND owner_id = ?`,
      request.workspaceId,
      request.kind,
      request.ownerId,
    ).toArray()[0];
    if (!row) throw new Error("memory_scope_creation_failed");
    return WorkspaceMemoryScopeSchema.parse({
      memoryScopeId: row.memory_scope_id,
      workspaceId: row.workspace_id,
      kind: row.kind,
      ownerId: row.owner_id,
    });
  });
}

// -- Item reads ---------------------------------------------------------------

/** The FTS leg of hybrid retrieval: live items in the given scopes, bm25-ranked. */
export function searchWorkspaceMemoryItemsFts(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryFtsSearchRequest,
): WorkspaceMemoryCandidateList {
  const rows = storage.sql.exec<{ memory_item_id: string; revision: number }>(
    `SELECT item.memory_item_id, item.revision
       FROM memory_items_fts
       JOIN memory_items item ON item.rowid = memory_items_fts.rowid
      WHERE memory_items_fts MATCH ?
        AND ${inJsonList("item.memory_scope_id")}
        AND item.invalidated_at IS NULL
        AND (item.expires_at IS NULL OR item.expires_at > ?)
      ORDER BY bm25(memory_items_fts), item.updated_at DESC
      LIMIT ?`,
    request.match,
    JSON.stringify(request.scopeIds),
    request.now,
    request.limit,
  ).toArray();
  return WorkspaceMemoryCandidateListSchema.parse({
    candidates: rows.map((row) => ({
      memoryItemId: row.memory_item_id,
      revision: Number(row.revision),
    })),
  });
}

type ItemRow = {
  memory_item_id: string;
  memory_scope_id: string;
  workspace_id: string;
  scope_kind: WorkspaceMemoryScope["kind"];
  text: string;
  revision: number;
  expires_at: string | null;
  invalidated_at: string | null;
  updated_at: string;
}

function itemFromRow(row: ItemRow) {
  return {
    memoryItemId: row.memory_item_id,
    memoryScopeId: row.memory_scope_id,
    workspaceId: row.workspace_id,
    scopeKind: row.scope_kind,
    text: row.text,
    revision: Number(row.revision),
    expiresAt: row.expires_at,
    invalidatedAt: row.invalidated_at,
    updatedAt: row.updated_at,
  };
}

/** Live items among the requested ids, restricted to the authorized scopes. */
export function canonicalWorkspaceMemoryItems(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryCanonicalItemsRequest,
): WorkspaceMemoryItemList {
  if (request.scopeIds.length === 0 || request.memoryItemIds.length === 0) {
    return WorkspaceMemoryItemListSchema.parse({ items: [] });
  }
  const rows = storage.sql.exec<ItemRow>(
    `SELECT item.memory_item_id, item.memory_scope_id, item.workspace_id,
            scope.kind AS scope_kind, item.text, item.revision, item.expires_at,
            item.invalidated_at, item.updated_at
       FROM memory_items item
       JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
      WHERE item.workspace_id = ?
        AND ${inJsonList("item.memory_scope_id")}
        AND ${inJsonList("item.memory_item_id")}
        AND item.invalidated_at IS NULL
        AND (item.expires_at IS NULL OR item.expires_at > ?)`,
    request.workspaceId,
    JSON.stringify(request.scopeIds),
    JSON.stringify(request.memoryItemIds),
    request.now,
  ).toArray();
  return WorkspaceMemoryItemListSchema.parse({ items: rows.map(itemFromRow) });
}

/** Bump non-authoritative access counters; a lost update costs nothing. */
export function recordWorkspaceMemoryItemAccess(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryAccessRecordRequest,
): void {
  if (request.memoryItemIds.length === 0) return;
  storage.sql.exec(
    `UPDATE memory_items
        SET access_count = access_count + 1, last_accessed_at = ?
      WHERE workspace_id = ? AND ${inJsonList("memory_item_id")}
        AND invalidated_at IS NULL`,
    request.at,
    request.workspaceId,
    JSON.stringify(request.memoryItemIds),
  );
}

/** One item with its scope kind, regardless of liveness — the write path's read. */
export function workspaceMemoryItemForWrite(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryItemForWriteRequest,
): WorkspaceMemoryItemForWriteResult {
  const row = storage.sql.exec<ItemRow>(
    `SELECT item.memory_item_id, item.memory_scope_id, item.workspace_id,
            scope.kind AS scope_kind, item.text, item.revision, item.expires_at,
            item.invalidated_at, item.updated_at
       FROM memory_items item
       JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
      WHERE item.memory_item_id = ? AND item.workspace_id = ?`,
    request.memoryItemId,
    request.workspaceId,
  ).toArray()[0];
  return WorkspaceMemoryItemForWriteResultSchema.parse(
    row ? { outcome: "found", item: itemFromRow(row) } : { outcome: "not_found" },
  );
}

// -- Mutation receipts --------------------------------------------------------

export function workspaceMemoryMutationReceipt(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryReceiptRequest,
): WorkspaceMemoryReceiptResult {
  const row = receiptFor(
    storage, "memory_mutations", request.workspaceId, request.harnessRunId, request.receiptId,
  );
  return WorkspaceMemoryReceiptResultSchema.parse(row
    ? {
      outcome: "found",
      operation: row.operation,
      inputHash: row.input_hash,
      resultJson: row.result_json,
    }
    : { outcome: "none" });
}

export function workspaceMemoryTableMutationReceipt(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryReceiptRequest,
): WorkspaceMemoryReceiptResult {
  const row = receiptFor(
    storage, "memory_table_mutations", request.workspaceId, request.harnessRunId, request.receiptId,
  );
  return WorkspaceMemoryReceiptResultSchema.parse(row
    ? {
      outcome: "found",
      operation: row.operation,
      inputHash: row.input_hash,
      resultJson: row.result_json,
    }
    : { outcome: "none" });
}

// -- Item writes --------------------------------------------------------------

function insertMemoryMutation(
  storage: DurableObjectStorage,
  workspaceId: string,
  memoryItemId: string,
  memoryScopeId: string,
  operation: "add" | "update" | "invalidate",
  priorRevision: number | null,
  resultingRevision: number,
  mutation: MutationRecord,
  at: string,
): void {
  storage.sql.exec(
    `INSERT INTO memory_mutations
       (memory_mutation_id, receipt_id, memory_item_id, memory_scope_id, workspace_id,
        operation, prior_revision, resulting_revision, actor_principal_json,
        harness_run_id, workstream_id, rationale, input_hash, mutation_json,
        result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    mutation.memoryMutationId ?? null,
    mutation.receiptId,
    memoryItemId,
    memoryScopeId,
    workspaceId,
    operation,
    priorRevision,
    resultingRevision,
    mutation.actorPrincipalJson,
    mutation.harnessRunId,
    mutation.workstreamId,
    mutation.rationale,
    mutation.inputHash,
    mutation.mutationJson,
    mutation.resultJson ?? null,
    at,
  );
}

function insertOutboxRow(
  storage: DurableObjectStorage,
  workspaceId: string,
  outboxId: string,
  memoryItemId: string,
  memoryScopeId: string,
  revision: number,
  operation: "upsert" | "delete",
  at: string,
): void {
  storage.sql.exec(
    `INSERT INTO memory_index_outbox
       (outbox_id, memory_item_id, memory_scope_id, workspace_id, revision,
        operation, status, available_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    outboxId,
    memoryItemId,
    memoryScopeId,
    workspaceId,
    revision,
    operation,
    at,
    at,
    at,
  );
}

/** The item, its audit record, and its embedding-outbox intent, or a replay. */
export function addWorkspaceMemoryItem(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryAddRequest,
  outboxId: string,
): WorkspaceMemoryAddResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "add",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryAddResultSchema.parse(settled);
    storage.sql.exec(
      `INSERT INTO memory_items
         (memory_item_id, memory_scope_id, workspace_id, text, revision, expires_at,
          provenance_json, last_mutation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      request.memoryItemId,
      request.memoryScopeId,
      request.workspaceId,
      request.text,
      request.expiresAt,
      request.provenanceJson,
      request.mutation.memoryMutationId ?? "",
      request.at,
      request.at,
    );
    insertMemoryMutation(
      storage, request.workspaceId, request.memoryItemId, request.memoryScopeId,
      "add", null, 1, request.mutation, request.at,
    );
    insertOutboxRow(
      storage, request.workspaceId, outboxId, request.memoryItemId,
      request.memoryScopeId, 1, "upsert", request.at,
    );
    return WorkspaceMemoryAddResultSchema.parse({ outcome: "added" });
  });
}

/**
 * Compare-and-set on the item's revision, with the audit and outbox rows in
 * the same transaction. The witness is the `RETURNING` row: a revision that
 * moved since the caller's read answers `revision_conflict` having written
 * nothing, where the facade path had to reconstruct that answer from a D1
 * batch counter after the fact.
 */
export function updateWorkspaceMemoryItem(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryUpdateRequest,
  outboxId: string,
): WorkspaceMemoryWriteResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "update",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryWriteResultSchema.parse(settled);
    const nextRevision = request.expectedRevision + 1;
    const witness = storage.sql.exec<{ revision: number }>(
      `UPDATE memory_items
          SET text = ?, revision = ?, expires_at = ?, last_mutation_id = ?, updated_at = ?
        WHERE memory_item_id = ? AND workspace_id = ? AND memory_scope_id = ?
          AND revision = ? AND invalidated_at IS NULL
        RETURNING revision`,
      request.text,
      nextRevision,
      request.expiresAt,
      request.mutation.memoryMutationId ?? "",
      request.at,
      request.memoryItemId,
      request.workspaceId,
      request.memoryScopeId,
      request.expectedRevision,
    ).toArray()[0];
    if (Number(witness?.revision) !== nextRevision) {
      return WorkspaceMemoryWriteResultSchema.parse({ outcome: "revision_conflict" });
    }
    insertMemoryMutation(
      storage, request.workspaceId, request.memoryItemId, request.memoryScopeId,
      "update", request.expectedRevision, nextRevision, request.mutation, request.at,
    );
    insertOutboxRow(
      storage, request.workspaceId, outboxId, request.memoryItemId,
      request.memoryScopeId, nextRevision, "upsert", request.at,
    );
    return WorkspaceMemoryWriteResultSchema.parse({ outcome: "written" });
  });
}

/** The reversible tombstone: same CAS shape as update, outbox op `delete`. */
export function invalidateWorkspaceMemoryItem(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryInvalidateRequest,
  outboxId: string,
): WorkspaceMemoryWriteResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "invalidate",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryWriteResultSchema.parse(settled);
    const nextRevision = request.expectedRevision + 1;
    const witness = storage.sql.exec<{ revision: number }>(
      `UPDATE memory_items
          SET revision = ?, invalidated_at = ?, invalidated_by_principal_json = ?,
              invalidation_reason = ?, last_mutation_id = ?, updated_at = ?
        WHERE memory_item_id = ? AND workspace_id = ? AND memory_scope_id = ?
          AND revision = ? AND invalidated_at IS NULL
        RETURNING revision`,
      nextRevision,
      request.at,
      request.mutation.actorPrincipalJson,
      request.reason,
      request.mutation.memoryMutationId ?? "",
      request.at,
      request.memoryItemId,
      request.workspaceId,
      request.memoryScopeId,
      request.expectedRevision,
    ).toArray()[0];
    if (Number(witness?.revision) !== nextRevision) {
      return WorkspaceMemoryWriteResultSchema.parse({ outcome: "revision_conflict" });
    }
    insertMemoryMutation(
      storage, request.workspaceId, request.memoryItemId, request.memoryScopeId,
      "invalidate", request.expectedRevision, nextRevision, request.mutation, request.at,
    );
    insertOutboxRow(
      storage, request.workspaceId, outboxId, request.memoryItemId,
      request.memoryScopeId, nextRevision, "delete", request.at,
    );
    return WorkspaceMemoryWriteResultSchema.parse({ outcome: "written" });
  });
}

// -- Embedding outbox ---------------------------------------------------------

export function dueWorkspaceMemoryIndexOutbox(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryOutboxDueRequest,
): WorkspaceMemoryOutboxDueList {
  const rows = storage.sql.exec<{
    outbox_id: string;
    memory_item_id: string;
    memory_scope_id: string;
    workspace_id: string;
    revision: number;
    operation: "upsert" | "delete";
    attempt_count: number;
  }>(
    `SELECT outbox_id, memory_item_id, memory_scope_id, workspace_id,
            revision, operation, attempt_count
       FROM memory_index_outbox
      WHERE workspace_id = ?
        AND ((status = 'pending' AND available_at <= ?)
          OR (status = 'processing' AND lease_expires_at <= ?))
      ORDER BY created_at ASC, outbox_id ASC
      LIMIT ?`,
    request.workspaceId,
    request.now,
    request.now,
    request.limit,
  ).toArray();
  return WorkspaceMemoryOutboxDueListSchema.parse({
    rows: rows.map((row) => ({
      outboxId: row.outbox_id,
      memoryItemId: row.memory_item_id,
      memoryScopeId: row.memory_scope_id,
      workspaceId: row.workspace_id,
      revision: Number(row.revision),
      operation: row.operation,
      attemptCount: Number(row.attempt_count),
    })),
  });
}

/** Claim one due row for this lease; the witness is the returned lease token. */
export function claimWorkspaceMemoryIndexOutboxRow(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryOutboxClaimRequest,
): WorkspaceMemoryOutboxClaimResult {
  const witness = storage.sql.exec<{ outbox_id: string; lease_token: string | null }>(
    `UPDATE memory_index_outbox
        SET status = 'processing', lease_token = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1, updated_at = ?
      WHERE outbox_id = ? AND workspace_id = ? AND (
        (status = 'pending' AND available_at <= ?)
        OR (status = 'processing' AND lease_expires_at <= ?)
      )
      RETURNING outbox_id, lease_token`,
    request.leaseToken,
    request.leaseExpiresAt,
    request.now,
    request.outboxId,
    request.workspaceId,
    request.now,
    request.now,
  ).toArray()[0];
  return WorkspaceMemoryOutboxClaimResultSchema.parse({
    claimed: witness?.outbox_id === request.outboxId && witness.lease_token === request.leaseToken,
  });
}

export function completeWorkspaceMemoryIndexOutboxRow(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryOutboxCompleteRequest,
): void {
  storage.sql.exec(
    `UPDATE memory_index_outbox
        SET status = 'completed', completed_at = ?, lease_token = NULL,
            lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE outbox_id = ? AND workspace_id = ?
        AND status = 'processing' AND lease_token = ?`,
    request.at,
    request.at,
    request.outboxId,
    request.workspaceId,
    request.leaseToken,
  );
}

export function retryWorkspaceMemoryIndexOutboxRow(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryOutboxRetryRequest,
): void {
  storage.sql.exec(
    `UPDATE memory_index_outbox
        SET status = 'pending', available_at = ?, lease_token = NULL,
            lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE outbox_id = ? AND workspace_id = ?
        AND status = 'processing' AND lease_token = ?`,
    request.availableAt,
    request.lastError,
    request.at,
    request.outboxId,
    request.workspaceId,
    request.leaseToken,
  );
}

/** What the vector index should hold for this item, read at projection time. */
export function workspaceMemoryIndexProjectionSource(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryProjectionSourceRequest,
): WorkspaceMemoryProjectionSourceResult {
  const row = storage.sql.exec<{
    text: string;
    revision: number;
    invalidated_at: string | null;
    expires_at: string | null;
    scope_kind: WorkspaceMemoryScope["kind"];
    scope_owner_id: string;
  }>(
    `SELECT item.text, item.revision, item.invalidated_at, item.expires_at,
            scope.kind AS scope_kind, scope.owner_id AS scope_owner_id
       FROM memory_items item
       JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
      WHERE item.memory_item_id = ? AND item.memory_scope_id = ? AND item.workspace_id = ?`,
    request.memoryItemId,
    request.memoryScopeId,
    request.workspaceId,
  ).toArray()[0];
  return WorkspaceMemoryProjectionSourceResultSchema.parse(row
    ? {
      outcome: "found",
      text: row.text,
      revision: Number(row.revision),
      invalidatedAt: row.invalidated_at,
      expiresAt: row.expires_at,
      scopeKind: row.scope_kind,
      scopeOwnerId: row.scope_owner_id,
    }
    : { outcome: "none" });
}

// -- Tables: reads ------------------------------------------------------------

type TableRow = {
  memory_table_id: string;
  memory_scope_id: string;
  workspace_id: string;
  scope_kind: WorkspaceMemoryScope["kind"];
  name: string;
  description: string;
  usage_instructions: string;
  key_column_ids_json: string;
  schema_revision: number;
  data_revision: number;
  invalidated_at: string | null;
}

type ColumnRow = {
  memory_table_column_id: string;
  memory_table_id: string;
  name: string;
  description: string;
  value_type: "string" | "url" | "number" | "integer" | "boolean" | "datetime" | "date";
  is_required: number;
  is_searchable: number;
  position: number;
}

/** One table and its ordered columns, invalidated or not — the caller decides. */
export function workspaceMemoryTableWithColumns(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableRequest,
): WorkspaceMemoryTableResult {
  const table = storage.sql.exec<TableRow>(
    `SELECT table_def.memory_table_id, table_def.memory_scope_id, table_def.workspace_id,
            scope.kind AS scope_kind, table_def.name, table_def.description,
            table_def.usage_instructions, table_def.key_column_ids_json,
            table_def.schema_revision, table_def.data_revision, table_def.invalidated_at
       FROM memory_tables table_def
       JOIN memory_scopes scope ON scope.memory_scope_id = table_def.memory_scope_id
      WHERE table_def.memory_table_id = ? AND table_def.workspace_id = ?`,
    request.memoryTableId,
    request.workspaceId,
  ).toArray()[0];
  if (!table) return WorkspaceMemoryTableResultSchema.parse({ outcome: "not_found" });
  const columns = storage.sql.exec<ColumnRow>(
    `SELECT memory_table_column_id, memory_table_id, name, description,
            value_type, is_required, is_searchable, position
       FROM memory_table_columns WHERE memory_table_id = ? ORDER BY position`,
    request.memoryTableId,
  ).toArray();
  return WorkspaceMemoryTableResultSchema.parse({
    outcome: "found",
    table: {
      memoryTableId: table.memory_table_id,
      memoryScopeId: table.memory_scope_id,
      workspaceId: table.workspace_id,
      scopeKind: table.scope_kind,
      name: table.name,
      description: table.description,
      usageInstructions: table.usage_instructions,
      keyColumnIdsJson: table.key_column_ids_json,
      schemaRevision: Number(table.schema_revision),
      dataRevision: Number(table.data_revision),
      invalidatedAt: table.invalidated_at,
    },
    columns: columns.map((column) => ({
      memoryTableColumnId: column.memory_table_column_id,
      memoryTableId: column.memory_table_id,
      name: column.name,
      description: column.description,
      valueType: column.value_type,
      isRequired: column.is_required === 1,
      isSearchable: column.is_searchable === 1,
      position: Number(column.position),
    })),
  });
}

/** Live tables in the given scopes whose prose matches the LIKE pattern. */
export function searchWorkspaceMemoryTables(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableSearchRequest,
): WorkspaceMemoryTableSearchResult {
  const rows = storage.sql.exec<{ memory_table_id: string }>(
    `SELECT table_def.memory_table_id
       FROM memory_tables table_def
      WHERE table_def.workspace_id = ?
        AND ${inJsonList("table_def.memory_scope_id")}
        AND table_def.invalidated_at IS NULL
        AND (table_def.name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR table_def.description LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR table_def.usage_instructions LIKE ? ESCAPE '\\' COLLATE NOCASE)
      ORDER BY table_def.name COLLATE NOCASE
      LIMIT ?`,
    request.workspaceId,
    JSON.stringify(request.scopeIds),
    request.like,
    request.like,
    request.like,
    request.limit,
  ).toArray();
  return WorkspaceMemoryTableSearchResultSchema.parse({
    memoryTableIds: rows.map((row) => row.memory_table_id),
  });
}

type RowRecordRow = {
  memory_table_row_id: string;
  data_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
  invalidated_at: string | null;
}

function rowRecordFromRow(row: RowRecordRow) {
  return {
    memoryTableRowId: row.memory_table_row_id,
    dataJson: row.data_json,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    invalidatedAt: row.invalidated_at,
  };
}

export function workspaceMemoryTableRowsById(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableRowsByIdRequest,
): WorkspaceMemoryTableRowList {
  if (request.memoryTableRowIds.length === 0) {
    return WorkspaceMemoryTableRowListSchema.parse({ rows: [] });
  }
  const rows = storage.sql.exec<RowRecordRow>(
    `SELECT memory_table_row_id, data_json, revision, created_at, updated_at, invalidated_at
       FROM memory_table_rows
      WHERE workspace_id = ? AND memory_table_id = ?
        AND ${inJsonList("memory_table_row_id")}`,
    request.workspaceId,
    request.memoryTableId,
    JSON.stringify(request.memoryTableRowIds),
  ).toArray();
  return WorkspaceMemoryTableRowListSchema.parse({ rows: rows.map(rowRecordFromRow) });
}

const CELL_PREFIX =
  "cell.memory_table_row_id = row.memory_table_row_id AND cell.memory_table_column_id = ?";

function compileNormalizedFilter(
  node: WorkspaceMemoryTableFilter,
  bindings: Array<string | number | null>,
): string {
  if ("all" in node || "any" in node) {
    const isAll = "all" in node;
    const children = isAll ? node.all : node.any;
    if (children.length === 0) return isAll ? "1 = 1" : "1 = 0";
    return `(${children
      .map((child) => compileNormalizedFilter(child, bindings))
      .join(isAll ? " AND " : " OR ")})`;
  }
  const exists = (condition: string, negated = false): string => {
    bindings.push(node.columnId);
    const sql = `EXISTS (SELECT 1 FROM memory_table_cells cell WHERE ${CELL_PREFIX} AND ${condition})`;
    return negated ? `NOT ${sql}` : sql;
  };
  switch (node.op) {
    case "exists":
      return exists("1 = 1");
    case "not_exists":
      return exists("1 = 1", true);
    case "in": {
      const sql = exists(`cell.${node.field} IN (SELECT value FROM json_each(?))`, node.negated);
      bindings.push(node.valuesJson);
      return sql;
    }
    case "between": {
      const sql = exists(`cell.${node.field} BETWEEN ? AND ?`);
      bindings.push(node.from, node.to);
      return sql;
    }
    case "like": {
      const sql = exists("cell.string_value LIKE ? ESCAPE '\\' COLLATE NOCASE", node.negated);
      bindings.push(node.pattern);
      return sql;
    }
    case "compare": {
      const operator = (
        { eq: "=", neq: "=", gt: ">", gte: ">=", lt: "<", lte: "<=" } as const
      )[node.comparison];
      const comparison =
        `cell.${node.field} ${operator} ?${node.field === "string_value" ? " COLLATE NOCASE" : ""}`;
      const sql = exists(comparison, node.comparison === "neq");
      bindings.push(node.value);
      return sql;
    }
  }
}

/**
 * One page of rows and the data revision they were read under, in one object
 * event, so a cursor's staleness is decided against the same revision the
 * rows came from. The `WHERE` clause is assembled from a closed set of
 * fragments; every dynamic identifier — cell field, sort direction — comes
 * from the protocol's own enums, and every value is bound.
 */
export function queryWorkspaceMemoryTableRows(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableQueryRequest,
): WorkspaceMemoryTableQueryResult {
  const table = storage.sql.exec<{ data_revision: number }>(
    `SELECT data_revision FROM memory_tables
      WHERE memory_table_id = ? AND workspace_id = ? AND invalidated_at IS NULL`,
    request.memoryTableId,
    request.workspaceId,
  ).toArray()[0];
  if (!table) return WorkspaceMemoryTableQueryResultSchema.parse({ outcome: "not_found" });
  const bindings: Array<string | number | null> = [request.memoryTableId];
  const where = ["row.memory_table_id = ?", "row.invalidated_at IS NULL"];
  if (request.exactRowIds && request.exactRowIds.length > 0) {
    where.push(inJsonList("row.memory_table_row_id"));
    bindings.push(JSON.stringify(request.exactRowIds));
  }
  if (request.ftsMatch !== null) {
    where.push(`row.rowid IN (
      SELECT rowid FROM memory_table_rows_fts WHERE memory_table_rows_fts MATCH ?
    )`);
    bindings.push(request.ftsMatch);
  }
  if (request.filter) where.push(compileNormalizedFilter(request.filter, bindings));
  const orderBindings: string[] = [];
  const order = request.orderBy.map((entry) => {
    orderBindings.push(entry.columnId);
    return `(SELECT ordered.${entry.field} FROM memory_table_cells ordered
      WHERE ordered.memory_table_row_id = row.memory_table_row_id
        AND ordered.memory_table_column_id = ?) ${entry.direction === "desc" ? "DESC" : "ASC"}`;
  });
  order.push("row.updated_at DESC", "row.memory_table_row_id ASC");
  const rows = storage.sql.exec<RowRecordRow>(
    `SELECT row.memory_table_row_id, row.data_json, row.revision,
            row.created_at, row.updated_at, row.invalidated_at
       FROM memory_table_rows row
      WHERE ${where.join(" AND ")}
      ORDER BY ${order.join(", ")}
      LIMIT ? OFFSET ?`,
    ...bindings,
    ...orderBindings,
    request.limit,
    request.offset,
  ).toArray();
  return WorkspaceMemoryTableQueryResultSchema.parse({
    outcome: "found",
    dataRevision: Number(table.data_revision),
    rows: rows.map(rowRecordFromRow),
  });
}

// -- Tables: writes -----------------------------------------------------------

function insertTableMutation(
  storage: DurableObjectStorage,
  workspaceId: string,
  memoryTableId: string,
  memoryScopeId: string,
  operation: "create" | "insert_rows" | "update_rows" | "invalidate_rows",
  mutation: MutationRecord,
  resultJson: string,
  at: string,
  onConflictIgnore = false,
): void {
  storage.sql.exec(
    `INSERT INTO memory_table_mutations
       (memory_table_mutation_id, receipt_id, memory_table_id, memory_scope_id,
        workspace_id, operation, actor_principal_json, harness_run_id, workstream_id,
        rationale, input_hash, mutation_json, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ${onConflictIgnore ? "ON CONFLICT(harness_run_id, receipt_id) DO NOTHING" : ""}`,
    mutation.memoryTableMutationId ?? null,
    mutation.receiptId,
    memoryTableId,
    memoryScopeId,
    workspaceId,
    operation,
    mutation.actorPrincipalJson,
    mutation.harnessRunId,
    mutation.workstreamId,
    mutation.rationale,
    mutation.inputHash,
    mutation.mutationJson,
    resultJson,
    at,
  );
}

function insertCells(
  storage: DurableObjectStorage,
  memoryTableId: string,
  memoryTableRowId: string,
  cells: WorkspaceMemoryTableInsertRowsRequest["rows"][number]["cells"],
): void {
  for (const cell of cells) {
    storage.sql.exec(
      `INSERT INTO memory_table_cells
         (memory_table_row_id, memory_table_id, memory_table_column_id, value_type,
          string_value, number_value, boolean_value, temporal_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      memoryTableRowId,
      memoryTableId,
      cell.memoryTableColumnId,
      cell.valueType,
      cell.stringValue,
      cell.numberValue,
      cell.booleanValue,
      cell.temporalValue,
    );
  }
}

/** The table, its columns, and its audit record — or the standing table's id. */
export function createWorkspaceMemoryTable(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableCreateRequest,
): WorkspaceMemoryTableCreateResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_table_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "create",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryTableCreateResultSchema.parse(settled);
    const existing = storage.sql.exec<{ memory_table_id: string }>(
      `SELECT memory_table_id FROM memory_tables
        WHERE memory_scope_id = ? AND name = ? COLLATE NOCASE AND invalidated_at IS NULL`,
      request.memoryScopeId,
      request.name,
    ).toArray()[0];
    if (existing) {
      return WorkspaceMemoryTableCreateResultSchema.parse({
        outcome: "name_exists",
        memoryTableId: existing.memory_table_id,
      });
    }
    storage.sql.exec(
      `INSERT INTO memory_tables
         (memory_table_id, memory_scope_id, workspace_id, name, description,
          usage_instructions, key_column_ids_json, last_mutation_id, provenance_json,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      request.memoryTableId,
      request.memoryScopeId,
      request.workspaceId,
      request.name,
      request.description,
      request.usageInstructions,
      request.keyColumnIdsJson,
      request.mutation.memoryTableMutationId ?? null,
      request.provenanceJson,
      request.at,
      request.at,
    );
    for (const column of request.columns) {
      storage.sql.exec(
        `INSERT INTO memory_table_columns
           (memory_table_column_id, memory_table_id, name, description, value_type,
            is_required, is_searchable, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        column.memoryTableColumnId,
        request.memoryTableId,
        column.name,
        column.description,
        column.valueType,
        column.isRequired ? 1 : 0,
        column.isSearchable ? 1 : 0,
        column.position,
        request.at,
      );
    }
    insertTableMutation(
      storage, request.workspaceId, request.memoryTableId, request.memoryScopeId,
      "create", request.mutation, request.mutation.resultJson ?? "{}", request.at,
    );
    return WorkspaceMemoryTableCreateResultSchema.parse({ outcome: "created" });
  });
}

/**
 * Record the create receipt for a table that already existed with the same
 * schema, so replaying the same idempotency key keeps answering the same
 * opened table. `DO NOTHING` because two attempts under one key may race.
 */
export function recordWorkspaceMemoryTableOpenReceipt(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableOpenReceiptRequest,
): void {
  insertTableMutation(
    storage, request.workspaceId, request.memoryTableId, request.memoryScopeId,
    "create", request.mutation, request.mutation.resultJson ?? "{}", request.at, true,
  );
}

/**
 * Insert-by-natural-key as one decision: the revision bump, every row and its
 * cells, and the audit record commit together or not at all. Which rows were
 * new is decided by each insert's `RETURNING` witness, and the recorded
 * result is built from those witnesses so the audit row and the caller's
 * answer cannot disagree. The facade path ran this as capped retries around a
 * D1 batch and threw `memory_table_insert_contention` when it lost three
 * times; a single transaction has nothing to contend with.
 */
export function insertWorkspaceMemoryTableRows(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableInsertRowsRequest,
): WorkspaceMemoryTableInsertRowsResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_table_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "insert_rows",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryTableInsertRowsResultSchema.parse(settled);
    const table = storage.sql.exec<{ memory_scope_id: string; data_revision: number }>(
      `UPDATE memory_tables SET data_revision = data_revision + 1,
           last_mutation_id = ?, updated_at = ?
        WHERE memory_table_id = ? AND workspace_id = ? AND invalidated_at IS NULL
        RETURNING memory_scope_id, data_revision`,
      request.mutation.memoryTableMutationId,
      request.at,
      request.memoryTableId,
      request.workspaceId,
    ).toArray()[0];
    if (!table) {
      return WorkspaceMemoryTableInsertRowsResultSchema.parse({ outcome: "table_not_found" });
    }
    const insertedRows: Array<{
      memoryTableRowId: string;
      revision: number;
      values: Record<string, unknown>;
    }> = [];
    for (const row of request.rows) {
      const witness = storage.sql.exec<{ memory_table_row_id: string }>(
        `INSERT INTO memory_table_rows
           (memory_table_row_id, memory_table_id, memory_scope_id, workspace_id,
            natural_key_hash, data_json, searchable_text, provenance_json,
            created_by_mutation_id, last_mutation_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_table_id, natural_key_hash) DO NOTHING
         RETURNING memory_table_row_id`,
        row.memoryTableRowId,
        request.memoryTableId,
        table.memory_scope_id,
        request.workspaceId,
        row.naturalKeyHash,
        row.dataJson,
        row.searchableText,
        request.provenanceJson,
        request.mutation.memoryTableMutationId,
        request.mutation.memoryTableMutationId,
        request.at,
        request.at,
      ).toArray()[0];
      if (!witness) continue;
      insertCells(storage, request.memoryTableId, row.memoryTableRowId, row.cells);
      insertedRows.push({
        memoryTableRowId: row.memoryTableRowId,
        revision: 1,
        values: JSON.parse(row.dataJson) as Record<string, unknown>,
      });
    }
    insertedRows.sort((left, right) =>
      left.memoryTableRowId < right.memoryTableRowId ? -1
        : left.memoryTableRowId > right.memoryTableRowId ? 1 : 0);
    const resultJson = JSON.stringify({
      memoryTableId: request.memoryTableId,
      memoryTableMutationId: request.mutation.memoryTableMutationId,
      insertedCount: insertedRows.length,
      existingCount: request.rows.length - insertedRows.length,
      duplicateInputCount: request.duplicateInputCount,
      insertedRows,
    });
    insertTableMutation(
      storage, request.workspaceId, request.memoryTableId, table.memory_scope_id,
      "insert_rows", request.mutation, resultJson, request.at,
    );
    return WorkspaceMemoryTableInsertRowsResultSchema.parse({ outcome: "inserted", resultJson });
  });
}

/**
 * Check every row's revision, then write them all, in one transaction. The
 * caller read the rows to build its patches, and another writer may have
 * moved them since — the in-transaction check is the one that decides, and a
 * single stale row refuses the whole mutation with nothing written.
 */
export function updateWorkspaceMemoryTableRows(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableUpdateRowsRequest,
): WorkspaceMemoryTableWriteResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_table_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "update_rows",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryTableWriteResultSchema.parse(settled);
    const guard = checkTableRowRevisions(storage, request.workspaceId, request.memoryTableId,
      request.rows.map((row) => ({ id: row.memoryTableRowId, expected: row.expectedRevision })));
    if (guard) return guard;
    bumpTableRevision(storage, request);
    for (const row of request.rows) {
      storage.sql.exec(
        `UPDATE memory_table_rows
            SET data_json = ?, searchable_text = ?, revision = ?,
                last_mutation_id = ?, updated_at = ?
          WHERE memory_table_row_id = ? AND memory_table_id = ?`,
        row.dataJson,
        row.searchableText,
        row.expectedRevision + 1,
        request.mutation.memoryTableMutationId,
        request.at,
        row.memoryTableRowId,
        request.memoryTableId,
      );
      storage.sql.exec(
        `DELETE FROM memory_table_cells WHERE memory_table_row_id = ?`,
        row.memoryTableRowId,
      );
      insertCells(storage, request.memoryTableId, row.memoryTableRowId, row.cells);
    }
    finishTableMutation(storage, request, "update_rows");
    return WorkspaceMemoryTableWriteResultSchema.parse({ outcome: "written" });
  });
}

/** Same shape as update, writing the reversible tombstone columns instead. */
export function invalidateWorkspaceMemoryTableRows(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryTableInvalidateRowsRequest,
): WorkspaceMemoryTableWriteResult {
  return storage.transactionSync(() => {
    const settled = settledReceipt(
      receiptFor(storage, "memory_table_mutations", request.workspaceId,
        request.mutation.harnessRunId, request.mutation.receiptId),
      "invalidate_rows",
      request.mutation.inputHash,
    );
    if (settled) return WorkspaceMemoryTableWriteResultSchema.parse(settled);
    const guard = checkTableRowRevisions(storage, request.workspaceId, request.memoryTableId,
      request.rows.map((row) => ({ id: row.memoryTableRowId, expected: row.expectedRevision })));
    if (guard) return guard;
    bumpTableRevision(storage, request);
    for (const row of request.rows) {
      storage.sql.exec(
        `UPDATE memory_table_rows
            SET revision = ?, invalidated_at = ?, invalidated_by_principal_json = ?,
                invalidation_reason = ?, last_mutation_id = ?, updated_at = ?
          WHERE memory_table_row_id = ? AND memory_table_id = ?`,
        row.expectedRevision + 1,
        request.at,
        request.actorPrincipalJson,
        request.reason,
        request.mutation.memoryTableMutationId,
        request.at,
        row.memoryTableRowId,
        request.memoryTableId,
      );
    }
    finishTableMutation(storage, request, "invalidate_rows");
    return WorkspaceMemoryTableWriteResultSchema.parse({ outcome: "written" });
  });
}

/**
 * The rows named by a mutation, verified live and at their expected revision.
 * Runs inside the caller's transaction; a refusal leaves it with no writes.
 */
function checkTableRowRevisions(
  storage: DurableObjectStorage,
  workspaceId: string,
  memoryTableId: string,
  rows: Array<{ id: string; expected: number }>,
): WorkspaceMemoryTableWriteResult | null {
  const table = storage.sql.exec<{ memory_table_id: string }>(
    `SELECT memory_table_id FROM memory_tables
      WHERE memory_table_id = ? AND workspace_id = ? AND invalidated_at IS NULL`,
    memoryTableId,
    workspaceId,
  ).toArray()[0];
  if (!table) return WorkspaceMemoryTableWriteResultSchema.parse({ outcome: "table_not_found" });
  const current = new Map(storage.sql.exec<{
    memory_table_row_id: string;
    revision: number;
    invalidated_at: string | null;
  }>(
    `SELECT memory_table_row_id, revision, invalidated_at
       FROM memory_table_rows
      WHERE memory_table_id = ? AND ${inJsonList("memory_table_row_id")}`,
    memoryTableId,
    JSON.stringify(rows.map((row) => row.id)),
  ).toArray().map((row) => [row.memory_table_row_id, row]));
  for (const row of rows) {
    const stored = current.get(row.id);
    if (!stored || stored.invalidated_at) {
      return WorkspaceMemoryTableWriteResultSchema.parse({ outcome: "row_not_found" });
    }
    if (Number(stored.revision) !== row.expected) {
      return WorkspaceMemoryTableWriteResultSchema.parse({ outcome: "row_revision_conflict" });
    }
  }
  return null;
}

function bumpTableRevision(
  storage: DurableObjectStorage,
  request: { memoryTableId: string; workspaceId: string; at: string;
    mutation: { memoryTableMutationId: string } },
): void {
  storage.sql.exec(
    `UPDATE memory_tables SET data_revision = data_revision + 1,
         last_mutation_id = ?, updated_at = ?
      WHERE memory_table_id = ? AND workspace_id = ?`,
    request.mutation.memoryTableMutationId,
    request.at,
    request.memoryTableId,
    request.workspaceId,
  );
}

function finishTableMutation(
  storage: DurableObjectStorage,
  request: {
    workspaceId: string; memoryTableId: string; at: string;
    mutation: MutationRecord & { resultJson: string };
  },
  operation: "update_rows" | "invalidate_rows",
): void {
  const scope = storage.sql.exec<{ memory_scope_id: string }>(
    `SELECT memory_scope_id FROM memory_tables WHERE memory_table_id = ?`,
    request.memoryTableId,
  ).toArray()[0];
  insertTableMutation(
    storage, request.workspaceId, request.memoryTableId, scope?.memory_scope_id ?? "",
    operation, request.mutation, request.mutation.resultJson, request.at,
  );
}
