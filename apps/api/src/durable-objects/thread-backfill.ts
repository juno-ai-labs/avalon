import { IdSchema, WorkspaceIdSchema } from "@rally/contracts";
import { RegionSchema } from "@rally/contracts/regions";
import { z } from "zod";

/**
 * A one-off job over every thread of an Organization and each of its open
 * Breakouts: the work list, the alarm lane that sends it, and the RPC halves
 * the consumer settles it through.
 *
 * Channel colour sync worked out how to do this without overloading anyone
 * (`channel-color-sync.ts`), and this is that lane with its triggers and
 * revisions taken out, because a one-off has neither: a migration fills the
 * list once, and a row is done when the consumer says so. A later backfill is
 * a migration that inserts rows under a new `job` and a handler for it in the
 * consumer, not another copy of the lane.
 *
 * **One batch in flight per Organization**, for the reason colour sync gives:
 * a claimed row is `in_flight`, and the lane sends nothing while any in-flight
 * row's gate is still ahead, so the next batch waits on the consumer rather
 * than on a chosen interval. A row the consumer could not finish is released
 * and retries at its own gate.
 *
 * See `docs/thread-backfill.md`.
 */

/** Every job a row may name. A job is added with the code that runs it, never before. */
export const THREAD_BACKFILL_JOBS = ["description_summary", "suggestion_backfill", "conversation_view"] as const;
export const ThreadBackfillJobSchema = z.enum(THREAD_BACKFILL_JOBS);
export type ThreadBackfillJob = z.infer<typeof ThreadBackfillJobSchema>;

/**
 * WorkspaceDO migration 100: the work list, and its first job. Every thread
 * that is not archived has its description summarized the way a new one's is
 * (`summarizeExistingDescription`), Breakouts included.
 */
export const THREAD_BACKFILL_MIGRATION: readonly string[] = [
  `CREATE TABLE thread_backfill (
    job TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    in_flight INTEGER NOT NULL DEFAULT 0 CHECK (in_flight IN (0, 1)),
    PRIMARY KEY (job, workstream_id)
  ) STRICT`,
  `CREATE INDEX thread_backfill_due_idx ON thread_backfill(not_before, job, workstream_id)`,
  `INSERT INTO thread_backfill(job, workstream_id, attempts, not_before)
     SELECT 'description_summary', workstream_id, 0, 0 FROM channels WHERE archived_at IS NULL`,
];

/**
 * WorkspaceDO migration 115: the suggestion backfill. Every thread that is
 * not archived has the newest settled Rally turn of its Main and of each open
 * Breakout judged for a merge or Breakout suggestion, the way a fresh
 * settlement is (`backfillSuggestion`), so a conversation that was quiet when
 * the chip shipped gets its line without waiting for a new run.
 */
export const SUGGESTION_BACKFILL_MIGRATION: readonly string[] = [
  `INSERT OR IGNORE INTO thread_backfill(job, workstream_id, attempts, not_before)
     SELECT 'suggestion_backfill', workstream_id, 0, 0 FROM channels WHERE archived_at IS NULL`,
];

/** One thread for one job. */
export const ThreadBackfillMessageSchema = z.strictObject({
  type: z.literal("thread_backfill"),
  job: ThreadBackfillJobSchema,
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  workstreamId: IdSchema,
  /** The claim this delivery carries; a release from an older one is refused. */
  attempt: z.number().int().positive(),
});
export type ThreadBackfillMessage = z.infer<typeof ThreadBackfillMessageSchema>;

/**
 * The conversations to run one job over: Main (`"0"`) and each open Breakout.
 * `null` when there is nothing to do — the row is gone, or the thread is
 * archived or has no projection — and the row is settled by `threadBackfillWork`.
 */
export type ThreadBackfillWork = { substreamIds: string[] } | null;

/** `null` too for an Organization held below migration 100, which has no table yet. */
export function nextThreadBackfillAt(sql: SqlStorage): number | null {
  const present = sql.exec(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'thread_backfill'",
  ).toArray().length > 0;
  if (!present) return null;
  return sql.exec<{ due: number | null }>(
    // While a batch is in flight the next wake is its earliest gate, not the
    // pending rows' (which are due now and would wake the alarm for nothing).
    `SELECT COALESCE(
       (SELECT MIN(not_before) FROM thread_backfill WHERE in_flight = 1 AND not_before > ?),
       (SELECT MIN(not_before) FROM thread_backfill)) AS due`,
    Date.now(),
  ).one().due;
}

/** Whether a batch sent earlier is still waiting on its consumer, as of `now`. */
function batchInFlight(sql: SqlStorage, now: number): boolean {
  return sql.exec(
    "SELECT 1 FROM thread_backfill WHERE in_flight = 1 AND not_before > ? LIMIT 1", now,
  ).toArray().length > 0;
}

/**
 * Send one batch of due rows, advancing each row's retry gate before the
 * await so a failed or lost delivery comes round again on its own. The row is
 * deleted by the consumer, not here.
 */
export async function publishThreadBackfill(input: {
  sql: SqlStorage;
  queue: { sendBatch(messages: Array<{ body: ThreadBackfillMessage }>): Promise<unknown> };
  workspaceId: string;
  region: ThreadBackfillMessage["region"];
  now: number;
  retryAt: (attempt: number) => number;
}): Promise<number> {
  if (batchInFlight(input.sql, input.now)) return 0;
  // Cloudflare Queue sendBatch accepts at most 100 messages (Cloudflare Queues
  // limits, read 2026-10-12); one batch is also the most in flight at once.
  const rows = input.sql.exec<{ job: string; workstream_id: string; attempts: number }>(
    `SELECT job, workstream_id, attempts FROM thread_backfill
      WHERE not_before <= ? ORDER BY not_before, job, workstream_id LIMIT 100`,
    input.now,
  ).toArray();
  if (rows.length === 0) return 0;
  for (const row of rows) {
    input.sql.exec(
      `UPDATE thread_backfill SET attempts = ?, not_before = ?, in_flight = 1
        WHERE job = ? AND workstream_id = ?`,
      row.attempts + 1, input.retryAt(row.attempts + 1), row.job, row.workstream_id,
    );
  }
  await input.queue.sendBatch(rows.map((row) => ({
    body: ThreadBackfillMessageSchema.parse({
      type: "thread_backfill",
      job: row.job,
      region: input.region,
      workspaceId: input.workspaceId,
      workstreamId: row.workstream_id,
      attempt: row.attempts + 1,
    }),
  })));
  return rows.length;
}

/** Settle a row the consumer finished. */
export function completeThreadBackfill(sql: SqlStorage, job: ThreadBackfillJob, workstreamId: string): boolean {
  return sql.exec<{ workstream_id: string }>(
    "DELETE FROM thread_backfill WHERE job = ? AND workstream_id = ? RETURNING workstream_id",
    job, workstreamId,
  ).toArray().length === 1;
}

/**
 * Let a row the consumer could not finish stop holding the next batch back.
 * Its gate, set when it was claimed, still decides when it is sent again.
 *
 * Only the latest claim releases. A delivery can outlive its gate (each
 * conversation is a model call), and the alarm then claims the row again; a
 * late failure from the older delivery must not clear the newer claim, or the
 * lane would send the next batch while this one is still running.
 */
export function releaseThreadBackfill(
  sql: SqlStorage, job: ThreadBackfillJob, workstreamId: string, attempt: number,
): boolean {
  return sql.exec<{ workstream_id: string }>(
    `UPDATE thread_backfill SET in_flight = 0
      WHERE job = ? AND workstream_id = ? AND attempts = ? RETURNING workstream_id`,
    job, workstreamId, attempt,
  ).toArray().length === 1;
}

/** The conversations of one listed thread, or `null` after settling a row with nothing to do. */
export function threadBackfillWork(
  sql: SqlStorage,
  input: { job: ThreadBackfillJob; workstreamId: string },
): ThreadBackfillWork {
  const listed = sql.exec(
    "SELECT 1 FROM thread_backfill WHERE job = ? AND workstream_id = ?", input.job, input.workstreamId,
  ).toArray().length > 0;
  // Settled already, by an earlier delivery of the same row.
  if (!listed) return null;
  if (input.job === "conversation_view") {
    const substreamIds = sql.exec<{ substream_id: string }>(
      `SELECT substream_id FROM parent_children WHERE parent_id = ? AND status = 'ready'
       UNION SELECT substream_id FROM sidekick_children WHERE sidekick_id = ?
       UNION SELECT '0' WHERE EXISTS (SELECT 1 FROM channels WHERE workstream_id = ?)
         OR EXISTS (SELECT 1 FROM spaces WHERE space_id = ?)
         OR EXISTS (SELECT 1 FROM parent_metadata WHERE parent_id = ?)
         OR EXISTS (SELECT 1 FROM parent_children WHERE parent_id = ?)
       ORDER BY substream_id`,
      // HostedParent.childRegistry also supplies an implicit Main for legacy
      // parents whose registry has not materialized its "0" row yet.
      input.workstreamId, input.workstreamId, input.workstreamId, input.workstreamId,
      input.workstreamId, input.workstreamId,
    ).toArray().map((row) => row.substream_id);
    if (substreamIds.length) return { substreamIds };
    completeThreadBackfill(sql, input.job, input.workstreamId);
    return null;
  }
  const thread = sql.exec<{ archived_at: number | null }>(
    "SELECT archived_at FROM channels WHERE workstream_id = ?", input.workstreamId,
  ).toArray()[0];
  if (!thread || thread.archived_at !== null) {
    completeThreadBackfill(sql, input.job, input.workstreamId);
    return null;
  }
  const breakouts = sql.exec<{ substream_id: string }>(
    `SELECT substream_id FROM breakouts
      WHERE workstream_id = ? AND archived_at IS NULL ORDER BY substream_id`,
    input.workstreamId,
  ).toArray().map((row) => row.substream_id);
  return { substreamIds: ["0", ...breakouts] };
}
