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

export interface CompactionCheckpointRow extends Record<string, SqlStorageValue> {
  run_id: string;
  compacted_through_sequence: number;
  messages_json: string;
  summary: string;
  checkpoint_template_version: number;
  execution_principal_key: string;
  resource_visibility_fingerprint: string;
  model: string;
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

  // ----------------------------------------------------- plugin activation

  /**
   * The plugins this work stream has authorized before, newest question first
   * only in name — the order is by id, as the routed statement's was.
   *
   * A hint, not an authorization. The caller intersects it with the run's own
   * eligible set, so a hint for a plugin the run may not load is discarded
   * there rather than trusted here.
   */
  activationHints(): string[] {
    return this.sql.exec<{ plugin_id: string } & Record<string, SqlStorageValue>>(
      `SELECT plugin_id FROM plugin_activation_hints ORDER BY plugin_id`,
    ).toArray().map((row) => row.plugin_id);
  }

  /**
   * Note that a plugin was authorized for this work stream.
   *
   * `activated_at` is set once and never moved, so the hint records when this
   * work stream first reached for the plugin; `last_authorized_at` moves every
   * time. The retired trigger wrote exactly this, and the caller's own
   * `ON CONFLICT(workstream_id, plugin_id)` clause never ran — the view had no
   * unique index for it to name, and the trigger's upsert governed instead.
   */
  recordPluginActivation(input: { pluginId: string; now: number }): void {
    this.sql.exec(
      `INSERT INTO plugin_activation_hints (plugin_id, activated_at, last_authorized_at)
       VALUES (?, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET last_authorized_at = excluded.last_authorized_at`,
      input.pluginId,
      input.now,
      input.now,
    );
  }

  // ---------------------------------------------------------- compaction

  /**
   * The compaction checkpoint a run should resume from.
   *
   * Without a fence this is the newest checkpoint for the principal — highest
   * sequence, then most recently written. With one it is that exact
   * checkpoint, so a run that froze a fence mid-flight resumes from the same
   * rows rather than from whatever has been written since.
   */
  compactionCheckpoint(input: {
    executionPrincipalKey: string;
    fence?: { runId: string; compactedThroughSequence: number };
  }): CompactionCheckpointRow | undefined {
    const columns = `run_id, compacted_through_sequence, messages_json, summary,
              checkpoint_template_version, execution_principal_key,
              resource_visibility_fingerprint, model`;
    if (input.fence) {
      return first(this.sql.exec<CompactionCheckpointRow>(
        `SELECT ${columns} FROM compaction_checkpoints
          WHERE execution_principal_key = ? AND run_id = ? AND compacted_through_sequence = ?
          LIMIT 1`,
        input.executionPrincipalKey,
        input.fence.runId,
        input.fence.compactedThroughSequence,
      ));
    }
    return first(this.sql.exec<CompactionCheckpointRow>(
      `SELECT ${columns} FROM compaction_checkpoints
        WHERE execution_principal_key = ?
        ORDER BY compacted_through_sequence DESC, updated_at DESC
        LIMIT 1`,
      input.executionPrincipalKey,
    ));
  }

  /**
   * Write the checkpoint a compaction produced, if the inventory has not moved.
   *
   * `expectedInventoryRevision` is the fence the routed statement expressed as
   * a `WHERE COALESCE((SELECT revision FROM workstream_resource_inventory_revisions
   * …), 0) = ?` on the insert itself: a checkpoint summarizes what a principal
   * could see, so one written against an inventory that has since changed
   * describes a visibility that no longer exists. The revision lives in this
   * same object, so the check is a read inside the write's transaction rather
   * than a correlated subquery across a routed statement.
   *
   * `projection_key` is what the retired trigger synthesized, and it is kept
   * verbatim — the rows already written carry it, and a different key would
   * make every existing checkpoint invisible to this read.
   */
  persistCompactionCheckpoint(input: {
    executionPrincipalKey: string;
    resourceVisibilityFingerprint: string;
    checkpointTemplateVersion: number;
    runId: string;
    compactedThroughSequence: number;
    messagesJson: string;
    summary: string;
    model: string;
    contextTokensBeforeCompaction: number;
    contextWindowTokens: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    expectedInventoryRevision: number;
    now: number;
  }): "persisted" | "inventory_revision_moved" {
    return this.storage.transactionSync(() => {
      const revision = first(this.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
        `SELECT revision FROM resource_inventory_revision WHERE id = 1`,
      ))?.revision ?? 0;
      if (revision !== input.expectedInventoryRevision) return "inventory_revision_moved";
      this.sql.exec(
        `INSERT INTO compaction_checkpoints
           (projection_key, execution_principal_key, resource_visibility_fingerprint,
            checkpoint_template_version, run_id, compacted_through_sequence, messages_json,
            summary, model, context_tokens_before_compaction, context_window_tokens,
            input_tokens, output_tokens, cost_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(projection_key, run_id, compacted_through_sequence) DO UPDATE SET
            messages_json = excluded.messages_json, summary = excluded.summary,
            resource_visibility_fingerprint = excluded.resource_visibility_fingerprint,
            model = excluded.model,
            context_tokens_before_compaction = excluded.context_tokens_before_compaction,
            context_window_tokens = excluded.context_window_tokens,
            input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
            cost_micros = excluded.cost_micros, updated_at = excluded.updated_at`,
        `legacy:${input.executionPrincipalKey}:${input.resourceVisibilityFingerprint}:v${input.checkpointTemplateVersion}`,
        input.executionPrincipalKey,
        input.resourceVisibilityFingerprint,
        input.checkpointTemplateVersion,
        input.runId,
        input.compactedThroughSequence,
        input.messagesJson,
        input.summary,
        input.model,
        input.contextTokensBeforeCompaction,
        input.contextWindowTokens,
        input.inputTokens,
        input.outputTokens,
        input.costMicros,
        input.now,
        input.now,
      );
      return "persisted";
    });
  }

  /** Whether this work stream has been archived, from its own identity row. */
  #archived(): boolean {
    return first(this.sql.exec<{ archived: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS archived FROM workstream WHERE id = 1 AND archived_at IS NOT NULL`,
    )) !== undefined;
  }
}
