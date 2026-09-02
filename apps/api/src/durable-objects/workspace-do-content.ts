
import { WorkspaceDoDirectoryEffects } from "./workspace-do-directory-effects";
import { uuidV7 } from "../lib/uuid-v7";
import { SIDEBAR_LIST_LIMIT } from "../services/sidebar-reads";
import {
  addWorkspaceMemoryItem,
  canonicalWorkspaceMemoryItems,
  claimWorkspaceMemoryIndexOutboxRow,
  completeWorkspaceMemoryIndexOutboxRow,
  createWorkspaceMemoryTable,
  dueWorkspaceMemoryIndexOutbox,
  ensureWorkspaceMemoryScope,
  insertWorkspaceMemoryTableRows,
  invalidateWorkspaceMemoryItem,
  invalidateWorkspaceMemoryTableRows,
  queryWorkspaceMemoryTableRows,
  recordWorkspaceMemoryItemAccess,
  recordWorkspaceMemoryTableOpenReceipt,
  retryWorkspaceMemoryIndexOutboxRow,
  searchWorkspaceMemoryItemsFts,
  searchWorkspaceMemoryTables,
  updateWorkspaceMemoryItem,
  updateWorkspaceMemoryTableRows,
  workspaceMemoryIndexProjectionSource,
  workspaceMemoryItemForWrite,
  workspaceMemoryMutationReceipt,
  workspaceMemoryTableMutationReceipt,
  workspaceMemoryTableRowsById,
  workspaceMemoryTableWithColumns,
} from "./workspace-memory-storage";
import {
  WorkspaceMemoryAccessRecordRequestSchema,
  WorkspaceMemoryAddRequestSchema,
  WorkspaceMemoryCanonicalItemsRequestSchema,
  WorkspaceMemoryFtsSearchRequestSchema,
  WorkspaceMemoryInvalidateRequestSchema,
  WorkspaceMemoryItemForWriteRequestSchema,
  WorkspaceMemoryOutboxClaimRequestSchema,
  WorkspaceMemoryOutboxCompleteRequestSchema,
  WorkspaceMemoryOutboxDueRequestSchema,
  WorkspaceMemoryOutboxRetryRequestSchema,
  WorkspaceMemoryProjectionSourceRequestSchema,
  WorkspaceMemoryReceiptRequestSchema,
  WorkspaceMemoryScopeEnsureRequestSchema,
  WorkspaceMemoryTableCreateRequestSchema,
  WorkspaceMemoryTableInsertRowsRequestSchema,
  WorkspaceMemoryTableInvalidateRowsRequestSchema,
  WorkspaceMemoryTableOpenReceiptRequestSchema,
  WorkspaceMemoryTableQueryRequestSchema,
  WorkspaceMemoryTableRequestSchema,
  WorkspaceMemoryTableRowsByIdRequestSchema,
  WorkspaceMemoryTableSearchRequestSchema,
  WorkspaceMemoryTableUpdateRowsRequestSchema,
  WorkspaceMemoryUpdateRequestSchema,
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
import {
  appendWorkspaceNoteSegment,
  archiveWorkspaceNote,
  commitWorkspaceNoteGeneration,
  markWorkspaceNotePrivacyTransitionProcessed,
  pendingWorkspaceNotePrivacyTransitions,
  retireWorkspaceNoteResourceDeletion,
  updateWorkspaceNote,
  visibleWorkspaceNoteResourceIds,
  workspaceNoteResourceDeletionOutbox,
  workspaceNoteSidebar,
  workspaceNoteState,
} from "./workspace-notes-storage";
import {
  WorkspaceNoteArchiveRequestSchema,
  WorkspaceNoteDeletionOutboxRequestSchema,
  WorkspaceNoteDeletionRetireRequestSchema,
  WorkspaceNoteGenerationCommitRequestSchema,
  WorkspaceNotePrivacyMarkRequestSchema,
  WorkspaceNotePrivacyPendingRequestSchema,
  WorkspaceNoteSegmentAppendRequestSchema,
  WorkspaceNoteSidebarRequestSchema,
  WorkspaceNoteStateRequestSchema,
  WorkspaceNoteUpdateRequestSchema,
  WorkspaceNoteVisibilityRequestSchema,
  type WorkspaceNoteArchiveRequest,
  type WorkspaceNoteArchiveResult,
  type WorkspaceNoteDeletionOutbox,
  type WorkspaceNoteDeletionOutboxRequest,
  type WorkspaceNoteDeletionRetireRequest,
  type WorkspaceNoteDeletionRetireResult,
  type WorkspaceNoteGenerationCommitRequest,
  type WorkspaceNoteGenerationCommitResult,
  type WorkspaceNotePrivacyMarkRequest,
  type WorkspaceNotePrivacyMarkResult,
  type WorkspaceNotePrivacyPendingRequest,
  type WorkspaceNotePrivacyPendingResult,
  type WorkspaceNoteSegmentAppendRequest,
  type WorkspaceNoteSegmentAppendResult,
  type WorkspaceNoteSidebarList,
  type WorkspaceNoteSidebarRequest,
  type WorkspaceNoteState,
  type WorkspaceNoteStateRequest,
  type WorkspaceNoteUpdateRequest,
  type WorkspaceNoteUpdateResult,
  type WorkspaceNoteVisibilityRequest,
  type WorkspaceNoteVisibilityResult,
} from "./workspace-notes-protocol";
import {
  claimWorkspaceDigestDelivery,
  ensureDefaultWorkspaceDigestSchedule,
  latestWorkspaceDigestCursor,
  markWorkspaceDigestDeliveryRunning,
  markWorkspaceDigestTargetDelivered,
  markWorkspaceDigestTargetFailed,
  recordWorkspaceDigestDeliveryWorkstream,
  recordWorkspaceDigestSummary,
  releaseWorkspaceDigestDeliveryClaim,
  replaceWorkspaceDigestSchedule,
  replaceWorkspaceDigestScheduleRows,
  settleWorkspaceDigestDelivery,
  workspaceDigestDeliveryContext,
  workspaceDigestDeliveryTargets,
  workspaceDigestScheduleForFire,
  workspaceDigestScheduleRowState,
  workspaceDigestSettings,
  workspaceDigestTerminalContext,
} from "./workspace-digests-storage";
import {
  WorkspaceDigestClaimRequestSchema,
  WorkspaceDigestCursorRequestSchema,
  WorkspaceDigestDefaultRequestSchema,
  WorkspaceDigestDeliveryContextRequestSchema,
  WorkspaceDigestDeliveryRunningRequestSchema,
  WorkspaceDigestDeliveryTargetsRequestSchema,
  WorkspaceDigestDeliveryWorkstreamRequestSchema,
  WorkspaceDigestFireScheduleRequestSchema,
  WorkspaceDigestReleaseClaimRequestSchema,
  WorkspaceDigestReplaceRequestSchema,
  WorkspaceDigestReplaceRowsRequestSchema,
  WorkspaceDigestRowStateRequestSchema,
  WorkspaceDigestSettingsRequestSchema,
  WorkspaceDigestSettleRequestSchema,
  WorkspaceDigestSummaryRequestSchema,
  WorkspaceDigestTargetDeliveredRequestSchema,
  WorkspaceDigestTargetFailedRequestSchema,
  WorkspaceDigestTerminalContextRequestSchema,
  type WorkspaceDigestClaimRequest,
  type WorkspaceDigestClaimResult,
  type WorkspaceDigestCursor,
  type WorkspaceDigestCursorRequest,
  type WorkspaceDigestDefaultRequest,
  type WorkspaceDigestDefaultResult,
  type WorkspaceDigestDeliveryContext,
  type WorkspaceDigestDeliveryContextRequest,
  type WorkspaceDigestDeliveryRunningRequest,
  type WorkspaceDigestDeliveryTargets,
  type WorkspaceDigestDeliveryTargetsRequest,
  type WorkspaceDigestDeliveryWorkstreamRequest,
  type WorkspaceDigestFireSchedule,
  type WorkspaceDigestFireScheduleRequest,
  type WorkspaceDigestReleaseClaimRequest,
  type WorkspaceDigestReleaseClaimResult,
  type WorkspaceDigestReplaceRequest,
  type WorkspaceDigestReplaceResult,
  type WorkspaceDigestReplaceRowsRequest,
  type WorkspaceDigestRowState,
  type WorkspaceDigestRowStateRequest,
  type WorkspaceDigestRunningResult,
  type WorkspaceDigestSettings,
  type WorkspaceDigestSettingsRequest,
  type WorkspaceDigestSettleRequest,
  type WorkspaceDigestSettleResult,
  type WorkspaceDigestSummaryRequest,
  type WorkspaceDigestTargetDeliveredRequest,
  type WorkspaceDigestTargetFailedRequest,
  type WorkspaceDigestTargetOutcomeResult,
  type WorkspaceDigestTerminalContext,
  type WorkspaceDigestTerminalContextRequest,
} from "./workspace-digests-protocol";

/**
 * `WorkspaceDO`'s workspace-authored content: notes, memory items and tables, and
 * digest schedules and deliveries.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoContent extends WorkspaceDoDirectoryEffects {

  /** One note and its whole transcript, behind the requested access fence. */
  async noteWithSegments(input: WorkspaceNoteStateRequest): Promise<WorkspaceNoteState> {
    await this.initialized;
    const request = WorkspaceNoteStateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceNoteState(this.state.storage, request);
  }

  /** The notes the sidebar opens with, from the statement the socket also serves. */
  async listNoteSidebar(input: WorkspaceNoteSidebarRequest): Promise<WorkspaceNoteSidebarList> {
    await this.initialized;
    const request = WorkspaceNoteSidebarRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceNoteSidebar(
      this.state.storage,
      request.workspaceId,
      request.userId,
      Math.min(request.limit, SIDEBAR_LIST_LIMIT),
      request.before,
    );
  }

  /**
   * Apply an owner's edit, deciding `becamePrivate` from the row the write
   * replaced — and recording the workspace-to-personal transition in the
   * privacy outbox within the same transaction. The D1 trigger that used to
   * write that row did not travel to this object at cutover, so the "now
   * private" notices had silently stopped.
   */
  async updateNote(input: WorkspaceNoteUpdateRequest): Promise<WorkspaceNoteUpdateResult> {
    await this.initialized;
    const request = WorkspaceNoteUpdateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = updateWorkspaceNote(this.state.storage, request);
    if (result.outcome === "updated") this.publishSidebarList("notes");
    if (result.becamePrivate) this.refreshScheduleAfterWrite(request.workspaceId);
    return result;
  }

  /**
   * Archive, or say why not: a live recording refuses distinctly, because
   * archiving under it would 404 the next segment save while capture kept
   * running. As a write and a fallback read through the facade the two
   * refusals were classified a round trip apart.
   */
  async archiveNote(input: WorkspaceNoteArchiveRequest): Promise<WorkspaceNoteArchiveResult> {
    await this.initialized;
    const request = WorkspaceNoteArchiveRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = archiveWorkspaceNote(this.state.storage, request);
    if (result.outcome === "archived") this.publishSidebarList("notes");
    return result;
  }

  /**
   * Store one transcript segment: fence, duplicate check, sequence allocation
   * and both writes in one critical section, with a replayed save answered by
   * the stored segment rather than a constraint error.
   */
  async appendNoteSegment(
    input: WorkspaceNoteSegmentAppendRequest,
  ): Promise<WorkspaceNoteSegmentAppendResult> {
    await this.initialized;
    const request = WorkspaceNoteSegmentAppendRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = appendWorkspaceNoteSegment(this.state.storage, request);
    if (result.outcome === "appended") this.publishSidebarList("notes");
    return result;
  }

  /** Land a generated briefing only if the cursor pair it was read against still holds. */
  async commitNoteGeneration(
    input: WorkspaceNoteGenerationCommitRequest,
  ): Promise<WorkspaceNoteGenerationCommitResult> {
    await this.initialized;
    const request = WorkspaceNoteGenerationCommitRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = commitWorkspaceNoteGeneration(this.state.storage, request);
    if (result.outcome === "committed") this.publishSidebarList("notes");
    return result;
  }

  /** Which of these note resources the principal may currently see; reads only. */
  async visibleNoteResourceIds(
    input: WorkspaceNoteVisibilityRequest,
  ): Promise<WorkspaceNoteVisibilityResult> {
    await this.initialized;
    const request = WorkspaceNoteVisibilityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return visibleWorkspaceNoteResourceIds(this.state.storage, request);
  }

  /** The privacy transitions the notifier has not yet delivered. */
  async pendingNotePrivacyTransitions(
    input: WorkspaceNotePrivacyPendingRequest,
  ): Promise<WorkspaceNotePrivacyPendingResult> {
    await this.initialized;
    const request = WorkspaceNotePrivacyPendingRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return pendingWorkspaceNotePrivacyTransitions(this.state.storage, request);
  }

  /** Settle one delivered privacy transition; a replay learns it was not pending. */
  async markNotePrivacyTransitionProcessed(
    input: WorkspaceNotePrivacyMarkRequest,
  ): Promise<WorkspaceNotePrivacyMarkResult> {
    await this.initialized;
    const request = WorkspaceNotePrivacyMarkRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = markWorkspaceNotePrivacyTransitionProcessed(this.state.storage, request);
    if (result.outcome === "processed") this.refreshScheduleAfterWrite(request.workspaceId);
    return result;
  }

  /** The note R2 objects still waiting for cleanup, one pass's worth. */
  async noteResourceDeletionOutbox(
    input: WorkspaceNoteDeletionOutboxRequest,
  ): Promise<WorkspaceNoteDeletionOutbox> {
    await this.initialized;
    const request = WorkspaceNoteDeletionOutboxRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceNoteResourceDeletionOutbox(this.state.storage);
  }

  /** Retire one cleanup entry once its R2 objects are gone. */
  async retireNoteResourceDeletion(
    input: WorkspaceNoteDeletionRetireRequest,
  ): Promise<WorkspaceNoteDeletionRetireResult> {
    await this.initialized;
    const request = WorkspaceNoteDeletionRetireRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = retireWorkspaceNoteResourceDeletion(this.state.storage, request);
    if (result.outcome === "retired") this.refreshScheduleAfterWrite(request.workspaceId);
    return result;
  }

  /** Create a memory scope if it is missing; answer with the stored row either way. */
  async ensureMemoryScope(input: WorkspaceMemoryScopeEnsureRequest): Promise<WorkspaceMemoryScope> {
    await this.initialized;
    const request = WorkspaceMemoryScopeEnsureRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return ensureWorkspaceMemoryScope(this.state.storage, request);
  }

  /** The FTS leg of hybrid memory retrieval, over the caller's authorized scopes. */
  async searchMemoryItemsFts(
    input: WorkspaceMemoryFtsSearchRequest,
  ): Promise<WorkspaceMemoryCandidateList> {
    await this.initialized;
    const request = WorkspaceMemoryFtsSearchRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return searchWorkspaceMemoryItemsFts(this.state.storage, request);
  }

  /**
   * Live items among the requested ids, restricted to the given scopes.
   *
   * The scope list is the service's re-resolved authorization union: what this
   * method enforces is that no candidate outside it is answered, so a scope
   * revoked mid-search cannot leak rows through the ranking.
   */
  async canonicalMemoryItems(
    input: WorkspaceMemoryCanonicalItemsRequest,
  ): Promise<WorkspaceMemoryItemList> {
    await this.initialized;
    const request = WorkspaceMemoryCanonicalItemsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return canonicalWorkspaceMemoryItems(this.state.storage, request);
  }

  /** Bump non-authoritative access counters; a lost update costs nothing. */
  async recordMemoryItemAccess(input: WorkspaceMemoryAccessRecordRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryAccessRecordRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceMemoryItemAccess(this.state.storage, request);
  }

  /** One item with its scope kind, live or not — the write path's read. */
  async memoryItemForWrite(
    input: WorkspaceMemoryItemForWriteRequest,
  ): Promise<WorkspaceMemoryItemForWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryItemForWriteRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryItemForWrite(this.state.storage, request);
  }

  /**
   * A prose-memory mutation receipt by idempotency key, so the service can
   * answer a replay before it authorizes anything — the order the tool path
   * has always had.
   */
  async memoryMutationReceipt(
    input: WorkspaceMemoryReceiptRequest,
  ): Promise<WorkspaceMemoryReceiptResult> {
    await this.initialized;
    const request = WorkspaceMemoryReceiptRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryMutationReceipt(this.state.storage, request);
  }

  /**
   * Add one durable memory: the item, its audit record, and its
   * embedding-outbox intent in one transaction, with the receipt decided
   * inside it. The facade path ran these as a D1 batch and re-read the
   * receipt out-of-band when the batch lost a race.
   */
  async addMemoryItem(input: WorkspaceMemoryAddRequest): Promise<WorkspaceMemoryAddResult> {
    await this.initialized;
    const request = WorkspaceMemoryAddRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = addWorkspaceMemoryItem(this.state.storage, request, uuidV7());
    if (result.outcome === "added") this.refreshScheduleAfterMemoryOutboxWrite(request.workspaceId);
    return result;
  }

  /**
   * Replace a durable memory at an expected revision. A refusal is an
   * outcome, not a throw: `revision_conflict` reaches the service with its
   * HTTP-mapped error intact rather than as a bare RPC message.
   */
  async updateMemoryItem(input: WorkspaceMemoryUpdateRequest): Promise<WorkspaceMemoryWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryUpdateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = updateWorkspaceMemoryItem(this.state.storage, request, uuidV7());
    if (result.outcome === "written") this.refreshScheduleAfterMemoryOutboxWrite(request.workspaceId);
    return result;
  }

  /** Reversibly invalidate a durable memory at an expected revision. */
  async invalidateMemoryItem(
    input: WorkspaceMemoryInvalidateRequest,
  ): Promise<WorkspaceMemoryWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryInvalidateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = invalidateWorkspaceMemoryItem(this.state.storage, request, uuidV7());
    if (result.outcome === "written") this.refreshScheduleAfterMemoryOutboxWrite(request.workspaceId);
    return result;
  }

  /** Embedding-outbox rows due for projection, oldest first. */
  async dueMemoryIndexOutbox(
    input: WorkspaceMemoryOutboxDueRequest,
  ): Promise<WorkspaceMemoryOutboxDueList> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxDueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return dueWorkspaceMemoryIndexOutbox(this.state.storage, request);
  }

  /** Claim one due outbox row for a lease; the witness is the returned token. */
  async claimMemoryIndexOutboxRow(
    input: WorkspaceMemoryOutboxClaimRequest,
  ): Promise<WorkspaceMemoryOutboxClaimResult> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceMemoryIndexOutboxRow(this.state.storage, request);
  }

  /** Settle a claimed outbox row as projected. */
  async completeMemoryIndexOutboxRow(input: WorkspaceMemoryOutboxCompleteRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxCompleteRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    completeWorkspaceMemoryIndexOutboxRow(this.state.storage, request);
  }

  /** Return a claimed outbox row to pending with its backoff and last error. */
  async retryMemoryIndexOutboxRow(input: WorkspaceMemoryOutboxRetryRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxRetryRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    retryWorkspaceMemoryIndexOutboxRow(this.state.storage, request);
  }

  /** What the vector index should hold for one item, read at projection time. */
  async memoryIndexProjectionSource(
    input: WorkspaceMemoryProjectionSourceRequest,
  ): Promise<WorkspaceMemoryProjectionSourceResult> {
    await this.initialized;
    const request = WorkspaceMemoryProjectionSourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryIndexProjectionSource(this.state.storage, request);
  }

  /** One durable table and its ordered columns, invalidated or not. */
  async memoryTableWithColumns(
    input: WorkspaceMemoryTableRequest,
  ): Promise<WorkspaceMemoryTableResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryTableWithColumns(this.state.storage, request);
  }

  /** Live durable tables in the given scopes whose prose matches the pattern. */
  async searchMemoryTables(
    input: WorkspaceMemoryTableSearchRequest,
  ): Promise<WorkspaceMemoryTableSearchResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableSearchRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return searchWorkspaceMemoryTables(this.state.storage, request);
  }

  /**
   * One page of rows and the revision they were read under, in one object
   * event. Through the facade the page and the stale-revision re-check were
   * separate round trips, so a mutation between them failed an innocent read
   * with `memory_table_query_changed_during_read`; here that window is gone.
   */
  async queryMemoryTableRows(
    input: WorkspaceMemoryTableQueryRequest,
  ): Promise<WorkspaceMemoryTableQueryResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableQueryRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return queryWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** The rows a mutation names, in whatever state they currently hold. */
  async memoryTableRowsById(
    input: WorkspaceMemoryTableRowsByIdRequest,
  ): Promise<WorkspaceMemoryTableRowList> {
    await this.initialized;
    const request = WorkspaceMemoryTableRowsByIdRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryTableRowsById(this.state.storage, request);
  }

  /** A durable-table mutation receipt by idempotency key. */
  async memoryTableMutationReceipt(
    input: WorkspaceMemoryReceiptRequest,
  ): Promise<WorkspaceMemoryReceiptResult> {
    await this.initialized;
    const request = WorkspaceMemoryReceiptRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryTableMutationReceipt(this.state.storage, request);
  }

  /**
   * Create a typed durable table, or answer with the standing table's id so
   * the service can decide whether the caller reopened it or collided with it.
   */
  async createMemoryTable(
    input: WorkspaceMemoryTableCreateRequest,
  ): Promise<WorkspaceMemoryTableCreateResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableCreateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return createWorkspaceMemoryTable(this.state.storage, request);
  }

  /** Record the create receipt for an idempotent reopen of a standing table. */
  async recordMemoryTableOpenReceipt(
    input: WorkspaceMemoryTableOpenReceiptRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryTableOpenReceiptRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceMemoryTableOpenReceipt(this.state.storage, request);
  }

  /**
   * Insert rows by natural key as one decision: revision bump, rows, cells,
   * and the audit record commit together. The facade path retried a D1 batch
   * against its own revision counter and threw
   * `memory_table_insert_contention` after three losses; a single transaction
   * has nothing to contend with, so that failure mode no longer exists.
   */
  async insertMemoryTableRows(
    input: WorkspaceMemoryTableInsertRowsRequest,
  ): Promise<WorkspaceMemoryTableInsertRowsResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableInsertRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return insertWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** Patch rows at expected revisions; one stale row refuses the whole batch. */
  async updateMemoryTableRows(
    input: WorkspaceMemoryTableUpdateRowsRequest,
  ): Promise<WorkspaceMemoryTableWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableUpdateRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return updateWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** Reversibly invalidate rows at expected revisions, all or nothing. */
  async invalidateMemoryTableRows(
    input: WorkspaceMemoryTableInvalidateRowsRequest,
  ): Promise<WorkspaceMemoryTableWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableInvalidateRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return invalidateWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** A person's digest configuration, minus the connector-joined delivery targets. */
  async digestSettings(input: WorkspaceDigestSettingsRequest): Promise<WorkspaceDigestSettings> {
    await this.initialized;
    const request = WorkspaceDigestSettingsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestSettings(this.state.storage, request);
  }

  /**
   * Replace a person's digest wholesale, in one transaction.
   *
   * The create-or-update decision lives inside it: as a read through the
   * runtime facade followed by a batch, two first saves both read "nothing
   * yet" and `UNIQUE (workspace_id, user_id)` refused whichever landed second.
   */
  async replaceDigestSchedule(
    input: WorkspaceDigestReplaceRequest,
  ): Promise<WorkspaceDigestReplaceResult> {
    await this.initialized;
    const request = WorkspaceDigestReplaceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = replaceWorkspaceDigestSchedule(this.state.storage, request);
    this.refreshScheduleAfterDigestWrite(request.workspaceId);
    return result;
  }

  /** The reconciler's default: created on absence, otherwise what already exists. */
  async ensureDefaultDigestSchedule(
    input: WorkspaceDigestDefaultRequest,
  ): Promise<WorkspaceDigestDefaultResult> {
    await this.initialized;
    const request = WorkspaceDigestDefaultRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return ensureDefaultWorkspaceDigestSchedule(this.state.storage, request);
  }

  /** How a digest's derived rows stand against the account timezone. */
  async digestScheduleRowState(
    input: WorkspaceDigestRowStateRequest,
  ): Promise<WorkspaceDigestRowState> {
    await this.initialized;
    const request = WorkspaceDigestRowStateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestScheduleRowState(this.state.storage, request);
  }

  /** Rebuild one digest's derived `schedules` rows — a timezone move, or a repair. */
  async replaceDigestScheduleRows(input: WorkspaceDigestReplaceRowsRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceDigestReplaceRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    replaceWorkspaceDigestScheduleRows(this.state.storage, request);
    this.refreshScheduleAfterDigestWrite(request.workspaceId);
  }

  /** What the scheduler must re-validate before firing an occurrence. */
  async digestScheduleForFire(
    input: WorkspaceDigestFireScheduleRequest,
  ): Promise<WorkspaceDigestFireSchedule> {
    await this.initialized;
    const request = WorkspaceDigestFireScheduleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestScheduleForFire(this.state.storage, request);
  }

  /** The highest point this schedule has committed to covering. */
  async latestDigestCursor(input: WorkspaceDigestCursorRequest): Promise<WorkspaceDigestCursor> {
    await this.initialized;
    const request = WorkspaceDigestCursorRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return latestWorkspaceDigestCursor(this.state.storage, request);
  }

  /** Claim one occurrence; a retried alarm learns the first attempt already has it. */
  async claimDigestDelivery(
    input: WorkspaceDigestClaimRequest,
  ): Promise<WorkspaceDigestClaimResult> {
    await this.initialized;
    const request = WorkspaceDigestClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceDigestDelivery(this.state.storage, request);
  }

  /** Record which hidden work stream this occurrence executes in. */
  async recordDigestDeliveryWorkstream(
    input: WorkspaceDigestDeliveryWorkstreamRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryWorkstreamRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceDigestDeliveryWorkstream(this.state.storage, request);
  }

  /** The launch succeeded: the claim graduates from `planned` to `running`, or says it could not. */
  async markDigestDeliveryRunning(
    input: WorkspaceDigestDeliveryRunningRequest,
  ): Promise<WorkspaceDigestRunningResult> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryRunningRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return markWorkspaceDigestDeliveryRunning(this.state.storage, request);
  }

  /** Undo a claim whose launch never started, so the scheduler's retry gets another go. */
  async releaseDigestDeliveryClaim(
    input: WorkspaceDigestReleaseClaimRequest,
  ): Promise<WorkspaceDigestReleaseClaimResult> {
    await this.initialized;
    const request = WorkspaceDigestReleaseClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return releaseWorkspaceDigestDeliveryClaim(this.state.storage, request);
  }

  /** One occurrence, as settlement and the run's trigger context read it. */
  async digestDeliveryContext(
    input: WorkspaceDigestDeliveryContextRequest,
  ): Promise<WorkspaceDigestDeliveryContext> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryContextRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestDeliveryContext(this.state.storage, request);
  }

  /** Keep what the run wrote, before delivery decides what happens to it. */
  async recordDigestSummary(input: WorkspaceDigestSummaryRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceDigestSummaryRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceDigestSummary(this.state.storage, request);
  }

  /**
   * Settle one occurrence, exactly once.
   *
   * The witness is the point: two settlement attempts of one retried workflow
   * step can overlap, and the loser must learn it lost rather than emit the
   * terminal telemetry and the delivery note a second time.
   */
  async settleDigestDelivery(
    input: WorkspaceDigestSettleRequest,
  ): Promise<WorkspaceDigestSettleResult> {
    await this.initialized;
    const request = WorkspaceDigestSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return settleWorkspaceDigestDelivery(this.state.storage, request);
  }

  /** What the terminal telemetry event says about destinations and history. */
  async digestTerminalTelemetryContext(
    input: WorkspaceDigestTerminalContextRequest,
  ): Promise<WorkspaceDigestTerminalContext> {
    await this.initialized;
    const request = WorkspaceDigestTerminalContextRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestTerminalContext(this.state.storage, request);
  }

  /** The frozen destinations one occurrence goes to. */
  async digestDeliveryTargets(
    input: WorkspaceDigestDeliveryTargetsRequest,
  ): Promise<WorkspaceDigestDeliveryTargets> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestDeliveryTargets(this.state.storage, request);
  }

  /** One destination received this digest. */
  async markDigestTargetDelivered(
    input: WorkspaceDigestTargetDeliveredRequest,
  ): Promise<WorkspaceDigestTargetOutcomeResult> {
    await this.initialized;
    const request = WorkspaceDigestTargetDeliveredRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return markWorkspaceDigestTargetDelivered(this.state.storage, request);
  }

  /** Record why a destination did not receive this digest. */
  async markDigestTargetFailed(
    input: WorkspaceDigestTargetFailedRequest,
  ): Promise<WorkspaceDigestTargetOutcomeResult> {
    await this.initialized;
    const request = WorkspaceDigestTargetFailedRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return markWorkspaceDigestTargetFailed(this.state.storage, request);
  }
}
