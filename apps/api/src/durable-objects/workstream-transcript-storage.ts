import {
  ExternalActorSchema,
  type ExternalActor,
  type TranscriptActivity,
  type TranscriptBlock,
  type TranscriptRange,
  type TranscriptRangeResult,
  type TranscriptTurn,
  type WorkstreamTranscriptSnapshot,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";
import {
  applyBindLoopTransition,
  BIND_LOOP_PROJECTOR_VERSION,
  projectBindLoopMessages,
  type BindCompactionCommit,
  type BindLoopMessage,
  type BindLoopMessageOrigin,
  type BindLoopProjectionState,
  type BindLoopTransition,
  type BindProviderBoundary,
} from "@rally/agent-harness";
import { uuidV7 } from "../lib/uuid-v7";

export interface TranscriptFactMaterial {
  factId: string;
  factKind: string;
  audience: "shared" | "participant" | "model";
  payload: unknown;
  origin: BindLoopMessageOrigin | {
    originKind: "system_projection";
    sourceKind: string;
    sourceId: string;
    sourceRevision: number;
  };
  runId: string | null;
  turnId: string | null;
  toolCallId: string | null;
}

export interface PreparedTranscriptFact extends TranscriptFactMaterial {
  canonical: string;
  hash: string;
  payloadId: string;
}

interface MessageProjectionRow extends Record<string, SqlStorageValue> {
  message_position: number;
  fact_id: string;
  payload_json: string;
}

interface TurnRow extends Record<string, SqlStorageValue> {
  transcript_sequence: number;
  turn_id: string;
  entry_kind: string;
  actor: string;
  author_user_id: string | null;
  client_message_id: string | null;
  external_actor_json: string | null;
  activity_id: string | null;
  attention_ordinal: number | null;
  revision: number;
  created_at: number;
}

interface BlockRow extends Record<string, SqlStorageValue> {
  turn_id: string;
  block_id: string;
  block_index: number;
  block_kind: string;
  payload_json: string;
  tool_call_id: string | null;
  plugin_id: string | null;
  tool_name: string | null;
  call_index: number | null;
  lifecycle_state: string | null;
  activity_id: string | null;
  part_content: string | null;
  part_message_type: string | null;
  part_structured_content_json: string | null;
}

interface TranscriptMentionRow extends Record<string, SqlStorageValue> {
  part_id: string;
  mention_kind: "person" | "connector";
  target_user_id: string | null;
  connector_type: string | null;
  start_offset: number;
  end_offset: number;
}

interface TranscriptAttachmentRow extends Record<string, SqlStorageValue> {
  part_id: string;
  resource_id: string;
  position: number;
  title: string | null;
  mime_type: string | null;
  content_ref: string | null;
  metadata_json: string | null;
  attachment_json: string;
  attached_at: number;
}

interface ActivityRow extends Record<string, SqlStorageValue> {
  activity_id: string;
  parent_activity_id: string | null;
  scope: string;
  subject_id: string;
  call_index: number | null;
  label: string;
  lifecycle_state: string;
  revision: number;
}

interface IntervalRow extends Record<string, SqlStorageValue> {
  activity_id: string;
  interval_id: string;
  started_at: number;
  stopped_at: number | null;
  duration_ms: number | null;
  revision: number;
}

export interface ActivityEdge {
  activityId: string;
  parentActivityId: string | null;
  scope: TranscriptActivity["scope"];
  subjectId: string;
  callIndex: number | null;
  label: string;
  action: "start" | "complete" | "fail" | "cancel" | "abandon";
  revision: number;
  occurredAtUtc: string;
}

export interface ParticipantMessageInput {
  turnId: string;
  actor: "human" | "assistant" | "external" | "system";
  authorUserId: string | null;
  clientMessageId?: string;
  messageType?: "text" | "system" | "elicitation";
  text: string;
  structuredContentJson?: string | null;
  externalActorJson?: string | null;
  producedByRunId?: string | null;
  messageSequenceNumber?: number;
  createdAtUtc: string;
  attentionOrdinal: number | null;
}

export interface PreparedParticipantMessage {
  input: ParticipantMessageInput;
  fact: PreparedTranscriptFact;
  occurredAt: number;
}

export interface WorkstreamMessageRecordInput {
  messageId: string;
  clientMessageId: string;
  authorType: "human" | "agent" | "external" | "system";
  authorUserId: string | null;
  externalActorJson: string | null;
  messageType: "text" | "system" | "elicitation" | "tool" | "suggestion";
  text: string;
  structuredContentJson: string | null;
  producedByRunId: string | null;
  role?: "system" | "user" | "assistant" | "tool" | "note";
  kind?: string;
  effectIntentId?: string | null;
  toolName?: string | null;
  toolMode?: "read" | "write" | null;
  toolStatus?: "pending" | "completed" | "failed" | "ambiguous" | null;
  visibility?: "people" | "model" | "both" | "system";
  sequenceNumber: number;
  attentionOrdinal: number | null;
  createdAt?: number;
  editedAt?: number | null;
  now: number;
}

export interface PreparedWorkstreamMessageRecord {
  input: WorkstreamMessageRecordInput;
  fact: PreparedTranscriptFact;
}

export interface TranscriptCompactionContinuation {
  executionPrincipalKey: string;
  resourceVisibilityFingerprint: string;
  checkpointTemplateVersion: number;
  compactedThroughSequence: number;
  expectedInventoryRevision: number;
}

export interface TranscriptCompactionCheckpointRow {
  checkpoint_fact_id: string;
  execution_principal_key: string;
  resource_visibility_fingerprint: string;
  checkpoint_template_version: number;
  run_id: string;
  compacted_through_sequence: number;
  messages_json: string;
  summary: string;
  model: string;
}

interface LegacyParticipantPartRow extends Record<string, SqlStorageValue> {
  id: string;
  sequence_number: number;
  attention_ordinal: number | null;
  role: string;
  kind: string;
  author_type: string;
  author_user_id: string | null;
  content: string | null;
  content_ref_id: string | null;
  message_type: string;
  structured_content_json: string | null;
  tool_name: string | null;
  tool_status: string | null;
  created_at: number;
  updated_at: number;
}

interface LegacyCompactionCheckpointRow extends Record<string, SqlStorageValue> {
  projection_key: string;
  execution_principal_key: string;
  resource_visibility_fingerprint: string;
  checkpoint_template_version: number;
  run_id: string;
  compacted_through_sequence: number;
  messages_json: string;
  summary: string;
  model: string;
  context_tokens_before_compaction: number;
  context_window_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  created_at: number;
  updated_at: number;
}

interface LegacyBackfillReceiptRow extends Record<string, SqlStorageValue> {
  operator_run_id: string;
  cutover_version: number;
  cutover_applied_at: number;
  pre_backfill_bookmark: string;
  source_part_count: number;
  source_checkpoint_count: number;
  source_sha256: string;
  participant_turn_count: number;
  checkpoint_projection_count: number;
  bind_history_status: "not_reconstructable_from_legacy_aggregate_rows";
  completed_at: number;
}

interface LegacyPayloadTransferPartRow extends Record<string, SqlStorageValue> {
  id: string;
  sequence_number: number;
  attention_ordinal: number | null;
  role: string;
  author_type: string;
  author_user_id: string | null;
  external_actor_json: string | null;
  content: string | null;
  client_message_id: string | null;
  produced_by_run_id: string | null;
  message_type: string;
  structured_content_json: string | null;
  created_at: number;
  updated_at: number;
}

interface LegacyPayloadTransferReceiptRow extends Record<string, SqlStorageValue> {
  operator_run_id: string;
  pre_transfer_bookmark: string;
  source_part_count: number;
  source_attachment_count: number;
  source_mention_count: number;
  source_checkpoint_count: number;
  source_sha256: string;
  message_record_count: number;
  checkpoint_projection_count: number;
  completed_at: number;
}

export interface LegacyTranscriptBackfillOutcome {
  applied: boolean;
  verified: boolean;
  operatorRunId: string;
  cutoverAppliedAt: number;
  preBackfillBookmark: string;
  sourcePartCount: number;
  sourceCheckpointCount: number;
  sourceSha256: string;
  participantTurnCount: number;
  checkpointProjectionCount: number;
  bindHistoryStatus: "not_reconstructable_from_legacy_aggregate_rows";
  completedAt: number;
}

export interface LegacyTranscriptPayloadTransferOutcome {
  applied: boolean;
  verified: boolean;
  operatorRunId: string;
  preTransferBookmark: string;
  sourcePartCount: number;
  sourceAttachmentCount: number;
  sourceMentionCount: number;
  sourceCheckpointCount: number;
  sourceSha256: string;
  messageRecordCount: number;
  checkpointProjectionCount: number;
  completedAt: number;
}

/**
 * Canonical transcript substrate for the main work-stream child.
 *
 * Payload rows own bytes. Facts own semantic identity. Participant and Bind
 * tables are projections containing only stable references and ordering data.
 * Every multi-row state transition is one object-local SQLite transaction.
 */
export class WorkstreamTranscriptStorage {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly hasLiveTranscriptSnapshot: () => boolean = () => false,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  hasLegacyBackfillReceipt(): boolean {
    return this.legacyBackfillReceipt() !== undefined;
  }

  /**
   * Project the participant-visible pre-v27 feed into the ordered transcript.
   *
   * The old `parts.sequence_number` is a faithful order for what the member
   * could see, but it is not a faithful Bind history: assistant turns were
   * concatenated and tool protocol messages were stored in other ledgers. This
   * operation therefore moves only facts the old authority actually retained.
   * Exact compaction checkpoint arrays remain owned by their immutable legacy
   * rows and receive canonical references; no Bind-loop state is invented.
   *
   * Hash preparation and the PITR bookmark happen before the transaction. The
   * transaction re-reads and byte-compares the complete source snapshot before
   * writing, so an event interleaved across either await makes the operation
   * abort rather than commit a projection of two different source moments.
   */
  async backfillLegacyTranscript(input: {
    operatorRunId: string;
    cutoverVersion: 27;
  }): Promise<LegacyTranscriptBackfillOutcome> {
    const existing = this.legacyBackfillReceipt();
    if (existing) return this.verifyLegacyBackfill(existing, false);
    if (this.hasLiveTranscriptSnapshot()) {
      throw new Error("legacy_transcript_backfill_live_snapshot");
    }
    const cutover = this.sql.exec<{ applied_at: number } & Record<string, SqlStorageValue>>(
      `SELECT applied_at FROM _sql_schema_migrations WHERE version = ?`,
      input.cutoverVersion,
    ).toArray()[0];
    if (!cutover) throw new Error("legacy_transcript_cutover_receipt_missing");
    const cutoverAppliedAt = Number(cutover.applied_at);
    const parts = this.legacyParticipantParts(cutoverAppliedAt);
    const checkpoints = this.legacyCompactionCheckpoints(cutoverAppliedAt);
    const sourceCanonical = canonicalJson({ parts, checkpoints });
    const sourceSha256 = await sha256(sourceCanonical);
    const preparedParts = await Promise.all(parts.map(async (part) => ({
      part,
      fact: await this.prepareFact(this.legacyParticipantFact(part)),
      tool: legacyToolProjection(part),
    })));
    const preparedCheckpoints = await Promise.all(checkpoints.map(async (checkpoint) => ({
      checkpoint,
      fact: await this.prepareFact({
        factId: legacyCheckpointFactId(checkpoint),
        factKind: "legacy_compaction_checkpoint_reference",
        audience: "model",
        payload: {
          legacyProjectionKey: checkpoint.projection_key,
          runId: checkpoint.run_id,
          compactedThroughSequence: Number(checkpoint.compacted_through_sequence),
        },
        origin: derivedOrigin(
          "legacy_compaction_checkpoint",
          `${checkpoint.projection_key}:${checkpoint.run_id}:${checkpoint.compacted_through_sequence}`,
          Number(checkpoint.checkpoint_template_version),
        ),
        runId: checkpoint.run_id,
        turnId: null,
        toolCallId: null,
      }),
    })));
    const preBackfillBookmark = await this.storage.getCurrentBookmark();
    const completedAt = Date.now();
    const applied = this.storage.transactionSync(() => {
      if (this.legacyBackfillReceipt()) return false;
      // Renumbering the canonical suffix would change the meaning of an open
      // client's immutable snapshot fence. Re-check after the bookmark await,
      // inside the no-await commit boundary, so a socket that opened while the
      // source was prepared makes this attempt fail before any row moves.
      if (this.hasLiveTranscriptSnapshot()) {
        throw new Error("legacy_transcript_backfill_live_snapshot");
      }
      const activeRun = this.sql.exec<{ run_id: string } & Record<string, SqlStorageValue>>(
        `SELECT run_id FROM runs
          WHERE status IN ('admitted', 'running', 'waiting', 'steering')
          LIMIT 1`,
      ).toArray()[0];
      const activeActivity = this.sql.exec<{
        activity_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT activity_id FROM transcript_activities
          WHERE lifecycle_state = 'active'
          LIMIT 1`,
      ).toArray()[0];
      const pendingLegacyTool = this.sql.exec<{
        id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT part.id FROM parts part
          JOIN tool_effects effect ON effect.effect_intent_id = part.effect_intent_id
         WHERE part.substream_id = '0'
           AND part.visibility IN ('people', 'both')
           AND part.kind = 'tool_call'
           AND part.tool_status = 'pending'
           AND part.created_at <= ?
           AND effect.status IN ('admitted', 'executing')
          LIMIT 1`,
        cutoverAppliedAt,
      ).toArray()[0];
      if (activeRun || activeActivity || pendingLegacyTool) {
        throw new Error("legacy_transcript_backfill_not_quiescent");
      }
      const currentCanonical = canonicalJson({
        parts: this.legacyParticipantParts(cutoverAppliedAt),
        checkpoints: this.legacyCompactionCheckpoints(cutoverAppliedAt),
      });
      if (currentCanonical !== sourceCanonical) throw new Error("legacy_transcript_source_moved");
      const overlappingTurn = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
        `SELECT turn.turn_id
           FROM participant_transcript_turns turn
           JOIN parts part ON part.id = turn.turn_id
          WHERE part.created_at < ?
          LIMIT 1`,
        cutoverAppliedAt,
      ).toArray()[0];
      if (overlappingTurn) throw new Error("legacy_transcript_partial_participant_projection");

      const legacyTurnCount = preparedParts.length;
      if (legacyTurnCount > 0) {
        const currentMaximum = Number(this.sql.exec<{
          maximum: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT COALESCE(MAX(transcript_sequence), 0) AS maximum
             FROM participant_transcript_turns`,
        ).one().maximum);
        // First move every post-cutover row above both its old and final range.
        // The second update can then lower it behind the inserted legacy prefix
        // without colliding with another primary key during row-by-row writes.
        const temporaryOffset = currentMaximum + legacyTurnCount + 1;
        this.sql.exec(
          `UPDATE participant_transcript_turns
              SET transcript_sequence = transcript_sequence + ?`,
          temporaryOffset,
        );
        for (let index = 0; index < preparedParts.length; index += 1) {
          const { part, fact, tool } = preparedParts[index]!;
          const sequence = index + 1;
          this.insertFact(fact, Number(part.created_at));
          this.sql.exec(
            `INSERT INTO participant_transcript_turns
               (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
                root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
             VALUES (?, ?, 'conversation', ?, ?, ?, NULL, ?, 1, ?, ?)`,
            sequence,
            part.id,
            legacyParticipantActor(part.author_type),
            part.author_type === "member" ? part.author_user_id : null,
            fact.factId,
            part.attention_ordinal,
            part.created_at,
            part.updated_at,
          );
          this.sql.exec(
            `INSERT INTO participant_transcript_blocks
               (turn_id, block_id, block_index, block_kind, fact_id, tool_call_id,
                plugin_id, tool_name, call_index, lifecycle_state, activity_id,
                revision, updated_at)
             VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?)`,
            part.id,
            tool ? `${part.id}:tool:0` : `${part.id}:text:0`,
            tool ? "tool" : "text",
            fact.factId,
            tool?.toolCallId ?? null,
            tool?.pluginId ?? null,
            tool?.toolName ?? null,
            tool ? 0 : null,
            tool?.status ?? null,
            part.updated_at,
          );
        }
        this.sql.exec(
          `UPDATE participant_transcript_turns
              SET transcript_sequence = transcript_sequence - ? + ?
            WHERE transcript_sequence > ?`,
          temporaryOffset,
          legacyTurnCount,
          temporaryOffset,
        );
        this.sql.exec(
          `UPDATE transcript_counters
              SET next_transcript_sequence = next_transcript_sequence + ?, updated_at = ?
            WHERE id = 1`,
          legacyTurnCount,
          completedAt,
        );
      }

      for (const { checkpoint, fact } of preparedCheckpoints) {
        this.insertFact(fact, Number(checkpoint.created_at));
        this.sql.exec(
          `INSERT INTO transcript_compaction_checkpoints
             (checkpoint_fact_id, execution_principal_key, resource_visibility_fingerprint,
              checkpoint_template_version, run_id, compacted_through_sequence, model,
              context_tokens_before_compaction, context_window_tokens, input_tokens,
              output_tokens, cost_micros, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(execution_principal_key, run_id, compacted_through_sequence) DO NOTHING`,
          fact.factId,
          checkpoint.execution_principal_key,
          checkpoint.resource_visibility_fingerprint,
          checkpoint.checkpoint_template_version,
          checkpoint.run_id,
          checkpoint.compacted_through_sequence,
          checkpoint.model,
          checkpoint.context_tokens_before_compaction,
          checkpoint.context_window_tokens,
          checkpoint.input_tokens,
          checkpoint.output_tokens,
          checkpoint.cost_micros,
          checkpoint.created_at,
          checkpoint.updated_at,
        );
        const projected = this.sql.exec<{ checkpoint_fact_id: string } & Record<string, SqlStorageValue>>(
          `SELECT checkpoint_fact_id FROM transcript_compaction_checkpoints
            WHERE execution_principal_key = ? AND run_id = ?
              AND compacted_through_sequence = ?`,
          checkpoint.execution_principal_key,
          checkpoint.run_id,
          checkpoint.compacted_through_sequence,
        ).one();
        if (projected.checkpoint_fact_id !== fact.factId) {
          throw new Error("legacy_compaction_projection_conflict");
        }
      }
      this.sql.exec(
        `INSERT INTO legacy_transcript_backfills
           (id, operator_run_id, cutover_version, cutover_applied_at,
            pre_backfill_bookmark, source_part_count, source_checkpoint_count,
            source_sha256, participant_turn_count, checkpoint_projection_count,
            bind_history_status, completed_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 'not_reconstructable_from_legacy_aggregate_rows', ?)`,
        input.operatorRunId,
        input.cutoverVersion,
        cutoverAppliedAt,
        preBackfillBookmark,
        parts.length,
        checkpoints.length,
        sourceSha256,
        preparedParts.length,
        preparedCheckpoints.length,
        completedAt,
      );
      return true;
    });
    const receipt = this.legacyBackfillReceipt();
    if (!receipt) throw new Error("legacy_transcript_backfill_receipt_missing");
    return this.verifyLegacyBackfill(receipt, applied);
  }

  /**
   * Move every legacy message and checkpoint payload under canonical facts.
   *
   * This is explicit fleet work rather than constructor SQL because hashing
   * and reconciling the complete retained transcript is content-sized. The
   * old tables stay in place for the first rollout only; the stacked cleanup
   * release drops them after every authoritative object carries this receipt.
   */
  async transferLegacyTranscriptPayloadOwnership(input: {
    operatorRunId: string;
  }): Promise<LegacyTranscriptPayloadTransferOutcome> {
    const existing = this.legacyPayloadTransferReceipt();
    if (existing) return this.verifyLegacyPayloadTransfer(existing, false);
    if (this.hasLiveTranscriptSnapshot()) {
      throw new Error("legacy_transcript_payload_transfer_live_snapshot");
    }
    const source = this.legacyPayloadTransferSource();
    if (!this.legacyBackfillReceipt()) {
      const hasUnownedLegacyCheckpoint = source.checkpoints.some(
        (checkpoint) => this.exactCanonicalCheckpointFactId(checkpoint) === null,
      );
      if (source.parts.length > 0 || hasUnownedLegacyCheckpoint) {
        throw new Error("legacy_transcript_payload_transfer_requires_backfill");
      }
    }
    const sourceCanonical = canonicalJson(source);
    const sourceSha256 = await sha256(sourceCanonical);
    const preparedParts = await Promise.all(source.parts.map(async (part) => ({
      part,
      prepared: await prepareWorkstreamMessageRecord({
        messageId: part.id,
        clientMessageId: part.client_message_id ?? `legacy:${part.id}`,
        authorType: legacyMessageAuthorType(part.author_type),
        authorUserId: part.author_user_id,
        externalActorJson: part.external_actor_json,
        messageType: legacyMessageType(part.message_type),
        role: part.role as NonNullable<WorkstreamMessageRecordInput["role"]>,
        text: part.content ?? "",
        structuredContentJson: part.structured_content_json,
        producedByRunId: part.produced_by_run_id,
        sequenceNumber: Number(part.sequence_number),
        attentionOrdinal: part.attention_ordinal === null
          ? null
          : Number(part.attention_ordinal),
        now: Number(part.updated_at),
      }),
    })));
    const preparedCheckpoints = await Promise.all(source.checkpoints.map(async (checkpoint) => {
      const existingFactId = this.exactCanonicalCheckpointFactId(checkpoint);
      if (existingFactId) return { checkpoint, fact: null, factId: existingFactId };
      const fact = await prepareTranscriptFact({
        factId: `${legacyCheckpointFactId(checkpoint)}:owned`,
        factKind: "legacy_compaction_checkpoint",
        audience: "model",
        payload: {
          messages: JSON.parse(checkpoint.messages_json) as unknown,
          summary: checkpoint.summary,
          model: checkpoint.model,
          contextTokensBeforeCompaction: Number(checkpoint.context_tokens_before_compaction),
          contextWindowTokens: Number(checkpoint.context_window_tokens),
          inputTokens: Number(checkpoint.input_tokens),
          outputTokens: Number(checkpoint.output_tokens),
          costMicros: Number(checkpoint.cost_micros),
        },
        origin: derivedOrigin(
          "legacy_compaction_checkpoint",
          `${checkpoint.projection_key}:${checkpoint.run_id}:${checkpoint.compacted_through_sequence}`,
          Number(checkpoint.checkpoint_template_version),
        ),
        runId: checkpoint.run_id,
        turnId: null,
        toolCallId: null,
      });
      return { checkpoint, fact, factId: fact.factId };
    }));
    const preTransferBookmark = await this.storage.getCurrentBookmark();
    const completedAt = Date.now();
    const applied = this.storage.transactionSync(() => {
      if (this.legacyPayloadTransferReceipt()) return false;
      if (this.hasLiveTranscriptSnapshot()) {
        throw new Error("legacy_transcript_payload_transfer_live_snapshot");
      }
      const activeRun = this.sql.exec<{ run_id: string } & Record<string, SqlStorageValue>>(
        `SELECT run_id FROM runs
          WHERE status IN ('admitted', 'running', 'waiting', 'steering') LIMIT 1`,
      ).toArray()[0];
      const activeActivity = this.sql.exec<{ activity_id: string } & Record<string, SqlStorageValue>>(
        `SELECT activity_id FROM transcript_activities
          WHERE lifecycle_state = 'active' LIMIT 1`,
      ).toArray()[0];
      const mutableTool = this.sql.exec<{ id: string } & Record<string, SqlStorageValue>>(
        `SELECT part.id FROM parts part
          JOIN tool_effects effect ON effect.effect_intent_id = part.effect_intent_id
         WHERE part.kind = 'tool_call'
           AND part.tool_status = 'pending'
           AND effect.status IN ('admitted', 'executing')
         LIMIT 1`,
      ).toArray()[0];
      if (activeRun || activeActivity || mutableTool) {
        throw new Error("legacy_transcript_payload_transfer_not_quiescent");
      }
      if (canonicalJson(this.legacyPayloadTransferSource()) !== sourceCanonical) {
        throw new Error("legacy_transcript_payload_transfer_source_moved");
      }
      for (const { part, prepared } of preparedParts) {
        insertPreparedTranscriptFact(this.sql, prepared.fact, Number(part.updated_at));
        this.sql.exec(
          `INSERT INTO workstream_message_records
             (message_id, substream_id, sequence_number, attention_ordinal, fact_id,
              turn_id, turn_open_sequence, part_index, role, kind, author_type,
              author_user_id, external_actor_json, content_ref_id, content_bytes,
              content_hash, answers_message_id, input_message_ids_json, client_message_id,
              effect_intent_id, occurrence_key, produced_by_run_id, attempt_epoch,
              executor_event_seq, model_turn_id, tool_position, delivery_intent,
              input_batch_id, admission_cut_seq, tool_name, tool_mode, tool_status,
              compacts_through_sequence, compacts_through_turn_id, projected_input_hash,
              projection_key, authorization_revisions_json, lineage_fences_json,
              terminal_reason, visibility, pinned, message_type, edited_at, created_at, updated_at)
           SELECT id, substream_id, sequence_number, attention_ordinal, ?, turn_id,
                  turn_open_sequence, part_index, role, kind, author_type, author_user_id,
                  external_actor_json, content_ref_id, content_bytes, content_hash,
                  answers_part_id, input_part_ids_json, client_message_id, effect_intent_id,
                  occurrence_key, produced_by_run_id, attempt_epoch, executor_event_seq,
                  model_turn_id, tool_position, delivery_intent, input_batch_id,
                  admission_cut_seq, tool_name, tool_mode, tool_status,
                  compacts_through_sequence, compacts_through_turn_id, projected_input_hash,
                  projection_key, authorization_revisions_json, lineage_fences_json,
                  terminal_reason, visibility, pinned, message_type, edited_at, created_at, updated_at
             FROM parts WHERE id = ?
           ON CONFLICT(message_id) DO UPDATE SET fact_id = excluded.fact_id`,
          prepared.fact.factId,
          part.id,
        );
        this.sql.exec(
          `UPDATE participant_transcript_turns
              SET root_fact_id = ?, revision = revision + 1, updated_at = MAX(updated_at, ?)
            WHERE turn_id = ?`,
          prepared.fact.factId,
          completedAt,
          part.id,
        );
        this.sql.exec(
          `UPDATE participant_transcript_blocks
              SET fact_id = ?, revision = revision + 1, updated_at = MAX(updated_at, ?)
            WHERE turn_id = ?`,
          prepared.fact.factId,
          completedAt,
          part.id,
        );
      }
      this.sql.exec(
        `INSERT INTO workstream_message_attachments(message_id, resource_id, position, attachment_json)
         SELECT part_id, resource_id, position, attachment_json FROM part_attachments
         WHERE 1
         ON CONFLICT(message_id, resource_id) DO UPDATE SET
           position = excluded.position, attachment_json = excluded.attachment_json`,
      );
      this.sql.exec(
        `INSERT INTO workstream_message_mentions
           (message_id, mention_index, mention_kind, target_user_id, connector_type,
            start_offset, end_offset, attention_ordinal)
         SELECT part_id, mention_index, mention_kind, target_user_id, connector_type,
                start_offset, end_offset, attention_ordinal
           FROM part_mentions
          WHERE 1
         ON CONFLICT(message_id, mention_index) DO UPDATE SET
           mention_kind = excluded.mention_kind,
           target_user_id = excluded.target_user_id,
           connector_type = excluded.connector_type,
           start_offset = excluded.start_offset,
           end_offset = excluded.end_offset,
           attention_ordinal = excluded.attention_ordinal`,
      );
      for (const { checkpoint, fact, factId } of preparedCheckpoints) {
        if (fact) insertPreparedTranscriptFact(this.sql, fact, Number(checkpoint.updated_at));
        this.sql.exec(
          `INSERT INTO transcript_compaction_checkpoints
             (checkpoint_fact_id, execution_principal_key, resource_visibility_fingerprint,
              checkpoint_template_version, run_id, compacted_through_sequence, model,
              context_tokens_before_compaction, context_window_tokens, input_tokens,
              output_tokens, cost_micros, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(execution_principal_key, run_id, compacted_through_sequence) DO UPDATE SET
             checkpoint_fact_id = excluded.checkpoint_fact_id,
             resource_visibility_fingerprint = excluded.resource_visibility_fingerprint,
             checkpoint_template_version = excluded.checkpoint_template_version,
             model = excluded.model,
             context_tokens_before_compaction = excluded.context_tokens_before_compaction,
             context_window_tokens = excluded.context_window_tokens,
             input_tokens = excluded.input_tokens,
             output_tokens = excluded.output_tokens,
             cost_micros = excluded.cost_micros,
             updated_at = excluded.updated_at`,
          factId,
          checkpoint.execution_principal_key,
          checkpoint.resource_visibility_fingerprint,
          checkpoint.checkpoint_template_version,
          checkpoint.run_id,
          checkpoint.compacted_through_sequence,
          checkpoint.model,
          checkpoint.context_tokens_before_compaction,
          checkpoint.context_window_tokens,
          checkpoint.input_tokens,
          checkpoint.output_tokens,
          checkpoint.cost_micros,
          checkpoint.created_at,
          checkpoint.updated_at,
        );
      }
      this.sql.exec(
        `INSERT INTO legacy_transcript_payload_transfers
           (id, operator_run_id, pre_transfer_bookmark, source_part_count,
            source_attachment_count, source_mention_count, source_checkpoint_count,
            source_sha256, message_record_count, checkpoint_projection_count, completed_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.operatorRunId,
        preTransferBookmark,
        source.parts.length,
        source.attachments.length,
        source.mentions.length,
        source.checkpoints.length,
        sourceSha256,
        preparedParts.length,
        preparedCheckpoints.length,
        completedAt,
      );
      return true;
    });
    const receipt = this.legacyPayloadTransferReceipt();
    if (!receipt) throw new Error("legacy_transcript_payload_transfer_receipt_missing");
    return this.verifyLegacyPayloadTransfer(receipt, applied);
  }

  async commitBindTransition(transition: BindLoopTransition, now = Date.now()): Promise<void> {
    const previous = this.readBindProjection(transition.loopId);
    const next = applyBindLoopTransition(previous, transition);
    const previousRows = previous
      ? this.messageRows(transition.loopId, previous.stateRevision)
      : [];
    const facts = await this.materializeProjectionFacts(transition, next, previousRows);

    this.storage.transactionSync(() => {
      this.assertExpectedHead(previous, transition);
      for (const fact of facts.materials) this.insertFact(fact, now);
      this.writeBindState(transition, next, facts.factIds, now);
      if (transition.kind === "assistant_accepted") {
        if (!facts.appendedFactId) throw new Error("assistant_projection_fact_missing");
        this.projectAssistantTurn(transition, facts.appendedFactId, now);
      }
    });
  }

  async commitBindCompaction(input: {
    commit: BindCompactionCommit;
    continuation: TranscriptCompactionContinuation;
    now?: number;
  }): Promise<void> {
    const { commit, continuation } = input;
    const now = input.now ?? Date.now();
    const transition = commit.transition;
    const existing = this.sql.exec<{ payload_json: string } & Record<string, SqlStorageValue>>(
      `SELECT payload.payload_json
         FROM transcript_facts fact
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE fact.fact_id = ?`,
      `${transition.compactionEventId}:checkpoint`,
    ).toArray()[0];
    if (existing) {
      if (canonicalJson(JSON.parse(existing.payload_json)) !== canonicalJson(commit.checkpoint)) {
        throw new Error("compaction_event_payload_conflict");
      }
      return;
    }
    const previous = this.readBindProjection(transition.loopId);
    const next = applyBindLoopTransition(previous, transition);
    const previousRows = previous
      ? this.messageRows(transition.loopId, previous.stateRevision)
      : [];
    const facts = await this.materializeProjectionFacts(transition, next, previousRows);
    const checkpointMaterial: TranscriptFactMaterial = {
      factId: `${transition.compactionEventId}:checkpoint`,
      factKind: "compaction_checkpoint",
      audience: "model",
      payload: commit.checkpoint,
      origin: canonicalOrigin(),
      runId: transition.loopId,
      turnId: null,
      toolCallId: null,
    };
    const statusMaterial: TranscriptFactMaterial = {
      factId: `${transition.compactionEventId}:status`,
      factKind: "compaction_status",
      audience: "participant",
      payload: { compactionEventId: transition.compactionEventId, trigger: commit.checkpoint.trigger },
      origin: canonicalOrigin(),
      runId: transition.loopId,
      turnId: transition.compactionEventId,
      toolCallId: null,
    };
    const [checkpointFact, statusFact] = await Promise.all([
      this.prepareFact(checkpointMaterial),
      this.prepareFact(statusMaterial),
    ]);

    this.storage.transactionSync(() => {
      this.assertExpectedHead(previous, transition);
      const inventoryRevision = this.sql.exec<{ revision: number } & Record<string, SqlStorageValue>>(
        `SELECT revision FROM resource_inventory_revision WHERE id = 1`,
      ).toArray()[0]?.revision ?? 0;
      if (Number(inventoryRevision) !== continuation.expectedInventoryRevision) {
        throw new Error("compaction_resource_visibility_changed");
      }
      for (const fact of [...facts.materials, checkpointFact, statusFact]) this.insertFact(fact, now);
      this.writeBindState(transition, next, facts.factIds, now);
      this.sql.exec(
        `INSERT INTO transcript_compaction_checkpoints
           (checkpoint_fact_id, execution_principal_key, resource_visibility_fingerprint,
            checkpoint_template_version, run_id, compacted_through_sequence, model,
            context_tokens_before_compaction, context_window_tokens, input_tokens,
            output_tokens, cost_micros, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(execution_principal_key, run_id, compacted_through_sequence) DO UPDATE SET
           checkpoint_fact_id = excluded.checkpoint_fact_id,
           resource_visibility_fingerprint = excluded.resource_visibility_fingerprint,
           model = excluded.model,
           context_tokens_before_compaction = excluded.context_tokens_before_compaction,
           context_window_tokens = excluded.context_window_tokens,
           input_tokens = excluded.input_tokens,
           output_tokens = excluded.output_tokens,
           cost_micros = excluded.cost_micros,
           updated_at = excluded.updated_at`,
        checkpointFact.factId,
        continuation.executionPrincipalKey,
        continuation.resourceVisibilityFingerprint,
        continuation.checkpointTemplateVersion,
        transition.loopId,
        continuation.compactedThroughSequence,
        commit.checkpoint.model,
        commit.checkpoint.contextTokensBeforeCompaction,
        commit.checkpoint.contextWindowTokens,
        commit.checkpoint.inputTokens,
        commit.checkpoint.outputTokens,
        Math.max(0, Math.round(commit.checkpoint.costCents * 10_000)),
        now,
        now,
      );
      this.insertParticipantStatus({
        turnId: transition.compactionEventId,
        factId: statusFact.factId,
        activityId: transition.compactionEventId,
        now,
      });
      this.sql.exec(
        `UPDATE transcript_activity_intervals
            SET stopped_at = ?, duration_ms = MAX(0, ? - started_at), revision = revision + 1
          WHERE activity_id = ? AND stopped_at IS NULL`,
        now,
        now,
        transition.compactionEventId,
      );
      this.sql.exec(
        `UPDATE transcript_activities
            SET label = 'Context automatically compacted', lifecycle_state = 'completed',
                revision = revision + 1, updated_at = ?
          WHERE activity_id = ? AND lifecycle_state = 'active'`,
        now,
        transition.compactionEventId,
      );
      this.sql.exec(
        `UPDATE participant_transcript_turns
            SET revision = revision + 1, updated_at = ?
          WHERE turn_id = ?`,
        now,
        transition.compactionEventId,
      );
    });
  }

  async reserveCompactionStatus(input: {
    compactionEventId: string;
    runId: string;
    trigger: "manual" | "auto";
    occurredAtUtc: string;
  }): Promise<void> {
    const now = Date.parse(input.occurredAtUtc);
    if (!Number.isFinite(now)) throw new Error("invalid_compaction_timestamp");
    const material: TranscriptFactMaterial = {
      factId: `${input.compactionEventId}:status`,
      factKind: "compaction_status",
      audience: "participant",
      payload: { compactionEventId: input.compactionEventId, trigger: input.trigger },
      origin: canonicalOrigin(),
      runId: input.runId,
      turnId: input.compactionEventId,
      toolCallId: null,
    };
    const fact = await this.prepareFact(material);
    this.storage.transactionSync(() => {
      this.insertFact(fact, now);
      this.insertParticipantStatus({
        turnId: input.compactionEventId,
        factId: fact.factId,
        activityId: input.compactionEventId,
        now,
      });
    });
  }

  compactionCheckpoint(input: {
    executionPrincipalKey: string;
    fence?: { runId: string; compactedThroughSequence: number };
  }): TranscriptCompactionCheckpointRow | undefined {
    const where = input.fence
      ? `checkpoint.execution_principal_key = ? AND checkpoint.run_id = ?
           AND checkpoint.compacted_through_sequence = ?`
      : `checkpoint.execution_principal_key = ?`;
    const params = input.fence
      ? [input.executionPrincipalKey, input.fence.runId, input.fence.compactedThroughSequence]
      : [input.executionPrincipalKey];
    return this.sql.exec<TranscriptCompactionCheckpointRow & Record<string, SqlStorageValue>>(
      `SELECT checkpoint.checkpoint_fact_id, checkpoint.execution_principal_key,
              checkpoint.resource_visibility_fingerprint,
              checkpoint.checkpoint_template_version, checkpoint.run_id,
              checkpoint.compacted_through_sequence, checkpoint.model,
              COALESCE(
                json_extract(payload.payload_json, '$.messages'), legacy.messages_json
              ) AS messages_json,
              COALESCE(
                json_extract(payload.payload_json, '$.summary'), legacy.summary
              ) AS summary
         FROM transcript_compaction_checkpoints checkpoint
         JOIN transcript_facts fact ON fact.fact_id = checkpoint.checkpoint_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         LEFT JOIN compaction_checkpoints legacy
           ON fact.fact_kind = 'legacy_compaction_checkpoint_reference'
          AND legacy.projection_key = json_extract(payload.payload_json, '$.legacyProjectionKey')
          AND legacy.run_id = json_extract(payload.payload_json, '$.runId')
          AND legacy.compacted_through_sequence =
              json_extract(payload.payload_json, '$.compactedThroughSequence')
        WHERE ${where}
        ORDER BY checkpoint.compacted_through_sequence DESC, checkpoint.updated_at DESC
        LIMIT 1`,
      ...params,
    ).toArray()[0];
  }

  recordProviderBoundary(boundary: BindProviderBoundary, now = Date.now()): void {
    if (boundary.projectedHash !== boundary.bindHash) throw new Error("bind_loop_projection_mismatch");
    this.storage.transactionSync(() => {
      const head = this.sql.exec<{ state_revision: number } & Record<string, SqlStorageValue>>(
        `SELECT state_revision FROM bind_loop_heads WHERE loop_id = ?`,
        boundary.loopId,
      ).toArray()[0];
      if (!head || Number(head.state_revision) !== boundary.stateRevision) {
        throw new Error("bind_provider_boundary_stale_projection");
      }
      this.sql.exec(
        `INSERT INTO bind_provider_boundaries
           (loop_id, state_revision, generation, system_projection_revision,
            projector_version, projected_hash, bind_hash, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(loop_id, state_revision) DO UPDATE SET
           projected_hash = excluded.projected_hash,
           bind_hash = excluded.bind_hash,
           verified_at = excluded.verified_at
         WHERE bind_provider_boundaries.projected_hash = excluded.projected_hash
           AND bind_provider_boundaries.bind_hash = excluded.bind_hash`,
        boundary.loopId,
        boundary.stateRevision,
        boundary.generation,
        boundary.systemProjectionRevision,
        boundary.projectorVersion,
        boundary.projectedHash,
        boundary.bindHash,
        now,
      );
    });
  }

  async appendParticipantMessage(input: ParticipantMessageInput): Promise<number> {
    const prepared = await this.prepareParticipantMessage(input);
    return this.storage.transactionSync(() => this.appendPreparedParticipantMessage(prepared));
  }

  async prepareParticipantMessage(input: ParticipantMessageInput): Promise<PreparedParticipantMessage> {
    const now = Date.parse(input.createdAtUtc);
    if (!Number.isFinite(now)) throw new Error("invalid_participant_message_timestamp");
    const material: TranscriptFactMaterial = {
      factId: `${input.turnId}:message`,
      factKind: "participant_message",
      audience: "shared",
      payload: {
        role: input.actor === "assistant"
          ? "assistant"
          : input.actor === "system" ? "system" : "user",
        content: input.text,
        structuredContent: input.structuredContentJson == null
          ? null
          : JSON.parse(input.structuredContentJson) as unknown,
      },
      origin: canonicalOrigin(),
      runId: input.producedByRunId ?? null,
      turnId: input.turnId,
      toolCallId: null,
    };
    const fact = await this.prepareFact(material);
    return { input, fact, occurredAt: now };
  }

  /** Join an already-open object-local transaction; preparation performs no writes. */
  appendPreparedParticipantMessage(prepared: PreparedParticipantMessage): number {
      const { input, fact, occurredAt: now } = prepared;
      const existing = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
        `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
        input.turnId,
      ).toArray()[0];
      if (existing) return Number(existing.transcript_sequence);
      this.insertFact(fact, now);
      const sequence = this.allocateTranscriptSequence(now);
      this.sql.exec(
        `INSERT INTO participant_transcript_turns
           (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
            root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
         VALUES (?, ?, 'conversation', ?, ?, ?, NULL, ?, 1, ?, ?)`,
        sequence,
        input.turnId,
        input.actor,
        input.authorUserId,
        fact.factId,
        input.attentionOrdinal,
        now,
        now,
      );
      this.sql.exec(
        `INSERT INTO participant_transcript_blocks
           (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
         VALUES (?, ?, 0, 'text', ?, 1, ?)`,
        input.turnId,
        `${input.turnId}:text:0`,
        fact.factId,
        now,
      );
      insertWorkstreamMessageRecord(this.sql, {
        input: {
          messageId: input.turnId,
          clientMessageId: input.clientMessageId ?? input.turnId,
          authorType: input.actor === "human" ? "human" : input.actor === "assistant" ? "agent" : input.actor,
          authorUserId: input.authorUserId,
          externalActorJson: input.externalActorJson ?? null,
          messageType: input.messageType ?? "text",
          text: input.text,
          structuredContentJson: input.structuredContentJson ?? null,
          producedByRunId: input.producedByRunId ?? null,
          sequenceNumber: input.messageSequenceNumber ?? sequence,
          attentionOrdinal: input.attentionOrdinal,
          now,
        },
        fact,
      });
      return sequence;
  }

  async upsertToolLifecycle(input: {
    toolCallId: string;
    pluginId: string | null;
    toolName: string;
    status: "started" | "completed" | "failed" | "cancelled";
    participantSafeInput?: unknown;
    participantSafeResult?: unknown;
    error?: string | null;
    occurredAtUtc: string;
  }): Promise<void> {
    const now = Date.parse(input.occurredAtUtc);
    if (!Number.isFinite(now)) throw new Error("invalid_tool_lifecycle_timestamp");
    const existingBlock = this.sql.exec<{
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT payload.payload_json
         FROM participant_transcript_blocks block
         JOIN transcript_facts fact ON fact.fact_id = block.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE block.tool_call_id = ?`,
      input.toolCallId,
    ).toArray()[0];
    if (!existingBlock) throw new Error("participant_tool_plan_missing");
    const previousPayload = JSON.parse(existingBlock.payload_json) as Record<string, unknown>;
    const payload = {
      participantSafeInput: input.participantSafeInput
        ?? previousPayload.participantSafeInput
        ?? null,
      participantSafeResult: input.participantSafeResult ?? null,
      error: input.error ?? null,
      status: input.status,
    };
    const material: TranscriptFactMaterial = {
      factId: `${input.toolCallId}:participant:${input.status}`,
      factKind: "participant_tool_lifecycle",
      audience: "participant",
      payload,
      origin: canonicalOrigin(),
      runId: null,
      turnId: null,
      toolCallId: input.toolCallId,
    };
    const fact = await this.prepareFact(material);
    this.storage.transactionSync(() => {
      this.insertFact(fact, now);
      const block = this.sql.exec<{
        turn_id: string;
        block_index: number;
        lifecycle_state: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT turn_id, block_index, lifecycle_state
           FROM participant_transcript_blocks WHERE tool_call_id = ?`,
        input.toolCallId,
      ).toArray()[0];
      if (!block) throw new Error("participant_tool_plan_missing");
      if (terminalToolStatus(String(block.lifecycle_state)) && block.lifecycle_state !== input.status) return;
      this.sql.exec(
        `UPDATE participant_transcript_blocks
            SET fact_id = ?, plugin_id = COALESCE(plugin_id, ?),
                tool_name = ?, lifecycle_state = ?, activity_id = ?,
                revision = revision + 1, updated_at = ?
          WHERE tool_call_id = ?`,
        fact.factId,
        input.pluginId,
        input.toolName,
        input.status,
        `${input.toolCallId}:activity`,
        now,
        input.toolCallId,
      );
      this.sql.exec(
        `UPDATE participant_transcript_turns
            SET revision = revision + 1, updated_at = ?
          WHERE turn_id = ?`,
        now,
        block.turn_id,
      );
    });
  }

  upsertActivity(edge: ActivityEdge): TranscriptActivity {
    const occurredAt = Date.parse(edge.occurredAtUtc);
    if (!Number.isFinite(occurredAt)) throw new Error("invalid_activity_timestamp");
    this.storage.transactionSync(() => {
      const existing = this.sql.exec<ActivityRow>(
        `SELECT activity_id, parent_activity_id, scope, subject_id, call_index, label,
                lifecycle_state, revision
           FROM transcript_activities WHERE activity_id = ?`,
        edge.activityId,
      ).toArray()[0];
      if (existing && Number(existing.revision) >= edge.revision) return;
      if (existing && existing.parent_activity_id !== edge.parentActivityId) {
        throw new Error("activity_parent_cannot_change");
      }
      if (edge.parentActivityId) {
        const parent = this.sql.exec<{ activity_id: string } & Record<string, SqlStorageValue>>(
          `SELECT activity_id FROM transcript_activities WHERE activity_id = ?`,
          edge.parentActivityId,
        ).toArray()[0];
        if (!parent) throw new Error("activity_parent_missing");
      }
      const requestedState = activityState(edge.action);
      const childActive = existing && edge.action !== "start"
        ? this.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
          `SELECT COUNT(*) AS count FROM transcript_activities
            WHERE parent_activity_id = ? AND lifecycle_state = 'active'`,
          edge.activityId,
        ).one().count
        : 0;
      const nextState = Number(childActive) > 0 ? "active" : requestedState;
      this.sql.exec(
        `INSERT INTO transcript_activities
           (activity_id, parent_activity_id, scope, subject_id, call_index, label,
            lifecycle_state, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(activity_id) DO UPDATE SET
           label = excluded.label,
           lifecycle_state = excluded.lifecycle_state,
           revision = excluded.revision,
           updated_at = excluded.updated_at
         WHERE excluded.revision > transcript_activities.revision
           AND (
             transcript_activities.lifecycle_state = 'active'
             OR (
               excluded.lifecycle_state = 'active'
               AND transcript_activities.lifecycle_state = 'completed'
             )
           )`,
        edge.activityId,
        edge.parentActivityId,
        edge.scope,
        edge.subjectId,
        edge.callIndex,
        edge.label,
        nextState,
        edge.revision,
        occurredAt,
        occurredAt,
      );
      if (edge.action === "start") {
        this.sql.exec(
          `INSERT INTO transcript_activity_intervals
             (activity_id, interval_id, started_at, stopped_at, duration_ms, revision)
           VALUES (?, ?, ?, NULL, NULL, ?)
           ON CONFLICT(activity_id, interval_id) DO NOTHING`,
          edge.activityId,
          `${edge.activityId}:${edge.revision}`,
          occurredAt,
          edge.revision,
        );
      } else if (nextState !== "active") {
        this.sql.exec(
          `UPDATE transcript_activity_intervals
              SET stopped_at = ?, duration_ms = MAX(0, ? - started_at), revision = ?
            WHERE activity_id = ? AND stopped_at IS NULL`,
          occurredAt,
          occurredAt,
          edge.revision,
          edge.activityId,
        );
      }
    });
    const activity = this.activity(edge.activityId);
    if (!activity) throw new Error("activity_upsert_failed");
    return activity;
  }

  createOpeningSnapshot(input: {
    unreadHighWaterAttentionOrdinal: number | null;
    now?: number;
  }): WorkstreamTranscriptSnapshot {
    const now = input.now ?? Date.now();
    const snapshotId = uuidV7(now);
    return this.storage.transactionSync(() => {
      const counter = this.sql.exec<{
        next_transcript_sequence: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
      ).one();
      const snapshotThrough = Number(counter.next_transcript_sequence) - 1;
      const realtime = this.sql.exec<{ event_sequence: number } & Record<string, SqlStorageValue>>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ).toArray()[0];
      const eventSequence = realtime ? Number(realtime.event_sequence) : 0;
      const opening = this.openingRanges(
        snapshotId,
        snapshotThrough,
        now,
        input.unreadHighWaterAttentionOrdinal,
      );
      const activeTurns = this.activeTurns(snapshotThrough);
      const openingTurns = opening.ranges.flatMap((range) => range.turns);
      const activities = this.activitiesForTurns([...openingTurns, ...activeTurns], now, true);
      return {
        snapshotId,
        snapshotThrough,
        eventSequence,
        snapshotAtUtc: new Date(now).toISOString(),
        unreadAnchorSequence: opening.unreadAnchorSequence,
        unreadReason: opening.unreadReason,
        ranges: opening.ranges,
        activities,
        activeActivities: activities.filter((activity) => activity.state === "active"),
        activeTurns,
      };
    });
  }

  range(
    snapshot: Pick<WorkstreamTranscriptSnapshot, "snapshotId" | "snapshotThrough" | "snapshotAtUtc">,
    requested: TranscriptRange,
    purpose: TranscriptRangeResult["purpose"] = "requested",
    includeActivities = true,
  ): TranscriptRangeResult {
    const snapshotAt = Date.parse(snapshot.snapshotAtUtc);
    if (!Number.isFinite(snapshotAt)) throw new Error("invalid_transcript_snapshot_timestamp");
    const upper = snapshot.snapshotThrough + 1;
    const startInclusive = Math.min(Math.max(1, requested.startInclusive), upper);
    const endExclusive = Math.min(Math.max(startInclusive, requested.endExclusive), upper);
    const turns = this.turnsInRange(startInclusive, endExclusive);
    return {
      purpose,
      requested,
      covered: { startInclusive, endExclusive },
      turns,
      activities: includeActivities
        ? this.activitiesForTurns(turns, snapshotAt)
        : [],
    };
  }

  participantTurn(turnId: string): TranscriptTurn | null {
    const row = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
      turnId,
    ).toArray()[0];
    if (!row) return null;
    return this.turnsInRange(Number(row.transcript_sequence), Number(row.transcript_sequence) + 1)[0] ?? null;
  }

  participantTurnForTool(toolCallId: string): TranscriptTurn | null {
    const row = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM participant_transcript_blocks WHERE tool_call_id = ?`,
      toolCallId,
    ).toArray()[0];
    return row ? this.participantTurn(row.turn_id) : null;
  }

  setParticipantTurnAttentionOrdinal(input: {
    turnId: string;
    attentionOrdinal: number;
  }): TranscriptTurn | null {
    this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE participant_transcript_turns
            SET attention_ordinal = ?, revision = revision + 1, updated_at = ?
          WHERE turn_id = ?
            AND (attention_ordinal IS NULL OR attention_ordinal = ?)`,
        input.attentionOrdinal,
        Date.now(),
        input.turnId,
        input.attentionOrdinal,
      );
    });
    return this.participantTurn(input.turnId);
  }

  readBindProjection(loopId: string): BindLoopProjectionState | null {
    const head = this.sql.exec<{
      generation: number;
      state_revision: number;
      system_projection_revision: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT generation, state_revision, system_projection_revision
         FROM bind_loop_heads WHERE loop_id = ?`,
      loopId,
    ).toArray()[0];
    if (!head) return null;
    const state = this.sql.exec<{
      system_renderer_version: string;
      system_input_hash: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT system_renderer_version, system_input_hash
         FROM bind_loop_states WHERE loop_id = ? AND state_revision = ?`,
      loopId,
      head.state_revision,
    ).one();
    const messages = this.messageRows(loopId, Number(head.state_revision));
      if (messages.length === 0) throw new Error("bind_loop_state_empty");
    return {
      loopId,
      generation: Number(head.generation),
      stateRevision: Number(head.state_revision),
      systemProjection: {
        revision: Number(head.system_projection_revision),
        rendererVersion: state.system_renderer_version,
        inputHash: state.system_input_hash,
        message: JSON.parse(messages[0]!.payload_json) as BindLoopMessage,
      },
      nonSystemMessages: messages.slice(1).map((row) =>
        JSON.parse(row.payload_json) as BindLoopMessage),
    };
  }

  private openingRanges(
    snapshotId: string,
    snapshotThrough: number,
    snapshotAt: number,
    unreadAttentionOrdinal: number | null,
  ): {
    ranges: TranscriptRangeResult[];
    unreadAnchorSequence: number | null;
    unreadReason: "no_unread" | "anchor_unavailable" | null;
  } {
    const fence = {
      snapshotId,
      snapshotThrough,
      snapshotAtUtc: new Date(snapshotAt).toISOString(),
    };
    if (snapshotThrough === 0) {
      return {
        ranges: [],
        unreadAnchorSequence: null,
        unreadReason: unreadAttentionOrdinal === null ? "no_unread" : "anchor_unavailable",
      };
    }
    const latestConversation = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT transcript_sequence FROM participant_transcript_turns
        INDEXED BY participant_transcript_latest_conversation_idx
        WHERE entry_kind = 'conversation' AND transcript_sequence <= ?
        ORDER BY transcript_sequence DESC LIMIT 5`,
      snapshotThrough,
    ).toArray();
    let latestRange: TranscriptRange | null = null;
    if (latestConversation.length > 0) {
      latestRange = {
        startInclusive: Number(latestConversation[latestConversation.length - 1]!.transcript_sequence),
        endExclusive: snapshotThrough + 1,
      };
    } else {
      const latestStatus = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
        `SELECT transcript_sequence FROM participant_transcript_turns
          INDEXED BY participant_transcript_status_idx
          WHERE entry_kind = 'status' AND transcript_sequence <= ?
          ORDER BY transcript_sequence DESC LIMIT 5`,
        snapshotThrough,
      ).toArray();
      if (latestStatus.length > 0) {
        latestRange = {
          startInclusive: Number(latestStatus[latestStatus.length - 1]!.transcript_sequence),
          endExclusive: snapshotThrough + 1,
        };
      }
    }
    let unreadRange: TranscriptRange | null = null;
    let unreadAnchorSequence: number | null = null;
    if (unreadAttentionOrdinal !== null) {
      const anchor = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
        `SELECT transcript_sequence FROM participant_transcript_turns
          INDEXED BY participant_transcript_attention_idx
          WHERE entry_kind = 'conversation' AND attention_ordinal >= ?
            AND transcript_sequence <= ?
          ORDER BY attention_ordinal, transcript_sequence LIMIT 1`,
        unreadAttentionOrdinal,
        snapshotThrough,
      ).toArray()[0];
      if (anchor) {
        unreadAnchorSequence = Number(anchor.transcript_sequence);
        const around = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
          `SELECT transcript_sequence FROM (
             SELECT transcript_sequence FROM participant_transcript_turns
              INDEXED BY participant_transcript_latest_conversation_idx
              WHERE entry_kind = 'conversation' AND transcript_sequence < ?
              ORDER BY transcript_sequence DESC LIMIT 5
           )
           UNION ALL SELECT ?
           UNION ALL
           SELECT transcript_sequence FROM (
             SELECT transcript_sequence FROM participant_transcript_turns
              INDEXED BY participant_transcript_latest_conversation_idx
              WHERE entry_kind = 'conversation' AND transcript_sequence > ?
                AND transcript_sequence <= ?
              ORDER BY transcript_sequence LIMIT 5
           )
           ORDER BY transcript_sequence`,
          anchor.transcript_sequence,
          anchor.transcript_sequence,
          anchor.transcript_sequence,
          snapshotThrough,
        ).toArray();
        if (around.length > 0) {
          unreadRange = {
            startInclusive: Number(around[0]!.transcript_sequence),
            endExclusive: Number(around[around.length - 1]!.transcript_sequence) + 1,
          };
        }
      }
    }
    if (unreadRange && latestRange
      && unreadRange.startInclusive === latestRange.startInclusive
      && unreadRange.endExclusive === latestRange.endExclusive) {
      return {
        ranges: [this.range(fence, unreadRange, "unread_and_latest", false)],
        unreadAnchorSequence,
        unreadReason: null,
      };
    }
    return {
      ranges: [
        ...(unreadRange ? [this.range(fence, unreadRange, "unread" as const, false)] : []),
        ...(latestRange ? [this.range(fence, latestRange, "latest" as const, false)] : []),
      ],
      unreadAnchorSequence,
      unreadReason: unreadAttentionOrdinal === null
        ? "no_unread"
        : unreadRange ? null : "anchor_unavailable",
    };
  }

  private turnsInRange(startInclusive: number, endExclusive: number): TranscriptTurn[] {
    if (endExclusive <= startInclusive) return [];
    const turns = this.sql.exec<TurnRow>(
      `SELECT turn.transcript_sequence, turn.turn_id, turn.entry_kind, turn.actor,
              turn.author_user_id, part.client_message_id, part.external_actor_json,
              turn.activity_id, turn.attention_ordinal, turn.revision, turn.created_at
         FROM participant_transcript_turns AS turn INDEXED BY participant_transcript_sequence_idx
         LEFT JOIN parts part ON part.id = turn.turn_id
        WHERE turn.transcript_sequence >= ? AND turn.transcript_sequence < ?
        ORDER BY turn.transcript_sequence`,
      startInclusive,
      endExclusive,
    ).toArray();
    if (turns.length === 0) return [];
    const placeholders = turns.map(() => "?").join(", ");
    const blocks = this.sql.exec<BlockRow>(
      `SELECT block.turn_id, block.block_id, block.block_index, block.block_kind,
              payload.payload_json, block.tool_call_id, block.plugin_id,
              block.tool_name, block.call_index, block.lifecycle_state, block.activity_id
              , part.content AS part_content, part.message_type AS part_message_type,
              part.structured_content_json AS part_structured_content_json
         FROM participant_transcript_blocks block
         JOIN transcript_facts fact ON fact.fact_id = block.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         LEFT JOIN parts part ON part.id = block.turn_id
        WHERE block.turn_id IN (${placeholders})
        ORDER BY block.turn_id, block.block_index`,
      ...turns.map((turn) => turn.turn_id),
    ).toArray();
    const mentions = this.sql.exec<TranscriptMentionRow>(
      `SELECT part_id, mention_kind, target_user_id, connector_type,
              start_offset, end_offset
         FROM part_mentions
        WHERE part_id IN (${placeholders})
        ORDER BY part_id, mention_index`,
      ...turns.map((turn) => turn.turn_id),
    ).toArray();
    const mentionsByTurn = new Map<string, TranscriptMentionRow[]>();
    for (const mention of mentions) {
      const current = mentionsByTurn.get(mention.part_id) ?? [];
      current.push(mention);
      mentionsByTurn.set(mention.part_id, current);
    }
    const attachments = this.sql.exec<TranscriptAttachmentRow>(
      `SELECT attachment.part_id, attachment.resource_id, attachment.position,
              json_extract(link.resource_json, '$.title') AS title,
              json_extract(link.resource_json, '$.mimeType') AS mime_type,
              json_extract(link.resource_json, '$.contentRef') AS content_ref,
              json_extract(link.resource_json, '$.metadata') AS metadata_json,
              attachment.attachment_json, link.attached_at
         FROM part_attachments attachment
         JOIN workstream_resource_links link ON link.resource_id = attachment.resource_id
        WHERE attachment.part_id IN (${placeholders})
        ORDER BY attachment.part_id, attachment.position`,
      ...turns.map((turn) => turn.turn_id),
    ).toArray();
    const attachmentsByTurn = new Map<string, TranscriptAttachmentRow[]>();
    for (const attachment of attachments) {
      const current = attachmentsByTurn.get(attachment.part_id) ?? [];
      current.push(attachment);
      attachmentsByTurn.set(attachment.part_id, current);
    }
    const blocksByTurn = new Map<string, TranscriptBlock[]>();
    for (const block of blocks) {
      const hydrated = hydrateBlock(
        block,
        mentionsByTurn.get(block.turn_id) ?? [],
        attachmentsByTurn.get(block.turn_id) ?? [],
      );
      const current = blocksByTurn.get(block.turn_id) ?? [];
      current.push(hydrated);
      blocksByTurn.set(block.turn_id, current);
    }
    return turns.map((turn) => ({
      transcriptSequence: Number(turn.transcript_sequence),
      turnId: turn.turn_id,
      entryKind: turn.entry_kind as TranscriptTurn["entryKind"],
      actor: turn.actor as TranscriptTurn["actor"],
      authorUserId: turn.author_user_id,
      clientMessageId: turn.client_message_id,
      externalActor: parseExternalActor(turn.external_actor_json),
      attentionOrdinal: turn.attention_ordinal === null ? null : Number(turn.attention_ordinal),
      createdAtUtc: new Date(Number(turn.created_at)).toISOString(),
      revision: Number(turn.revision),
      blocks: blocksByTurn.get(turn.turn_id) ?? [],
      activityId: turn.activity_id,
      turnManifestRef: null,
      manifestByteLength: null,
      manifestSha256: null,
    }));
  }

  private activeTurns(snapshotThrough: number): TranscriptTurn[] {
    const rows = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT turn.transcript_sequence
         FROM participant_transcript_turns turn
         JOIN transcript_activities activity ON activity.activity_id = turn.activity_id
        WHERE activity.lifecycle_state = 'active' AND turn.transcript_sequence <= ?
        ORDER BY turn.transcript_sequence`,
      snapshotThrough,
    ).toArray();
    return rows.flatMap((row) => this.turnsInRange(
      Number(row.transcript_sequence),
      Number(row.transcript_sequence) + 1,
    ));
  }

  private activitiesForTurns(
    turns: TranscriptTurn[],
    snapshotAt: number,
    includeActive = false,
  ): TranscriptActivity[] {
    const activityIds = new Set<string>();
    for (const turn of turns) {
      if (turn.activityId) activityIds.add(turn.activityId);
      for (const block of turn.blocks) {
        if ("activityId" in block && block.activityId) activityIds.add(block.activityId);
      }
    }
    return this.activitiesForIds([...activityIds], snapshotAt, includeActive);
  }

  private activitiesForIds(
    activityIds: string[],
    snapshotAt: number,
    includeActive: boolean,
  ): TranscriptActivity[] {
    if (activityIds.length === 0 && !includeActive) return [];
    const idPlaceholders = activityIds.map(() => "?").join(", ");
    const seedClauses = [
      ...(activityIds.length > 0
        ? [`SELECT activity_id FROM transcript_activities WHERE activity_id IN (${idPlaceholders})`]
        : []),
      ...(includeActive
        ? ["SELECT activity_id FROM transcript_activities WHERE lifecycle_state = 'active'"]
        : []),
    ];
    const rows = this.sql.exec<ActivityRow>(
      `WITH RECURSIVE selected(activity_id) AS (
         ${seedClauses.join(" UNION ")}
         UNION
         SELECT activity.parent_activity_id
           FROM transcript_activities activity
           JOIN selected ON selected.activity_id = activity.activity_id
          WHERE activity.parent_activity_id IS NOT NULL
       )
       SELECT activity.activity_id, activity.parent_activity_id, activity.scope,
              activity.subject_id, activity.call_index, activity.label,
              activity.lifecycle_state, activity.revision
         FROM transcript_activities activity
         JOIN selected ON selected.activity_id = activity.activity_id
        ORDER BY activity.created_at, activity.parent_activity_id, activity.call_index`,
      ...activityIds,
    ).toArray();
    return this.hydrateActivities(rows, snapshotAt);
  }

  private activity(activityId: string): TranscriptActivity | null {
    const row = this.sql.exec<ActivityRow>(
      `SELECT activity_id, parent_activity_id, scope, subject_id, call_index,
              label, lifecycle_state, revision
         FROM transcript_activities WHERE activity_id = ?`,
      activityId,
    ).toArray()[0];
    return row ? this.hydrateActivities([row], Date.now())[0] ?? null : null;
  }

  private hydrateActivities(rows: ActivityRow[], snapshotAt: number): TranscriptActivity[] {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const intervals = this.sql.exec<IntervalRow>(
      `SELECT activity_id, interval_id, started_at, stopped_at, duration_ms, revision
         FROM transcript_activity_intervals
        WHERE activity_id IN (${placeholders})
        ORDER BY activity_id, started_at`,
      ...rows.map((row) => row.activity_id),
    ).toArray();
    const intervalsByActivity = new Map<string, IntervalRow[]>();
    for (const interval of intervals) {
      const current = intervalsByActivity.get(interval.activity_id) ?? [];
      current.push(interval);
      intervalsByActivity.set(interval.activity_id, current);
    }
    return sortActivities(rows.map((row) => ({
      activityId: row.activity_id,
      parentActivityId: row.parent_activity_id,
      scope: row.scope as TranscriptActivity["scope"],
      subjectId: row.subject_id,
      callIndex: row.call_index === null ? null : Number(row.call_index),
      label: row.label,
      state: row.lifecycle_state as TranscriptActivity["state"],
      intervals: (intervalsByActivity.get(row.activity_id) ?? []).map((interval) => ({
        intervalId: interval.interval_id,
        startedAtUtc: new Date(Number(interval.started_at)).toISOString(),
        stoppedAtUtc: interval.stopped_at === null ? null : new Date(Number(interval.stopped_at)).toISOString(),
        durationMs: interval.duration_ms === null ? null : Number(interval.duration_ms),
        elapsedMsAtSnapshot: interval.stopped_at === null
          ? Math.max(0, snapshotAt - Number(interval.started_at))
          : null,
        revision: Number(interval.revision),
      })),
      revision: Number(row.revision),
    })));
  }

  private async materializeProjectionFacts(
    transition: BindLoopTransition,
    next: BindLoopProjectionState,
    previousRows: MessageProjectionRow[],
  ): Promise<{ materials: PreparedTranscriptFact[]; factIds: string[]; appendedFactId: string | null }> {
    const nextMessages = projectBindLoopMessages(next);
    const reusable = new Map<string, string[]>();
    for (const row of previousRows) {
      const key = JSON.stringify(JSON.parse(row.payload_json));
      reusable.set(key, [...(reusable.get(key) ?? []), row.fact_id]);
    }
    const materials: PreparedTranscriptFact[] = [];
    const factIds: string[] = [];
    let appendedFactId: string | null = null;
    for (let position = 0; position < nextMessages.length; position += 1) {
      const message = nextMessages[position]!;
      const key = JSON.stringify(message);
      const suffix = position === nextMessages.length - 1
        && ["assistant_accepted", "tool_result_accepted", "protocol_user_appended"].includes(transition.kind)
        ? transition.kind
        : `message:${position}`;
      const reuse = reusable.get(key)?.shift();
      if (reuse) {
        factIds.push(reuse);
        if (suffix === "assistant_accepted") appendedFactId = reuse;
        continue;
      }
      const factId = `${transition.loopId}:state:${transition.stateRevision}:${suffix}`;
      const material: TranscriptFactMaterial = {
        factId,
        factKind: position === 0 ? "system_projection" : "model_message",
        audience: position === 0 ? "model" : participantShareable(message) ? "shared" : "model",
        payload: message,
        origin: this.messageOrigin(transition, position, next.systemProjection),
        runId: transition.loopId,
        turnId: "turnId" in transition ? transition.turnId : null,
        toolCallId: "toolCallId" in transition ? transition.toolCallId : null,
      };
      const prepared = await this.prepareFact(material);
      materials.push(prepared);
      factIds.push(factId);
      if (suffix === "assistant_accepted") appendedFactId = factId;
    }
    return { materials, factIds, appendedFactId };
  }

  private assertExpectedHead(
    previous: BindLoopProjectionState | null,
    transition: BindLoopTransition,
  ): void {
    const current = this.sql.exec<{
      generation: number;
      state_revision: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT generation, state_revision FROM bind_loop_heads WHERE loop_id = ?`,
      transition.loopId,
    ).toArray()[0];
    if (!previous) {
      if (current || transition.kind !== "state_initialized") throw new Error("bind_loop_head_conflict");
      return;
    }
    if (!current
      || Number(current.generation) !== previous.generation
      || Number(current.state_revision) !== previous.stateRevision) {
      throw new Error("bind_loop_head_conflict");
    }
  }

  private writeBindState(
    transition: BindLoopTransition,
    next: BindLoopProjectionState,
    factIds: string[],
    now: number,
  ): void {
    this.sql.exec(
      `INSERT INTO bind_loop_heads
         (loop_id, generation, state_revision, system_projection_revision,
          projector_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(loop_id) DO UPDATE SET
         generation = excluded.generation,
         state_revision = excluded.state_revision,
         system_projection_revision = excluded.system_projection_revision,
         projector_version = excluded.projector_version,
         updated_at = excluded.updated_at`,
      next.loopId,
      next.generation,
      next.stateRevision,
      next.systemProjection.revision,
      BIND_LOOP_PROJECTOR_VERSION,
      now,
    );
    this.sql.exec(
      `INSERT INTO bind_loop_states
         (loop_id, state_revision, generation, transition_kind,
          system_projection_revision, system_renderer_version, system_input_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      next.loopId,
      next.stateRevision,
      next.generation,
      transition.kind,
      next.systemProjection.revision,
      next.systemProjection.rendererVersion,
      next.systemProjection.inputHash,
      now,
    );
    for (let position = 0; position < factIds.length; position += 1) {
      const sequence = this.allocateLoopSequence(now);
      this.sql.exec(
        `INSERT INTO bind_loop_state_messages
           (loop_id, state_revision, message_position, loop_sequence, fact_id)
         VALUES (?, ?, ?, ?, ?)`,
        next.loopId,
        next.stateRevision,
        position,
        sequence,
        factIds[position]!,
      );
    }
  }

  private projectAssistantTurn(
    transition: Extract<BindLoopTransition, { kind: "assistant_accepted" }>,
    rootFactId: string,
    now: number,
  ): void {
    const existing = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM participant_transcript_turns WHERE turn_id = ?`,
      transition.turnId,
    ).toArray()[0];
    if (existing) return;
    const message = transition.message as {
      content?: unknown;
      tool_calls?: Array<{ id: string; type: string; function?: { name?: string; arguments?: string } }>;
    };
    const sequence = this.allocateTranscriptSequence(now);
    const activityId = `${transition.turnId}:activity`;
    this.sql.exec(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
          root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
       VALUES (?, ?, 'conversation', 'assistant', NULL, ?, ?, NULL, 1, ?, ?)`,
      sequence,
      transition.turnId,
      rootFactId,
      activityId,
      now,
      now,
    );
    let blockIndex = 0;
    const thinking = this.sql.exec<{ activity_id: string } & Record<string, SqlStorageValue>>(
      `SELECT activity_id FROM transcript_activities
        WHERE scope = 'thinking' AND subject_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      transition.turnId,
    ).toArray()[0];
    if (thinking) {
      this.sql.exec(
        `INSERT INTO participant_transcript_blocks
           (turn_id, block_id, block_index, block_kind, fact_id, activity_id,
            revision, updated_at)
         VALUES (?, ?, ?, 'thinking', ?, ?, 1, ?)`,
        transition.turnId,
        `${transition.turnId}:thinking`,
        blockIndex,
        rootFactId,
        thinking.activity_id,
        now,
      );
      blockIndex += 1;
    }
    if (typeof message.content === "string" && message.content.length > 0) {
      this.sql.exec(
        `INSERT INTO participant_transcript_blocks
           (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
         VALUES (?, ?, ?, 'text', ?, 1, ?)`,
        transition.turnId,
        `${transition.turnId}:text:0`,
        blockIndex,
        rootFactId,
        now,
      );
      blockIndex += 1;
    }
    for (let callIndex = 0; callIndex < (message.tool_calls?.length ?? 0); callIndex += 1) {
      const call = message.tool_calls![callIndex]!;
      const participantToolCallId = `${transition.loopId}:turn:${transition.modelTurnIndex}:tool:${callIndex}`;
      this.sql.exec(
        `INSERT INTO participant_transcript_blocks
           (turn_id, block_id, block_index, block_kind, fact_id, tool_call_id,
            tool_name, call_index, lifecycle_state, revision, updated_at)
         VALUES (?, ?, ?, 'tool', ?, ?, ?, ?, 'planned', 1, ?)`,
        transition.turnId,
        `${transition.turnId}:tool:${callIndex}`,
        blockIndex,
        rootFactId,
        participantToolCallId,
        call.function?.name ?? "tool",
        callIndex,
        now,
      );
      blockIndex += 1;
    }
  }

  private insertParticipantStatus(input: {
    turnId: string;
    factId: string;
    activityId: string;
    now: number;
  }): void {
    const existing = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM participant_transcript_turns WHERE turn_id = ?`,
      input.turnId,
    ).toArray()[0];
    if (existing) return;
    const sequence = this.allocateTranscriptSequence(input.now);
    this.sql.exec(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
          root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
       VALUES (?, ?, 'status', 'system', NULL, ?, ?, NULL, 1, ?, ?)`,
      sequence,
      input.turnId,
      input.factId,
      input.activityId,
      input.now,
      input.now,
    );
  }

  private messageRows(loopId: string, stateRevision: number): MessageProjectionRow[] {
    return this.sql.exec<MessageProjectionRow>(
      `SELECT projected.message_position, projected.fact_id, payload.payload_json
         FROM bind_loop_state_messages projected
         JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE projected.loop_id = ? AND projected.state_revision = ?
        ORDER BY projected.message_position`,
      loopId,
      stateRevision,
    ).toArray();
  }

  private async prepareFact(fact: TranscriptFactMaterial): Promise<PreparedTranscriptFact> {
    return prepareTranscriptFact(fact);
  }

  private insertFact(fact: PreparedTranscriptFact, now: number): void {
    insertPreparedTranscriptFact(this.sql, fact, now);
  }

  private messageOrigin(
    transition: BindLoopTransition,
    position: number,
    systemProjection: BindLoopProjectionState["systemProjection"],
  ): TranscriptFactMaterial["origin"] {
    if (position === 0) {
      return {
        originKind: "system_projection",
        sourceKind: "system_prompt_inputs",
        sourceId: systemProjection.inputHash,
        sourceRevision: systemProjection.revision,
      };
    }
    if (transition.kind === "state_initialized") {
      const origin = transition.nonSystemMessageOrigins[position - 1];
      if (!origin) throw new Error("bind_loop_message_origin_missing");
      return origin;
    }
    if (transition.kind === "assistant_accepted") return canonicalOrigin();
    if (transition.kind === "tool_result_accepted") {
      return derivedOrigin(
        "tool_receipt",
        `${transition.turnId}:tool:${transition.callIndex}`,
        transition.callIndex,
      );
    }
    if (transition.kind === "protocol_user_appended") {
      if (transition.origin === "protocol") return protocolOrigin();
      if (!transition.sourceId) throw new Error("bind_loop_derived_source_missing");
      return derivedOrigin("protocol_source", transition.sourceId, null);
    }
    if (transition.kind === "state_replaced") return protocolOrigin();
    if (transition.kind === "state_reconciled") {
      return derivedOrigin(
        "bind_loop_state",
        `${transition.loopId}:state:${transition.stateRevision - 1}`,
        transition.stateRevision - 1,
      );
    }
    throw new Error("bind_loop_message_origin_unavailable");
  }

  private legacyParticipantParts(cutoverAppliedAt: number): LegacyParticipantPartRow[] {
    return this.sql.exec<LegacyParticipantPartRow>(
      `SELECT id, sequence_number, attention_ordinal, role, kind, author_type,
              author_user_id, content, content_ref_id, message_type,
              structured_content_json, tool_name, tool_status, created_at, updated_at
         FROM parts
        WHERE substream_id = '0'
          AND visibility IN ('people', 'both')
          AND (
            created_at < ?
            OR (
              created_at = ?
              AND NOT EXISTS (
                SELECT 1 FROM participant_transcript_turns projected
                 WHERE projected.turn_id = parts.id
              )
            )
          )
        ORDER BY sequence_number, id`,
        cutoverAppliedAt,
        cutoverAppliedAt,
    ).toArray();
  }

  private legacyCompactionCheckpoints(cutoverAppliedAt: number): LegacyCompactionCheckpointRow[] {
    return this.sql.exec<LegacyCompactionCheckpointRow>(
      `SELECT projection_key, execution_principal_key, resource_visibility_fingerprint,
              checkpoint_template_version, run_id, compacted_through_sequence,
              messages_json, summary, model, context_tokens_before_compaction,
              context_window_tokens, input_tokens, output_tokens, cost_micros,
              created_at, updated_at
         FROM compaction_checkpoints
        WHERE created_at <= ?
        ORDER BY execution_principal_key, run_id, compacted_through_sequence,
                 projection_key`,
      cutoverAppliedAt,
    ).toArray();
  }

  private legacyBackfillReceipt(): LegacyBackfillReceiptRow | undefined {
    return this.sql.exec<LegacyBackfillReceiptRow>(
      `SELECT operator_run_id, cutover_version, cutover_applied_at,
              pre_backfill_bookmark, source_part_count, source_checkpoint_count,
              source_sha256, participant_turn_count, checkpoint_projection_count,
              bind_history_status, completed_at
         FROM legacy_transcript_backfills WHERE id = 1`,
    ).toArray()[0];
  }

  private legacyPayloadTransferSource(): {
    parts: LegacyPayloadTransferPartRow[];
    attachments: Array<Record<string, SqlStorageValue>>;
    mentions: Array<Record<string, SqlStorageValue>>;
    checkpoints: LegacyCompactionCheckpointRow[];
  } {
    return {
      parts: this.sql.exec<LegacyPayloadTransferPartRow>(
        `SELECT * FROM parts ORDER BY sequence_number, id`,
      ).toArray(),
      attachments: this.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM part_attachments ORDER BY part_id, position, resource_id`,
      ).toArray(),
      mentions: this.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT * FROM part_mentions ORDER BY part_id, mention_index`,
      ).toArray(),
      checkpoints: this.sql.exec<LegacyCompactionCheckpointRow>(
        `SELECT projection_key, execution_principal_key, resource_visibility_fingerprint,
                checkpoint_template_version, run_id, compacted_through_sequence,
                messages_json, summary, model, context_tokens_before_compaction,
                context_window_tokens, input_tokens, output_tokens, cost_micros,
                created_at, updated_at
           FROM compaction_checkpoints
          ORDER BY execution_principal_key, run_id, compacted_through_sequence, projection_key`,
      ).toArray(),
    };
  }

  private legacyPayloadTransferReceipt(): LegacyPayloadTransferReceiptRow | undefined {
    return this.sql.exec<LegacyPayloadTransferReceiptRow>(
      `SELECT operator_run_id, pre_transfer_bookmark, source_part_count,
              source_attachment_count, source_mention_count, source_checkpoint_count,
              source_sha256, message_record_count, checkpoint_projection_count, completed_at
         FROM legacy_transcript_payload_transfers WHERE id = 1`,
    ).toArray()[0];
  }

  private exactCanonicalCheckpointFactId(
    checkpoint: LegacyCompactionCheckpointRow,
  ): string | null {
    const existing = this.sql.exec<{
      checkpoint_fact_id: string;
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT checkpoint.checkpoint_fact_id, payload.payload_json
         FROM transcript_compaction_checkpoints checkpoint
         JOIN transcript_facts fact ON fact.fact_id = checkpoint.checkpoint_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE checkpoint.execution_principal_key = ?
          AND checkpoint.run_id = ?
          AND checkpoint.compacted_through_sequence = ?`,
      checkpoint.execution_principal_key,
      checkpoint.run_id,
      checkpoint.compacted_through_sequence,
    ).toArray()[0];
    if (!existing) return null;
    const payload = JSON.parse(existing.payload_json) as Record<string, unknown>;
    if (!("messages" in payload) || typeof payload.summary !== "string") return null;
    return canonicalJson(payload.messages) === canonicalJson(JSON.parse(checkpoint.messages_json))
      && payload.summary === checkpoint.summary
      ? existing.checkpoint_fact_id
      : null;
  }

  private async verifyLegacyPayloadTransfer(
    receipt: LegacyPayloadTransferReceiptRow,
    applied: boolean,
  ): Promise<LegacyTranscriptPayloadTransferOutcome> {
    const source = this.legacyPayloadTransferSource();
    const records = this.sql.exec<{
      message_id: string;
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT record.message_id, payload.payload_json
         FROM workstream_message_records record
         JOIN transcript_facts fact ON fact.fact_id = record.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        ORDER BY record.sequence_number, record.message_id`,
    ).toArray();
    const recordPayloads = new Map(records.map((row) => [row.message_id, row.payload_json]));
    const payloadsMatch = source.parts.every((part) => {
      const payloadJson = recordPayloads.get(part.id);
      if (!payloadJson) return false;
      const payload = JSON.parse(payloadJson) as Record<string, unknown>;
      const expectedStructured = part.structured_content_json === null
        ? null
        : JSON.parse(part.structured_content_json) as unknown;
      return payload.role === part.role
        && payload.content === (part.content ?? "")
        && canonicalJson(payload.structuredContent ?? null) === canonicalJson(expectedStructured);
    });
    const scalarMismatches = Number(this.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count
         FROM parts part
         LEFT JOIN workstream_message_records record ON record.message_id = part.id
        WHERE record.message_id IS NULL
           OR record.substream_id IS NOT part.substream_id
           OR record.sequence_number IS NOT part.sequence_number
           OR record.attention_ordinal IS NOT part.attention_ordinal
           OR record.turn_id IS NOT part.turn_id
           OR record.turn_open_sequence IS NOT part.turn_open_sequence
           OR record.part_index IS NOT part.part_index
           OR record.role IS NOT part.role
           OR record.kind IS NOT part.kind
           OR record.author_type IS NOT part.author_type
           OR record.author_user_id IS NOT part.author_user_id
           OR record.external_actor_json IS NOT part.external_actor_json
           OR record.content_ref_id IS NOT part.content_ref_id
           OR record.content_bytes IS NOT part.content_bytes
           OR record.content_hash IS NOT part.content_hash
           OR record.answers_message_id IS NOT part.answers_part_id
           OR record.input_message_ids_json IS NOT part.input_part_ids_json
           OR record.client_message_id IS NOT part.client_message_id
           OR record.effect_intent_id IS NOT part.effect_intent_id
           OR record.occurrence_key IS NOT part.occurrence_key
           OR record.produced_by_run_id IS NOT part.produced_by_run_id
           OR record.attempt_epoch IS NOT part.attempt_epoch
           OR record.executor_event_seq IS NOT part.executor_event_seq
           OR record.model_turn_id IS NOT part.model_turn_id
           OR record.tool_position IS NOT part.tool_position
           OR record.delivery_intent IS NOT part.delivery_intent
           OR record.input_batch_id IS NOT part.input_batch_id
           OR record.admission_cut_seq IS NOT part.admission_cut_seq
           OR record.tool_name IS NOT part.tool_name
           OR record.tool_mode IS NOT part.tool_mode
           OR record.tool_status IS NOT part.tool_status
           OR record.compacts_through_sequence IS NOT part.compacts_through_sequence
           OR record.compacts_through_turn_id IS NOT part.compacts_through_turn_id
           OR record.projected_input_hash IS NOT part.projected_input_hash
           OR record.projection_key IS NOT part.projection_key
           OR record.authorization_revisions_json IS NOT part.authorization_revisions_json
           OR record.lineage_fences_json IS NOT part.lineage_fences_json
           OR record.terminal_reason IS NOT part.terminal_reason
           OR record.visibility IS NOT part.visibility
           OR record.pinned IS NOT part.pinned
           OR record.message_type IS NOT part.message_type
           OR record.edited_at IS NOT part.edited_at
           OR record.created_at IS NOT part.created_at
           OR record.updated_at IS NOT part.updated_at`,
    ).one().count);
    const attachmentMismatches = Number(this.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM (
         SELECT part_id AS message_id, resource_id, position, attachment_json FROM part_attachments
         EXCEPT
         SELECT message_id, resource_id, position, attachment_json FROM workstream_message_attachments
         UNION ALL
         SELECT message_id, resource_id, position, attachment_json FROM workstream_message_attachments
         EXCEPT
         SELECT part_id AS message_id, resource_id, position, attachment_json FROM part_attachments
       )`,
    ).one().count);
    const mentionMismatches = Number(this.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM (
         SELECT part_id AS message_id, mention_index, mention_kind, target_user_id,
                connector_type, start_offset, end_offset, attention_ordinal FROM part_mentions
         EXCEPT
         SELECT message_id, mention_index, mention_kind, target_user_id,
                connector_type, start_offset, end_offset, attention_ordinal FROM workstream_message_mentions
         UNION ALL
         SELECT message_id, mention_index, mention_kind, target_user_id,
                connector_type, start_offset, end_offset, attention_ordinal FROM workstream_message_mentions
         EXCEPT
         SELECT part_id AS message_id, mention_index, mention_kind, target_user_id,
                connector_type, start_offset, end_offset, attention_ordinal FROM part_mentions
       )`,
    ).one().count);
    const checkpointRows = this.sql.exec<{
      execution_principal_key: string;
      run_id: string;
      compacted_through_sequence: number;
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT checkpoint.execution_principal_key, checkpoint.run_id,
              checkpoint.compacted_through_sequence, payload.payload_json
         FROM transcript_compaction_checkpoints checkpoint
         JOIN transcript_facts fact ON fact.fact_id = checkpoint.checkpoint_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id`,
    ).toArray();
    const checkpointPayloads = new Map(checkpointRows.map((row) => [
      `${row.execution_principal_key}:${row.run_id}:${row.compacted_through_sequence}`,
      JSON.parse(row.payload_json) as Record<string, unknown>,
    ]));
    const checkpointsMatch = source.checkpoints.every((checkpoint) => {
      const payload = checkpointPayloads.get(
        `${checkpoint.execution_principal_key}:${checkpoint.run_id}:${checkpoint.compacted_through_sequence}`,
      );
      return payload !== undefined
        && canonicalJson(payload.messages) === canonicalJson(JSON.parse(checkpoint.messages_json))
        && payload.summary === checkpoint.summary;
    });
    const participantProjectionMismatches = Number(this.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM (
         SELECT turn.turn_id
           FROM participant_transcript_turns turn
           JOIN workstream_message_records record ON record.message_id = turn.turn_id
          WHERE turn.entry_kind = 'conversation'
            AND turn.root_fact_id IS NOT record.fact_id
         UNION ALL
         SELECT block.block_id
           FROM participant_transcript_blocks block
           JOIN workstream_message_records record ON record.message_id = block.turn_id
          WHERE block.fact_id IS NOT record.fact_id
       )`,
    ).one().count);
    const sourceStillAtReceipt = source.parts.length === Number(receipt.source_part_count)
      && source.attachments.length === Number(receipt.source_attachment_count)
      && source.mentions.length === Number(receipt.source_mention_count)
      && source.checkpoints.length === Number(receipt.source_checkpoint_count);
    const receiptDigestMatches = !sourceStillAtReceipt
      || await sha256(canonicalJson(source)) === receipt.source_sha256;
    const verified = records.length === source.parts.length
      && scalarMismatches === 0
      && payloadsMatch
      && participantProjectionMismatches === 0
      && attachmentMismatches === 0
      && mentionMismatches === 0
      && checkpointsMatch
      && receiptDigestMatches;
    if (!verified) throw new Error("legacy_transcript_payload_transfer_reconciliation_failed");
    return {
      applied,
      verified,
      operatorRunId: receipt.operator_run_id,
      preTransferBookmark: receipt.pre_transfer_bookmark,
      sourcePartCount: Number(receipt.source_part_count),
      sourceAttachmentCount: Number(receipt.source_attachment_count),
      sourceMentionCount: Number(receipt.source_mention_count),
      sourceCheckpointCount: Number(receipt.source_checkpoint_count),
      sourceSha256: receipt.source_sha256,
      messageRecordCount: Number(receipt.message_record_count),
      checkpointProjectionCount: Number(receipt.checkpoint_projection_count),
      completedAt: Number(receipt.completed_at),
    };
  }

  private legacyParticipantFact(part: LegacyParticipantPartRow): TranscriptFactMaterial {
    const tool = legacyToolProjection(part);
    return {
      factId: tool ? `${part.id}:legacy-tool` : `${part.id}:message`,
      factKind: tool ? "legacy_participant_tool" : "participant_message",
      audience: tool ? "participant" : "shared",
      // The immutable legacy part remains the one owner of its content. The
      // canonical fact is a stable semantic identity and source reference, as
      // it is for every new human/system participant message after v27.
      payload: {
        role: legacyParticipantActor(part.author_type),
        partId: part.id,
        ...(tool ? { legacyTool: true } : {}),
      },
      origin: canonicalOrigin(),
      runId: null,
      turnId: part.id,
      toolCallId: tool?.toolCallId ?? null,
    };
  }

  private async verifyLegacyBackfill(
    receipt: LegacyBackfillReceiptRow,
    applied: boolean,
  ): Promise<LegacyTranscriptBackfillOutcome> {
    const parts = this.sql.exec<LegacyParticipantPartRow>(
      `SELECT part.id, part.sequence_number, part.attention_ordinal, part.role, part.kind,
              part.author_type, part.author_user_id, part.content, part.content_ref_id,
              part.message_type, part.structured_content_json, part.tool_name,
              part.tool_status, part.created_at, part.updated_at
         FROM participant_transcript_turns turn
         JOIN parts part ON part.id = turn.turn_id
        WHERE turn.transcript_sequence <= ?
        ORDER BY turn.transcript_sequence`,
      receipt.participant_turn_count,
    ).toArray();
    const checkpoints = this.legacyCompactionCheckpoints(Number(receipt.cutover_applied_at));
    const digest = await sha256(canonicalJson({ parts, checkpoints }));
    const projectedParts = this.sql.exec<{
      source_sequence: number;
      transcript_sequence: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT part.sequence_number AS source_sequence, turn.transcript_sequence
         FROM parts part
         JOIN participant_transcript_turns turn ON turn.turn_id = part.id
        WHERE turn.transcript_sequence <= ?
        ORDER BY part.sequence_number, part.id`,
      receipt.participant_turn_count,
    ).toArray();
    const projectedCheckpoints = Number(this.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count
         FROM compaction_checkpoints legacy
         JOIN transcript_compaction_checkpoints projected
           ON projected.execution_principal_key = legacy.execution_principal_key
          AND projected.run_id = legacy.run_id
          AND projected.compacted_through_sequence = legacy.compacted_through_sequence
         JOIN transcript_facts fact ON fact.fact_id = projected.checkpoint_fact_id
        WHERE legacy.created_at <= ?
          AND fact.fact_kind = 'legacy_compaction_checkpoint_reference'`,
      receipt.cutover_applied_at,
    ).one().count);
    const sequencesMatch = projectedParts.every(
      (row, index) => Number(row.transcript_sequence) === index + 1,
    );
    const verified = digest === receipt.source_sha256
      && parts.length === Number(receipt.source_part_count)
      && checkpoints.length === Number(receipt.source_checkpoint_count)
      && projectedParts.length === Number(receipt.participant_turn_count)
      && projectedCheckpoints === Number(receipt.checkpoint_projection_count)
      && parts.length === projectedParts.length
      && checkpoints.length === projectedCheckpoints
      && sequencesMatch;
    if (!verified) throw new Error("legacy_transcript_backfill_reconciliation_failed");
    return {
      applied,
      verified,
      operatorRunId: receipt.operator_run_id,
      cutoverAppliedAt: Number(receipt.cutover_applied_at),
      preBackfillBookmark: receipt.pre_backfill_bookmark,
      sourcePartCount: Number(receipt.source_part_count),
      sourceCheckpointCount: Number(receipt.source_checkpoint_count),
      sourceSha256: receipt.source_sha256,
      participantTurnCount: Number(receipt.participant_turn_count),
      checkpointProjectionCount: Number(receipt.checkpoint_projection_count),
      bindHistoryStatus: receipt.bind_history_status,
      completedAt: Number(receipt.completed_at),
    };
  }

  private allocateTranscriptSequence(now: number): number {
    const value = Number(this.sql.exec<{ next_transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
    ).one().next_transcript_sequence);
    this.sql.exec(
      `UPDATE transcript_counters
          SET next_transcript_sequence = next_transcript_sequence + 1, updated_at = ?
        WHERE id = 1`,
      now,
    );
    return value;
  }

  private allocateLoopSequence(now: number): number {
    const value = Number(this.sql.exec<{ next_loop_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT next_loop_sequence FROM transcript_counters WHERE id = 1`,
    ).one().next_loop_sequence);
    this.sql.exec(
      `UPDATE transcript_counters
          SET next_loop_sequence = next_loop_sequence + 1, updated_at = ?
        WHERE id = 1`,
      now,
    );
    return value;
  }
}

export async function prepareTranscriptFact(
  fact: TranscriptFactMaterial,
): Promise<PreparedTranscriptFact> {
  const canonical = canonicalJson(fact.payload);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return {
    ...fact,
    canonical,
    hash,
    payloadId: `payload:${fact.audience}:${hash}`,
  };
}

export function insertPreparedTranscriptFact(
  sql: SqlStorage,
  fact: PreparedTranscriptFact,
  now: number,
): void {
  sql.exec(
    `INSERT INTO transcript_payloads
       (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
     VALUES (?, ?, 'application/json', ?, ?, ?, ?)
     ON CONFLICT(audience, payload_sha256, byte_length) DO NOTHING`,
    fact.payloadId,
    fact.audience,
    fact.canonical,
    fact.hash,
    new TextEncoder().encode(fact.canonical).byteLength,
    now,
  );
  sql.exec(
    `INSERT INTO transcript_facts
       (fact_id, fact_kind, payload_id, origin_kind, source_kind, source_id,
        source_revision, run_id, turn_id, tool_call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fact_id) DO UPDATE SET
       payload_id = excluded.payload_id,
       run_id = excluded.run_id,
       turn_id = excluded.turn_id,
       tool_call_id = excluded.tool_call_id`,
    fact.factId,
    fact.factKind,
    fact.payloadId,
    fact.origin.originKind,
    fact.origin.sourceKind,
    fact.origin.sourceId,
    fact.origin.sourceRevision,
    fact.runId,
    fact.turnId,
    fact.toolCallId,
    now,
  );
}

export async function prepareWorkstreamMessageRecord(
  input: WorkstreamMessageRecordInput,
): Promise<PreparedWorkstreamMessageRecord> {
  const fact = await prepareTranscriptFact({
    factId: `${input.messageId}:message-record`,
    factKind: "workstream_message",
    audience: "shared",
    payload: {
      role: input.role ?? modelRoleForAuthor(input.authorType),
      content: input.text,
      structuredContent: input.structuredContentJson === null
        ? null
        : JSON.parse(input.structuredContentJson) as unknown,
    },
    origin: canonicalOrigin(),
    runId: input.producedByRunId,
    turnId: input.messageId,
    toolCallId: null,
  });
  return { input, fact };
}

export function insertWorkstreamMessageRecord(
  sql: SqlStorage,
  prepared: PreparedWorkstreamMessageRecord,
): void {
  const { input, fact } = prepared;
  insertPreparedTranscriptFact(sql, fact, input.now);
  sql.exec(
    `INSERT INTO workstream_message_records
       (message_id, substream_id, sequence_number, attention_ordinal, fact_id,
        role, kind, author_type, author_user_id, external_actor_json,
        client_message_id, effect_intent_id, produced_by_run_id, attempt_epoch,
        tool_name, tool_mode, tool_status, visibility, pinned,
        message_type, edited_at, created_at, updated_at)
     VALUES (?, '0', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             (SELECT attempt_epoch FROM runs WHERE run_id = ?), ?, ?, ?, ?, 0, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       fact_id = excluded.fact_id,
       tool_name = excluded.tool_name,
       tool_mode = excluded.tool_mode,
       tool_status = excluded.tool_status,
       edited_at = excluded.edited_at,
       updated_at = excluded.updated_at`,
    input.messageId,
    input.sequenceNumber,
    input.attentionOrdinal,
    fact.factId,
    input.role ?? (input.authorType === "human" || input.authorType === "external"
      ? "user"
      : input.authorType === "agent" ? "assistant" : "system"),
    input.kind ?? "text",
    input.authorType === "human" ? "member" : input.authorType,
    input.authorUserId,
    input.externalActorJson,
    input.clientMessageId,
    input.effectIntentId ?? null,
    input.producedByRunId,
    input.producedByRunId,
    input.toolName ?? null,
    input.toolMode ?? null,
    input.toolStatus ?? null,
    input.visibility ?? (input.messageType === "system" ? "people" : "both"),
    input.messageType,
    input.editedAt ?? null,
    input.createdAt ?? input.now,
    input.now,
  );
}

function hydrateBlock(
  row: BlockRow,
  mentions: readonly TranscriptMentionRow[],
  attachments: readonly TranscriptAttachmentRow[],
): TranscriptBlock {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (row.block_kind === "text") {
    return {
      type: "text",
      blockId: row.block_id,
      blockIndex: Number(row.block_index),
      text: typeof payload.content === "string" ? payload.content : row.part_content ?? "",
      streaming: false,
      mentions: mentions.map((mention) => ({
        type: mention.mention_kind,
        userId: mention.target_user_id,
        connectorType: mention.connector_type,
        startOffset: Number(mention.start_offset),
        endOffset: Number(mention.end_offset),
      })),
      attachments: attachments.map((attachment) => {
        const metadata = parseJson<{ size?: unknown }>(attachment.metadata_json, {});
        const attachmentMetadata = parseJson<{ attachedAt?: unknown }>(attachment.attachment_json, {});
        const attachedAt = typeof attachmentMetadata.attachedAt === "string"
          && Number.isFinite(Date.parse(attachmentMetadata.attachedAt))
          ? attachmentMetadata.attachedAt
          : new Date(Number(attachment.attached_at)).toISOString();
        const size = Number(metadata.size ?? 0);
        return {
          id: attachment.resource_id,
          fileName: truncateUtf16Safe(attachment.title ?? attachment.resource_id, 300),
          mimeType: truncateUtf16Safe(attachment.mime_type || "application/octet-stream", 160),
          sizeBytes: Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : 0,
          contentAvailable: attachment.content_ref !== null,
          createdAt: attachedAt,
        };
      }),
      messageType: isParticipantMessageType(row.part_message_type)
        ? row.part_message_type
        : "text",
      structuredContent: parseStructuredContent(row.part_structured_content_json),
    };
  }
  if (row.block_kind === "thinking") {
    return {
      type: "thinking",
      blockId: row.block_id,
      blockIndex: Number(row.block_index),
      providerEvidence: "reasoning_tokens",
      summary: null,
      activityId: row.activity_id ?? row.block_id,
    };
  }
  const toolCalls = Array.isArray(payload.tool_calls) ? payload.tool_calls as Array<Record<string, unknown>> : [];
  const call = toolCalls[Number(row.call_index ?? 0)];
  const fn = call?.function && typeof call.function === "object"
    ? call.function as Record<string, unknown>
    : null;
  const canonicalStructuredContent = payload.structuredContent !== null
    && typeof payload.structuredContent === "object"
    && !Array.isArray(payload.structuredContent)
    ? payload.structuredContent as Record<string, unknown>
    : null;
  const canonicalInvocation = canonicalStructuredContent?.invocation !== null
    && typeof canonicalStructuredContent?.invocation === "object"
    && !Array.isArray(canonicalStructuredContent.invocation)
    ? canonicalStructuredContent.invocation as Record<string, unknown>
    : null;
  const legacyInvocation = canonicalInvocation ?? (payload.legacyTool === true
    ? legacyToolInvocation(row.part_structured_content_json)
    : null);
  const safe = payload.status ? payload : {};
  return {
    type: "tool",
    blockId: row.block_id,
    blockIndex: Number(row.block_index),
    toolCallId: row.tool_call_id ?? row.block_id,
    pluginId: row.plugin_id,
    toolName: row.tool_name
      ?? (typeof legacyInvocation?.toolName === "string" ? legacyInvocation.toolName : null)
      ?? (typeof fn?.name === "string" ? fn.name : "tool"),
    callIndex: Number(row.call_index ?? 0),
    status: (row.lifecycle_state ?? "planned") as Extract<TranscriptBlock, { type: "tool" }>["status"],
    participantSafeInput: safe.participantSafeInput
      ?? legacyInvocation?.inputSummary
      ?? null,
    participantSafeResult: safe.participantSafeResult
      ?? legacyInvocation?.outputSummary
      ?? null,
    error: typeof safe.error === "string"
      ? safe.error
      : legacyToolError(legacyInvocation),
    activityId: row.activity_id,
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseExternalActor(value: string | null): ExternalActor | null {
  const parsed = ExternalActorSchema.safeParse(parseJson(value, null));
  return parsed.success ? parsed.data : null;
}

function parseStructuredContent(value: string | null): Record<string, unknown> | null {
  const parsed = parseJson<unknown>(value, null);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function isParticipantMessageType(
  value: string | null,
): value is "text" | "system" | "elicitation" | "suggestion" {
  return value === "text" || value === "system" || value === "elicitation" || value === "suggestion";
}

function participantShareable(message: BindLoopMessage): boolean {
  // New provider/protocol roles remain model-only until their participant
  // visibility has been reviewed explicitly.
  return message.role === "assistant";
}

function canonicalOrigin(): BindLoopMessageOrigin {
  return {
    originKind: "canonical",
    sourceKind: null,
    sourceId: null,
    sourceRevision: null,
  };
}

function protocolOrigin(): BindLoopMessageOrigin {
  return {
    originKind: "protocol",
    sourceKind: null,
    sourceId: null,
    sourceRevision: null,
  };
}

function derivedOrigin(
  sourceKind: string,
  sourceId: string,
  sourceRevision: number | null,
): BindLoopMessageOrigin {
  return { originKind: "derived", sourceKind, sourceId, sourceRevision };
}

function terminalToolStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function activityState(action: ActivityEdge["action"]): TranscriptActivity["state"] {
  if (action === "start") return "active";
  if (action === "complete") return "completed";
  if (action === "fail") return "failed";
  if (action === "cancel") return "cancelled";
  return "abandoned";
}

function sortActivities(activities: TranscriptActivity[]): TranscriptActivity[] {
  const activityIds = new Set(activities.map((activity) => activity.activityId));
  const byParent = new Map<string | null, TranscriptActivity[]>();
  for (const activity of activities) {
    const parentId = activity.parentActivityId && activityIds.has(activity.parentActivityId)
      ? activity.parentActivityId
      : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(activity);
    byParent.set(parentId, siblings);
  }
  const ordered: TranscriptActivity[] = [];
  const visit = (parentId: string | null): void => {
    const siblings = byParent.get(parentId) ?? [];
    siblings.sort((left, right) =>
      (left.callIndex ?? Number.MAX_SAFE_INTEGER) - (right.callIndex ?? Number.MAX_SAFE_INTEGER)
      || left.activityId.localeCompare(right.activityId));
    for (const activity of siblings) {
      ordered.push(activity);
      visit(activity.activityId);
    }
  };
  visit(null);
  return ordered;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function legacyParticipantActor(authorType: string): ParticipantMessageInput["actor"] {
  if (authorType === "member") return "human";
  if (authorType === "agent") return "assistant";
  if (authorType === "external" || authorType === "connector") return "external";
  return "system";
}

function legacyMessageAuthorType(
  authorType: string,
): WorkstreamMessageRecordInput["authorType"] {
  if (authorType === "member") return "human";
  if (authorType === "agent") return "agent";
  if (authorType === "external") return "external";
  return "system";
}

function legacyMessageType(messageType: string): WorkstreamMessageRecordInput["messageType"] {
  if (messageType === "system") return "system";
  if (messageType === "elicitation") return "elicitation";
  if (messageType === "tool") return "tool";
  if (messageType === "suggestion") return "suggestion";
  return "text";
}

function modelRoleForAuthor(
  authorType: WorkstreamMessageRecordInput["authorType"],
): NonNullable<WorkstreamMessageRecordInput["role"]> {
  if (authorType === "agent") return "assistant";
  if (authorType === "system") return "system";
  return "user";
}

function legacyToolProjection(part: LegacyParticipantPartRow): {
  toolCallId: string;
  pluginId: string | null;
  toolName: string;
  status: "started" | "completed" | "failed" | "cancelled";
} | null {
  if (part.message_type !== "tool" && part.kind !== "tool_call" && part.kind !== "tool_result") {
    return null;
  }
  const invocation = legacyToolInvocation(part.structured_content_json);
  const plugin = invocation?.plugin && typeof invocation.plugin === "object"
    ? invocation.plugin as Record<string, unknown>
    : null;
  const pluginId = typeof plugin?.pluginId === "string" && plugin.pluginId.length > 0
    ? plugin.pluginId
    : null;
  const rawStatus = typeof invocation?.status === "string" ? invocation.status : part.tool_status;
  const status = rawStatus === "completed"
    ? "completed" as const
    : rawStatus === "failed" || rawStatus === "ambiguous"
      ? "failed" as const
      : "started" as const;
  return {
    // A legacy card's stable participant identity was its effect-intent/part
    // id. Prefixing it keeps it disjoint from Bind's model-facing tool-call id.
    toolCallId: `legacy:${part.id}`,
    pluginId,
    toolName: typeof invocation?.toolName === "string" && invocation.toolName.length > 0
      ? invocation.toolName
      : part.tool_name ?? "tool",
    status,
  };
}

function legacyToolInvocation(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed.invocation && typeof parsed.invocation === "object"
      ? parsed.invocation as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function legacyToolError(invocation: Record<string, unknown> | null): string | null {
  if (!invocation?.error || typeof invocation.error !== "object") return null;
  const message = (invocation.error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}

function legacyCheckpointFactId(checkpoint: LegacyCompactionCheckpointRow): string {
  return `legacy-compaction:${checkpoint.projection_key}:${checkpoint.run_id}:${checkpoint.compacted_through_sequence}`;
}

function sortJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (value === undefined) throw new Error("transcript_non_json_value");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("transcript_non_finite_number");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]));
  }
  throw new Error("transcript_non_json_value");
}
