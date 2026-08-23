/**
 * Object-local scheduling state for one work stream.
 *
 * Five families of row that all answer "what should happen to this work stream
 * later, and has it happened yet": the wake-ups a run asked for, the
 * elicitations waiting on a person, the compaction jobs that shrink a
 * transcript, the description-refresh cadence, and the plugin activation hints.
 *
 * It exists for the reason `workstream-tool-receipt-storage.ts` does, and it
 * carries the same correction. The routed statements reached these rows through
 * five compatibility views whose INSTEAD OF triggers renamed the primary key on
 * four of them — `wakeup_id` to `id`, `elicitation_id` to `id`, `job_id` to
 * `id`, and `plugin_id` onto a synthetic row — invented `workspace_id` and
 * `workstream_id` from the object's identity row, and converted unix
 * milliseconds to ISO-8601 in both directions.
 *
 * The pattern worth naming is the *claim*. A wake-up is taken by an optimistic
 * `WHERE status = 'pending' AND version = ?` and the caller reads
 * `meta.changes` to learn whether it won. That is a compare-and-swap written
 * out because a routed statement has no transaction to hold the read in. Here
 * the read and the write are one `transactionSync`, so the version column is
 * the record of how many times a row has moved rather than the mechanism that
 * decides whether it may.
 *
 * Timestamps are unix milliseconds, the object's convention.
 */

/** What a wake-up is, in the object's own vocabulary. */
export type WakeupStatus = "pending" | "fired" | "cancelled";

export interface WakeupRow extends Record<string, SqlStorageValue> {
  wakeup_id: string;
  created_by_run_id: string | null;
  execution_principal_json: string;
  prompt: string;
  due_at: number;
  status: string;
  idempotency_key: string;
  version: number;
  created_at: number;
}

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

export class WorkstreamSchedulingStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  // ------------------------------------------------------------- wake-ups

  /** How many wake-ups this work stream is still waiting on. */
  pendingWakeupCount(): number {
    return this.sql.exec<{ pending: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS pending FROM workstream_wakeups WHERE status = 'pending'`,
    ).one().pending;
  }

  /** The pending wake-ups, soonest first. */
  pendingWakeups(input: { limit: number }): WakeupRow[] {
    return this.sql.exec<WakeupRow>(
      `SELECT wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
              status, idempotency_key, version, created_at
         FROM workstream_wakeups
        WHERE status = 'pending'
        ORDER BY due_at ASC
        LIMIT ?`,
      input.limit,
    ).toArray();
  }

  /** One wake-up by id, whatever its status. */
  wakeup(input: { wakeupId: string }): WakeupRow | undefined {
    return first(this.sql.exec<WakeupRow>(
      `SELECT wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
              status, idempotency_key, version, created_at
         FROM workstream_wakeups WHERE wakeup_id = ?`,
      input.wakeupId,
    ));
  }

  /** The wake-up a replayed tool receipt already created, if any. */
  wakeupByIdempotencyKey(input: { idempotencyKey: string }): WakeupRow | undefined {
    return first(this.sql.exec<WakeupRow>(
      `SELECT wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
              status, idempotency_key, version, created_at
         FROM workstream_wakeups WHERE idempotency_key = ?`,
      input.idempotencyKey,
    ));
  }

  /**
   * Schedule one wake-up, or report the one a replay already scheduled.
   *
   * The routed statement selected `FROM workstreams w WHERE w.archived_at IS
   * NULL` to refuse scheduling against an archived work stream, then relied on
   * `ON CONFLICT … DO NOTHING` and a follow-up read to tell a replay from a
   * refusal — two outcomes through one `changes` count. Both questions are
   * answered here directly, and the archived check reads this object's own
   * identity row rather than joining a table it no longer holds.
   */
  scheduleWakeup(input: {
    wakeupId: string;
    createdByRunId: string | null;
    executionPrincipalJson: string;
    prompt: string;
    dueAt: number;
    idempotencyKey: string;
    now: number;
  }): { outcome: "scheduled" | "replayed" | "workstream_archived"; wakeupId: string } {
    return this.storage.transactionSync(() => {
      if (this.#archived()) {
        return { outcome: "workstream_archived" as const, wakeupId: input.wakeupId };
      }
      const existing = this.wakeupByIdempotencyKey({ idempotencyKey: input.idempotencyKey });
      if (existing) {
        return { outcome: "replayed" as const, wakeupId: existing.wakeup_id };
      }
      this.sql.exec(
        `INSERT INTO workstream_wakeups
           (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
            status, idempotency_key, fired_at, cancelled_at, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, 1, ?, ?)`,
        input.wakeupId,
        input.createdByRunId,
        input.executionPrincipalJson,
        input.prompt,
        input.dueAt,
        input.idempotencyKey,
        input.now,
        input.now,
      );
      return { outcome: "scheduled" as const, wakeupId: input.wakeupId };
    });
  }

  /**
   * Take exclusive ownership of a due wake-up.
   *
   * The compare-and-swap the routed statement spelled out. Claiming before the
   * run starts biases the path to at-most-once: a crash after the claim loses a
   * wake-up, where a crash after an unclaimed launch would start the same prompt
   * twice and repeat whatever external writes it makes.
   *
   * `expectedVersion` is still taken, and still checked, even though the
   * transaction makes an interleaving impossible — a caller that read a row,
   * did something slow, and then claimed on a stale understanding is exactly
   * the case it was written for, and that is a caller-side race the object
   * cannot see.
   */
  claimDueWakeup(input: {
    wakeupId: string;
    expectedVersion: number;
    now: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      const row = this.wakeup({ wakeupId: input.wakeupId });
      if (!row || row.status !== "pending" || row.version !== input.expectedVersion) return false;
      this.sql.exec(
        `UPDATE workstream_wakeups
            SET status = 'fired', fired_at = ?, version = version + 1, updated_at = ?
          WHERE wakeup_id = ?`,
        input.now,
        input.now,
        input.wakeupId,
      );
      return true;
    });
  }

  /** Undo a claim whose run never started, so the next alarm retries it. */
  releaseClaimedWakeup(input: { wakeupId: string; now: number }): boolean {
    return this.storage.transactionSync(() => {
      const row = this.wakeup({ wakeupId: input.wakeupId });
      if (!row || row.status !== "fired") return false;
      this.sql.exec(
        `UPDATE workstream_wakeups
            SET status = 'pending', fired_at = NULL, version = version + 1, updated_at = ?
          WHERE wakeup_id = ?`,
        input.now,
        input.wakeupId,
      );
      return true;
    });
  }

  /** Cancel a pending wake-up, distinguishing "already settled" from "absent". */
  cancelWakeup(input: {
    wakeupId: string;
    now: number;
  }): "cancelled" | "not_pending" | "not_found" {
    return this.storage.transactionSync(() => {
      const row = this.wakeup({ wakeupId: input.wakeupId });
      if (!row) return "not_found";
      if (row.status !== "pending") return "not_pending";
      this.sql.exec(
        `UPDATE workstream_wakeups
            SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ?
          WHERE wakeup_id = ?`,
        input.now,
        input.now,
        input.wakeupId,
      );
      return "cancelled";
    });
  }

  /**
   * Remove a pending wake-up that was never armed.
   *
   * The caller creates the row and then arms an alarm for it; if the arming
   * fails it deletes rather than cancels, so a member is never shown a pending
   * wake-up that nothing will ever fire. A pending row with no alarm is the one
   * outcome that lies.
   */
  deleteUnarmedWakeup(input: { wakeupId: string }): boolean {
    return this.storage.transactionSync(() => {
      const row = this.wakeup({ wakeupId: input.wakeupId });
      if (!row || row.status !== "pending") return false;
      this.sql.exec(`DELETE FROM workstream_wakeups WHERE wakeup_id = ?`, input.wakeupId);
      return true;
    });
  }

  /** Whether this work stream has been archived, from its own identity row. */
  #archived(): boolean {
    return first(this.sql.exec<{ archived: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS archived FROM workstream WHERE id = 1 AND archived_at IS NOT NULL`,
    )) !== undefined;
  }
}
