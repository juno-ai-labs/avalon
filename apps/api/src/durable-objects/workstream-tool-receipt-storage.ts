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

import {
  enqueueExternalBindingInTransaction,
  OutboundExternalBindingSchema,
  type OutboundExternalBinding,
} from "./external-binding-outbox";
import { uuidV7 } from "../lib/uuid-v7";
import { ToolPageError, ToolPageStorage, type PageClaim, type PageIssueSchema, type PageClaimSchema } from "./tool-page-storage";
import type { z } from "zod";
import type { ToolExecutionAccount, ToolExecutionAccountRecord } from "@rally/contracts";
import {
  TOOL_ACCOUNT_CHECKPOINT, readToolExecutionAccount, completedToolResourceAccounts,
  ExecutionAccountReadSchema, ResourceExecutionAccountsSchema, RecordExecutionAccountSchema, parseExecutionAccountRequest,
} from "./tool-execution-account";
import {
  WorkstreamTranscriptStorage,
  type PreparedToolLifecycle,
} from "./workstream-transcript-storage";

interface PreparedResidualToolPart {
  effectIntentId: string;
  status: "failed" | "ambiguous";
  lifecycle: PreparedToolLifecycle | null;
}

/**
 * A plan blob's declared mode, or undefined for anything that will not parse.
 *
 * Undefined rather than a throw because every caller is a gate that must fail
 * closed: an unreadable plan is not a read.
 */
function planMode(executionPlanJson: string | null): unknown {
  try {
    return (JSON.parse(executionPlanJson ?? "null") as { mode?: unknown } | null)?.mode;
  } catch {
    return undefined;
  }
}

/**
 * A plan blob's declared idempotency class, or null for anything unreadable.
 *
 * The class was already persisted in the plan — `persistToolExecutionPlan`
 * writes `{ mode, idempotency, capability, … }` — and nothing read it back,
 * which is how an interrupted `provider_key` write came to be classified on
 * `mode` alone and reported as `ambiguous_external_write`. Null rather than a
 * throw, and every caller treats null as the strictest class, because a receipt
 * written before this was read has no claim to the safer one.
 */
function planIdempotency(executionPlanJson: string | null): ToolReceiptIdempotency | null {
  let declared: unknown;
  try {
    declared = (JSON.parse(executionPlanJson ?? "null") as { idempotency?: unknown } | null)?.idempotency;
  } catch {
    return null;
  }
  return declared === "safe" || declared === "provider_key" || declared === "record_before_execute"
    ? declared
    : null;
}

function parseObject(value: string | null, errorCode: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "null") as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the same stable storage-boundary error as a non-object.
  }
  throw new Error(errorCode);
}

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

/** The idempotency contract a tool declared, as its receipt recorded it. */
export type ToolReceiptIdempotency = "safe" | "provider_key" | "record_before_execute";

/** What `persistToolExecutionPlan` decided, unchanged from the routed shape. */
export type ToolReceiptAdmission =
  | { state: "created"; effectIntentId: string }
  | { state: "resume_read"; effectIntentId: string }
  /**
   * An unsettled `provider_key` write whose plan, request, and provider key all
   * match the call asking to run. The provider dedupes on that key, so running
   * it again reaches the same external operation rather than a second one —
   * which is the whole of what `provider_key` promises, and the reason this is
   * not `ambiguous_external_write`. `record_before_execute` has no such key and
   * keeps the ambiguous outcome.
   */
  | { state: "resume_write"; effectIntentId: string }
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
  /**
   * The class the tool declared, read back from the persisted plan. Null for a
   * receipt whose plan will not parse or predates the field; callers treat that
   * as `record_before_execute`, the class that assumes the least.
   */
  idempotency: ToolReceiptIdempotency | null;
  providerIdempotencyKey: string | null;
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
  provider_idempotency_key: string | null;
  started_at: number | null;
  settled_at: number | null;
  checkpoint_index: number;
}

const RECEIPT_COLUMNS = `effect_intent_id, run_id, tool_call_id, tool_name, mode,
         connection_id, request_hash, input_json, status, output_ref, output_summary,
         provider_operation_id, error_json, execution_plan_hash, execution_plan_json,
         provider_idempotency_key, started_at, settled_at, checkpoint_index`;

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
    idempotency: planIdempotency(row.execution_plan_json),
    providerIdempotencyKey: row.provider_idempotency_key,
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
  provider_idempotency_key: string | null;
  status: string;
  checkpoint_index: number;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

const LEASE_HOLDING_STATUSES = new Set(["running"]);

export class WorkstreamToolReceiptStorage {
  constructor(
    private readonly storage: DurableObjectStorage,
  ) {}

  executionAccount(raw: { runId: string; effectIntentId: string }): ToolExecutionAccountRecord | null {
    const input = parseExecutionAccountRequest(ExecutionAccountReadSchema, raw);
    return readToolExecutionAccount(this.sql, input.runId, input.effectIntentId);
  }

  resourceExecutionAccounts(raw: { runId: string | null; resourceKeys?: string[] }): ToolExecutionAccountRecord[] {
    const input = parseExecutionAccountRequest(ResourceExecutionAccountsSchema, raw);
    return completedToolResourceAccounts(this.sql, input.runId, input.resourceKeys);
  }

  /** Persist before provider dispatch. Only a definite refusal permits another account. */
  recordExecutionAccount(raw: {
    effectIntentId: string; fence: ToolReceiptFence; now: number;
    phase: ToolExecutionAccountRecord["phase"]; account: ToolExecutionAccount; resourceKeys: string[];
  }): ToolExecutionAccountRecord {
    const input = parseExecutionAccountRequest(RecordExecutionAccountSchema, raw);
    return this.storage.transactionSync(() => {
      if (this.#fence(input.fence, input.now, input.phase !== "selected") !== "held") {
        throw new Error("tool_execution_account_ownership_lost");
      }
      const effect = first(this.sql.exec<{ status: string; checkpoint_index: number }>(
        "SELECT status,checkpoint_index FROM tool_effects WHERE effect_intent_id=? AND run_id=?",
        input.effectIntentId, input.fence.runId,
      ));
      if (!effect || !["executing", "ambiguous"].includes(effect.status)) throw new Error("tool_execution_account_receipt_missing");
      const prior = this.executionAccount({ runId: input.fence.runId, effectIntentId: input.effectIntentId });
      const record: ToolExecutionAccountRecord = {
        phase: input.phase, account: input.account, originalAccount: prior?.originalAccount ?? input.account,
        resourceKeys: [...new Set([...(prior?.resourceKeys ?? []), ...input.resourceKeys])],
      };
      const sameAccount = prior && prior.account.connectionId === record.account.connectionId
        && JSON.stringify(prior.account.principal) === JSON.stringify(record.account.principal)
        && prior.account.sidekickId === record.account.sidekickId
        && prior.account.delegatedUserId === record.account.delegatedUserId;
      if ((!prior && input.phase !== "selected")
        || (prior && prior.account.sidekickId !== record.account.sidekickId)
        || (prior && !sameAccount && (prior.phase !== "refused" || input.phase !== "selected" || effect.status === "ambiguous"))) {
        throw new Error("tool_execution_account_change_refused");
      }
      // A retry keeps its account. A renewed grant can authorize reconciliation
      // under that same identity, while originalAccount preserves first dispatch.
      if (sameAccount && input.phase === "selected" && prior!.phase !== "refused"
        && JSON.stringify(prior!.account) === JSON.stringify(record.account)) return prior!;
      if (prior?.phase === "refused" && input.phase === "served") throw new Error("tool_execution_account_not_selected");
      if (prior?.phase === "served" && input.phase === "refused") throw new Error("tool_execution_account_already_served");
      const written = this.#appendCheckpoint({
        effectIntentId: input.effectIntentId, runId: input.fence.runId, attemptId: input.fence.attemptId,
        index: effect.checkpoint_index + 1, phase: TOOL_ACCOUNT_CHECKPOINT, payloadJson: JSON.stringify(record), now: input.now,
      });
      if (written === null) throw new Error("tool_execution_account_checkpoint_conflict");
      this.sql.exec("UPDATE tool_effects SET checkpoint_index=? WHERE effect_intent_id=?", written, input.effectIntentId);
      return record;
    });
  }

  issuePage(input: z.infer<typeof PageIssueSchema> & { fence: ToolReceiptFence }): string | null {
    return this.storage.transactionSync(() => {
      this.#assertPageReceipt(input, true);
      return new ToolPageStorage(this.sql).issue(input);
    });
  }

  claimPage(input: z.infer<typeof PageClaimSchema> & { fence: ToolReceiptFence }): PageClaim {
    return this.storage.transactionSync(() => {
      this.#assertPageReceipt(input);
      return new ToolPageStorage(this.sql).claim(input);
    });
  }

  #assertPageReceipt(input: { runId: string; effectIntentId: string; fence: ToolReceiptFence }, allowCancellationRequested = false): void {
    if (input.runId !== input.fence.runId || this.#fence(input.fence, Date.now(), allowCancellationRequested) !== "held") {
      throw new ToolPageError("page_execution_ownership_lost");
    }
    const receipt = first(this.sql.exec<{ status: string }>(
      "SELECT status FROM tool_effects WHERE effect_intent_id = ? AND run_id = ?",
      input.effectIntentId, input.runId,
    ));
    if (receipt?.status !== "executing") throw new ToolPageError("page_execution_receipt_missing");
  }

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
     * this same attempt can still settle definitively before its parent
     * terminalizes. Refusing here would demote a known returned result to the
     * residual stop fallback, including ambiguity for a write.
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
    if (!LEASE_HOLDING_STATUSES.has(row.status)) {
      return row.status === "cancelled" ? "cancelled" : "lost";
    }
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
    providerIdempotencyKey: string | null;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptAdmission {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<EffectRow>(
        `SELECT effect_intent_id, request_hash, execution_plan_hash, execution_plan_json,
                provider_idempotency_key, status, checkpoint_index
           FROM tool_effects WHERE run_id = ? AND tool_call_id = ?`,
        input.fence.runId,
        input.toolCallId,
      ));

      // Exact replay of a completed receipt is a read, not a new execution or
      // mutation. A replacement object expires the dead instance's run lease
      // before it resumes that same attempt, so requiring the old lease here
      // would hide the durable result during the recovery window. Only the
      // exact immutable plan may bypass the live fence; rebinds, mismatches,
      // admitted reads, and every write still prove current ownership below.
      const existingPlanMatches = existing?.execution_plan_hash === input.executionPlanHash
        || input.compatiblePriorPlanHashes.includes(existing?.execution_plan_hash ?? "");
      if (existing?.status === "completed"
        && existing.request_hash === input.requestHash
        && existingPlanMatches) {
        return { state: "replay_completed", effectIntentId: existing.effect_intent_id };
      }

      const held = this.#fence(input.fence, input.now);
      if (held !== "held") {
        return { state: held === "cancelled" ? "cancelled" : "ownership_lost" };
      }

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

      const planMatches = existingPlanMatches;
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
        // An unsettled write the provider itself dedupes is not ambiguous: the
        // key it was admitted under is still the key it will be re-submitted
        // under, so the second call reaches the first call's operation. Only
        // `admitted` and `executing` qualify — the two states an interrupted
        // attempt leaves behind. A settled `failed` keeps the ambiguous
        // promotion below, because moving a terminal receipt back into
        // execution would rewrite a result a caller may already have read.
        if (
          planIdempotency(existing.execution_plan_json) === "provider_key"
          && input.providerIdempotencyKey !== null
          && existing.provider_idempotency_key === input.providerIdempotencyKey
          && (existing.status === "admitted" || existing.status === "executing")
        ) {
          return { state: "resume_write", effectIntentId: existing.effect_intent_id };
        }
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
    input: {
      mode: "read" | "write";
      executionPlanJson: string;
      requestHash: string;
      toolCallId: string;
      fence: ToolReceiptFence;
    },
  ): boolean {
    if (existing.status !== "completed") return false;
    // Both statements of the *incoming* call's mode, derived here rather than
    // taken as a boolean from the caller. The caller computed the same
    // conjunction and could not have disagreed with itself, but it was trust
    // this gate did not need: the object is handed both statements anyway, and
    // a widened rebind is the one failure here that is silent.
    if (input.mode !== "read" || planMode(input.executionPlanJson) !== "read") return false;
    if (existing.request_hash === input.requestHash) return false;
    if (planMode(existing.execution_plan_json) !== "read") return false;
    return !this.#hasDependents(existing.effect_intent_id, input.fence.runId, input.toolCallId);
  }

  /**
   * A child run or an attachment receipt built on this result.
   *
   * Deliberately unlike `attachmentDependencies`, which additionally joins on
   * `tool_effects.status = 'completed'`. That method answers "what may this
   * replay claim to have read", so an in-flight receipt has nothing to offer.
   * This one answers "may this result be taken away", and a dependency written
   * against a receipt that has since moved is exactly the case that must still
   * refuse — scoping it to completed receipts would let a rebind proceed while
   * something was mid-way through depending on the result it clears.
   */
  #hasDependents(effectIntentId: string, runId: string, toolCallId: string): boolean {
    return first(this.sql.exec<{ dependent: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS dependent
        WHERE EXISTS (
                SELECT 1 FROM runs
                 WHERE parent_run_id = ? AND parent_tool_call_id = ?
              )
           OR EXISTS (
                SELECT 1 FROM attachment_tool_receipts WHERE tool_invocation_id = ?
              )
           OR EXISTS (
                SELECT 1 FROM tool_pages WHERE producer_id = ? OR consumer_id = ?
              )
           OR EXISTS (
                SELECT 1 FROM tool_effect_checkpoints WHERE effect_intent_id = ? AND phase = ?
                  AND json_extract(member_safe_payload_json,'$.phase')='served'
              )`,
      runId,
      toolCallId,
      effectIntentId,
      effectIntentId,
      effectIntentId,
      effectIntentId,
      TOOL_ACCOUNT_CHECKPOINT,
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

  /** Ordered relevant tool history used to rebuild run-local safety state after eviction. */
  /**
   * The latest receipts of some capabilities across every run on this object.
   *
   * An automation's conversation drafts across turns: a plugin inspected in
   * one turn is still inspected when an elicitation pause ends and the next
   * turn resumes the draft. Replaying by run alone forgot that and refused
   * the rule until the model inspected again.
   */
  receiptsForCapabilities(input: { capabilities: readonly string[]; limit: number }): ToolReceiptRecord[] {
    if (input.capabilities.length === 0) return [];
    const placeholders = input.capabilities.map(() => "?").join(", ");
    return this.sql.exec<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM tool_effects
        WHERE json_extract(execution_plan_json, '$.capability') IN (${placeholders})
        ORDER BY COALESCE(settled_at, started_at, 0) DESC, tool_position DESC LIMIT ?`,
      ...input.capabilities,
      Math.max(1, Math.min(input.limit, 500)),
    ).toArray().map(receiptRecord).reverse();
  }

  receiptsForRun(input: { runId: string; capabilities: readonly string[] }): ToolReceiptRecord[] {
    if (input.capabilities.length === 0) return [];
    const placeholders = input.capabilities.map(() => "?").join(", ");
    return this.sql.exec<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM tool_effects
        WHERE run_id = ?
          AND json_extract(execution_plan_json, '$.capability') IN (${placeholders})
        ORDER BY tool_position`,
      input.runId,
      ...input.capabilities,
    ).toArray().map(receiptRecord);
  }

  canvaTransactionOwned(input: { runId: string; connectionId: string; transactionId: string; effectIntentId?: string }): boolean {
    return Boolean(first(this.sql.exec<{ effect_intent_id: string }>(
      `SELECT effect.effect_intent_id FROM tool_effects effect JOIN runs ON runs.run_id = effect.run_id
        WHERE effect.run_id = ? AND effect.connection_id = ? AND effect.provider_operation_id = ?
          AND effect.status = 'completed' AND runs.terminalized_at IS NULL
          AND json_extract(effect.execution_plan_json, '$.capability') = 'canva.personal.mcp'
          AND json_extract(effect.execution_plan_json, '$.canonicalToolName') = 'start-editing-transaction'
          AND NOT EXISTS (SELECT 1 FROM tool_effects closure
            WHERE closure.connection_id = effect.connection_id AND closure.status <> 'admitted'
              AND closure.effect_intent_id <> ?
              AND json_extract(closure.execution_plan_json, '$.capability') = 'canva.personal.mcp'
              AND json_extract(closure.execution_plan_json, '$.canonicalToolName') IN ('commit-editing-transaction', 'cancel-editing-transaction')
              AND json_extract(closure.input_json, '$.transaction_id') = effect.provider_operation_id)`,
      input.runId, input.connectionId, input.transactionId, input.effectIntentId ?? '',
    )));
  }

  /** Terminal-run cleanup derives from receipts, never model memory. */
  canvaCleanupForRun(input: { runId: string }): Array<{
    effectIntentId: string; connectionId: string; transactionId: string;
    state: "open" | "closed" | "uncertain";
  }> {
    const run = first(this.sql.exec<{ terminalized_at: number | null }>(
      "SELECT terminalized_at FROM runs WHERE run_id = ?", input.runId,
    ));
    if (!run || run.terminalized_at === null) return [];
    return this.receiptsForRun({ runId: input.runId, capabilities: ["canva.personal.mcp"] })
      .filter((receipt) => receipt.status === "completed" && receipt.providerOperationId && receipt.connectionId
        && parseObject(receipt.executionPlanJson, "canva_receipt_invalid").canonicalToolName === "start-editing-transaction")
      .map((receipt) => {
        const cleanup = first(this.sql.exec<{ phase: string }>(
          `SELECT phase FROM tool_effect_checkpoints WHERE effect_intent_id = ?
            AND phase IN ('canva_cleanup_started', 'canva_cleanup_cancelled', 'canva_cleanup_uncertain')
            ORDER BY checkpoint_index DESC LIMIT 1`, receipt.effectIntentId,
        ));
        // A commit in any run can have consumed this transaction. Any dispatched
        // commit without a completed receipt is uncertain, including failed calls.
        const closures = this.sql.exec<{ status: string; operation: string }>(
          `SELECT status, json_extract(execution_plan_json, '$.canonicalToolName') AS operation
             FROM tool_effects WHERE connection_id = ? AND status <> 'admitted'
               AND json_extract(execution_plan_json, '$.capability') = 'canva.personal.mcp'
               AND json_extract(execution_plan_json, '$.canonicalToolName') IN ('commit-editing-transaction', 'cancel-editing-transaction')
               AND json_extract(input_json, '$.transaction_id') = ?`,
          receipt.connectionId!, receipt.providerOperationId!,
        ).toArray();
        const state = cleanup?.phase === "canva_cleanup_cancelled" || closures.some((closure) => closure.status === "completed")
          ? "closed" as const
          : cleanup || closures.length ? "uncertain" as const : "open" as const;
        return { effectIntentId: receipt.effectIntentId, connectionId: receipt.connectionId!,
          transactionId: receipt.providerOperationId!, state };
      });
  }

  claimCanvaCleanup(input: { runId: string; effectIntentId: string }): { checkpointIndex: number } | null {
    return this.storage.transactionSync(() => {
      const candidate = this.canvaCleanupForRun(input).find((value) => value.effectIntentId === input.effectIntentId);
      if (candidate?.state !== "open") return null;
      const effect = this.#effect(input.effectIntentId);
      const run = first(this.sql.exec<{ legacy_attempt_id: string }>(
        "SELECT legacy_attempt_id FROM runs WHERE run_id = ?", input.runId,
      ));
      if (!effect || !run) return null;
      const index = this.#appendCheckpoint({ ...input, attemptId: run.legacy_attempt_id,
        index: effect.checkpoint_index + 1, phase: "canva_cleanup_started", payloadJson: "{}", now: Date.now() });
      if (index === null) return null;
      this.sql.exec("UPDATE tool_effects SET checkpoint_index = ? WHERE effect_intent_id = ?", index, input.effectIntentId);
      return { checkpointIndex: index };
    });
  }

  settleCanvaCleanup(input: { runId: string; effectIntentId: string; checkpointIndex: number; cancelled: boolean }): void {
    this.storage.transactionSync(() => {
      const claim = first(this.sql.exec<{ attempt_id: string }>(
        `SELECT attempt_id FROM tool_effect_checkpoints WHERE effect_intent_id = ? AND run_id = ?
          AND checkpoint_index = ? AND phase = 'canva_cleanup_started'`,
        input.effectIntentId, input.runId, input.checkpointIndex,
      ));
      const effect = this.#effect(input.effectIntentId);
      if (!claim || !effect || effect.checkpoint_index !== input.checkpointIndex) return;
      const index = this.#appendCheckpoint({ ...input, attemptId: claim.attempt_id,
        index: input.checkpointIndex + 1, phase: input.cancelled ? "canva_cleanup_cancelled" : "canva_cleanup_uncertain",
        payloadJson: "{}", now: Date.now() });
      if (index !== null) this.sql.exec("UPDATE tool_effects SET checkpoint_index = ? WHERE effect_intent_id = ?", index, input.effectIntentId);
    });
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
   * Close every receipt a run still has open, because the run is ending now.
   *
   * The stop and the reap both reach this after committing the terminal run.
   * That terminal-first ordering is required to avoid settling a receipt whose
   * run is still live or has been taken over. A later immutable lifecycle
   * marker acknowledges this object-local transaction; the bounded sweep
   * retries terminal rows that are missing it.
   *
   * A receipt that was *executing* a write is `ambiguous`, not `failed`: the
   * provider may already have performed it, and the run ending is not evidence
   * either way. Everything else — admitted but never started, or a read — takes
   * the caller's own outcome, because the caller knows whether this was a
   * member stopping the work or a lease that lapsed.
   */
  async settleResidualReceipts(input: {
    runId: string;
    attemptId: string;
    /** The phase and payload for a receipt that was not mid-write. */
    phase: string;
    errorJson: string;
    payloadJson: string;
    /** The message an ambiguous receipt carries, which differs by caller. */
    ambiguousMessage: string;
    /**
     * How the caller's claim on the lease is proved, which differs by caller.
     *
     * Both callers settle *after* their terminal write lands, and name the
     * instant it stamped. That ordering is forced: the run row and these
     * receipts are in the same object, but the caller reaches them through two
     * different paths and cannot hold one transaction across both. Of the two
     * orderings only this one fails safe — a settle that never runs leaves a
     * terminal run with open receipts. The caller records an immutable
     * acknowledgment only after this transaction succeeds; the next bounded
     * sweep retries any terminal row missing that marker. Settling first and
     * then failing to terminalize would instead close the receipts of a run
     * that is still live and may have just been taken over.
     */
    lease: { kind: "terminalized"; at: number };
    now: number;
  }): Promise<{ settled: number; open: number }> {
    const terminalized = first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS ok FROM runs WHERE run_id = ? AND terminalized_at = ?`,
      input.runId,
      input.lease.at,
    ));
    if (!terminalized) {
      return { settled: 0, open: this.#residualReceipts(input.runId).length };
    }
    const preparedParts = new Map((await Promise.all(this.#residualReceipts(input.runId).map(
      (receipt) => this.#prepareResidualToolPart({
        effectIntentId: receipt.effect_intent_id,
        toolCallId: receipt.tool_call_id,
        status: receipt.ambiguous === 1 ? "ambiguous" : "failed",
        errorJson: receipt.ambiguous === 1
          ? JSON.stringify({ code: "ambiguous_external_write", message: input.ambiguousMessage })
          : input.errorJson,
        settledAt: input.now,
      }),
    ))).map((prepared) => [prepared.effectIntentId, prepared]));
    return this.storage.transactionSync(() => {
      // The terminal stamp is the only remaining fence: the write that set it
      // also cleared `lease_owner` and `lease_expires_at`, so there is no live
      // lease left to name. Matching the exact instant ties this call to that
      // write rather than to some earlier terminalization.
      const owned = first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS ok FROM runs WHERE run_id = ? AND terminalized_at = ?`,
        input.runId,
        input.lease.at,
      ));
      if (!owned) return { settled: 0, open: this.#residualReceipts(input.runId).length };
      const residual = this.#residualReceipts(input.runId);
      let settled = 0;
      for (const receipt of residual) {
        const ambiguous = receipt.ambiguous === 1;
        const errorJson = ambiguous
          ? JSON.stringify({ code: "ambiguous_external_write", message: input.ambiguousMessage })
          : input.errorJson;
        const preparedPart = preparedParts.get(receipt.effect_intent_id);
        if (!preparedPart
          || preparedPart.status !== (ambiguous ? "ambiguous" : "failed")) throw new Error("residual_tool_part_source_moved");
        const index = this.#appendCheckpoint({
          effectIntentId: receipt.effect_intent_id,
          runId: input.runId,
          attemptId: input.attemptId,
          index: receipt.checkpoint_index + 1,
          phase: ambiguous ? "ambiguous_external_write" : input.phase,
          payloadJson: ambiguous ? '{"code":"ambiguous_external_write"}' : input.payloadJson,
          now: input.now,
        });
        // Null means the index was already taken — an older partially admitted
        // settlement left a checkpoint there. Advancing past it rather than
        // conflicting on it is what keeps a stop from wedging on its own debris.
        const settledIndex = index ?? this.#appendCheckpoint({
          effectIntentId: receipt.effect_intent_id,
          runId: input.runId,
          attemptId: input.attemptId,
          index: this.#highestCheckpointIndex(receipt.effect_intent_id) + 1,
          phase: ambiguous ? "ambiguous_external_write" : input.phase,
          payloadJson: ambiguous ? '{"code":"ambiguous_external_write"}' : input.payloadJson,
          now: input.now,
        });
        if (settledIndex === null) continue;
        this.sql.exec(
          `UPDATE tool_effects
              SET status = ?, settled_at = ?, error_json = ?, checkpoint_index = ?
            WHERE effect_intent_id = ?`,
          ambiguous ? "ambiguous" : "failed",
          input.now,
          errorJson,
          settledIndex,
          receipt.effect_intent_id,
        );
        if (preparedPart.lifecycle) {
          new WorkstreamTranscriptStorage(this.storage)
            .upsertPreparedToolLifecycle(preparedPart.lifecycle);
        }
        settled += 1;
      }
      // `open` is what the caller's terminal event is fenced on. It is normally
      // zero, and is not only when a receipt could not take a checkpoint index
      // at all — in which case the run must not terminalize claiming its tools
      // are finished.
      return { settled, open: this.#residualReceipts(input.runId).length };
    });
  }

  async #prepareResidualToolPart(input: {
    effectIntentId: string;
    toolCallId: string;
    status: "failed" | "ambiguous";
    errorJson: string;
    settledAt: number;
  }): Promise<PreparedResidualToolPart> {
    try {
      const parsedError = parseObject(input.errorJson, "residual_tool_error_invalid");
      const lifecycle = await new WorkstreamTranscriptStorage(this.storage).prepareToolLifecycle({
        toolCallId: input.toolCallId,
        status: input.status,
        error: typeof parsedError.message === "string" ? parsedError.message : input.status,
        occurredAtUtc: new Date(input.settledAt).toISOString(),
      });
      return {
        effectIntentId: input.effectIntentId,
        status: input.status,
        lifecycle,
      };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "participant_tool_plan_missing") throw error;
      return {
        effectIntentId: input.effectIntentId,
        status: input.status,
        lifecycle: null,
      };
    }
  }

  /** Receipts still open on a run, and whether each was mid-write. */
  #residualReceipts(runId: string): Array<{
    effect_intent_id: string; tool_call_id: string; ambiguous: number; checkpoint_index: number;
  } & Record<string, SqlStorageValue>> {
    return this.sql.exec<{
      effect_intent_id: string; tool_call_id: string; ambiguous: number; checkpoint_index: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT effect_intent_id, tool_call_id, checkpoint_index,
              CASE WHEN status = 'executing'
                     AND COALESCE(json_extract(execution_plan_json, '$.mode'), '') != 'read'
                   THEN 1 ELSE 0 END AS ambiguous
         FROM tool_effects
        WHERE run_id = ? AND status IN ('admitted', 'executing')`,
      runId,
    ).toArray();
  }

  #highestCheckpointIndex(effectIntentId: string): number {
    return first(this.sql.exec<{ index: number | null } & Record<string, SqlStorageValue>>(
      `SELECT MAX(checkpoint_index) AS "index" FROM tool_effect_checkpoints
        WHERE effect_intent_id = ?`,
      effectIntentId,
    ))?.index ?? 0;
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
    /** Optional, and absent means the ordinary cancellation fence applies. */
    allowCancellationRequested?: boolean;
    /**
     * The reply thread this send opened, bound to the run that sent it. It is
     * committed with the completion or not at all: a send whose receipt never
     * completed has no binding. See docs/external-conversation-bindings.md.
     */
    externalBinding?: OutboundExternalBinding;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    const summary = input.outputSummary.slice(0, 4_000);
    const externalBinding = input.externalBinding
      ? OutboundExternalBindingSchema.parse(input.externalBinding)
      : null;
    return this.storage.transactionSync(() => {
      const held = this.#fence(input.fence, input.now, input.allowCancellationRequested === true);
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
      if (moved) {
        if (externalBinding) {
          enqueueExternalBindingInTransaction(this.sql, {
            ...externalBinding,
            at: new Date(input.now).toISOString(),
          }, input.now);
        }
        return "persisted";
      }
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
    /** Optional, and absent means the ordinary cancellation fence applies. */
    allowCancellationRequested?: boolean;
    fence: ToolReceiptFence;
    now: number;
  }): ToolReceiptSettlement {
    return this.storage.transactionSync(() => {
      const held = this.#fence(input.fence, input.now, input.allowCancellationRequested === true);
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

  /** Restore checked-in development receipts through typed object authority. */
  seedDevelopmentReceipt(input: {
    effectIntentId: string;
    runId: string;
    toolPosition: number;
    toolCallId: string;
    toolName: string;
    mode: "read" | "write";
    requestHash: string;
    status: ToolReceiptStatus;
    connectionId: string | null;
    inputJson: string;
    outputSummary: string | null;
    executionPlanJson: string | null;
    startedAt: number | null;
    settledAt: number | null;
  }): { outcome: "inserted" | "exists" } {
    if (this.#effect(input.effectIntentId)) return { outcome: "exists" as const };
    this.sql.exec(
      `INSERT INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
          tool_name, mode, request_hash, authority_revision, status, tool_call_id,
          connection_id, input_json, output_summary, execution_plan_json,
          started_at, settled_at)
       VALUES (?, ?, 0, ?, ?, ?, ?, ?, 'development_fixture', ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.effectIntentId,
      input.runId,
      input.toolPosition,
      `development_fixture:${input.effectIntentId}`,
      input.toolName,
      input.mode,
      input.requestHash,
      input.status,
      input.toolCallId,
      input.connectionId,
      input.inputJson,
      input.outputSummary,
      input.executionPlanJson,
      input.startedAt,
      input.settledAt,
    );
    return { outcome: "inserted" as const };
  }
}
