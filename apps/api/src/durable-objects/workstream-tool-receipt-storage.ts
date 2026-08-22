/**
 * Object-local durable tool receipts for one work stream.
 *
 * Every receipt a run writes — the admitted execution plan, its append-only
 * checkpoints, and its terminal settlement — lives in this object's `tool_effects`
 * and `tool_effect_checkpoints`. This module is the only thing that writes them.
 *
 * It exists because `harness-run-runtime.ts` previously reached the same rows by
 * preparing D1-shaped SQL against a routed handle: statements naming
 * `tool_invocations` were rewritten onto `_runtime_tool_invocations`, a
 * compatibility view whose INSTEAD OF triggers renamed six columns, remapped two
 * status values, converted unix milliseconds to ISO-8601 in both directions, and
 * invented five NOT NULL columns the old vocabulary never carried.
 *
 * The cost was not only vocabulary. Each operation was a *fence, a batch, and a
 * reconcile* — three round trips across the Worker boundary, with the run's lease
 * fence re-evaluated in SQL every time because it could not be trusted between
 * trips. Here each one is a single `transactionSync`: the fence is read, the
 * decision is made, both rows are written, and the outcome is returned without the
 * gate opening in between. A caller can no longer observe a half-settled receipt,
 * and the lease cannot lapse between the check and the write.
 *
 * Timestamps are unix milliseconds, the object's convention. Statuses are the
 * object's own — `admitted` and `executing`, which the retired view spelled
 * `pending` and `started`.
 */

import { uuidV7 } from "../lib/uuid-v7";

/** The real statuses, and the compatibility spellings they replaced. */
export type ToolReceiptStatus =
  | "admitted" | "executing" | "completed" | "failed" | "ambiguous";

/**
 * The run-lease fence every write is evaluated under.
 *
 * `attemptId` is `runs.legacy_attempt_id` — a text attempt identity that exists
 * only because three compatibility views project one, while the object's own
 * attempt identity is the integer `attempt_epoch`. Slice 1 keeps using it because
 * `claimHarnessAttempt` still writes it and the messages and harness-run slices
 * still read it; it is dropped when the last of the three lands.
 */
export interface ToolReceiptFence {
  runId: string;
  attemptId: string;
  owner: string;
}

/** What `persistToolExecutionPlan` decided, unchanged from the routed shape. */
export type ToolReceiptAdmission =
  | { state: "created"; effectIntentId: string }
  | { state: "resume_read"; effectIntentId: string }
  | { state: "replay_completed"; effectIntentId: string }
  | { state: "ambiguous_external_write"; effectIntentId: string }
  /**
   * The fence did not hold. Returned rather than thrown: an exception crossing
   * the RPC boundary arrives as an opaque string, and the caller has to tell
   * "your lease is gone" apart from "the object failed", because only the first
   * is a normal end to a run.
   */
  | { state: "ownership_lost" };

export type ToolReceiptSettlement = "persisted" | "already_persisted" | "ownership_lost";

interface EffectRow extends Record<string, SqlStorageValue> {
  effect_intent_id: string;
  request_hash: string;
  execution_plan_hash: string | null;
  status: string;
  checkpoint_index: number;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

export class WorkstreamToolReceiptStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * Whether the run still holds the lease this write claims.
   *
   * Read inside the same transaction as the write it guards, which is the whole
   * point of moving these operations here: the routed version asked this
   * question over RPC, then asked it again inside each statement's WHERE clause
   * because the answer could have changed in between.
   */
  #fenceHolds(fence: ToolReceiptFence, now: number): boolean {
    return first(this.sql.exec<{ held: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS held FROM runs
        WHERE run_id = ? AND legacy_attempt_id = ? AND lease_owner = ?
          AND status = 'running' AND cancellation_requested_at IS NULL
          AND terminalized_at IS NULL AND lease_expires_at > ?`,
      fence.runId,
      fence.attemptId,
      fence.owner,
      now,
    )) !== undefined;
  }

  #effect(effectIntentId: string): EffectRow | undefined {
    return first(this.sql.exec<EffectRow>(
      `SELECT effect_intent_id, request_hash, execution_plan_hash, status, checkpoint_index
         FROM tool_effects WHERE effect_intent_id = ?`,
      effectIntentId,
    ));
  }

  /**
   * Append a checkpoint and return the index it landed on.
   *
   * The index is read back rather than assumed: a receipt replanned in place
   * already carries checkpoints past a caller's static number, and the routed
   * version had to re-select it for exactly this reason.
   */
  #appendCheckpoint(input: {
    effectIntentId: string;
    runId: string;
    attemptId: string;
    index: number;
    phase: string;
    payloadJson: string;
    now: number;
  }): number | null {
    const written = this.sql.exec<{ checkpoint_index: number } & Record<string, SqlStorageValue>>(
      `INSERT INTO tool_effect_checkpoints
         (checkpoint_id, effect_intent_id, run_id, attempt_id, checkpoint_index,
          phase, member_safe_payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(effect_intent_id, checkpoint_index) DO NOTHING
       RETURNING checkpoint_index`,
      uuidV7(input.now),
      input.effectIntentId,
      input.runId,
      input.attemptId,
      input.index,
      input.phase.slice(0, 120),
      input.payloadJson,
      input.now,
    ).toArray();
    return written[0]?.checkpoint_index ?? null;
  }

  // ------------------------------------------------------------------ admit

  /**
   * Admit a tool call's execution plan, or say what the existing receipt means.
   *
   * The caller hashes the plan before calling: hashing is async and this runs
   * inside a synchronous transaction. That split is deliberate rather than
   * incidental — it is what lets the whole decision, which the routed version
   * spread over as many as six round trips with a settlement in the middle, be
   * one atomic step.
   */
  admit(input: {
    effectIntentId: string;
    runId: string;
    toolCallId: string;
    toolName: string;
    mode: "read" | "write";
    connectionId: string | null;
    requestHash: string;
    inputJson: string;
    executionPlanHash: string;
    executionPlanJson: string;
    compatiblePriorPlanHashes: readonly string[];
    providerIdempotencyKey: string | null;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptAdmission {
    return this.storage.transactionSync(() => {
      if (!this.#fenceHolds(input.fence, input.now)) return { state: "ownership_lost" };

      const existing = first(this.sql.exec<EffectRow>(
        `SELECT effect_intent_id, request_hash, execution_plan_hash, status, checkpoint_index
           FROM tool_effects WHERE run_id = ? AND tool_call_id = ?`,
        input.fence.runId,
        input.toolCallId,
      ));

      if (!existing) {
        // `MAX(tool_position) + 1`, never `COUNT(*)`. The table is
        // `UNIQUE (run_id, attempt_epoch, tool_position)`, and a count stops
        // being injective the moment a receipt is deleted — which the
        // attachment-receipt paths do. Object schema migration 16 repaired the
        // compatibility trigger for the same reason; this inherits the fix
        // rather than reintroducing the defect in typed form.
        this.sql.exec(
          `INSERT INTO tool_effects
             (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
              tool_name, mode, request_hash, authority_revision, status, tool_call_id,
              connection_id, input_json, execution_plan_hash, execution_plan_json,
              provider_idempotency_key, started_at, checkpoint_index)
           SELECT ?1, run.run_id, run.attempt_epoch,
                  (SELECT COALESCE(MAX(tool_position) + 1, 0)
                     FROM tool_effects WHERE run_id = run.run_id),
                  'runtime:' || ?1, ?2, ?3, ?4, COALESCE(?5, 'runtime'), 'executing',
                  ?6, ?7, ?8, ?5, ?9, ?10, ?11, 0
             FROM runs run WHERE run.run_id = ?12`,
          input.effectIntentId,
          input.toolName,
          input.mode,
          input.requestHash,
          input.executionPlanHash,
          input.toolCallId,
          input.connectionId,
          input.inputJson,
          input.executionPlanJson,
          input.providerIdempotencyKey,
          input.now,
          input.fence.runId,
        );
        this.#appendCheckpoint({
          effectIntentId: input.effectIntentId,
          runId: input.fence.runId,
          attemptId: input.fence.attemptId,
          index: 0,
          phase: "execution_planned",
          payloadJson: "{}",
          now: input.now,
        });
        return { state: "created", effectIntentId: input.effectIntentId };
      }

      // From here the receipt already exists, and every branch is about what a
      // second call landing on one coordinate is allowed to mean.
      //
      // There is deliberately no "was this receipt admitted under a different
      // attempt?" branch. `tool_effects` has no attempt column: the retired
      // view projected the *run's current* `legacy_attempt_id`, so that
      // comparison could only ever differ when the attempt changed between the
      // caller's fence check and its follow-up read — a race across two round
      // trips. The fence above and this read are one transaction, so it cannot.
      // (Whether a receipt should instead be matched against its own
      // `attempt_epoch` is a real question the view's projection hid, and a
      // behavior change; it is not this slice's to make.)

      const planMatches = existing.execution_plan_hash === input.executionPlanHash
        || input.compatiblePriorPlanHashes.includes(existing.execution_plan_hash ?? "");
      if (existing.request_hash !== input.requestHash || !planMatches) {
        // A settled *read* whose result nothing depends on may be rebound to
        // the call that landed on its coordinates; anything else is ambiguous.
        if (
          input.mode === "read"
          && existing.status === "completed"
          && !this.#hasDependents(existing.effect_intent_id, input.fence.runId, input.toolCallId)
        ) {
          return this.#replanCompletedRead(existing, input);
        }
        // `completed` and `ambiguous` are already terminal; moving them would
        // report a lease failure that did not happen.
        if (existing.status !== "completed" && existing.status !== "ambiguous") {
          this.#settle({
            effectIntentId: existing.effect_intent_id,
            fence: input.fence,
            now: input.now,
            fromStatuses: ["admitted", "executing"],
            phase: "ambiguous_external_write",
            payloadJson: JSON.stringify({ code: "ambiguous_external_write" }),
            apply: (checkpointIndex) => this.sql.exec(
              `UPDATE tool_effects
                  SET status = 'ambiguous', settled_at = ?, error_json = ?,
                      checkpoint_index = ?
                WHERE effect_intent_id = ?`,
              input.now,
              JSON.stringify({
                code: "ambiguous_external_write",
                message: "A tool-call receipt was reused with a different immutable execution plan",
              }),
              checkpointIndex,
              existing.effect_intent_id,
            ),
          });
        }
        return { state: "ambiguous_external_write", effectIntentId: existing.effect_intent_id };
      }

      if (existing.status === "completed") {
        return { state: "replay_completed", effectIntentId: existing.effect_intent_id };
      }
      if (input.mode === "write") {
        if (existing.status !== "ambiguous") {
          this.#settle({
            effectIntentId: existing.effect_intent_id,
            fence: input.fence,
            now: input.now,
            fromStatuses: ["admitted", "executing"],
            phase: "ambiguous_external_write",
            payloadJson: JSON.stringify({ code: "ambiguous_external_write" }),
            apply: (checkpointIndex) => this.sql.exec(
              `UPDATE tool_effects
                  SET status = 'ambiguous', settled_at = ?, error_json = ?,
                      checkpoint_index = ?
                WHERE effect_intent_id = ?`,
              input.now,
              JSON.stringify({
                code: "ambiguous_external_write",
                message: "A prior write may have reached the provider",
              }),
              checkpointIndex,
              existing.effect_intent_id,
            ),
          });
        }
        return { state: "ambiguous_external_write", effectIntentId: existing.effect_intent_id };
      }
      return { state: "resume_read", effectIntentId: existing.effect_intent_id };
    });
  }

  /** A child run or an attachment receipt built on this result. */
  #hasDependents(effectIntentId: string, runId: string, toolCallId: string): boolean {
    return first(this.sql.exec<{ dependent: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS dependent
        WHERE EXISTS (
                SELECT 1 FROM runs
                 WHERE parent_run_id = ? AND parent_tool_call_id = ?
              )
           OR EXISTS (
                SELECT 1 FROM attachment_tool_receipts WHERE tool_invocation_id = ?
              )`,
      runId,
      toolCallId,
      effectIntentId,
    )) !== undefined;
  }

  #replanCompletedRead(
    existing: EffectRow,
    input: {
      toolName: string;
      connectionId: string | null;
      requestHash: string;
      inputJson: string;
      executionPlanHash: string;
      executionPlanJson: string;
      providerIdempotencyKey: string | null;
      fence: ToolReceiptFence;
      now: number;
    },
  ): ToolReceiptAdmission {
    const index = this.#appendCheckpoint({
      effectIntentId: existing.effect_intent_id,
      runId: input.fence.runId,
      attemptId: input.fence.attemptId,
      index: existing.checkpoint_index + 1,
      phase: "execution_replanned",
      payloadJson: JSON.stringify({ toolName: input.toolName }),
      now: input.now,
    });
    if (index === null) {
      return { state: "ambiguous_external_write", effectIntentId: existing.effect_intent_id };
    }
    this.sql.exec(
      `UPDATE tool_effects
          SET tool_name = ?, connection_id = ?, request_hash = ?, input_json = ?,
              execution_plan_hash = ?, execution_plan_json = ?,
              provider_idempotency_key = ?, status = 'executing', started_at = ?,
              settled_at = NULL, output_ref = NULL, output_summary = NULL,
              error_json = NULL, checkpoint_index = ?
        WHERE effect_intent_id = ? AND status = 'completed'`,
      input.toolName,
      input.connectionId,
      input.requestHash,
      input.inputJson,
      input.executionPlanHash,
      input.executionPlanJson,
      input.providerIdempotencyKey,
      input.now,
      index,
      existing.effect_intent_id,
    );
    return { state: "created", effectIntentId: existing.effect_intent_id };
  }

  // ----------------------------------------------------------------- settle

  /**
   * The shape every settling write shares: append a checkpoint, then move the
   * receipt, both or neither.
   *
   * The routed version expressed this as a two-statement D1 batch where each
   * statement re-proved the fence and the second additionally proved the first
   * had landed. Inside one transaction the proof is structural — if the
   * checkpoint did not land, nothing else runs.
   */
  #settle(input: {
    effectIntentId: string;
    fence: ToolReceiptFence;
    now: number;
    fromStatuses: readonly ToolReceiptStatus[];
    phase: string;
    payloadJson: string;
    apply: (checkpointIndex: number) => unknown;
  }): boolean {
    const effect = this.#effect(input.effectIntentId);
    if (!effect || !input.fromStatuses.includes(effect.status as ToolReceiptStatus)) return false;
    const index = this.#appendCheckpoint({
      effectIntentId: input.effectIntentId,
      runId: input.fence.runId,
      attemptId: input.fence.attemptId,
      index: effect.checkpoint_index + 1,
      phase: input.phase,
      payloadJson: input.payloadJson,
      now: input.now,
    });
    if (index === null) return false;
    input.apply(index);
    return true;
  }

  /** Append progress to a live receipt without settling it. */
  checkpoint(input: {
    effectIntentId: string;
    checkpointIndex: number;
    phase: string;
    payloadJson: string;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    return this.storage.transactionSync(() => {
      if (!this.#fenceHolds(input.fence, input.now)) return "ownership_lost";
      const effect = this.#effect(input.effectIntentId);
      if (!effect) return "ownership_lost";
      const index = Math.max(1, Math.trunc(input.checkpointIndex));
      // Already past this index: the caller is replaying its own checkpoint,
      // which is the ordinary shape of a retried step rather than a failure.
      if (effect.checkpoint_index >= index) return "already_persisted";
      const written = this.#appendCheckpoint({
        effectIntentId: input.effectIntentId,
        runId: input.fence.runId,
        attemptId: input.fence.attemptId,
        index,
        phase: input.phase,
        payloadJson: input.payloadJson,
        now: input.now,
      });
      if (written === null) return "already_persisted";
      this.sql.exec(
        `UPDATE tool_effects SET checkpoint_index = ? WHERE effect_intent_id = ?`,
        written,
        input.effectIntentId,
      );
      return "persisted";
    });
  }

  /** Make a successful provider result replayable. */
  complete(input: {
    effectIntentId: string;
    checkpointIndex: number;
    outputRef: string;
    outputSummary: string;
    providerOperationId: string | null;
    payloadJson: string;
    allowAmbiguousReconciliation: boolean;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    const summary = input.outputSummary.slice(0, 4_000);
    return this.storage.transactionSync(() => {
      if (!this.#fenceHolds(input.fence, input.now)) return "ownership_lost";
      const moved = this.#settle({
        effectIntentId: input.effectIntentId,
        fence: input.fence,
        now: input.now,
        fromStatuses: input.allowAmbiguousReconciliation
          ? ["admitted", "executing", "ambiguous"]
          : ["admitted", "executing"],
        phase: "result_persisted",
        payloadJson: input.payloadJson,
        apply: (checkpointIndex) => this.sql.exec(
          `UPDATE tool_effects
              SET status = 'completed', output_ref = ?, output_summary = ?,
                  result_hash = COALESCE(?, ?), provider_operation_id = ?,
                  settled_at = ?, checkpoint_index = ?, error_json = NULL
            WHERE effect_intent_id = ?`,
          input.outputRef,
          summary,
          input.outputRef,
          summary,
          input.providerOperationId,
          input.now,
          checkpointIndex,
          input.effectIntentId,
        ),
      });
      if (moved) return "persisted";
      const settled = first(this.sql.exec<{
        status: string; output_ref: string | null;
        output_summary: string | null; provider_operation_id: string | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT status, output_ref, output_summary, provider_operation_id
           FROM tool_effects WHERE effect_intent_id = ?`,
        input.effectIntentId,
      ));
      return settled?.status === "completed"
        && settled.output_ref === input.outputRef
        && settled.output_summary === summary
        && settled.provider_operation_id === input.providerOperationId
        ? "already_persisted"
        : "ownership_lost";
    });
  }

  /** Make a failed or ambiguous receipt terminal. */
  fail(input: {
    effectIntentId: string;
    status: "failed" | "ambiguous";
    phase: string;
    errorJson: string;
    payloadJson: string;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    return this.storage.transactionSync(() => {
      if (!this.#fenceHolds(input.fence, input.now)) return "ownership_lost";
      const moved = this.#settle({
        effectIntentId: input.effectIntentId,
        fence: input.fence,
        now: input.now,
        // An ambiguous finalize may also move an already-failed receipt: a
        // write that failed locally may still have reached the provider.
        fromStatuses: input.status === "ambiguous"
          ? ["admitted", "executing", "failed"]
          : ["admitted", "executing"],
        phase: input.phase,
        payloadJson: input.payloadJson,
        apply: (checkpointIndex) => this.sql.exec(
          `UPDATE tool_effects
              SET status = ?, settled_at = ?, error_json = ?, checkpoint_index = ?
            WHERE effect_intent_id = ?`,
          input.status,
          input.now,
          input.errorJson,
          checkpointIndex,
          input.effectIntentId,
        ),
      });
      if (moved) return "persisted";
      const settled = first(this.sql.exec<{ status: string; error_json: string | null } & Record<string, SqlStorageValue>>(
        `SELECT status, error_json FROM tool_effects WHERE effect_intent_id = ?`,
        input.effectIntentId,
      ));
      return settled?.status === input.status && settled.error_json === input.errorJson
        ? "already_persisted"
        : "ownership_lost";
    });
  }
}
