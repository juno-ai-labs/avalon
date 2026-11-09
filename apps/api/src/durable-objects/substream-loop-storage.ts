/** Durable singleton execution-loop authority owned by one AgentLoopDO. */

import { enqueueSemanticRealtimeReference } from "./workstream-semantic-realtime-outbox";

/**
 * How long this object waits before treating work an invocation claimed as
 * abandoned: the singleton execution lease, the harness attempt lease, and the
 * in-memory claim a message admission holds over its mailbox row all use it.
 *
 * They share it because they share the failure: a Workers invocation the
 * runtime cancels neither throws nor runs a `finally`, so nothing announces
 * that the claim's owner is gone and only elapsed time can. Five minutes is
 * comfortably longer than any of the three legitimately takes — an admission
 * reserving several attachments is the slowest, and it is seconds — so
 * recovery cannot race work that is merely slow, and every takeover it does
 * start is idempotent against the durable row it re-enters.
 */
export const LOOP_EXECUTION_LEASE_MS = 5 * 60_000;

export type LoopInputMode = "steer" | "queue";
export type PendingInputPreparationKind =
  | "human_message"
  | "human_elicitation"
  | "external_message"
  | "external_elicitation"
  | "automation_activation";
export type PendingInputPreparationState =
  | "preparing"
  | "ready"
  | "failed"
  | "discarded";
export type LoopStatus = "idle" | "executing";
export type AssistantTurnReservationState = "reserved" | "streaming" | "materialized";
export type AssistantTurnOutcome = "accepted" | "error";

export interface SubstreamLoopRow extends Record<string, SqlStorageValue> {
  id: number;
  loop_id: string;
  revision: number;
  status: LoopStatus;
  cycle_ordinal: number;
  step_ordinal: number;
  bind_state_revision: number;
  active_execution_id: string | null;
  active_execution_epoch: number | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  stop_requested_at: number | null;
  stop_after_step_ordinal: number | null;
  stop_reason: string | null;
  next_input_sequence: number;
  next_assistant_turn_sequence: number;
  next_execution_sequence: number;
  /**
   * The highest transcript sequence the model's conversation has considered.
   *
   * Not the transcript's high-water mark, and not the last admitted input:
   * every conversation turn at or below it is either in the projection or was
   * deliberately left out of it, and every one above it has not been looked at.
   * Advanced when an admission is appended, to the high-water the gap-fill
   * scanned before it — never to the admitted turn's own sequence, which is
   * allocated after the scan. An elicitation answer advances it not at all.
   */
  transcript_projected_through: number;
  created_at: number;
  updated_at: number;
}

export interface PendingLoopInputRow extends Record<string, SqlStorageValue> {
  input_id: string;
  loop_id: string;
  input_sequence: number;
  prepared_turn_id: string;
  admitted_after_transcript_sequence: number;
  mode: LoopInputMode;
  actor: "human" | "external" | "system";
  author_user_id: string | null;
  author_name_snapshot: string | null;
  author_avatar_url_snapshot: string | null;
  client_message_id: string | null;
  external_actor_json: string | null;
  message_type: string;
  prepared_payload_id: string;
  prepared_fact_id: string;
  prepared_payload_audience: "shared" | "participant" | "model";
  prepared_payload_media_type: string;
  prepared_payload_json: string;
  prepared_payload_sha256: string;
  prepared_payload_byte_length: number;
  bind_payload_json: string;
  provenance_json: string;
  authorization_json: string;
  attachments_json: string;
  mentions_json: string;
  /**
   * `0` for a message nobody addressed to Rally that was sent while an input
   * was still queued ahead of it. It waits so the room reads in send order,
   * lands the moment nothing is ahead of it, and never starts a run.
   */
  starts_run: 0 | 1;
  created_at: number;
  updated_at: number;
}

/** Minimal immutable witness retained after the canonical turn replaces a pending overlay. */
export interface DeliveredLoopInputRow extends Record<string, SqlStorageValue> {
  input_id: string;
  loop_id: string;
  input_sequence: number;
  delivered_turn_id: string;
  delivered_attention_ordinal: number;
  delivered_at: number;
}

export interface PendingInputPreparationRow extends Record<string, SqlStorageValue> {
  input_id: string;
  loop_id: string;
  input_sequence: number;
  admitted_after_transcript_sequence: number;
  client_message_id: string;
  preparation_kind: PendingInputPreparationKind;
  envelope_json: string | null;
  state: PendingInputPreparationState;
  terminal_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface AssistantTurnReservationRow extends Record<string, SqlStorageValue> {
  turn_id: string;
  loop_id: string;
  execution_id: string;
  cycle_ordinal: number;
  execution_epoch: number;
  assistant_turn_sequence: number;
  transcript_sequence: number;
  stream_id: string;
  state: AssistantTurnReservationState;
  outcome: AssistantTurnOutcome | null;
  materialized_turn_id: string | null;
  reserved_at: number;
  started_at: number | null;
  materialized_at: number | null;
  updated_at: number;
}

interface ExecutionRow extends Record<string, SqlStorageValue> {
  run_id: string;
  substream_loop_id: string | null;
  loop_input_id: string | null;
  loop_cycle_ordinal: number | null;
  loop_execution_id: string | null;
  loop_execution_epoch: number | null;
  loop_execution_sequence: number | null;
  terminalized_at: number | null;
}

export interface PreparedReservedLoopInput {
  inputId: string;
  preparedTurnId: string;
  mode: LoopInputMode;
  actor: PendingLoopInputRow["actor"];
  authorUserId: string | null;
  authorNameSnapshot: string | null;
  authorAvatarUrlSnapshot: string | null;
  clientMessageId: string | null;
  externalActorJson: string | null;
  messageType: string;
  preparedPayloadId: string;
  preparedFactId: string;
  preparedPayloadAudience: PendingLoopInputRow["prepared_payload_audience"];
  preparedPayloadMediaType: string;
  preparedPayloadJson: string;
  preparedPayloadSha256: string;
  preparedPayloadByteLength: number;
  bindPayloadJson: string;
  provenanceJson: string;
  authorizationJson: string;
  attachmentsJson: string;
  mentionsJson: string;
  /** Defaults to true; see `PendingLoopInputRow.starts_run`. */
  startsRun?: boolean;
  now: number;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

const LOOP_COLUMNS = `id, loop_id, revision, status, cycle_ordinal, step_ordinal,
  bind_state_revision, active_execution_id, active_execution_epoch,
  lease_owner, lease_expires_at, stop_requested_at, stop_after_step_ordinal,
  stop_reason, next_input_sequence, next_assistant_turn_sequence,
  next_execution_sequence, transcript_projected_through, created_at, updated_at`;
const INPUT_COLUMNS = `input_id, loop_id, input_sequence, prepared_turn_id,
  admitted_after_transcript_sequence, mode,
  actor, author_user_id, author_name_snapshot, author_avatar_url_snapshot,
  client_message_id, external_actor_json, message_type, prepared_payload_id,
  prepared_fact_id, prepared_payload_audience, prepared_payload_media_type,
  prepared_payload_json, prepared_payload_sha256,
  prepared_payload_byte_length, bind_payload_json, provenance_json, authorization_json,
  attachments_json, mentions_json, starts_run, created_at, updated_at`;
const DELIVERED_INPUT_COLUMNS = `input_id, loop_id, input_sequence,
  delivered_turn_id, delivered_attention_ordinal, delivered_at`;
const PREPARATION_COLUMNS = `input_id, loop_id, input_sequence,
  admitted_after_transcript_sequence, client_message_id, preparation_kind,
  envelope_json, state, terminal_code, created_at, updated_at`;
const RESERVATION_COLUMNS = `turn_id, loop_id, execution_id, cycle_ordinal, execution_epoch,
  assistant_turn_sequence, transcript_sequence, stream_id, state, outcome,
  materialized_turn_id, reserved_at, started_at, materialized_at, updated_at`;
const EXECUTION_COLUMNS = `run_id, substream_loop_id, loop_input_id,
  loop_cycle_ordinal, loop_execution_id,
  loop_execution_epoch, loop_execution_sequence, terminalized_at`;

export class SubstreamLoopStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  loop(): SubstreamLoopRow | undefined {
    return first(this.sql.exec<SubstreamLoopRow>(
      `SELECT ${LOOP_COLUMNS} FROM substream_loops WHERE id = 1`,
    ));
  }

  ensureLoop(input: { loopId: string; bindStateRevision: number; now: number }): SubstreamLoopRow {
    return this.storage.transactionSync(() => {
      const existing = this.loop();
      if (existing) {
        if (existing.loop_id !== input.loopId) throw new Error("substream_loop_identity_mismatch");
        return existing;
      }
      this.sql.exec(
        `INSERT INTO substream_loops
           (id, loop_id, revision, status, cycle_ordinal, step_ordinal,
            bind_state_revision, active_execution_id, active_execution_epoch,
            lease_owner, lease_expires_at, stop_requested_at,
            stop_after_step_ordinal, stop_reason, next_input_sequence,
            next_assistant_turn_sequence, next_execution_sequence,
            transcript_projected_through, created_at, updated_at)
         VALUES (1, ?, 1, 'idle', 0, 0, ?, NULL, NULL, NULL, NULL, NULL, NULL,
                 NULL, 1, 1, 1, 0, ?, ?)`,
        input.loopId, input.bindStateRevision, input.now, input.now,
      );
      return this.#requiredLoop(input.loopId);
    });
  }

  input(inputId: string): PendingLoopInputRow | undefined {
    return first(this.sql.exec<PendingLoopInputRow>(
      `SELECT ${INPUT_COLUMNS} FROM pending_loop_inputs WHERE input_id = ?`, inputId,
    ));
  }

  inputByClientMessageId(clientMessageId: string): PendingLoopInputRow | undefined {
    return first(this.sql.exec<PendingLoopInputRow>(
      `SELECT ${INPUT_COLUMNS} FROM pending_loop_inputs WHERE client_message_id = ?`,
      clientMessageId,
    ));
  }

  deliveredInput(inputId: string): DeliveredLoopInputRow | undefined {
    return first(this.sql.exec<DeliveredLoopInputRow>(
      `SELECT ${DELIVERED_INPUT_COLUMNS} FROM delivered_loop_inputs WHERE input_id = ?`,
      inputId,
    ));
  }

  inputPreparation(inputId: string): PendingInputPreparationRow | undefined {
    return first(this.sql.exec<PendingInputPreparationRow>(
      `SELECT ${PREPARATION_COLUMNS} FROM pending_loop_input_mailbox WHERE input_id = ?`,
      inputId,
    ));
  }

  inputPreparationByClientMessageId(
    clientMessageId: string,
  ): PendingInputPreparationRow | undefined {
    return first(this.sql.exec<PendingInputPreparationRow>(
      `SELECT ${PREPARATION_COLUMNS} FROM pending_loop_input_mailbox
        WHERE client_message_id = ?`,
      clientMessageId,
    ));
  }

  oldestPreparingInput(): PendingInputPreparationRow | undefined {
    return first(this.sql.exec<PendingInputPreparationRow>(
      `SELECT ${PREPARATION_COLUMNS} FROM pending_loop_input_mailbox
        WHERE state = 'preparing' ORDER BY input_sequence LIMIT 1`,
    ));
  }

  /**
   * Whether anything admitted before `inputSequence` has yet to land: a queued
   * input, or a reservation still being prepared. A message that starts no run
   * waits behind either, or it would be read before what was sent ahead of it.
   */
  hasInputAhead(inputSequence: number): boolean {
    return first(this.sql.exec<{ ahead: number }>(
      `SELECT EXISTS (
          SELECT 1 FROM pending_loop_inputs WHERE input_sequence < ?
        ) OR EXISTS (
          SELECT 1 FROM pending_loop_input_mailbox
           WHERE state = 'preparing' AND input_sequence < ?
        ) AS ahead`,
      inputSequence,
      inputSequence,
    ))?.ahead === 1;
  }

  /**
   * Whether the head of the visible queue starts no run. One flag off one row:
   * `nextLoopWorkAt` asks on every alarm re-arm, and `pendingInputs` would read
   * every queued payload to answer it.
   */
  visibleHeadStartsNoRun(): boolean {
    return first(this.sql.exec<{ starts_run: number }>(
      `SELECT starts_run FROM pending_loop_inputs
        WHERE NOT EXISTS (
            SELECT 1 FROM pending_loop_input_mailbox preparing
             WHERE preparing.loop_id = pending_loop_inputs.loop_id
               AND preparing.state = 'preparing'
               AND preparing.input_sequence < pending_loop_inputs.input_sequence
          )
        ORDER BY input_sequence LIMIT 1`,
    ))?.starts_run === 0;
  }

  pendingInputs(): PendingLoopInputRow[] {
    return this.sql.exec<PendingLoopInputRow>(
      `SELECT ${INPUT_COLUMNS} FROM pending_loop_inputs
        WHERE NOT EXISTS (
            SELECT 1 FROM pending_loop_input_mailbox preparing
             WHERE preparing.loop_id = pending_loop_inputs.loop_id
               AND preparing.state = 'preparing'
               AND preparing.input_sequence < pending_loop_inputs.input_sequence
          )
        ORDER BY input_sequence`,
    ).toArray();
  }

  /** Includes admitted input not yet claimed, even while payload preparation hides it. */
  hasPendingWork(): boolean {
    return first(this.sql.exec<{ pending: number }>(
      `SELECT EXISTS (SELECT 1 FROM pending_loop_inputs WHERE starts_run = 1)
           OR EXISTS (SELECT 1 FROM pending_loop_input_mailbox WHERE state = 'preparing') AS pending`,
    ))?.pending === 1;
  }

  /**
   * Reassign promotion order among currently visible pending inputs.
   *
   * Named ids take the order the caller sent. Ids that have already been
   * delivered are ignored rather than refused. Visible inputs the caller does
   * not name keep their relative order behind the ones it did — the same
   * rule as pin reorder, so a second window that admitted a message a moment
   * ago loses its position, never the message. Hidden inputs (still behind a
   * preparing mailbox head) keep the sequences they already hold.
   *
   * Sequence numbers of the visible set are permuted in place. Temporary
   * values are taken from `next_input_sequence` so they cannot collide with
   * hidden rows; `next_input_sequence` itself is not consumed. Loop revision
   * is left alone: an in-flight execution's fence must not move because
   * someone dragged the queue.
   */
  /** The caller owns the surrounding transaction and may add its own receipt. */
  reorderPendingInputsInTransaction(input: {
    inputIds: readonly string[];
    now: number;
  }): PendingLoopInputRow[] {
    const loop = this.loop();
    if (!loop) throw new Error("substream_loop_not_found");
    const current = this.pendingInputs();
    const byId = new Map(current.map((pending) => [pending.input_id, pending]));
    const named = input.inputIds.flatMap((inputId) => {
      const pending = byId.get(inputId);
      return pending ? [pending] : [];
    });
    const namedIds = new Set(named.map((pending) => pending.input_id));
    const unnamed = current.filter((pending) => !namedIds.has(pending.input_id));
    const ordered = [...named, ...unnamed];
    if (ordered.length === 0
      || ordered.every((pending, index) => pending.input_id === current[index]?.input_id)) {
      return current;
    }
    const sequences = current.map((pending) => Number(pending.input_sequence));
    const tempBase = loop.next_input_sequence;
    for (const [index, pending] of ordered.entries()) {
      this.sql.exec(
        `UPDATE pending_loop_inputs
            SET input_sequence = ?, updated_at = MAX(updated_at, ?)
          WHERE input_id = ?`,
        tempBase + index,
        input.now,
        pending.input_id,
      );
    }
    for (const [index, pending] of ordered.entries()) {
      const sequence = sequences[index];
      if (sequence === undefined) throw new Error("pending_input_reorder_sequence_missing");
      this.sql.exec(
        `UPDATE pending_loop_inputs
            SET input_sequence = ?, updated_at = MAX(updated_at, ?)
          WHERE input_id = ?`,
        sequence,
        input.now,
        pending.input_id,
      );
    }
    for (const pending of ordered) {
      enqueueSemanticRealtimeReference(
        this.sql,
        { kind: "loop_input_upserted", inputId: pending.input_id },
        input.now,
      );
    }
    return this.pendingInputs();
  }

  reserveInputPreparation(input: {
    inputId: string;
    loopId: string;
    clientMessageId: string;
    preparationKind: PendingInputPreparationKind;
    envelopeJson: string;
    now: number;
  }): { outcome: "reserved" | "reused"; preparation: PendingInputPreparationRow } {
    return this.storage.transactionSync(() => {
      const loop = this.loop();
      if (!loop || loop.loop_id !== input.loopId) {
        throw new Error("substream_loop_identity_mismatch");
      }
      if (this.deliveredInput(input.inputId)) {
        throw new Error("pending_input_already_delivered");
      }
      const existing = this.inputPreparation(input.inputId)
        ?? this.inputPreparationByClientMessageId(input.clientMessageId);
      if (existing) {
        if (existing.loop_id !== input.loopId
          || existing.client_message_id !== input.clientMessageId
          || existing.preparation_kind !== input.preparationKind
          || (existing.state === "preparing" && existing.envelope_json !== input.envelopeJson)) {
          throw new Error("pending_input_preparation_replay_mismatch");
        }
        return { outcome: "reused", preparation: existing };
      }
      const admittedAfter = Number(this.sql.exec<{
        next_transcript_sequence: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
      ).one().next_transcript_sequence) - 1;
      this.sql.exec(
        `INSERT INTO pending_loop_input_mailbox
           (input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
            client_message_id,
            preparation_kind, envelope_json, state, terminal_code,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'preparing', NULL, ?, ?)`,
        input.inputId,
        input.loopId,
        loop.next_input_sequence,
        admittedAfter,
        input.clientMessageId,
        input.preparationKind,
        input.envelopeJson,
        input.now,
        input.now,
      );
      this.#bumpLoop(loop.revision, input.now,
        "next_input_sequence = next_input_sequence + 1");
      const preparation = this.inputPreparation(input.inputId);
      if (!preparation) throw new Error("pending_input_preparation_not_found");
      return { outcome: "reserved", preparation };
    });
  }

  completeInputPreparation(input: PreparedReservedLoopInput): {
    outcome: "admitted" | "reused";
    input: PendingLoopInputRow;
  } {
    return this.storage.transactionSync(() => {
      const loop = this.loop();
      if (!loop) throw new Error("substream_loop_not_found");
      const preparation = this.inputPreparation(input.inputId);
      if (!preparation || preparation.loop_id !== loop.loop_id) {
        throw new Error("pending_input_preparation_not_found");
      }
      // An activation is authored by nobody: not a person in this room, and not
      // a provider account either. Mapping it onto "external" would put an
      // automation's own text where a connector identity is expected, and every
      // reader of that column would have to know the difference by name.
      const expectedActor = preparation.preparation_kind === "automation_activation"
        ? "system"
        : preparation.preparation_kind.startsWith("human_") ? "human" : "external";
      if (input.preparedTurnId !== preparation.input_id
        || input.clientMessageId !== preparation.client_message_id
        || input.actor !== expectedActor) {
        throw new Error("pending_input_preparation_material_mismatch");
      }
      const existing = this.input(input.inputId);
      if (existing) {
        if (existing.input_sequence !== preparation.input_sequence) {
          throw new Error("pending_input_preparation_sequence_mismatch");
        }
        this.#assertPreparedReplay(existing, input, loop.loop_id);
        return { outcome: "reused", input: existing };
      }
      if (preparation.state !== "preparing") {
        throw new Error(`pending_input_preparation_${preparation.state}`);
      }
      this.#insertPendingInput(
        input,
        loop.loop_id,
        preparation.input_sequence,
        preparation.admitted_after_transcript_sequence,
      );
      if (input.messageType !== "elicitation") {
        this.cancelPendingElicitations(input.now);
      }
      this.sql.exec(
        `UPDATE pending_loop_input_mailbox
            SET state = 'ready', envelope_json = NULL, updated_at = MAX(updated_at, ?)
          WHERE input_id = ? AND state = 'preparing'`,
        input.now,
        input.inputId,
      );
      this.#bumpLoop(loop.revision, input.now);
      this.#enqueueNewlyVisibleInputs(loop.loop_id, preparation.input_sequence, input.now);
      return { outcome: "admitted", input: this.#requiredInput(input.inputId) };
    });
  }

  /** A newly committed message supersedes every unanswered question in this room. */
  cancelPendingElicitations(now: number, onlySupersededByQueuedInput = false): void {
    const cancelled = this.sql.exec<{ elicitation_id: string } & Record<string, SqlStorageValue>>(
      `UPDATE elicitation_requests
          SET status = 'cancelled'
        WHERE status = 'pending'
          ${onlySupersededByQueuedInput ? `AND EXISTS (
            SELECT 1 FROM pending_loop_inputs AS pending
             WHERE pending.message_type != 'elicitation'
               AND (pending.created_at > elicitation_requests.created_at
                 OR (pending.created_at = elicitation_requests.created_at
                   AND EXISTS (
                     SELECT 1 FROM participant_transcript_turns AS question
                      WHERE question.client_message_id = 'elicitation:' || elicitation_requests.elicitation_id
                        AND pending.admitted_after_transcript_sequence >= question.transcript_sequence
                   )))
          )` : ""}
      RETURNING elicitation_id`,
    ).toArray();
    for (const row of cancelled) {
      enqueueSemanticRealtimeReference(this.sql, {
        kind: "elicitation_cancelled",
        elicitationId: row.elicitation_id,
      }, now);
    }
  }

  failInputPreparation(input: { inputId: string; terminalCode: string; now: number }): void {
    this.storage.transactionSync(() => {
      const loop = this.loop();
      if (!loop) throw new Error("substream_loop_not_found");
      const preparation = this.inputPreparation(input.inputId);
      if (!preparation || preparation.state !== "preparing") return;
      this.sql.exec(
        `UPDATE pending_loop_input_mailbox
            SET state = 'failed', envelope_json = NULL, terminal_code = ?, updated_at = MAX(updated_at, ?)
          WHERE input_id = ? AND state = 'preparing'`,
        input.terminalCode,
        input.now,
        input.inputId,
      );
      this.#bumpLoop(loop.revision, input.now);
      this.#enqueueNewlyVisibleInputs(loop.loop_id, preparation.input_sequence, input.now);
    });
  }

  discardInputPreparation(input: { inputId: string; now: number }): void {
    this.storage.transactionSync(() => {
      const loop = this.loop();
      if (!loop) throw new Error("substream_loop_not_found");
      const preparation = this.inputPreparation(input.inputId);
      if (!preparation || preparation.state !== "preparing") return;
      this.sql.exec(
        `UPDATE pending_loop_input_mailbox
            SET state = 'discarded', envelope_json = NULL, updated_at = MAX(updated_at, ?)
          WHERE input_id = ? AND state = 'preparing'`,
        input.now,
        input.inputId,
      );
      this.#bumpLoop(loop.revision, input.now);
      this.#enqueueNewlyVisibleInputs(loop.loop_id, preparation.input_sequence, input.now);
    });
  }

  /**
   * Publish only the FIFO prefix that the canonical snapshot can expose after
   * one preparation leaves the head-of-line gate. Rows made ready behind an
   * earlier preparation deliberately remain absent from both realtime and
   * snapshots until that earlier reservation settles.
   */
  #enqueueNewlyVisibleInputs(
    loopId: string,
    fromInputSequence: number,
    now: number,
  ): void {
    const newlyVisible = this.sql.exec<{
      input_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT pending.input_id
         FROM pending_loop_inputs AS pending
        WHERE pending.loop_id = ? AND pending.input_sequence >= ?
          AND NOT EXISTS (
            SELECT 1 FROM pending_loop_input_mailbox AS preparing
             WHERE preparing.loop_id = pending.loop_id
               AND preparing.state = 'preparing'
               AND preparing.input_sequence < pending.input_sequence
          )
        ORDER BY pending.input_sequence`,
      loopId,
      fromInputSequence,
    ).toArray();
    for (const pending of newlyVisible) {
      enqueueSemanticRealtimeReference(
        this.sql,
        { kind: "loop_input_upserted", inputId: pending.input_id },
        now,
      );
    }
  }

  /**
   * Atomically adopt an already-durable external/manual receipt as the next
   * activation. The receipt is the restart payload; the singleton remains the
   * lifecycle and lease authority.
   */
  activateExecutionReceipt(input: {
    runId: string;
    loopId: string;
    expectedLoopRevision: number;
    expectedBindStateRevision: number;
    executionEpoch: number;
    leaseOwner: string;
    leaseExpiresAt: number;
    now: number;
  }): { outcome: "activated" | "reused"; loop: SubstreamLoopRow; executionSequence: number } {
    return this.storage.transactionSync(() => {
      const run = first(this.sql.exec<{
        status: string;
        terminalized_at: number | null;
        execution_context_json: string | null;
        execution_available_at: number | null;
        substream_loop_id: string | null;
        loop_input_id: string | null;
        loop_cycle_ordinal: number | null;
        loop_execution_id: string | null;
        loop_execution_sequence: number | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT status, terminalized_at, execution_context_json, execution_available_at,
                substream_loop_id, loop_input_id, loop_cycle_ordinal,
                loop_execution_id, loop_execution_sequence
           FROM runs WHERE run_id = ?`,
        input.runId,
      ));
      if (!run) throw new Error("substream_loop_execution_receipt_not_found");
      const current = this.loop();
      if (!current || current.loop_id !== input.loopId) throw new Error("substream_loop_not_found");
      if (run.substream_loop_id !== null) {
        if (run.substream_loop_id !== input.loopId || run.loop_input_id !== null
          || run.loop_execution_id !== input.runId
          || run.loop_cycle_ordinal !== current.cycle_ordinal
          || run.loop_execution_sequence === null
          || current.status !== "executing"
          || current.active_execution_id !== input.runId) {
          throw new Error("substream_loop_execution_replay_mismatch");
        }
        return {
          outcome: "reused",
          loop: current,
          executionSequence: run.loop_execution_sequence,
        };
      }
      const loop = this.#requiredRevision(input.expectedLoopRevision);
      if (loop.status !== "idle") throw new Error("substream_loop_already_executing");
      if (loop.bind_state_revision !== input.expectedBindStateRevision) {
        throw new Error("substream_loop_bind_revision_mismatch");
      }
      if (!Number.isSafeInteger(input.executionEpoch) || input.executionEpoch < 1
        || !input.leaseOwner || !Number.isSafeInteger(input.leaseExpiresAt)
        || input.leaseExpiresAt <= input.now) {
        throw new Error("substream_loop_execution_fence_invalid");
      }
      if (!run.execution_context_json || run.terminalized_at !== null
        || !["admitted", "running"].includes(run.status)
        || (run.execution_available_at !== null && run.execution_available_at > input.now)) {
        throw new Error("substream_loop_execution_receipt_not_due");
      }
      const cycle = loop.cycle_ordinal + 1;
      const linked = first(this.sql.exec<{
        run_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE runs
            SET status = 'running', substream_loop_id = ?,
                loop_input_id = NULL,
                loop_cycle_ordinal = ?, loop_execution_id = ?,
                loop_execution_epoch = ?, loop_execution_sequence = ?,
                execution_available_at = NULL, updated_at = MAX(updated_at, ?)
          WHERE run_id = ? AND substream_loop_id IS NULL
            AND execution_context_json IS NOT NULL AND terminalized_at IS NULL
            AND status IN ('admitted', 'running')
            AND (execution_available_at IS NULL OR execution_available_at <= ?)
          RETURNING run_id`,
        input.loopId,
        cycle,
        input.runId,
        input.executionEpoch,
        loop.next_execution_sequence,
        input.now,
        input.runId,
        input.now,
      ));
      if (linked?.run_id !== input.runId) {
        throw new Error("substream_loop_execution_receipt_changed");
      }
      const activated = first(this.sql.exec<{
        loop_id: string;
        revision: number;
      } & Record<string, SqlStorageValue>>(
        `UPDATE substream_loops
            SET status = 'executing', cycle_ordinal = ?, step_ordinal = 0,
                active_execution_id = ?, active_execution_epoch = ?,
                lease_owner = ?, lease_expires_at = ?,
                next_execution_sequence = next_execution_sequence + 1,
                revision = revision + 1, updated_at = MAX(updated_at, ?)
          WHERE id = 1 AND revision = ? AND status = 'idle'
            AND bind_state_revision = ?
          RETURNING loop_id, revision`,
        cycle,
        input.runId,
        input.executionEpoch,
        input.leaseOwner,
        input.leaseExpiresAt,
        input.now,
        input.expectedLoopRevision,
        input.expectedBindStateRevision,
      ));
      if (activated?.loop_id !== input.loopId
        || activated.revision !== input.expectedLoopRevision + 1) {
        throw new Error("substream_loop_revision_mismatch");
      }
      return {
        outcome: "activated",
        loop: this.#requiredLoop(input.loopId),
        executionSequence: loop.next_execution_sequence,
      };
    });
  }

  heartbeatExecution(input: ExecutionFence & { leaseExpiresAt: number; now: number }): SubstreamLoopRow {
    return this.storage.transactionSync(() => {
      if (!Number.isSafeInteger(input.leaseExpiresAt) || input.leaseExpiresAt <= input.now) {
        throw new Error("substream_loop_execution_fence_invalid");
      }
      const loop = this.loop();
      if (!loop) throw new Error("substream_loop_not_found");
      this.#assertExecutionIdentity(loop, input);
      if (loop.lease_expires_at !== null && input.leaseExpiresAt < loop.lease_expires_at) {
        throw new Error("substream_loop_lease_regression");
      }
      const renewed = first(this.sql.exec<{
        loop_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE substream_loops SET lease_expires_at = ?, updated_at = MAX(updated_at, ?)
          WHERE id = 1 AND status = 'executing' AND active_execution_id = ?
            AND active_execution_epoch = ? AND lease_owner = ? AND lease_expires_at > ?
            AND lease_expires_at <= ?
          RETURNING loop_id`,
        input.leaseExpiresAt,
        input.now,
        input.executionId,
        input.executionEpoch,
        input.leaseOwner,
        input.now,
        input.leaseExpiresAt,
      ));
      if (renewed?.loop_id !== loop.loop_id) {
        throw new Error("substream_loop_execution_fence_mismatch");
      }
      return this.#requiredLoop(loop.loop_id);
    });
  }

  /**
   * Suspend the current executor without ending its loop cycle. The receipt
   * and singleton lease become due at the same instant, so the alarm can only
   * recover this exact execution with a higher epoch; it can never strand a
   * linked receipt behind an idle loop.
   */
  deferExecution(input: ExecutionFence & {
    availableAt: number;
    errorCode: string | null;
    now: number;
  }): SubstreamLoopRow {
    return this.storage.transactionSync(() => {
      const loop = this.#requiredExecution(input);
      if (!Number.isSafeInteger(input.availableAt) || input.availableAt <= input.now) {
        throw new Error("substream_loop_execution_deferral_invalid");
      }
      const receipt = first(this.sql.exec<{
        run_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE runs SET execution_available_at = ?, last_settlement_error_code = ?,
            updated_at = MAX(updated_at, ?)
          WHERE run_id = ? AND substream_loop_id = ?
            AND loop_execution_id = ? AND loop_execution_epoch = ?
            AND terminalized_at IS NULL
          RETURNING run_id`,
        input.availableAt,
        input.errorCode,
        input.now,
        input.executionId,
        loop.loop_id,
        input.executionId,
        input.executionEpoch,
      ));
      if (receipt?.run_id !== input.executionId) {
        throw new Error("substream_loop_execution_receipt_deferral_mismatch");
      }
      const deferred = first(this.sql.exec<{
        loop_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE substream_loops SET lease_expires_at = ?, updated_at = MAX(updated_at, ?)
          WHERE id = 1 AND status = 'executing' AND active_execution_id = ?
            AND active_execution_epoch = ? AND lease_owner = ?
            AND lease_expires_at > ?
          RETURNING loop_id`,
        input.availableAt,
        input.now,
        input.executionId,
        input.executionEpoch,
        input.leaseOwner,
        input.now,
      ));
      if (deferred?.loop_id !== loop.loop_id) {
        throw new Error("substream_loop_execution_fence_mismatch");
      }
      return this.#requiredLoop(loop.loop_id);
    });
  }

  /**
   * Release only the lease held by an attempt the current isolate proved it
   * expired during startup. This preserves every logical loop cursor and lets
   * recovery acquire epoch + 1 immediately after eviction.
   */
  expireExecutionLeaseForEvictedOwner(input: {
    executionId: string;
    executionEpoch: number;
    leaseOwner: string;
    now: number;
  }): SubstreamLoopRow {
    return this.storage.transactionSync(() => {
      const loop = this.loop();
      if (!loop) throw new Error("substream_loop_not_found");
      if (loop.status !== "executing" || loop.active_execution_id !== input.executionId
        || loop.active_execution_epoch !== input.executionEpoch
        || loop.lease_owner !== input.leaseOwner || loop.lease_expires_at === null) {
        throw new Error("substream_loop_execution_fence_mismatch");
      }
      if (loop.lease_expires_at <= input.now) return loop;
      const expired = first(this.sql.exec<{
        loop_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE substream_loops SET lease_expires_at = ?, updated_at = MAX(updated_at, ?)
          WHERE id = 1 AND status = 'executing' AND active_execution_id = ?
            AND active_execution_epoch = ? AND lease_owner = ?
            AND lease_expires_at > ?
          RETURNING loop_id`,
        input.now,
        input.now,
        input.executionId,
        input.executionEpoch,
        input.leaseOwner,
        input.now,
      ));
      if (expired?.loop_id !== loop.loop_id) {
        throw new Error("substream_loop_execution_fence_mismatch");
      }
      return this.#requiredLoop(loop.loop_id);
    });
  }

  recoverExecution(input: {
    executionId: string;
    newExecutionEpoch: number;
    leaseOwner: string;
    leaseExpiresAt: number;
    expectedLoopRevision: number;
    now: number;
  }): { outcome: "recovered" | "reused"; loop: SubstreamLoopRow } {
    return this.storage.transactionSync(() => {
      if (!Number.isSafeInteger(input.newExecutionEpoch) || input.newExecutionEpoch < 1
        || !input.leaseOwner || !Number.isSafeInteger(input.leaseExpiresAt)
        || input.leaseExpiresAt <= input.now) {
        throw new Error("substream_loop_execution_fence_invalid");
      }
      const current = this.loop();
      if (!current) throw new Error("substream_loop_not_found");
      if (current.status === "executing"
        && current.active_execution_id === input.executionId
        && current.active_execution_epoch === input.newExecutionEpoch
        && current.lease_owner === input.leaseOwner
        && current.lease_expires_at !== null && current.lease_expires_at > input.now) {
        const receipt = this.#execution(input.executionId);
        if (!receipt || receipt.substream_loop_id !== current.loop_id
          || receipt.loop_execution_id !== input.executionId
          || receipt.loop_execution_epoch !== input.newExecutionEpoch
          || receipt.terminalized_at !== null) {
          throw new Error("substream_loop_execution_receipt_recovery_mismatch");
        }
        return { outcome: "reused", loop: current };
      }
      const loop = this.#requiredRevision(input.expectedLoopRevision);
      if (loop.status !== "executing" || loop.active_execution_id !== input.executionId) {
        throw new Error("substream_loop_recovery_identity_mismatch");
      }
      if (loop.lease_expires_at === null || loop.lease_expires_at > input.now) {
        throw new Error("substream_loop_lease_not_expired");
      }
      if (loop.active_execution_epoch === null
        || input.newExecutionEpoch !== loop.active_execution_epoch + 1) {
        throw new Error("substream_loop_recovery_epoch_mismatch");
      }
      const receipt = first(this.sql.exec<{
        run_id: string;
        loop_execution_epoch: number;
      } & Record<string, SqlStorageValue>>(
        `UPDATE runs SET status = 'running', loop_execution_epoch = ?,
            execution_available_at = NULL, updated_at = MAX(updated_at, ?)
          WHERE run_id = ? AND substream_loop_id = ?
            AND loop_execution_id = ? AND loop_execution_epoch = ?
            AND terminalized_at IS NULL
            AND status IN ('admitted', 'running')
          RETURNING run_id, loop_execution_epoch`,
        input.newExecutionEpoch,
        input.now,
        input.executionId,
        loop.loop_id,
        input.executionId,
        loop.active_execution_epoch,
      ));
      if (receipt?.run_id !== input.executionId
        || receipt.loop_execution_epoch !== input.newExecutionEpoch) {
        throw new Error("substream_loop_execution_receipt_recovery_mismatch");
      }
      this.#bumpLoop(loop.revision, input.now,
        `active_execution_epoch = ?, lease_owner = ?, lease_expires_at = ?`,
        input.newExecutionEpoch, input.leaseOwner, input.leaseExpiresAt);
      return { outcome: "recovered", loop: this.#requiredLoop(loop.loop_id) };
    });
  }

  /** The caller owns the surrounding transaction and may add its own receipt. */
  requestStopInTransaction(input: ExecutionFence & { reason: string; now: number }): SubstreamLoopRow {
    const loop = this.#requiredExecution(input);
    if (loop.stop_requested_at !== null) return loop;
    this.#bumpLoop(loop.revision, input.now,
      "stop_requested_at = ?, stop_after_step_ordinal = step_ordinal, stop_reason = ?",
      input.now, input.reason);
    return this.#requiredLoop(loop.loop_id);
  }

  reservation(turnId: string): AssistantTurnReservationRow | undefined {
    return first(this.sql.exec<AssistantTurnReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM assistant_turn_reservations WHERE turn_id = ?`, turnId,
    ));
  }

  /** Durable model turns spent by one subordinate execution of this loop. */
  assistantTurnCountForExecution(executionId: string): number {
    return Number(first(this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM assistant_turn_reservations WHERE execution_id = ?`,
      executionId,
    ))?.count ?? 0);
  }

  activeReservation(): AssistantTurnReservationRow | undefined {
    return first(this.sql.exec<AssistantTurnReservationRow>(
      `SELECT ${RESERVATION_COLUMNS} FROM assistant_turn_reservations
        WHERE state IN ('reserved', 'streaming') ORDER BY assistant_turn_sequence LIMIT 1`,
    ));
  }

  reserveAssistantTurn(input: ExecutionFence & {
    receiptRunId: string; turnId: string; modelTurnIndex: number; streamId: string; now: number;
  }): { outcome: "reserved" | "reused"; reservation: AssistantTurnReservationRow }
    | { outcome: "active_reservation"; reservation: AssistantTurnReservationRow } {
    return this.storage.transactionSync(() => {
      const existing = this.reservation(input.turnId);
      if (existing) {
        const loop = this.loop();
        if (!loop) throw new Error("substream_loop_not_found");
        if (existing.loop_id !== loop.loop_id
          || existing.assistant_turn_sequence !== input.modelTurnIndex) {
          throw new Error("assistant_turn_reservation_replay_mismatch");
        }
        return { outcome: "reused", reservation: existing };
      }
      const loop = this.#requiredExecution(input);
      const active = this.activeReservation();
      if (active) return { outcome: "active_reservation", reservation: active };
      const run = this.#execution(input.receiptRunId);
      if (!run || run.substream_loop_id !== loop.loop_id
        || run.loop_cycle_ordinal !== loop.cycle_ordinal
        || run.loop_execution_id !== loop.active_execution_id) {
        throw new Error("assistant_turn_execution_not_linked");
      }
      if (!Number.isSafeInteger(input.modelTurnIndex) || input.modelTurnIndex < 1
        || input.modelTurnIndex !== loop.next_assistant_turn_sequence
        || input.turnId !== `${loop.loop_id}:turn:${input.modelTurnIndex}`
        || input.streamId.length === 0) {
        throw new Error("assistant_turn_model_index_mismatch");
      }
      const counter = first(this.sql.exec<{
        next_transcript_sequence: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
      ));
      if (!counter) throw new Error("transcript_counter_not_found");
      const counterUpdate = first(this.sql.exec<{
        next_transcript_sequence: number;
      } & Record<string, SqlStorageValue>>(
        `UPDATE transcript_counters SET next_transcript_sequence = next_transcript_sequence + 1,
            updated_at = ? WHERE id = 1 AND next_transcript_sequence = ?
          RETURNING next_transcript_sequence`,
        input.now, counter.next_transcript_sequence,
      ));
      if (counterUpdate?.next_transcript_sequence !== counter.next_transcript_sequence + 1) {
        throw new Error("transcript_counter_changed");
      }
      this.sql.exec(
        `INSERT INTO assistant_turn_reservations
           (turn_id, loop_id, execution_id, cycle_ordinal, execution_epoch,
            assistant_turn_sequence, transcript_sequence, stream_id, state,
            outcome, materialized_turn_id, reserved_at, started_at,
            materialized_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, NULL, ?, NULL, NULL, ?)`,
        input.turnId, loop.loop_id, loop.active_execution_id, loop.cycle_ordinal,
        loop.active_execution_epoch,
        input.modelTurnIndex, counter.next_transcript_sequence,
        input.streamId, input.now, input.now,
      );
      this.#bumpLoop(loop.revision, input.now,
        "next_assistant_turn_sequence = next_assistant_turn_sequence + 1");
      return { outcome: "reserved", reservation: this.#requiredReservation(input.turnId) };
    });
  }

  startAssistantTurn(input: ExecutionFence & { turnId: string; now: number }): "started" | "reused" {
    return this.storage.transactionSync(() => {
      const loop = this.#requiredExecution(input);
      const reservation = this.#requiredReservation(input.turnId);
      if (reservation.loop_id !== loop.loop_id
        || reservation.execution_id !== loop.active_execution_id) {
        throw new Error("assistant_turn_reservation_execution_mismatch");
      }
      if (reservation.state === "streaming") return "reused";
      if (reservation.state !== "reserved") throw new Error("assistant_turn_not_reservable");
      const started = first(this.sql.exec<{
        turn_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE assistant_turn_reservations SET state = 'streaming', started_at = ?,
            updated_at = ? WHERE turn_id = ? AND state = 'reserved'
          RETURNING turn_id`,
        input.now, input.now, input.turnId,
      ));
      if (started?.turn_id !== input.turnId) {
        throw new Error("assistant_turn_not_reservable");
      }
      return "started";
    });
  }

  #execution(runId: string): ExecutionRow | undefined {
    return first(this.sql.exec<ExecutionRow>(
      `SELECT ${EXECUTION_COLUMNS} FROM runs WHERE run_id = ?`, runId,
    ));
  }

  #requiredLoop(loopId: string): SubstreamLoopRow {
    const loop = this.loop();
    if (!loop || loop.loop_id !== loopId) throw new Error("substream_loop_not_found");
    return loop;
  }

  #requiredRevision(expectedRevision: number): SubstreamLoopRow {
    const loop = this.loop();
    if (!loop) throw new Error("substream_loop_not_found");
    if (loop.revision !== expectedRevision) throw new Error("substream_loop_revision_mismatch");
    return loop;
  }

  #requiredExecution(input: ExecutionFence): SubstreamLoopRow {
    const loop = this.#requiredRevision(input.expectedLoopRevision);
    this.#assertExecutionIdentity(loop, input);
    return loop;
  }

  #assertExecutionIdentity(loop: SubstreamLoopRow, input: ExecutionFence): void {
    if (loop.status !== "executing" || loop.active_execution_id !== input.executionId
      || loop.active_execution_epoch !== input.executionEpoch
      || loop.lease_owner !== input.leaseOwner
      || loop.lease_expires_at === null || loop.lease_expires_at <= input.now) {
      throw new Error("substream_loop_execution_fence_mismatch");
    }
  }

  #requiredInput(inputId: string): PendingLoopInputRow {
    const value = this.input(inputId);
    if (!value) throw new Error("substream_loop_input_not_found");
    return value;
  }

  #requiredReservation(turnId: string): AssistantTurnReservationRow {
    const value = this.reservation(turnId);
    if (!value) throw new Error("assistant_turn_reservation_not_found");
    return value;
  }

  #bumpLoop(
    expectedRevision: number,
    now: number,
    assignments = "",
    ...values: SqlStorageValue[]
  ): void {
    const prefix = assignments.length > 0 ? `${assignments}, ` : "";
    // `updated_at` never moves backwards: rows carry a `CHECK (updated_at >=
    // created_at)`, and the caller's `now` can lag the clock that created the
    // row — a test's fixed timestamps, or `Date.now()` regressing across
    // isolate replacement. The row's own history is the floor.
    const witness = first(this.sql.exec<{
      revision: number;
    } & Record<string, SqlStorageValue>>(
      `UPDATE substream_loops SET ${prefix}revision = revision + 1,
              updated_at = MAX(updated_at, ?)
        WHERE id = 1 AND revision = ?
        RETURNING revision`,
      ...values, now, expectedRevision,
    ));
    if (witness?.revision !== expectedRevision + 1) {
      throw new Error("substream_loop_revision_mismatch");
    }
  }

  #insertPendingInput(
    input: PreparedReservedLoopInput,
    loopId: string,
    inputSequence: number,
    admittedAfter: number,
  ): void {
    this.sql.exec(
      `INSERT INTO pending_loop_inputs
         (input_id, loop_id, input_sequence, prepared_turn_id,
          admitted_after_transcript_sequence, mode, actor,
          author_user_id, author_name_snapshot, author_avatar_url_snapshot,
          client_message_id, external_actor_json, message_type,
          prepared_payload_id, prepared_fact_id, prepared_payload_json,
          prepared_payload_audience, prepared_payload_media_type,
          prepared_payload_sha256, prepared_payload_byte_length,
          bind_payload_json, provenance_json, authorization_json, attachments_json, mentions_json,
          starts_run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.inputId, loopId, inputSequence, input.preparedTurnId,
      admittedAfter, input.mode, input.actor, input.authorUserId, input.authorNameSnapshot,
      input.authorAvatarUrlSnapshot, input.clientMessageId, input.externalActorJson,
      input.messageType, input.preparedPayloadId, input.preparedFactId,
      input.preparedPayloadJson, input.preparedPayloadAudience,
      input.preparedPayloadMediaType, input.preparedPayloadSha256,
      input.preparedPayloadByteLength, input.bindPayloadJson,
      input.provenanceJson, input.authorizationJson,
      input.attachmentsJson, input.mentionsJson, input.startsRun === false ? 0 : 1,
      input.now, input.now,
    );
  }

  #assertPreparedReplay(
    existing: PendingLoopInputRow,
    input: PreparedReservedLoopInput,
    loopId: string,
  ): void {
    const pairs: Array<[SqlStorageValue, SqlStorageValue]> = [
      [existing.input_id, input.inputId], [existing.loop_id, loopId],
      [existing.prepared_turn_id, input.preparedTurnId], [existing.mode, input.mode],
      [existing.actor, input.actor], [existing.author_user_id, input.authorUserId],
      [existing.author_name_snapshot, input.authorNameSnapshot],
      [existing.author_avatar_url_snapshot, input.authorAvatarUrlSnapshot],
      [existing.client_message_id, input.clientMessageId],
      [existing.external_actor_json, input.externalActorJson],
      [existing.message_type, input.messageType],
      [existing.prepared_payload_id, input.preparedPayloadId],
      [existing.prepared_fact_id, input.preparedFactId],
      [existing.prepared_payload_audience, input.preparedPayloadAudience],
      [existing.prepared_payload_media_type, input.preparedPayloadMediaType],
      [existing.prepared_payload_json, input.preparedPayloadJson],
      [existing.prepared_payload_sha256, input.preparedPayloadSha256],
      [existing.prepared_payload_byte_length, input.preparedPayloadByteLength],
      [existing.bind_payload_json, input.bindPayloadJson],
      [existing.provenance_json, input.provenanceJson],
      [existing.authorization_json, input.authorizationJson],
      [existing.attachments_json, input.attachmentsJson],
      [existing.mentions_json, input.mentionsJson],
      [existing.starts_run, input.startsRun === false ? 0 : 1],
    ];
    if (pairs.some(([actual, wanted]) => actual !== wanted)) {
      throw new Error("substream_loop_input_replay_mismatch");
    }
  }
}

interface ExecutionFence {
  executionId: string;
  executionEpoch: number;
  leaseOwner: string;
  expectedLoopRevision: number;
  now: number;
}
