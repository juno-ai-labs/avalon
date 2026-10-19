/**
 * The watch on a conversation import's reservation: a thread reserved for an
 * import whose main conversation has not opened within
 * `IMPORT_RESERVATION_RECLAIM_AFTER_MS` is presumed abandoned, and archived.
 *
 * The import's other exits all need a party that may never come: the window's
 * discard or abandon needs the window, and the run-end reclaim needs a run. A
 * start cut off before admitting its run, from a window that is gone, leaves
 * none of them, and the thread stays listed with a conversation that can never
 * open. This lane needs nothing but time.
 *
 * Armed in the reservation's own transaction, so no reservation exists that the
 * watch does not know about. At its due time the lane retires the create key in
 * D1 first, which refuses any import that `complete` has claimed, then archives
 * the thread through `discardReservedMain`, exactly as the run-end reclaim does.
 * See `docs/session-import.md`, step 6.
 */

/**
 * How long a reserved import thread may stay unopened before it is archived.
 *
 * - **Without it:** a start cut off before its run was admitted, from a window
 *   that then closed, leaves a listed thread whose conversation never opens and
 *   that its creator cannot remove (one did, from 2026-10-06 until this lane).
 * - **Who causes it:** a dropped connection, a deploy reset or a crashed window,
 *   not a caller choosing it.
 * - **Why nothing else stops it:** discard and abandon need the window, and the
 *   run-end reclaim needs an admitted run.
 * - **When it trips:** an import whose thread has not opened an hour after its
 *   reservation is archived and its `complete` refused. A real import opens its
 *   thread in 20 to 60 seconds, so only a dead one is reached.
 *
 * The number is the team's: one hour, chosen on 2026-10-19.
 */
export const IMPORT_RESERVATION_RECLAIM_AFTER_MS = 60 * 60 * 1000;

/**
 * WorkspaceDO migration 119: the watch, and every import reservation already
 * waiting on it: a hidden child still `reserved` (not a Breakout's preparation)
 * on a listed thread whose main conversation never delivered an effect. Seeded
 * from the child's reservation time, so one already past due is reclaimed on
 * the next alarm.
 */
export const IMPORT_RESERVATION_RECLAIM_MIGRATION: readonly string[] = [
  `CREATE TABLE import_reservation_reclaim (
    parent_id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
  ) STRICT`,
  `CREATE INDEX import_reservation_reclaim_due_idx ON import_reservation_reclaim(due_at)`,
  `INSERT OR IGNORE INTO import_reservation_reclaim(parent_id, user_id, due_at, attempts)
     SELECT child.parent_id, child.created_by_user_id, MIN(child.created_at) + ${IMPORT_RESERVATION_RECLAIM_AFTER_MS}, 0
       FROM parent_children child
       JOIN channels channel ON channel.workstream_id = child.parent_id AND channel.archived_at IS NULL
      WHERE child.kind = 'child' AND child.status = 'reserved' AND child.created_by_user_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM parent_breakout_preparations preparation
                         WHERE preparation.parent_id = child.parent_id
                           AND preparation.substream_id = child.substream_id)
        AND NOT EXISTS (SELECT 1 FROM parent_child_receipts receipt
                         WHERE receipt.parent_id = child.parent_id AND receipt.substream_id = '0')
      GROUP BY child.parent_id, child.created_by_user_id`,
];

/** Watch a thread just reserved for an import. A replayed reservation keeps its first due time. */
export function armImportReservationReclaim(
  sql: SqlStorage,
  input: { parentId: string; userId: string; now: number },
): void {
  sql.exec(
    `INSERT OR IGNORE INTO import_reservation_reclaim(parent_id, user_id, due_at, attempts)
     VALUES (?, ?, ?, 0)`,
    input.parentId, input.userId, input.now + IMPORT_RESERVATION_RECLAIM_AFTER_MS,
  );
}

/** `null` too for an Organization held below migration 119, which has no table yet. */
export function nextImportReservationReclaimAt(sql: SqlStorage): number | null {
  const present = sql.exec(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'import_reservation_reclaim'",
  ).toArray().length > 0;
  if (!present) return null;
  return sql.exec<{ due: number | null }>(
    "SELECT MIN(due_at) AS due FROM import_reservation_reclaim",
  ).one().due;
}

/**
 * Reclaim every reservation due by `now`. A thread whose main conversation has
 * opened is dropped without a reclaim; one whose reclaim throws keeps its row
 * and retries at its own gate.
 */
export async function reclaimDueImportReservations(input: {
  sql: SqlStorage;
  now: number;
  reclaim: (reservation: { parentId: string; userId: string }) => Promise<void>;
  retryAt: (attempt: number) => number;
  onFailure: (reservation: { parentId: string }, error: unknown) => void;
}): Promise<void> {
  const rows = input.sql.exec<{ parent_id: string; user_id: string; attempts: number }>(
    `SELECT parent_id, user_id, attempts FROM import_reservation_reclaim
      WHERE due_at <= ? ORDER BY due_at, parent_id`,
    input.now,
  ).toArray();
  for (const row of rows) {
    const opened = input.sql.exec(
      "SELECT 1 FROM parent_child_receipts WHERE parent_id = ? AND substream_id = '0' LIMIT 1",
      row.parent_id,
    ).toArray().length > 0;
    try {
      if (!opened) await input.reclaim({ parentId: row.parent_id, userId: row.user_id });
      input.sql.exec("DELETE FROM import_reservation_reclaim WHERE parent_id = ?", row.parent_id);
    } catch (error) {
      input.sql.exec(
        "UPDATE import_reservation_reclaim SET attempts = ?, due_at = ? WHERE parent_id = ?",
        row.attempts + 1, input.retryAt(row.attempts + 1), row.parent_id,
      );
      input.onFailure({ parentId: row.parent_id }, error);
    }
  }
}
