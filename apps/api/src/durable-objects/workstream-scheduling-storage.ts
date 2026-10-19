import { z } from "zod";

import { MemoryDigestFactSchema, type MemoryDigestFact } from "./workspace-memory-facts-protocol";
import { WorkstreamMessageStorage } from "./workstream-message-storage";
import type { PreparedConversationTurn } from "./workstream-transcript-storage";

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

export interface ElicitationRow extends Record<string, SqlStorageValue> {
  elicitation_id: string;
  run_id: string;
  tool_call_id: string;
  prompt: string;
  response_type: string;
  options_json: string;
  minimum_selections: number;
  maximum_selections: number | null;
  target_user_id: string | null;
  status: string;
  answer_json: string | null;
  answered_by_user_id: string | null;
  external_actor_json: string | null;
  created_at: number;
  answered_at: number | null;
}

export interface OpenElicitationInput {
  elicitationId: string;
  runId: string;
  toolCallId: string;
  prompt: string;
  responseType: string;
  optionsJson: string;
  minimumSelections: number;
  maximumSelections: number | null;
  targetUserId: string | null;
  messageId: string;
  structuredContentJson: string;
  now: number;
}

export interface AnswerElicitationExternallyInput {
  elicitationId: string;
  answerJson: string;
  externalActorJson: string;
  messageId: string;
  clientMessageId: string;
  structuredContentJson: string;
  now: number;
}

export interface DescriptionRefreshRow extends Record<string, SqlStorageValue> {
  rest_until: number;
  consecutive_keeps: number;
  evaluated_through_sequence: number;
}

/** The memory sweep's cursor and cadence for this conversation (`docs/agent-memory.md#the-sweep`). */
export interface MemorySweepStateRow extends Record<string, SqlStorageValue> {
  swept_through_seq: number;
  rest_until: number;
  consecutive_quiet: number;
  claim_from_seq: number | null;
  claim_to_seq: number | null;
  claim_attempt: number;
  claim_at: number | null;
  retry_at: number | null;
  version: number;
}

const MemoryDigestFactListSchema = z.array(MemoryDigestFactSchema);

function first<T>(cursor: SqlStorageCursor<T extends Record<string, SqlStorageValue> ? T : never>) {
  return cursor.toArray()[0];
}

/**
 * The rest a conversation has earned after a sweep: the floor, doubling once
 * per consecutive quiet sweep, up to the ceiling. The numbers are the lane's
 * (`memory-sweep-service.ts`); the arithmetic is here so the settle that
 * applies it needs nothing but numbers.
 */
export function memorySweepRestUntil(now: number, quiet: number, floorMs: number, ceilingMs: number): number {
  return now + Math.min(ceilingMs, floorMs * 2 ** Math.max(0, quiet));
}

export class WorkstreamSchedulingStorage {
  /**
   * The transcript authority, over this same object storage.
   *
   * Composed for the reason `WorkstreamHarnessRunStorage` composes it: asking a
   * question and answering one each write a canonical conversation turn in
   * the same transaction as the elicitation row this class owns. Each fact has
   * exactly one writer.
   * Both wrap the same `DurableObjectStorage`, so the nested `transactionSync`
   * is the same transaction rather than a second one.
   */
  private readonly messages: WorkstreamMessageStorage;

  constructor(private readonly storage: DurableObjectStorage) {
    this.messages = new WorkstreamMessageStorage(storage);
  }

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

  /**
   * The pending wake-ups, soonest first.
   *
   * The tiebreak matters because two other readers order the same rows:
   * `syncAgentTimerAlarms` and the sidebar's next-wake-up marker both use
   * `due_at, wakeup_id`. Two wake-ups due at the same instant would otherwise
   * lead this list and that marker differently.
   */
  pendingWakeups(input: { limit: number }): WakeupRow[] {
    return this.sql.exec<WakeupRow>(
      `SELECT wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
              status, idempotency_key, version, created_at
         FROM workstream_wakeups
        WHERE status = 'pending'
        ORDER BY due_at ASC, wakeup_id ASC
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

  // --------------------------------------------------------- elicitations

  /**
   * The question a person has been waiting on longest, if there is one.
   *
   * One operation for four routed reads. They differed only in which columns
   * they asked for — Slack's delivery wanted the prompt and the target, its
   * answer path wanted the response type and options, the workspace path
   * wanted all of it — and every one of them was the same
   * `status = 'open' ORDER BY created_at ASC LIMIT 1`. A caller takes what it
   * needs from the row rather than restating the query to narrow it.
   *
   * `pending`, not `open`: the retired view renamed the status in both
   * directions, and `pending` is what the object stores.
   */
  oldestOpenElicitation(): ElicitationRow | undefined {
    return first(this.sql.exec<ElicitationRow>(
      `SELECT elicitation_id, run_id, tool_call_id, prompt, response_type, options_json,
              minimum_selections, maximum_selections, target_user_id, status,
              answer_json, answered_by_user_id, external_actor_json, created_at, answered_at
         FROM elicitation_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1`,
    ));
  }

  /** How many questions this work stream is still waiting on. */
  openElicitationCount(): number {
    return this.sql.exec<{ open: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS open FROM elicitation_requests WHERE status = 'pending'`,
    ).one().open;
  }

  /**
   * Whether a run already asked this exact question.
   *
   * The replay check in front of the elicitation tool: the id is derived from
   * the provider idempotency key, so a retried receipt names the row its first
   * attempt wrote. Scoped to the run as well as the id, because a question
   * belongs to the run that asked it.
   */
  elicitationExistsForRun(input: { elicitationId: string; runId: string }): boolean {
    return first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS ok FROM elicitation_requests WHERE elicitation_id = ? AND run_id = ?`,
      input.elicitationId,
      input.runId,
    )) !== undefined;
  }

  /**
   * Ask a person a question, and put it in the transcript.
   *
   * The routed batch was three statements, and each of the last two existed to
   * work around the first two being separate. The transcript insert was an
   * `INSERT … SELECT … FROM workstreams` so it could read
   * `next_sequence_number` off the root in the same statement that consumed it,
   * with an `EXISTS` on the request row standing in for "the statement before
   * me succeeded"; the counter update then re-stated that fence twice more,
   * comparing `next_sequence_number` against the sequence the part had just
   * taken. A batch cannot see its own earlier statements' rows, so every one of
   * those clauses was asking the database a question the caller already knew
   * the answer to. Here the three are one transaction and none of it is needed.
   *
   * `needs_input` is stamped last and only on a move, which is what the retired
   * `_runtime_workstreams` update trigger did with `harness_status`: it left
   * `state_reason_code` and `state_changed_at` alone when the status it was
   * given matched the one already there.
   *
   * The part is `appendMessage`'s. It carries no run even though a run asked
   * the question — the routed insert never named `harness_run_id`, so NULL is
   * what every stored elicitation part has, and giving them their run is a
   * change that belongs to whoever needs it.
   */
  async prepareOpenElicitationMessage(
    input: OpenElicitationInput,
  ): Promise<PreparedConversationTurn> {
    return this.messages.prepareMessage({
      messageId: input.messageId,
      clientMessageId: `elicitation:${input.elicitationId}`,
      authorType: "agent",
      authorUserId: null,
      externalActorJson: null,
      messageType: "elicitation",
      text: "",
      structuredContentJson: input.structuredContentJson,
      producedByRunId: null,
      now: input.now,
    });
  }

  async openElicitation(
    input: OpenElicitationInput,
  ): Promise<{ outcome: "opened" | "exists"; sequenceNumber: number | null }> {
    const prepared = await this.prepareOpenElicitationMessage(input);
    return this.storage.transactionSync(() => this.openPreparedElicitation(input, prepared));
  }

  openPreparedElicitation(
    input: OpenElicitationInput,
    prepared: PreparedConversationTurn,
  ): { outcome: "opened" | "exists"; sequenceNumber: number | null } {
      const replay = first(this.sql.exec<{
        run_id: string; tool_call_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT run_id, tool_call_id FROM elicitation_requests WHERE elicitation_id = ?`,
        input.elicitationId,
      ));
      if (replay) {
        if (replay.run_id !== input.runId || replay.tool_call_id !== input.toolCallId) {
          throw new Error("elicitation_replay_identity_mismatch");
        }
        return { outcome: "exists" as const, sequenceNumber: null };
      }
      this.sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, tool_call_id, prompt, response_type, options_json, minimum_selections,
            maximum_selections, target_user_id, status, answer_json, answered_by_user_id,
            external_actor_json, created_at, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)`,
        input.elicitationId,
        input.runId,
        input.toolCallId,
        input.prompt,
        input.responseType,
        input.optionsJson,
        input.minimumSelections,
        input.maximumSelections,
        input.targetUserId,
        input.now,
      );
      const appended = this.messages.appendPreparedMessage(prepared);
      this.sql.exec(
        `UPDATE workstream
            SET exact_state = 'needs_input',
                state_reason_code = CASE WHEN exact_state = 'needs_input'
                  THEN state_reason_code ELSE 'runtime_needs_input' END,
                state_changed_at = CASE WHEN exact_state = 'needs_input'
                  THEN state_changed_at ELSE ?1 END,
                updated_at = ?1
          WHERE id = 1`,
        input.now,
      );
      return { outcome: "opened" as const, sequenceNumber: appended.sequenceNumber };
  }

  /**
   * Answer the question on behalf of someone Avalon has no account for.
   *
   * The external half of the elicitation answer; the member half is
   * `WorkstreamObjectProduct.answerElicitation`, which also admits the run that
   * resumes the work stream. This one does not, because its caller decides
   * separately — a Slack answer only launches a run once no question is left
   * open, and that count is read after this returns.
   *
   * `already_answered` rather than a throw: the routed batch expressed the race
   * as `WHERE … status = 'open'` and read `meta.changes` to find out whether it
   * had won, and losing it is an ordinary outcome — somebody else answered
   * first. The caller still turns it into a 409.
   *
   * The transcript part does not move the work stream out of `needs_input`. The
   * routed counter update never named `harness_status`, and the state belongs
   * to whether any question is still open rather than to this one having been
   * answered.
   */
  async prepareExternalElicitationAnswerMessage(
    input: AnswerElicitationExternallyInput,
  ): Promise<PreparedConversationTurn> {
    return this.messages.prepareMessage({
      messageId: input.messageId,
      clientMessageId: input.clientMessageId,
      authorType: "external",
      authorUserId: null,
      externalActorJson: input.externalActorJson,
      messageType: "elicitation",
      text: "",
      structuredContentJson: input.structuredContentJson,
      producedByRunId: null,
      now: input.now,
    });
  }

  async answerElicitationExternally(
    input: AnswerElicitationExternallyInput,
  ): Promise<{ outcome: "answered" | "already_answered"; sequenceNumber: number | null }> {
    const prepared = await this.prepareExternalElicitationAnswerMessage(input);
    return this.storage.transactionSync(
      () => this.answerPreparedElicitationExternally(input, prepared),
    );
  }

  answerPreparedElicitationExternally(
    input: AnswerElicitationExternallyInput,
    prepared: PreparedConversationTurn,
  ): { outcome: "answered" | "already_answered"; sequenceNumber: number | null } {
      const pending = first(this.sql.exec<{ ok: number } & Record<string, SqlStorageValue>>(
        `SELECT 1 AS ok FROM elicitation_requests
          WHERE elicitation_id = ? AND status = 'pending'`,
        input.elicitationId,
      )) !== undefined;
      if (!pending) return { outcome: "already_answered" as const, sequenceNumber: null };
      this.sql.exec(
        `UPDATE elicitation_requests
            SET status = 'answered', answer_json = ?, answered_by_user_id = NULL,
                external_actor_json = ?, answered_at = ?
          WHERE elicitation_id = ?`,
        input.answerJson,
        input.externalActorJson,
        input.now,
        input.elicitationId,
      );
      const appended = this.messages.appendPreparedMessage(prepared);
      return { outcome: "answered" as const, sequenceNumber: appended.sequenceNumber };
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

  // ------------------------------------------------- description refresh

  /**
   * The refresh cadence's standing state, or nothing before the first one.
   *
   * Read as the cheapest of the gates that decide whether a terminal run pays
   * for an evaluation at all: a work stream that has not rested is not looked
   * at, whatever happened in it.
   */
  descriptionRefreshState(): DescriptionRefreshRow | undefined {
    return first(this.sql.exec<DescriptionRefreshRow>(
      `SELECT rest_until, consecutive_keeps, evaluated_through_sequence
         FROM description_refresh_state WHERE id = 1`,
    ));
  }

  /**
   * Claim the right to evaluate this work stream's description.
   *
   * The floor that stops two runs terminalizing together from both spending an
   * inference call, and the reason a failing model is not retried by every run
   * behind it. Claiming writes the floor immediately; the outcome below
   * replaces it with whatever the decision earned.
   *
   * The routed version was an upsert whose `WHERE rest_until <= ?3` decided
   * whether the claim landed, read back through `meta.changes`, and then had to
   * re-select the row to learn the version it had just written. One
   * transaction answers both.
   *
   * `consecutive_keeps` is deliberately carried rather than reset. The routed
   * statement achieved that by omitting the column so the trigger saw NULL and
   * preserved the standing value — a contract that was lost once and restored
   * by an object-schema migration. Here it is simply not written.
   *
   * The five decision columns go the other way and are cleared, which is not
   * the same kind of omission. The retired trigger's conflict arm set them from
   * `excluded.*`, and the routed claim left them out of its column list, so
   * `excluded.*` was NULL and a claim wiped the previous evaluation's output.
   * Carrying them instead would leave `decision = 'pending'` beside the
   * description and reasoning of a *different*, already-closed evaluation — a
   * row shape production has never produced, and one that reads as current.
   * The insert arm a few lines up writes NULL for exactly these five, so
   * clearing here is also what makes a claim leave the same row either way.
   */
  claimDescriptionEvaluation(input: {
    evaluatedAt: number;
    restUntil: number;
    evaluatedThroughSequence: number;
    windowMessageCount: number;
  }): { version: number; consecutiveKeeps: number } | null {
    return this.storage.transactionSync(() => {
      const existing = first(this.sql.exec<{
        rest_until: number; consecutive_keeps: number; version: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT rest_until, consecutive_keeps, version FROM description_refresh_state WHERE id = 1`,
      ));
      if (!existing) {
        this.sql.exec(
          `INSERT INTO description_refresh_state
             (id, evaluated_at, rest_until, consecutive_keeps, evaluated_through_sequence,
              window_message_count, decision, rejection_code, confidence, model,
              previous_description, description, reasoning, version, created_at, updated_at)
           VALUES (1, ?, ?, 0, ?, ?, 'pending', NULL, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)`,
          input.evaluatedAt,
          input.restUntil,
          input.evaluatedThroughSequence,
          input.windowMessageCount,
          input.evaluatedAt,
          input.evaluatedAt,
        );
        return { version: 1, consecutiveKeeps: 0 };
      }
      if (existing.rest_until > input.evaluatedAt) return null;
      this.sql.exec(
        `UPDATE description_refresh_state
            SET evaluated_at = ?, rest_until = ?, evaluated_through_sequence = ?,
                window_message_count = ?, decision = 'pending', rejection_code = NULL,
                confidence = NULL, model = NULL, previous_description = NULL,
                description = NULL, reasoning = NULL,
                version = version + 1, updated_at = ?
          WHERE id = 1`,
        input.evaluatedAt,
        input.restUntil,
        input.evaluatedThroughSequence,
        input.windowMessageCount,
        input.evaluatedAt,
      );
      return { version: existing.version + 1, consecutiveKeeps: existing.consecutive_keeps };
    });
  }

  /**
   * Close a claim with what it decided, and the rest that decision earned.
   *
   * Guarded on the claim's own version, so a slow evaluation cannot overwrite
   * the result — or the rest — of the one that superseded it. `false` means the
   * row moved on, which the caller reports rather than retries: the decision is
   * still worth knowing, and the write that replaced it owns the row.
   */
  recordDescriptionOutcome(input: {
    expectedVersion: number;
    decision: string;
    rejectionCode: string | null;
    confidence: number | null;
    model: string;
    previousDescription: string;
    description: string | null;
    reasoning: string;
    windowMessageCount: number;
    consecutiveKeeps: number;
    restUntil: number;
    now: number;
  }): boolean {
    return this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE description_refresh_state
            SET decision = ?, rejection_code = ?, confidence = ?, model = ?,
                previous_description = ?, description = ?, reasoning = ?,
                window_message_count = ?, consecutive_keeps = ?, rest_until = ?, updated_at = ?
          WHERE id = 1 AND version = ?`,
        input.decision,
        input.rejectionCode,
        input.confidence,
        input.model,
        input.previousDescription,
        input.description,
        input.reasoning,
        input.windowMessageCount,
        input.consecutiveKeeps,
        input.restUntil,
        input.now,
        input.expectedVersion,
      );
      return this.#changed() > 0;
    });
  }

  // ------------------------------------------------------- memory sweep

  /**
   * The sweep's standing state, or nothing before the first claim. Read first
   * because it is the cheapest of the gates: a conversation that has not
   * rested is not looked at, whatever was said in it.
   */
  memorySweepState(): MemorySweepStateRow | undefined {
    return first(this.sql.exec<MemorySweepStateRow>(
      `SELECT swept_through_seq, rest_until, consecutive_quiet, claim_from_seq, claim_to_seq,
              claim_attempt, claim_at, retry_at, version
         FROM memory_sweep_state WHERE id = 1`,
    ));
  }

  /**
   * Claim one sweep of `fromSeq..toSeq`, pushing the rest forward before any
   * model call is made (the description loop's claim), so two runs settling
   * together spend one sweep and a failing model is not retried by every run
   * behind it. `null` when the conversation is resting or another claim is
   * in flight within `claimTimeoutMs`, both re-checked inside the write.
   *
   * The claim leaves `retry_at` at its rest: a delivery lost together with its
   * release would otherwise hold the lane until an unrelated run settled, since
   * the alarm reads nothing but `retry_at`. At the rest the claim has timed out
   * and the attempt claims again; a settle or release moves `retry_at` first.
   */
  claimMemorySweep(input: {
    now: number;
    fromSeq: number;
    toSeq: number;
    restUntil: number;
    claimTimeoutMs: number;
  }): { attempt: number } | null {
    return this.storage.transactionSync(() => {
      const existing = this.memorySweepState();
      if (!existing) {
        this.sql.exec(
          `INSERT INTO memory_sweep_state
             (id, swept_through_seq, rest_until, consecutive_quiet, claim_from_seq, claim_to_seq,
              claim_attempt, claim_at, retry_at, version, created_at, updated_at)
           VALUES (1, 0, ?, 0, ?, ?, 1, ?, ?, 1, ?, ?)`,
          input.restUntil, input.fromSeq, input.toSeq, input.now, input.restUntil, input.now, input.now,
        );
        return { attempt: 1 };
      }
      if (existing.rest_until > input.now) return null;
      if (existing.swept_through_seq !== input.fromSeq) return null;
      const inFlight = existing.claim_at !== null && existing.claim_to_seq !== null
        && existing.claim_at + input.claimTimeoutMs > input.now;
      if (inFlight) return null;
      const attempt = existing.claim_attempt + 1;
      this.sql.exec(
        `UPDATE memory_sweep_state
            SET rest_until = ?, claim_from_seq = ?, claim_to_seq = ?, claim_attempt = ?, claim_at = ?,
                retry_at = ?, version = version + 1, updated_at = ?
          WHERE id = 1`,
        input.restUntil, input.fromSeq, input.toSeq, attempt, input.now, input.restUntil, input.now,
      );
      return { attempt };
    });
  }

  /**
   * Move the cursor to what the store applied, and set the rest that outcome
   * earned: a sweep that wrote returns to the floor, a quiet one doubles it.
   * The rest is computed here from numbers, because this is called over the
   * scheduling port from the Queue consumer and a closure does not cross it.
   *
   * Compare-and-swap on the claimed `fromSeq`: a settle whose `fromSeq` is not
   * the cursor is refused, and settling to a `toSeq` the cursor already holds
   * is a no-op, so a redelivery after a committed apply finishes cleanly.
   *
   * `retry_at` goes to the new rest when the transcript already holds more
   * than the settled range: a run that settled while this sweep was in flight
   * found the conversation resting and asked the alarm back, and clearing that
   * here would leave its messages unswept until something else happened.
   */
  settleMemorySweep(input: {
    fromSeq: number;
    toSeq: number;
    /** The delivery's claim, for the record; the fence is `fromSeq`, and a range skipped without a claim passes 0. */
    attempt: number;
    wrote: boolean;
    restFloorMs: number;
    restCeilingMs: number;
    now: number;
  }): "settled" | "already_settled" | "refused" {
    return this.storage.transactionSync(() => {
      const existing = this.memorySweepState();
      if (!existing) return "refused";
      if (existing.swept_through_seq === input.toSeq && existing.claim_at === null) return "already_settled";
      if (existing.swept_through_seq !== input.fromSeq) return "refused";
      const quiet = input.wrote ? 0 : existing.consecutive_quiet + 1;
      const restUntil = memorySweepRestUntil(input.now, quiet, input.restFloorMs, input.restCeilingMs);
      const retryAt = this.messages.hasMessageAfter({ afterSequence: input.toSeq }) ? restUntil : null;
      this.sql.exec(
        `UPDATE memory_sweep_state
            SET swept_through_seq = ?, consecutive_quiet = ?, rest_until = ?, claim_from_seq = NULL,
                claim_to_seq = NULL, claim_at = NULL, retry_at = ?, version = version + 1, updated_at = ?
          WHERE id = 1`,
        input.toSeq, quiet, restUntil, retryAt, input.now,
      );
      return "settled";
    });
  }

  /**
   * Let a sweep the consumer could not finish stop holding the next one back.
   * Only the latest claim releases, and the rest set at claim time still
   * decides when the alarm tries again.
   */
  releaseMemorySweep(input: { attempt: number; now: number }): boolean {
    return this.storage.transactionSync(() => first(this.sql.exec<{ id: number } & Record<string, SqlStorageValue>>(
      `UPDATE memory_sweep_state
          SET claim_from_seq = NULL, claim_to_seq = NULL, claim_at = NULL, retry_at = rest_until,
              version = version + 1, updated_at = ?
        WHERE id = 1 AND claim_attempt = ? AND claim_at IS NOT NULL
        RETURNING id`,
      input.now, input.attempt,
    )) !== undefined);
  }

  /**
   * Ask the alarm to try again at `retryAt` (a resting conversation with
   * messages after the cursor), or at nothing. The alarm lane reads this and
   * nothing else, so every attempt has to move it.
   */
  deferMemorySweep(input: { retryAt: number | null; now: number }): void {
    this.sql.exec(
      `INSERT INTO memory_sweep_state
         (id, swept_through_seq, rest_until, consecutive_quiet, claim_from_seq, claim_to_seq,
          claim_attempt, claim_at, retry_at, version, created_at, updated_at)
       VALUES (1, 0, 0, 0, NULL, NULL, 0, NULL, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET retry_at = excluded.retry_at, updated_at = excluded.updated_at`,
      input.retryAt, input.now, input.now,
    );
  }

  // ------------------------------------------------------ memory digest

  /**
   * One principal's digest copy (`user:<id>`, `sidekick:<automationId>` or
   * `conversation`), or `null` when none was written yet. Validated here
   * because the run renders from it with nothing else in between.
   * `docs/agent-memory.md#the-digest`.
   */
  memoryDigestCopy(principal: string): MemoryDigestFact[] | null {
    const row = first(this.sql.exec<{ facts_json: string } & Record<string, SqlStorageValue>>(
      `SELECT facts_json FROM memory_digest_copies WHERE principal = ?`, principal,
    ));
    return row ? MemoryDigestFactListSchema.parse(JSON.parse(row.facts_json)) : null;
  }

  /**
   * Replace one principal's copy with a read at least as new. Two refreshes
   * can overlap and resume in either order; `sourceRevision` is the
   * WorkspaceDO's `memory_revision` at the read, so an older answer arriving
   * late never replaces a newer copy. An equal revision writes: two reads
   * with nothing written or marked between them answer alike, and a change
   * no trigger marks still reaches the copy at its next refresh. `true` when
   * the row was written.
   */
  storeMemoryDigestCopy(input: { principal: string; facts: MemoryDigestFact[]; sourceRevision: number; now: number }): boolean {
    return this.sql.exec<{ principal: string } & Record<string, SqlStorageValue>>(
      `INSERT INTO memory_digest_copies (principal, facts_json, source_revision, refreshed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (principal) DO UPDATE SET facts_json = excluded.facts_json,
         source_revision = excluded.source_revision, refreshed_at = excluded.refreshed_at
       WHERE excluded.source_revision >= memory_digest_copies.source_revision
       RETURNING principal`,
      input.principal, JSON.stringify(input.facts), input.sourceRevision, input.now,
    ).toArray().length > 0;
  }

  /** Every principal holding a copy here, so a refresh after a sweep can reach each one. */
  memoryDigestPrincipals(): string[] {
    return this.sql.exec<{ principal: string } & Record<string, SqlStorageValue>>(
      `SELECT principal FROM memory_digest_copies ORDER BY principal`,
    ).toArray().map((row) => row.principal);
  }

  /**
   * Drop one forgotten fact from every copy here, in the same call as the
   * forget that retracted it, so the next run in this conversation does not
   * render it again before the copy-sync lane catches up. `revision` is the
   * retraction's: every copy's `source_revision` is raised to at least it, so
   * a refresh that read before the forget and lands after it is refused in
   * every copy here. Answers the number of copies that held the fact.
   */
  removeFactFromMemoryDigestCopies(input: { factId: string; revision: number; now: number }): number {
    return this.storage.transactionSync(() => {
      const rows = this.sql.exec<{ principal: string; facts_json: string } & Record<string, SqlStorageValue>>(
        `SELECT principal, facts_json FROM memory_digest_copies`,
      ).toArray();
      let removed = 0;
      for (const row of rows) {
        const facts = MemoryDigestFactListSchema.parse(JSON.parse(row.facts_json));
        const kept = facts.filter((fact) => fact.factId !== input.factId);
        if (kept.length === facts.length) continue;
        this.sql.exec(
          `UPDATE memory_digest_copies SET facts_json = ?, refreshed_at = ? WHERE principal = ?`,
          JSON.stringify(kept), input.now, row.principal,
        );
        removed += 1;
      }
      this.sql.exec(
        `UPDATE memory_digest_copies SET source_revision = ? WHERE source_revision < ?`,
        input.revision, input.revision,
      );
      return removed;
    });
  }

  /** Rows written by the statement that just ran, in this transaction. */
  #changed(): number {
    return this.sql.exec<{ changes: number } & Record<string, SqlStorageValue>>(
      `SELECT changes() AS changes`,
    ).one().changes;
  }

  /** Whether this work stream has been archived, from its own identity row. */
  #archived(): boolean {
    return first(this.sql.exec<{ archived: number } & Record<string, SqlStorageValue>>(
      `SELECT 1 AS archived FROM workstream WHERE id = 1 AND archived_at IS NOT NULL`,
    )) !== undefined;
  }
}
