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
  | { state: "ownership_lost" }
  /**
   * The run was cancelled or asked to stop. Distinct from a lost lease because
   * callers surface them differently — one is a person stopping the work, the
   * other is this executor no longer being the one doing it.
   */
  | { state: "cancelled" };

export type ToolReceiptSettlement =
  | "persisted" | "already_persisted" | "ownership_lost" | "cancelled";

/**
 * A receipt as the object holds it, which is not how the wire spells it.
 *
 * Real column names, real statuses, unix milliseconds. `ToolInvocationSchema`
 * in `packages/contracts` still publishes `pending`/`started` and ISO-8601, and
 * that is a wire contract rather than a reader's habit — so the translation the
 * retired view did in SQL now happens in the Worker-side port, at the one
 * boundary that serves the wire. Everything else consumes this shape directly.
 *
 * `attempt_id`, `lease_expires_at` and `last_checkpoint_at` are deliberately
 * absent. The view projected all three and nothing ever read them;
 * `loadToolInvocation` pulled them only because it said `SELECT *`. The last of
 * them cost a correlated subquery per row, which is not reimplemented here.
 */
export interface ToolReceiptRecord {
  effectIntentId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  mode: "read" | "write";
  connectionId: string | null;
  requestHash: string;
  inputJson: string;
  status: ToolReceiptStatus;
  outputRef: string | null;
  outputSummary: string | null;
  providerOperationId: string | null;
  errorJson: string | null;
  executionPlanHash: string | null;
  executionPlanJson: string | null;
  startedAt: number | null;
  settledAt: number | null;
  checkpointIndex: number;
}

/** One resource version a replayable attachment read depended on. */
export interface AttachmentDependency {
  resourceId: string;
  derivativeSha256: string;
}

interface ReceiptRow extends Record<string, SqlStorageValue> {
  effect_intent_id: string;
  run_id: string;
  tool_call_id: string;
  tool_name: string;
  mode: string;
  connection_id: string | null;
  request_hash: string;
  input_json: string;
  status: string;
  output_ref: string | null;
  output_summary: string | null;
  provider_operation_id: string | null;
  error_json: string | null;
  execution_plan_hash: string | null;
  execution_plan_json: string | null;
  started_at: number | null;
  settled_at: number | null;
  checkpoint_index: number;
}

const RECEIPT_COLUMNS = `effect_intent_id, run_id, tool_call_id, tool_name, mode,
         connection_id, request_hash, input_json, status, output_ref, output_summary,
         provider_operation_id, error_json, execution_plan_hash, execution_plan_json,
         started_at, settled_at, checkpoint_index`;

function receiptRecord(row: ReceiptRow): ToolReceiptRecord {
  return {
    effectIntentId: row.effect_intent_id,
    runId: row.run_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    mode: row.mode === "write" ? "write" : "read",
    connectionId: row.connection_id,
    requestHash: row.request_hash,
    inputJson: row.input_json,
    status: row.status as ToolReceiptStatus,
    outputRef: row.output_ref,
    outputSummary: row.output_summary,
    providerOperationId: row.provider_operation_id,
    errorJson: row.error_json,
    executionPlanHash: row.execution_plan_hash,
    executionPlanJson: row.execution_plan_json,
    startedAt: row.started_at,
    settledAt: row.settled_at,
    checkpointIndex: row.checkpoint_index,
  };
}

interface EffectRow extends Record<string, SqlStorageValue> {
  effect_intent_id: string;
  request_hash: string;
  execution_plan_hash: string | null;
  execution_plan_json: string | null;
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
   * Whether the run still holds the lease this write claims, and if not, why.
   *
   * Read inside the same transaction as the write it guards, which is the whole
   * point of moving these operations here: the routed version asked this
   * question over RPC, then asked it again inside each statement's WHERE clause
   * because the answer could have changed in between.
   *
   * The reason is carried out rather than collapsed to a boolean because the
   * two failures are not the same event. A cancelled run is a person stopping
   * the work; a lost lease is this executor no longer being the one doing it,
   * and only the second is a fault.
   */
  #fence(
    fence: ToolReceiptFence,
    now: number,
    /**
     * Settle a receipt the run already started even though a member stop is
     * durable. Cancellation blocks *new* work; it must not strand a receipt
     * this same attempt has to settle before its parent can terminalize —
     * `terminalizeHarnessAttempt` refuses while any receipt is still admitted
     * or executing, so refusing here would deadlock the stop it is honouring.
     * Every other condition still holds: this exact attempt, this exact lease
     * owner, still running, not terminalized, not expired.
     */
    allowCancellationRequested = false,
  ): "held" | "cancelled" | "lost" {
    const row = first(this.sql.exec<{
      status: string; cancellation_requested_at: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT status, cancellation_requested_at FROM runs
        WHERE run_id = ? AND legacy_attempt_id = ? AND lease_owner = ?
          AND terminalized_at IS NULL AND lease_expires_at > ?`,
      fence.runId,
      fence.attemptId,
      fence.owner,
      now,
    ));
    if (!row) return "lost";
    if (row.status !== "running") return row.status === "cancelled" ? "cancelled" : "lost";
    if (row.cancellation_requested_at !== null && !allowCancellationRequested) return "cancelled";
    return "held";
  }

  /** The `output_ref` of a *completed* receipt, or undefined for anything else. */
  #settledOutputRef(effectIntentId: string): string | undefined {
    const row = first(this.sql.exec<{ output_ref: string | null } & Record<string, SqlStorageValue>>(
      `SELECT output_ref FROM tool_effects
        WHERE effect_intent_id = ? AND status = 'completed'`,
      effectIntentId,
    ));
    return row?.output_ref ?? undefined;
  }

  #effect(effectIntentId: string): EffectRow | undefined {
    return first(this.sql.exec<EffectRow>(
      `SELECT effect_intent_id, request_hash, execution_plan_hash, execution_plan_json,
              status, checkpoint_index
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
    /**
     * Both statements of the incoming call's mode agree that it is a read.
     *
     * Decided by the caller because only it holds the plan object. It is half
     * of the rebind gate; the other half — that the *stored* receipt was also a
     * read, and that this is a demonstrably different call — is decided here,
     * against rows the caller cannot see.
     */
    incomingIsRead: boolean;
    providerIdempotencyKey: string | null;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptAdmission {
    return this.storage.transactionSync(() => {
      const held = this.#fence(input.fence, input.now);
      if (held !== "held") {
        return { state: held === "cancelled" ? "cancelled" : "ownership_lost" };
      }

      const existing = first(this.sql.exec<EffectRow>(
        `SELECT effect_intent_id, request_hash, execution_plan_hash, execution_plan_json,
                status, checkpoint_index
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
        if (this.#mayRebind(existing, input)) {
          return this.#replanCompletedRead(existing, input);
        }
        // `completed` and `ambiguous` are already terminal; moving them would
        // report a lease failure that did not happen.
        if (existing.status !== "completed" && existing.status !== "ambiguous") {
          this.#settle({
            effectIntentId: existing.effect_intent_id,
            fence: input.fence,
            now: input.now,
            // `failed` too, and for the same reason `fail()` accepts it: a
            // write that failed locally may still have reached the provider,
            // so it may be promoted to ambiguous but never demoted.
            fromStatuses: ["admitted", "executing", "failed"],
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
            // `failed` too, and for the same reason `fail()` accepts it: a
            // write that failed locally may still have reached the provider,
            // so it may be promoted to ambiguous but never demoted.
            fromStatuses: ["admitted", "executing", "failed"],
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

  /**
   * Whether a settled receipt may be rebound to the call that reused its
   * coordinates, rather than being declared ambiguous.
   *
   * Every clause is a fence, and each one only ever relaxes the decision on
   * proof:
   *
   * - The receipt must be settled and must have been a *read*. A write that may
   *   have reached a provider can never be silently re-pointed.
   * - The stored plan must itself say `read`. An unreadable plan cannot prove
   *   the recorded call was one, so it fails closed.
   * - The request hash must differ. Identical input whose recorded policy
   *   cannot be proven compatible is the receipt-identity fence — one call whose
   *   identity is in doubt — and that still fails closed rather than rebinding.
   * - Nothing may already depend on the result.
   */
  #mayRebind(
    existing: EffectRow,
    input: { incomingIsRead: boolean; requestHash: string; toolCallId: string; fence: ToolReceiptFence },
  ): boolean {
    if (existing.status !== "completed" || !input.incomingIsRead) return false;
    if (existing.request_hash === input.requestHash) return false;
    let recordedMode: unknown;
    try {
      recordedMode = (JSON.parse(existing.execution_plan_json ?? "null") as { mode?: unknown } | null)?.mode;
    } catch {
      return false;
    }
    if (recordedMode !== "read") return false;
    return !this.#hasDependents(existing.effect_intent_id, input.fence.runId, input.toolCallId);
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

  // ---------------------------------------------------------------- reading

  /**
   * The receipt for one tool call, by the coordinate the run knows it as.
   *
   * `(run_id, tool_call_id)` is the key `tool_effects_run_call_uq` makes unique
   * and the key `admit` already reads. Three routed statements asked this same
   * question with three different column subsets; one full projection answers
   * all of them, and there is no fence or failure mode separating them.
   */
  receiptForCall(input: { runId: string; toolCallId: string }): ToolReceiptRecord | null {
    const row = first(this.sql.exec<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM tool_effects WHERE run_id = ? AND tool_call_id = ?`,
      input.runId,
      input.toolCallId,
    ));
    return row ? receiptRecord(row) : null;
  }

  /**
   * Receipts for a set of ids, for the transcript projection.
   *
   * The routed statement joined `messages` to filter these, which read like a
   * cross-slice dependency and was not one: the join was `ti.id = m.id`, pure
   * id equality on ids the caller had already selected. Dropping it removes the
   * only apparent reason this operation had to wait for the messages slice.
   *
   * A missing id is omitted rather than raised. A tool message whose receipt was
   * discarded is an ordinary state — that is exactly what `discardReceipt` does
   * — and the caller already treats absence as "no replay available".
   */
  receiptsByIds(input: { effectIntentIds: readonly string[] }): ToolReceiptRecord[] {
    if (input.effectIntentIds.length === 0) return [];
    const placeholders = input.effectIntentIds.map(() => "?").join(", ");
    return this.sql.exec<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM tool_effects
        WHERE effect_intent_id IN (${placeholders})
        ORDER BY effect_intent_id`,
      ...input.effectIntentIds,
    ).toArray().map(receiptRecord);
  }

  // ------------------------------------------------- attachment dependencies

  /**
   * Record the resource versions a replayable attachment read depended on.
   *
   * The receipt is proved to exist first, in the same transaction as the writes,
   * which is what the routed version's separate existence check could not
   * promise. The digest comparison that decides whether these rows are still
   * valid stays in the Worker: it reads `resources`, which belongs to the
   * workspace object, so it cannot join here and was never atomic with this
   * write either.
   */
  recordAttachmentDependencies(input: {
    workspaceId: string;
    effectIntentId: string;
    dependencies: readonly AttachmentDependency[];
    /**
     * The exact completion these dependencies belong to.
     *
     * The caller completes the receipt before registering, so by the time this
     * runs the row may already have been replanned onto a different call and
     * completed again. Matching the settled `output_ref` is what makes the
     * dependency belong to the result the caller actually saw, rather than to
     * whatever the receipt happens to hold now.
     */
    expectedOutputRef: string;
    now: number;
  }): "recorded" | "receipt_missing" {
    return this.storage.transactionSync(() => {
      const effect = this.#settledOutputRef(input.effectIntentId);
      if (effect !== input.expectedOutputRef) return "receipt_missing";
      for (const dependency of input.dependencies) {
        this.sql.exec(
          `INSERT INTO attachment_tool_receipts
             (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(resource_id, tool_invocation_id) DO UPDATE SET
             derivative_sha256 = excluded.derivative_sha256`,
          input.workspaceId,
          dependency.resourceId,
          input.effectIntentId,
          dependency.derivativeSha256,
          input.now,
        );
      }
      return "recorded";
    });
  }

  /**
   * Drop a receipt's recorded dependencies without touching the receipt.
   *
   * Deliberately not folded into `recordAttachmentDependencies`. It is the
   * compensating action taken when the Worker's `resources` read says a version
   * moved after the rows were written, so it has to be callable once that write
   * has already committed — a different failure mode, and therefore a different
   * operation.
   */
  clearAttachmentDependencies(input: {
    workspaceId: string;
    effectIntentId: string;
    /** Same fence as the write: only unwind rows belonging to that completion. */
    expectedOutputRef: string;
  }): number {
    if (this.#settledOutputRef(input.effectIntentId) !== input.expectedOutputRef) return 0;
    this.sql.exec(
      `DELETE FROM attachment_tool_receipts
        WHERE workspace_id = ? AND tool_invocation_id = ?`,
      input.workspaceId,
      input.effectIntentId,
    );
    return this.sql.exec<{ changes: number } & Record<string, SqlStorageValue>>(
      `SELECT changes() AS changes`,
    ).one().changes;
  }

  /**
   * What a completed receipt depended on, or nothing.
   *
   * Scoped to `completed` because the caller reads an empty list as "not
   * replayable", and an in-flight receipt has nothing to replay. The routed
   * statement joined on that status for the same reason; keeping it here means
   * the two cases stay indistinguishable to the caller, as they must.
   */
  attachmentDependencies(input: {
    workspaceId: string;
    effectIntentId: string;
  }): AttachmentDependency[] {
    return this.sql.exec<{
      resource_id: string; derivative_sha256: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT receipt.resource_id, receipt.derivative_sha256
         FROM attachment_tool_receipts receipt
         JOIN tool_effects effect ON effect.effect_intent_id = receipt.tool_invocation_id
        WHERE receipt.workspace_id = ? AND receipt.tool_invocation_id = ?
          AND effect.status = 'completed'
        ORDER BY receipt.resource_id`,
      input.workspaceId,
      input.effectIntentId,
    ).toArray().map((row) => ({
      resourceId: row.resource_id,
      derivativeSha256: row.derivative_sha256,
    }));
  }

  /**
   * Delete a receipt whose stored replay is no longer usable, reporting its ref.
   *
   * The ref comes back so the Worker can queue the stored payload for deletion
   * *after* this commits. The routed version enqueued the outbox row first and
   * could strand it pointing at a receipt that still existed; here the order is
   * fixed by the boundary rather than by remembering to write the statements the
   * right way round.
   *
   * Dependencies go with it, by `ON DELETE CASCADE`. That cascade is
   * load-bearing and was previously untested.
   */
  discardReceipt(input: {
    workspaceId: string;
    effectIntentId: string;
  }): { outputRef: string | null; deleted: boolean } {
    return this.storage.transactionSync(() => {
      const effect = first(this.sql.exec<{
        output_ref: string | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT output_ref FROM tool_effects WHERE effect_intent_id = ?`,
        input.effectIntentId,
      ));
      if (!effect) return { outputRef: null, deleted: false };
      this.sql.exec(
        `DELETE FROM tool_effects WHERE effect_intent_id = ?`,
        input.effectIntentId,
      );
      return { outputRef: effect.output_ref, deleted: true };
    });
  }

  /**
   * Settle every in-flight receipt of a run whose lease was reaped.
   *
   * This is the one operation here that is not fenced on a lease, and it could
   * not be: `#fence` demands a live one, and the sweep's entire premise is that
   * none exists. Every other method would answer `ownership_lost` by
   * construction. The guard is the run's own `terminalized_at`, re-read here
   * rather than trusted from the caller, so this is safe to call after the batch
   * that terminalized the run rather than only inside it.
   *
   * Write-ness comes from the execution plan, not from `tool_effects.mode`, and
   * the two disagree on purpose. For an absent or malformed plan the column says
   * `read`, while this treats it as possibly-a-write and settles `ambiguous`.
   * Preferring the column would silently turn "we could not confirm the write"
   * into "it definitely failed" for exactly the receipts whose provider request
   * may have landed — the wrong direction for the only case that matters.
   */
  abandonRunReceipts(input: { runId: string; terminalizedAt: number }): number {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE tool_effects
            SET status = CASE
                  WHEN status = 'executing'
                    AND COALESCE(json_extract(execution_plan_json, '$.mode'), '') != 'read'
                  THEN 'ambiguous' ELSE 'failed' END,
                settled_at = ?1,
                error_json = CASE
                  WHEN status = 'executing'
                    AND COALESCE(json_extract(execution_plan_json, '$.mode'), '') != 'read'
                  THEN json_object('code', 'ambiguous_external_write')
                  ELSE json_object('code', 'parent_run_terminated') END
          WHERE run_id = ?2 AND status IN ('admitted', 'executing')
            AND EXISTS (
              SELECT 1 FROM runs
               WHERE run_id = ?2 AND terminalized_at = ?1
            )`,
        input.terminalizedAt,
        input.runId,
      );
      return this.sql.exec<{ changes: number } & Record<string, SqlStorageValue>>(
        `SELECT changes() AS changes`,
      ).one().changes;
    });
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
      const held = this.#fence(input.fence, input.now);
      if (held !== "held") return held === "cancelled" ? "cancelled" : "ownership_lost";
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
    allowCancellationRequested: boolean;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    const summary = input.outputSummary.slice(0, 4_000);
    return this.storage.transactionSync(() => {
      const held = this.#fence(input.fence, input.now, input.allowCancellationRequested);
      if (held !== "held") return held === "cancelled" ? "cancelled" : "ownership_lost";
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
    allowCancellationRequested: boolean;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    return this.storage.transactionSync(() => {
      const held = this.#fence(input.fence, input.now, input.allowCancellationRequested);
      if (held !== "held") return held === "cancelled" ? "cancelled" : "ownership_lost";
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
