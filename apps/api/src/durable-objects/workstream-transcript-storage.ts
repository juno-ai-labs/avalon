import type {
  TranscriptActivity,
  TranscriptBlock,
  TranscriptRange,
  TranscriptRangeResult,
  TranscriptTurn,
  WorkstreamTranscriptSnapshot,
} from "@rally/contracts";
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

interface FactMaterial {
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

interface PreparedFact extends FactMaterial {
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
  part_structured_content_json: string | null;
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
  text: string;
  createdAtUtc: string;
  attentionOrdinal: number | null;
}

export interface PreparedParticipantMessage {
  input: ParticipantMessageInput;
  fact: PreparedFact;
  occurredAt: number;
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
        `SELECT id FROM parts
          WHERE substream_id = '0'
            AND visibility IN ('people', 'both')
            AND kind = 'tool_call'
            AND tool_status = 'pending'
            AND created_at <= ?
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
    const checkpointMaterial: FactMaterial = {
      factId: `${transition.compactionEventId}:checkpoint`,
      factKind: "compaction_checkpoint",
      audience: "model",
      payload: commit.checkpoint,
      origin: canonicalOrigin(),
      runId: transition.loopId,
      turnId: null,
      toolCallId: null,
    };
    const statusMaterial: FactMaterial = {
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
    const material: FactMaterial = {
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
    const material: FactMaterial = {
      factId: `${input.turnId}:message`,
      factKind: "participant_message",
      audience: "shared",
      // Human text remains owned by the canonical participant part written in
      // the same transaction. The transcript fact names it; it does not copy it.
      payload: { role: input.actor, partId: input.turnId },
      origin: canonicalOrigin(),
      runId: null,
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
    const material: FactMaterial = {
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
      `SELECT transcript_sequence, turn_id, entry_kind, actor, author_user_id,
              activity_id, attention_ordinal, revision, created_at
         FROM participant_transcript_turns
        INDEXED BY participant_transcript_sequence_idx
        WHERE transcript_sequence >= ? AND transcript_sequence < ?
        ORDER BY transcript_sequence`,
      startInclusive,
      endExclusive,
    ).toArray();
    if (turns.length === 0) return [];
    const placeholders = turns.map(() => "?").join(", ");
    const blocks = this.sql.exec<BlockRow>(
      `SELECT block.turn_id, block.block_id, block.block_index, block.block_kind,
              payload.payload_json, block.tool_call_id, block.plugin_id,
              block.tool_name, block.call_index, block.lifecycle_state, block.activity_id
              , part.content AS part_content,
              part.structured_content_json AS part_structured_content_json
         FROM participant_transcript_blocks block
         JOIN transcript_facts fact ON fact.fact_id = block.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
         LEFT JOIN parts part ON part.id = block.turn_id
        WHERE block.turn_id IN (${placeholders})
        ORDER BY block.turn_id, block.block_index`,
      ...turns.map((turn) => turn.turn_id),
    ).toArray();
    const blocksByTurn = new Map<string, TranscriptBlock[]>();
    for (const block of blocks) {
      const hydrated = hydrateBlock(block);
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
  ): Promise<{ materials: PreparedFact[]; factIds: string[]; appendedFactId: string | null }> {
    const nextMessages = projectBindLoopMessages(next);
    const reusable = new Map<string, string[]>();
    for (const row of previousRows) {
      const key = JSON.stringify(JSON.parse(row.payload_json));
      reusable.set(key, [...(reusable.get(key) ?? []), row.fact_id]);
    }
    const materials: PreparedFact[] = [];
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
      const material: FactMaterial = {
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

  private async prepareFact(fact: FactMaterial): Promise<PreparedFact> {
    const canonical = canonicalJson(fact.payload);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return {
      ...fact,
      canonical,
      hash,
      payloadId: `payload:${fact.audience}:${hash}`,
    };
  }

  private insertFact(fact: PreparedFact, now: number): void {
    this.sql.exec(
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
    this.sql.exec(
      `INSERT INTO transcript_facts
         (fact_id, fact_kind, payload_id, origin_kind, source_kind, source_id,
          source_revision, run_id, turn_id, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO NOTHING`,
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

  private messageOrigin(
    transition: BindLoopTransition,
    position: number,
    systemProjection: BindLoopProjectionState["systemProjection"],
  ): FactMaterial["origin"] {
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

  private legacyParticipantFact(part: LegacyParticipantPartRow): FactMaterial {
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

function hydrateBlock(row: BlockRow): TranscriptBlock {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (row.block_kind === "text") {
    return {
      type: "text",
      blockId: row.block_id,
      blockIndex: Number(row.block_index),
      text: typeof payload.content === "string" ? payload.content : row.part_content ?? "",
      streaming: false,
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
  const legacyInvocation = payload.legacyTool === true
    ? legacyToolInvocation(row.part_structured_content_json)
    : null;
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
