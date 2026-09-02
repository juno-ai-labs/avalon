import {
  type WorkstreamBatchFilter,
} from "@rally/contracts";

import {
  WorkspaceBatchDispatchAdvanceResultSchema,
  WorkspaceBatchDispatchBeginResultSchema,
  WorkspaceBatchNoteArchiveResultSchema,
  type WorkspaceBatchDispatchAdvanceRequest,
  type WorkspaceBatchDispatchBeginRequest,
  type WorkspaceBatchNoteArchiveRequest,
  type WorkspaceBatchNoteArchiveResult,
} from "./workspace-directory-protocol";
import {
  archiveWorkspaceNotesForOperation,
  workspaceNoteBatchTargets,
} from "./workspace-notes-storage";

/**
 * Bulk work-stream operations: which rows one filter selects, and the fenced
 * ledger that turns that selection into exactly-once Queue events.
 *
 * Apart from the RPC class because the writes are one resume protocol. A
 * dispatch is frozen against a request hash, advanced one published chunk at a
 * time so a retry republishes nothing, and the note archive belonging to the
 * same operation is fenced on that same hash and user. The selection query is
 * here too: the ledger is only correct if it froze exactly what the filter
 * selected.
 */

/**
 * The rows one grouping's action reaches, under exactly the rules the sidebar
 * showed that grouping by.
 *
 * `origin_type <> 'automation'` is not a new opinion here — it is the same
 * clause the paged recent list, the pinned rows, the running rows and the
 * per-row socket push all carry, because an automation's run work stream is
 * deliberately kept out of the sidebar and reached from the automation's own
 * screen instead. This read is the fifth on that table and used to be the one
 * that did not carry it, which meant a heading's **Archive all** irreversibly
 * archived run history — a *planned* run's work stream included — that the
 * reader had never been shown under that heading, while the confirmation
 * counted it as one of the "work streams in This month".
 *
 * A row this omits for pagination is a different matter and stays in: the
 * confirmation exists precisely to name the complete server-side total rather
 * than the page the client happens to hold. Hidden is not the same as not yet
 * loaded.
 */
export function workspaceBatchTargetIds(
  storage: DurableObjectStorage,
  userId: string,
  filter: WorkstreamBatchFilter,
): string[] {
const atOrAfter = filter.lastActivityAt?.atOrAfter;
const before = filter.lastActivityAt?.before;
const pinned = filter.pinned;
return storage.sql.exec<{ workstream_id: string }>(
  `SELECT directory.workstream_id
     FROM workspace_workstream_directory directory
     LEFT JOIN workspace_workstream_viewers viewer
       ON viewer.workstream_id = directory.workstream_id
      AND viewer.user_id = ?
      AND viewer.authority_generation = directory.authority_generation
     LEFT JOIN workspace_workstream_pins pin
       ON pin.workstream_id = directory.workstream_id AND pin.user_id = ?
    WHERE directory.archived_at IS NULL
      AND directory.origin_type <> 'automation'
      AND (? = 1 OR directory.system_kind IS NULL)
      AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
      AND (? IS NULL OR directory.last_activity_at >= ?)
      AND (? IS NULL OR directory.last_activity_at < ?)
      AND (? IS NULL
        OR (? = 1 AND pin.user_id IS NOT NULL)
        OR (? = 0 AND pin.user_id IS NULL))
    ORDER BY directory.workstream_id`,
  userId,
  userId,
  filter.includeSystem ? 1 : 0,
  atOrAfter ?? null,
  atOrAfter ? Date.parse(atOrAfter) : 0,
  before ?? null,
  before ? Date.parse(before) : 0,
  pinned === undefined ? null : Number(pinned),
  Number(pinned ?? false),
  Number(pinned ?? false),
).toArray().map((row) => row.workstream_id);
}

/** Freeze one target set and return only the Queue events not yet published. */
export function beginWorkspaceBatchDispatch(
  storage: DurableObjectStorage,
  request: WorkspaceBatchDispatchBeginRequest,
) {
return storage.transactionSync(() => {
  const existing = storage.sql.exec<{
    request_hash: string;
    user_id: string;
    target_count: number;
  }>(
    `SELECT request_hash, user_id, target_count
       FROM workspace_batch_dispatches WHERE operation_id = ?`,
    request.operationId,
  ).toArray()[0];
  if (existing
    && (existing.request_hash !== request.requestHash || existing.user_id !== request.userId)) {
    throw new Error("workstream_batch_dispatch_conflict");
  }

  let targetCount = existing?.target_count;
  if (!existing) {
    const now = Date.now();
    const targetIds = workspaceBatchTargetIds(storage, request.userId, request.filter);
    storage.sql.exec(
      `INSERT INTO workspace_batch_dispatches
         (operation_id, request_hash, user_id, target_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      request.operationId,
      request.requestHash,
      request.userId,
      targetIds.length,
      now,
      now,
    );
    storage.sql.exec(
      `INSERT INTO workspace_batch_dispatch_targets
         (operation_id, workstream_id, dispatched_at)
       SELECT ?, value, NULL FROM json_each(?)`,
      request.operationId,
      JSON.stringify(targetIds),
    );
    // The note half is frozen in the same transaction, and for the same
    // reason: selecting it again at archive time would let a note that
    // entered the range in between be taken, which under an open-ended
    // heading like "Last hour" is any note touched since the reader
    // confirmed. The receipt alone only closes that for a *retry*.
    if (request.update.kind === "archive") {
      storage.sql.exec(
        `INSERT INTO workspace_batch_dispatch_note_targets (operation_id, note_id)
         SELECT ?, value FROM json_each(?)`,
        request.operationId,
        JSON.stringify(workspaceNoteBatchTargets(
          storage,
          request.workspaceId,
          request.userId,
          request.filter,
        )),
      );
    }
    targetCount = targetIds.length;
  }

  const pending = storage.sql.exec<{ workstream_id: string }>(
    `SELECT workstream_id FROM workspace_batch_dispatch_targets
      WHERE operation_id = ? AND dispatched_at IS NULL
      ORDER BY workstream_id`,
    request.operationId,
  ).toArray();
  return WorkspaceBatchDispatchBeginResultSchema.parse({
    items: pending.map((row) => row.workstream_id),
    targetCount: targetCount ?? 0,
  });
});
}

/** Persist one successful Queue sendBatch chunk; redelivery is a no-op. */
export function advanceWorkspaceBatchDispatch(
  storage: DurableObjectStorage,
  request: WorkspaceBatchDispatchAdvanceRequest,
) {
return storage.transactionSync(() => {
  const dispatch = storage.sql.exec<{ request_hash: string }>(
    `SELECT request_hash FROM workspace_batch_dispatches WHERE operation_id = ?`,
    request.operationId,
  ).toArray()[0];
  if (!dispatch || dispatch.request_hash !== request.requestHash) {
    throw new Error("workstream_batch_dispatch_conflict");
  }
  const now = Date.now();
  storage.sql.exec(
    `UPDATE workspace_batch_dispatch_targets SET dispatched_at = COALESCE(dispatched_at, ?)
      WHERE operation_id = ?
        AND workstream_id IN (SELECT value FROM json_each(?))`,
    now,
    request.operationId,
    JSON.stringify(request.workstreamIds),
  );
  storage.sql.exec(
    `UPDATE workspace_batch_dispatches SET updated_at = ? WHERE operation_id = ?`,
    now,
    request.operationId,
  );
  const remaining = storage.sql.exec<{ count: number }>(
    `SELECT COUNT(*) AS count FROM workspace_batch_dispatch_targets
      WHERE operation_id = ? AND dispatched_at IS NULL`,
    request.operationId,
  ).one();
  return WorkspaceBatchDispatchAdvanceResultSchema.parse({ remainingCount: remaining.count });
});
}

/** Archive the notes belonging to one dispatch, fenced on its hash and user. */
export function archiveWorkspaceNotesForBatch(
  storage: DurableObjectStorage,
  request: WorkspaceBatchNoteArchiveRequest,
): WorkspaceBatchNoteArchiveResult {
const result = storage.transactionSync(() => {
  const dispatch = storage.sql.exec<{
    request_hash: string;
    user_id: string;
    archived_note_count: number | null;
  }>(
    `SELECT request_hash, user_id, archived_note_count
       FROM workspace_batch_dispatches WHERE operation_id = ?`,
    request.operationId,
  ).toArray()[0];
  if (!dispatch
    || dispatch.request_hash !== request.requestHash
    || dispatch.user_id !== request.userId) {
    throw new Error("workstream_batch_dispatch_conflict");
  }
  if (dispatch.archived_note_count !== null) {
    return WorkspaceBatchNoteArchiveResultSchema.parse({
      archivedNoteCount: dispatch.archived_note_count,
      replayed: true,
    });
  }
  const archived = archiveWorkspaceNotesForOperation(storage, {
    workspaceId: request.workspaceId,
    userId: request.userId,
    operationId: request.operationId,
    at: request.at,
  });
  storage.sql.exec(
    `UPDATE workspace_batch_dispatches SET archived_note_count = ?, updated_at = ?
      WHERE operation_id = ?`,
    archived.length,
    Date.now(),
    request.operationId,
  );
  return WorkspaceBatchNoteArchiveResultSchema.parse({
    archivedNoteCount: archived.length,
    replayed: false,
  });
});
  return result;
}
