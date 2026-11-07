import { sidekickRunRowFacts, sidekickRunRowText } from "./sidekick-run-row";
import {
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  ImportedMessageProvenanceSchema,
  ExternalActorSchema,
  PendingTranscriptInputSchema,
  type ExternalActor,
  type PendingTranscriptInput,
  type TranscriptActivity,
  type TranscriptBlock,
  type TranscriptPluginRun,
  type TranscriptRange,
  type TranscriptRangeResult,
  type TranscriptTurn,
  type WorkstreamTranscriptSnapshot,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { personMentionMarkdownRanges } from "@rally/contracts/citations";
import { HttpUrlSchema } from "@rally/contracts/url-schemas";
import {
  applyBindLoopTransition,
  bindLoopMessageChain,
  bindLoopNonSystemMessageCount,
  BIND_LOOP_PROJECTOR_VERSION,
  modelMessageWithoutProvenance,
  pendingBindToolBatch,
  projectBindLoopMessages,
  type BindCompactionCommit,
  type BindLoopMessage,
  type BindLoopMessageOrigin,
  type BindLoopProjectionState,
  type BindLoopTransition,
  type BindProviderBoundary,
  type HarnessActivationInput,
  type PendingBindToolBatch,
} from "@rally/agent-harness";
import { uuidV7 } from "../lib/uuid-v7";
import {
  externalInputFraming,
  projectImportedSourceMessage,
  projectParticipantTextMessage,
  projectSidekickPostMessage,
  type ExternalInputFraming,
} from "../services/workstream-participant-model-message";
import { boundParameterChunks } from "./bound-parameters";
import {
  SubstreamLoopStorage,
  type PendingLoopInputRow,
  type SubstreamLoopRow,
} from "./substream-loop-storage";
import { enqueueSemanticRealtimeReference } from "./workstream-semantic-realtime-outbox";
import {
  canonicalTranscriptJson,
  insertPreparedCanonicalTranscriptFact,
  prepareCanonicalTranscriptFact,
} from "./ordered-transcript-sqlite/canonical-payload-store";
import { startReadCursorAtLatest } from "./member-attention";

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
  author_name_snapshot: string | null;
  author_avatar_url_snapshot: string | null;
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
  message_type: string | null;
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
  connector_type: string | null;
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
  boundary_source: string;
  timing_accuracy: string;
  revision: number;
}

export interface ActivityEdge {
  connectorType?: string;
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
  authorSnapshot: { displayName: string; avatarUrl: string | null } | null;
  clientMessageId?: string;
  messageType?: "text" | "system" | "elicitation" | "automation_activation";
  text: string;
  structuredContentJson?: string | null;
  externalActorJson?: string | null;
  producedByRunId?: string | null;
  messageSequenceNumber?: number;
  createdAtUtc: string;
  attentionOrdinal: number | null;
}

export interface DevelopmentConversationTurnInput {
  turnId: string;
  clientMessageId: string | null;
  actor: "human" | "assistant" | "external" | "system";
  authorUserId: string | null;
  authorSnapshot: { displayName: string; avatarUrl: string | null } | null;
  externalActorJson: string | null;
  messageType: "text" | "system" | "elicitation" | "tool" | "automation_activation";
  text: string;
  structuredContentJson: string | null;
  producedByRunId: string | null;
  expectedTranscriptSequence: number;
  createdAtUtc: string;
}

export interface PreparedParticipantMessage {
  input: ParticipantMessageInput;
  fact: PreparedTranscriptFact;
  occurredAt: number;
}

export interface PendingInputProvenance {
  factKind: string;
  originKind: "canonical" | "protocol" | "derived" | "system_projection";
  sourceKind: string | null;
  sourceId: string | null;
  sourceRevision: number | null;
  runId: string | null;
  toolCallId: string | null;
}

export interface PendingInputMentionDescriptor {
  mentionIndex: number;
  mentionKind: "person" | "connector";
  targetUserId: string | null;
  connectorType: string | null;
  startOffset: number;
  endOffset: number;
}

export interface PendingInputAttachmentDescriptor {
  resourceId: string;
  position: number;
  attachmentJson: string;
  attachedByUserId: string | null;
  watchEnabled: boolean;
  relationshipType: string;
  resourceJson: string;
  attachedAt: number;
  updatedAt: number;
}

export interface PendingInputDeliveryEffectInput {
  inputId: string;
  attachmentResourceIds?: string[];
  turnId: string;
  transcriptSequence: number;
  attentionOrdinal: number;
  actor: PendingLoopInputRow["actor"] | "assistant";
  authorUserId: string | null;
  authorNameSnapshot: string | null;
  text: string;
  mentionedUserIds: string[];
  confirmedParticipantUserIds: string[];
  affectedUserIds: string[];
  activatedParticipants: Array<{ userId: string; participantEpoch: number }>;
}

type ProtocolUserTransition = Extract<BindLoopTransition, { kind: "protocol_user_appended" }>;
type PendingSettlementTransition = Extract<BindLoopTransition, {
  kind: "tool_result_accepted" | "protocol_user_appended";
}>;

export interface PendingSteerSettlementOutcome {
  transitions: PendingSettlementTransition[];
  turns: TranscriptTurn[];
  removedInputIds: string[];
  deliveryEffects: PendingInputDeliveryEffectInput[];
  /** The derived inputs this settlement delivered or found already projected. */
  deliveredDerivedInputKeys: string[];
  stop: boolean;
  loop: SubstreamLoopRow;
}

/**
 * A model-only user message a host authority wrote during the batch and wants
 * appended at the next settled step: a resident context block, for example.
 * It is not a participant turn, so it is never promoted into the shared
 * transcript; it is appended to the Bind loop with its provenance and nothing
 * else, the way an activation input is. `key` is the host's own identity for
 * the delivery, handed back so the host can close it in the same commit.
 */
export interface PendingDerivedInput {
  key: string;
  message: BindLoopMessage;
  provenance: BindLoopMessageOrigin;
}

export interface PendingInputActivationReceipt {
  runId: string;
  substreamId: string;
  executionEpoch: number;
  leaseOwner: string;
  leaseExpiresAt: number;
  executionContextJson: string;
  executionPrincipalJson: string;
  origin: string;
  model: string | null;
}

export interface PendingInputActivationOutcome {
  outcome: "activated" | "reused";
  transitions: PendingSettlementTransition[];
  turns: TranscriptTurn[];
  removedInputIds: string[];
  deliveryEffects: PendingInputDeliveryEffectInput[];
  loop: SubstreamLoopRow;
  receiptRunId: string;
}

/**
 * The one spelling of a loop release refused for an unsettled tool batch.
 *
 * `drainPersistentLoop` selects its deferral branch on this, so a free-floating
 * message literal at each of the two throw sites was a rename away from
 * reverting the whole change: the catch would stop matching, the throw would
 * escape as a plain `substream_loop_drain_failed`, and the loop would be back
 * to the invisible hot retry this exists to remove.
 */
export const UNSETTLED_TOOL_BATCH_ERROR_CODE = "substream_loop_has_unsettled_tool_batch";

/**
 * A loop release refused because the projection still owes Bind tool results.
 *
 * Carries what `unsettledToolBatchBlockingRelease` already computed. Both call
 * sites used to throw that away and leave an operator a bare code, which is the
 * defect [`naming-a-schema-failure.md`](../../../../docs/naming-a-schema-failure.md)
 * exists to stop: the turn and the number of withheld calls are the difference
 * between "a batch is stuck" and knowing which one.
 */
export class UnsettledToolBatchError extends Error {
  readonly code = UNSETTLED_TOOL_BATCH_ERROR_CODE;
  readonly turnId: string;
  readonly modelTurnIndex: number;
  readonly withheldCallCount: number;

  constructor(batch: PendingBindToolBatch) {
    super(UNSETTLED_TOOL_BATCH_ERROR_CODE);
    this.name = "UnsettledToolBatchError";
    this.turnId = batch.turnId;
    this.modelTurnIndex = batch.modelTurnIndex;
    this.withheldCallCount = batch.calls.length;
  }
}

/**
 * Whether a caught throw is that refusal.
 *
 * The message arm is not a second literal: it is the same constant, and it is
 * what makes this survive an object-port hop, which flattens a typed error to a
 * bare `Error` carrying only its message.
 */
export function isUnsettledToolBatchError(error: unknown): error is Error {
  return error instanceof UnsettledToolBatchError
    || (error instanceof Error && error.message === UNSETTLED_TOOL_BATCH_ERROR_CODE);
}

export interface TranscriptExecutionFence {
  executionId: string;
  executionEpoch: number;
  leaseOwner: string;
  expectedBindStateRevision: number;
}

interface PreparedPendingBindAppend {
  pending: PendingLoopInputRow;
  material: ParsedPendingInputMaterial;
  steps: PreparedPendingBindStep[];
  next: BindLoopProjectionState;
  /**
   * The transcript high-water the gap-fill scanned before this input, and so
   * the sequence the persisted mark may advance to when it commits. `null` for
   * an elicitation answer, which scans nothing and advances nothing.
   */
  projectedThrough: number | null;
}

interface PreparedPendingBindStep {
  previous: BindLoopProjectionState;
  transition: PendingSettlementTransition;
  next: BindLoopProjectionState;
  facts: PreparedBindProjectionFacts;
}

interface PreparedBindProjectionFacts {
  materials: PreparedTranscriptFact[];
  messageFacts: Array<{ position: number; factId: string }>;
  messageCount: number;
  appendedFactId: string | null;
}

interface PreparedActivationBindAppend {
  transition: ProtocolUserTransition;
  next: BindLoopProjectionState;
  facts: PreparedBindProjectionFacts;
}

export interface PreparedToolLifecycle {
  toolCallId: string;
  pluginId: string | null;
  toolName: string;
  status: "started" | "completed" | "failed" | "ambiguous" | "cancelled";
  occurredAt: number;
  expectedFactId: string;
  expectedRevision: number;
  fact: PreparedTranscriptFact;
}

export interface ConversationTurnInput {
  messageId: string;
  clientMessageId: string;
  authorType: "human" | "agent" | "external" | "system";
  authorUserId: string | null;
  externalActorJson: string | null;
  messageType: "text" | "system" | "elicitation" | "tool" | "suggestion" | "automation_activation";
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

export interface PreparedConversationTurn {
  input: ConversationTurnInput;
  fact: PreparedTranscriptFact;
}

function normalizedAuthorSnapshot(
  input: Pick<ParticipantMessageInput, "actor" | "authorUserId" | "authorSnapshot">,
  errorPrefix: "participant_message" | "development_turn",
): { displayName: string; avatarUrl: string | null } | null {
  if (input.actor === "human") {
    if (!input.authorUserId || !input.authorSnapshot?.displayName.trim()) {
      throw new Error(`${errorPrefix}_author_snapshot_required`);
    }
    return {
      // The public transcript contract owns this bound. Enforce it before
      // persistence so an upstream profile cannot create an unreadable row.
      displayName: truncateUtf16Safe(input.authorSnapshot.displayName, 180),
      avatarUrl: input.authorSnapshot.avatarUrl
        && HttpUrlSchema.safeParse(input.authorSnapshot.avatarUrl).success
        ? input.authorSnapshot.avatarUrl
        : null,
    };
  }
  if (input.authorUserId !== null || input.authorSnapshot) {
    throw new Error(`${errorPrefix}_author_snapshot_invalid`);
  }
  return null;
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

/**
 * Canonical transcript substrate for the main work-stream child.
 *
 * Payload rows own bytes. Facts own semantic identity. Participant and Bind
 * tables are projections containing only stable references and ordering data.
 * Every multi-row state transition is one object-local SQLite transaction.
 */
export class WorkstreamTranscriptStorage {
  private readonly bindProjectionCache = new Map<string, BindLoopProjectionState>();

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly hasLiveTranscriptSnapshot: () => boolean = () => false,
  ) {}

  private get sql(): SqlStorage {
    return this.storage.sql;
  }

  /**
   * How this conversation renders a turn from outside Rally: as evidence in a
   * Sidekick run child, as a request everywhere else. See
   * {@link externalInputFraming}.
   */
  externalInputFraming(): ExternalInputFraming {
    const conversation = this.sql.exec<{
      parent_kind: string;
      external_substream_id: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT workstream.parent_kind, identity.external_substream_id
         FROM workstream LEFT JOIN substream_agent_identity AS identity ON identity.id = 1
        WHERE workstream.id = 1`,
    ).toArray()[0];
    // An object with no root row has no parent to frame for: a request.
    if (!conversation) return "request";
    return externalInputFraming({
      parentKind: conversation.parent_kind,
      substreamId: conversation.external_substream_id ?? "0",
    });
  }

  /**
   * The highest transcript sequence the model's conversation has considered.
   *
   * Distinct from {@link transcriptThrough}, and the distinction is the point:
   * a human turn can land in the transcript without ever entering the
   * projection, and this is the mark that says which ones have. Read by the
   * run to record what a compaction checkpoint actually covers — the
   * high-water mark would claim turns the model never saw.
   */
  transcriptProjectedThrough(): number {
    return new SubstreamLoopStorage(this.storage).loop()?.transcript_projected_through ?? 0;
  }

  /** Highest canonical sequence currently owned by this transcript. */
  transcriptThrough(): number {
    return Number(this.sql.exec<{
      next_transcript_sequence: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
    ).one().next_transcript_sequence) - 1;
  }

  async commitBindTransition(
    transition: BindLoopTransition,
    now = Date.now(),
    executionFence?: TranscriptExecutionFence,
    enqueueRegionalEffectsInTransaction?: (
      deliveries: readonly PendingInputDeliveryEffectInput[],
    ) => void,
    assertAdmissionInTransaction?: () => void,
  ): Promise<void> {
    const previous = this.readBindProjection(transition.loopId);
    const next = applyBindLoopTransition(previous, transition);
    const facts = await this.materializeProjectionFacts(transition, previous, next);

    this.storage.transactionSync(() => {
      assertAdmissionInTransaction?.();
      this.assertExpectedHead(previous, transition);
      for (const fact of facts.materials) this.insertFact(fact, now);
      this.writeBindState(transition, next, facts, now);
      if (transition.kind === "assistant_accepted") {
        if (!facts.appendedFactId) throw new Error("assistant_projection_fact_missing");
        const delivery = this.projectAssistantTurn(transition, facts.appendedFactId, now);
        if (delivery) {
          if (!enqueueRegionalEffectsInTransaction) {
            throw new Error("assistant_mention_effect_enqueue_required");
          }
          invokeSynchronousEffectEnqueue(enqueueRegionalEffectsInTransaction, [delivery]);
        }
      }
      if (executionFence) {
        this.advanceLoopBindRevisionInTransaction(
          transition.loopId,
          executionFence,
          transition.stateRevision,
          now,
        );
      }
    });
    this.bindProjectionCache.set(transition.loopId, next);
  }

  /**
   * Atomically project one host-recovered tool result into both Bind and the
   * participant transcript. A crash may leave a receipt terminal while its
   * provider-protocol result is absent; neither projection may advance alone
   * once recovery resumes.
   */
  async commitRecoveredToolResult(input: {
    transition: Extract<BindLoopTransition, { kind: "tool_result_accepted" }>;
    receiptToolCallId: string;
    lifecycle: {
      toolName: string;
      status: "completed" | "failed" | "ambiguous";
      participantSafeResult?: unknown;
      error?: string | null;
    };
    settlesBatch: boolean;
    now?: number;
    executionFence: TranscriptExecutionFence;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    const transition = input.transition;
    const previous = this.readBindProjection(transition.loopId);
    const next = applyBindLoopTransition(previous, transition);
    const [facts, lifecycle] = await Promise.all([
      this.materializeProjectionFacts(transition, previous, next),
      this.prepareToolLifecycle({
        toolCallId: input.receiptToolCallId,
        toolName: input.lifecycle.toolName,
        status: input.lifecycle.status,
        ...(input.lifecycle.participantSafeResult === undefined
          ? {}
          : { participantSafeResult: input.lifecycle.participantSafeResult }),
        ...(input.lifecycle.error === undefined ? {} : { error: input.lifecycle.error }),
        occurredAtUtc: new Date(now).toISOString(),
      }),
    ]);
    this.storage.transactionSync(() => {
      this.assertExpectedHead(previous, transition);
      for (const fact of facts.materials) this.insertFact(fact, now);
      this.writeBindState(transition, next, facts, now);
      this.upsertPreparedToolLifecycle(lifecycle);
      if (input.settlesBatch) this.closeRecoveredAssistantActivities(transition.turnId, now);
      this.advanceLoopBindRevisionInTransaction(
        transition.loopId,
        input.executionFence,
        transition.stateRevision,
        now,
      );
    });
    this.bindProjectionCache.set(transition.loopId, next);
  }

  /**
   * Append the canonical user inputs an activated executor is about to give
   * Bind. Source identity, not structural content, is the replay key: a
   * delivered pending input may reach this boundary again after eviction and
   * must not become a second model message.
   */
  async commitActivationInputs(input: {
    loopId: string;
    executionId: string;
    executionEpoch: number;
    leaseOwner: string;
    expectedBindGeneration: number;
    expectedBindStateRevision: number;
    inputs: readonly HarnessActivationInput[];
    now?: number;
  }): Promise<{
    transitions: ProtocolUserTransition[];
    replayedActivationInputIds: string[];
  }> {
    const now = input.now ?? Date.now();
    const previous = this.readBindProjection(input.loopId);
    if (!previous
      || previous.generation !== input.expectedBindGeneration
      || previous.stateRevision !== input.expectedBindStateRevision) {
      throw new Error("bind_loop_head_conflict");
    }
    const existingActivationInputs = new Map(this.bindActivationInputs(
      input.loopId,
      input.inputs.map((entry) => entry.activationInputId),
    )
      .map((entry) => [entry.activationInputId, entry]));
    const presentedProvenances = input.inputs.flatMap(({ message }) => {
      const provenance = message.provenance;
      return provenance?.originKind === "derived"
        && typeof provenance.sourceKind === "string"
        && provenance.sourceKind.length > 0
        && typeof provenance.sourceId === "string"
        && provenance.sourceId.length > 0
        && (provenance.sourceRevision === null
          || (Number.isSafeInteger(provenance.sourceRevision)
            && provenance.sourceRevision >= 0))
        ? [{
            originKind: "derived" as const,
            sourceKind: provenance.sourceKind,
            sourceId: provenance.sourceId,
            sourceRevision: provenance.sourceRevision,
          }]
        : [];
    });
    const acceptedProvenance = new Set(this.currentBindProvenanceKeys(
      input.loopId,
      presentedProvenances,
    ));
    const requestedActivationInputIds = new Set<string>();
    const replayedActivationInputIds = new Set<string>();
    const receiptAliases: Array<{
      activationInputId: string;
      fact: PreparedTranscriptFact;
    }> = [];
    const missing: Array<{
      activationInputId: string;
      message: BindLoopMessage;
      provenance: BindLoopMessageOrigin;
    }> = [];
    for (const { activationInputId, message } of input.inputs) {
      if (requestedActivationInputIds.has(activationInputId)) {
        throw new Error("bind_activation_input_duplicate");
      }
      requestedActivationInputIds.add(activationInputId);
      if (message.role !== "user") throw new Error("bind_activation_input_role_invalid");
      const provenance = message.provenance;
      if (!activationInputId.trim() || !provenance
        || provenance.originKind !== "derived"
        || !provenance.sourceKind?.trim()
        || !provenance.sourceId?.trim()
        || (provenance.sourceRevision !== null
          && (!Number.isSafeInteger(provenance.sourceRevision)
            || provenance.sourceRevision < 0))) {
        throw new Error("bind_activation_input_provenance_required");
      }
      const bindMessage = modelMessageWithoutProvenance(message);
      const messageJson = canonicalJson(bindMessage);
      const provenanceKey = bindProvenanceKey(provenance);
      const replay = existingActivationInputs.get(activationInputId);
      if (replay) {
        if (replay.messageJson !== messageJson || replay.provenanceKey !== provenanceKey) {
          throw new Error("bind_activation_input_replay_mismatch");
        }
        replayedActivationInputIds.add(activationInputId);
        continue;
      }
      if (acceptedProvenance.has(provenanceKey)) {
        const fact = await this.prepareFact({
          factId: `${input.loopId}:activation-input:${activationInputId}`,
          factKind: "activation_input",
          audience: participantShareable(bindMessage) ? "shared" : "model",
          payload: bindMessage,
          origin: provenance,
          runId: input.loopId,
          turnId: null,
          toolCallId: null,
        });
        receiptAliases.push({
          activationInputId,
          fact,
        });
        replayedActivationInputIds.add(activationInputId);
        continue;
      }
      acceptedProvenance.add(provenanceKey);
      missing.push({ activationInputId, message: bindMessage, provenance });
    }

    const prepared: PreparedActivationBindAppend[] = [];
    let projection = previous;
    for (const entry of missing) {
      const transition: ProtocolUserTransition = {
        kind: "protocol_user_appended",
        loopId: input.loopId,
        generation: projection.generation,
        stateRevision: projection.stateRevision + 1,
        message: entry.message,
        provenance: entry.provenance,
        activationInputId: entry.activationInputId,
      };
      const next = applyBindLoopTransition(projection, transition);
      const facts = await this.materializeProjectionFacts(transition, projection, next);
      const appended = facts.messageFacts[0];
      if (!appended
        || appended.position !== bindLoopNonSystemMessageCount(projection) + 1) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      prepared.push({ transition, next, facts });
      projection = next;
    }

    const result = this.storage.transactionSync(() => {
      this.assertBindHead(
        input.loopId,
        input.expectedBindGeneration,
        input.expectedBindStateRevision,
      );
      this.assertLoopExecutionBindFence({
        executionId: input.executionId,
        executionEpoch: input.executionEpoch,
        leaseOwner: input.leaseOwner,
        expectedBindStateRevision: input.expectedBindStateRevision,
      }, input.loopId, now);
      for (let index = 0; index < prepared.length; index += 1) {
        const append = prepared[index]!;
        this.assertExpectedHead(index === 0 ? previous : prepared[index - 1]!.next, append.transition);
        for (const fact of append.facts.materials) this.insertFact(fact, now);
        this.writeBindState(append.transition, append.next, append.facts, now);
      }
      for (const alias of receiptAliases) {
        this.insertFact(alias.fact, now);
        this.sql.exec(
          `INSERT INTO bind_activation_inputs
             (loop_id, activation_input_id, fact_id, admitted_state_revision, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          input.loopId,
          alias.activationInputId,
          alias.fact.factId,
          input.expectedBindStateRevision,
          now,
        );
      }
      if (prepared.length > 0) {
        this.advanceLoopBindRevisionBatchInTransaction(
          input.loopId,
          {
            executionId: input.executionId,
            executionEpoch: input.executionEpoch,
            leaseOwner: input.leaseOwner,
            expectedBindStateRevision: input.expectedBindStateRevision,
          },
          projection.stateRevision,
          now,
        );
      }
      return {
        transitions: prepared.map((append) => append.transition),
        replayedActivationInputIds: [...replayedActivationInputIds],
      };
    });
    if (prepared.length > 0) this.bindProjectionCache.set(input.loopId, projection);
    return result;
  }

  /**
   * Close a reserved Workstream assistant turn without retaining partial
   * streamed bytes. The Bind settlement, canonical status pill, and
   * reservation outcome are one SQLite commit at the already-owned sequence.
   */
  async commitAssistantReservationError(input: {
    transition: Extract<BindLoopTransition, { kind: "assistant_reservation_settled" }>;
    code: string;
    label: string;
    executionFence?: TranscriptExecutionFence;
    now?: number;
  }): Promise<void> {
    const { transition } = input;
    if (transition.transcriptSequence === null) {
      throw new Error("workstream_assistant_reservation_missing_sequence");
    }
    const now = input.now ?? Date.now();
    const previous = this.readBindProjection(transition.loopId);
    const next = applyBindLoopTransition(previous, transition);
    const facts = await this.materializeProjectionFacts(transition, previous, next);
    const statusFact = await this.prepareFact({
      factId: `${transition.turnId}:status`,
      factKind: "assistant_turn_status",
      audience: "participant",
      payload: {
        role: "system",
        content: input.label,
        structuredContent: {
          kind: transition.outcome === "stopped"
            ? "assistant_turn_stopped"
            : "assistant_turn_failed",
          code: input.code,
        },
      },
      origin: canonicalOrigin(),
      runId: null,
      turnId: transition.turnId,
      toolCallId: null,
    });

    this.storage.transactionSync(() => {
      this.assertExpectedHead(previous, transition);
      const reservation = this.sql.exec<{
        transcript_sequence: number; state: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT transcript_sequence, state FROM assistant_turn_reservations
          WHERE turn_id = ? AND loop_id = ?`,
        transition.turnId,
        transition.loopId,
      ).toArray()[0];
      if (!reservation
        || Number(reservation.transcript_sequence) !== transition.transcriptSequence
        || (reservation.state !== "reserved" && reservation.state !== "streaming")) {
        throw new Error("workstream_assistant_reservation_mismatch");
      }
      for (const fact of [...facts.materials, statusFact]) this.insertFact(fact, now);
      this.writeBindState(transition, next, facts, now);
      const occupied = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
        `SELECT turn_id FROM participant_transcript_turns WHERE transcript_sequence = ?`,
        transition.transcriptSequence,
      ).toArray()[0];
      if (occupied && occupied.turn_id !== transition.turnId) {
        throw new Error("assistant_turn_reserved_sequence_occupied");
      }
      if (!occupied) {
        this.sql.exec(
          `INSERT INTO participant_transcript_turns
             (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
              author_name_snapshot, author_avatar_url_snapshot, client_message_id,
              external_actor_json, message_type, root_fact_id, activity_id,
              attention_ordinal, revision, created_at, updated_at)
           VALUES (?, ?, 'status', 'system', NULL, NULL, NULL, NULL, NULL,
                   'system', ?, NULL, NULL, 1, ?, ?)`,
          transition.transcriptSequence,
          transition.turnId,
          statusFact.factId,
          now,
          now,
        );
        this.sql.exec(
          `INSERT INTO participant_transcript_blocks
             (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
           VALUES (?, ?, 0, 'text', ?, 1, ?)`,
          transition.turnId,
          `${transition.turnId}:status`,
          statusFact.factId,
          now,
        );
      }
      const materialized = this.sql.exec<{
        turn_id: string;
      } & Record<string, SqlStorageValue>>(
        `UPDATE assistant_turn_reservations
            SET state = 'materialized', outcome = 'error',
                materialized_turn_id = turn_id, materialized_at = ?, updated_at = ?
          WHERE turn_id = ? AND state IN ('reserved', 'streaming')
          RETURNING turn_id`,
        now,
        now,
        transition.turnId,
      ).toArray()[0];
      if (materialized?.turn_id !== transition.turnId) {
        throw new Error("workstream_assistant_reservation_materialization_failed");
      }
      // A canonical participant mutation and the semantic reference that lets
      // an already-subscribed member observe it are one authority commit.
      enqueueSemanticRealtimeReference(
        this.sql,
        { kind: "transcript_turn", turnId: transition.turnId },
        now,
      );
      if (input.executionFence) {
        this.advanceLoopBindRevisionInTransaction(
          transition.loopId,
          input.executionFence,
          transition.stateRevision,
          now,
        );
      }
    });
    this.bindProjectionCache.set(transition.loopId, next);
  }

  /**
   * Settle the one active assistant reservation at a failed/stopped execution
   * boundary. A host reservation is committed before Bind's `assistant_reserved`
   * transition, so recovery may observe the former without the latter. Repair
   * that missing edge first, then materialize the canonical error pill. Each
   * commit is independently replayable; no provider call is needed between them.
   */
  async settleActiveAssistantReservation(input: {
    loopId: string;
    executionId: string;
    executionEpoch: number;
    leaseOwner: string;
    outcome: "failed" | "stopped";
    code: string;
    label: string;
    now?: number;
  }): Promise<{ turnId: string; transcriptSequence: number } | null> {
    const now = input.now ?? Date.now();
    const active = new SubstreamLoopStorage(this.storage).activeReservation();
    if (!active) return null;
    if (active.loop_id !== input.loopId) {
      throw new Error("workstream_assistant_reservation_mismatch");
    }
    let projection = this.readBindProjection(input.loopId);
    if (!projection) throw new Error("bind_loop_head_conflict");
    const pending = projection.lastAssistantReservation;
    if (!pending || pending.status !== "pending") {
      if (active.state !== "reserved"
        || active.assistant_turn_sequence !== projection.lastModelTurnIndex + 1
        || active.turn_id !== `${input.loopId}:turn:${active.assistant_turn_sequence}`) {
        throw new Error("bind_loop_pending_reservation_mismatch");
      }
      await this.commitBindTransition({
        kind: "assistant_reserved",
        loopId: input.loopId,
        generation: projection.generation,
        stateRevision: projection.stateRevision + 1,
        turnId: active.turn_id,
        modelTurnIndex: active.assistant_turn_sequence,
        transcriptSequence: active.transcript_sequence,
      }, now, {
        executionId: input.executionId,
        executionEpoch: input.executionEpoch,
        leaseOwner: input.leaseOwner,
        expectedBindStateRevision: projection.stateRevision,
      });
      projection = this.readBindProjection(input.loopId);
      if (!projection) throw new Error("bind_loop_head_conflict");
    }
    const repaired = projection.lastAssistantReservation;
    if (!repaired || repaired.status !== "pending"
      || repaired.turnId !== active.turn_id
      || repaired.modelTurnIndex !== active.assistant_turn_sequence
      || repaired.transcriptSequence !== active.transcript_sequence) {
      throw new Error("bind_loop_pending_reservation_mismatch");
    }
    await this.commitAssistantReservationError({
      transition: {
        kind: "assistant_reservation_settled",
        loopId: input.loopId,
        generation: projection.generation,
        stateRevision: projection.stateRevision + 1,
        turnId: active.turn_id,
        modelTurnIndex: active.assistant_turn_sequence,
        transcriptSequence: active.transcript_sequence,
        outcome: input.outcome,
      },
      code: input.code,
      label: input.label,
      executionFence: {
        executionId: input.executionId,
        executionEpoch: input.executionEpoch,
        leaseOwner: input.leaseOwner,
        expectedBindStateRevision: projection.stateRevision,
      },
      now,
    });
    return {
      turnId: active.turn_id,
      transcriptSequence: active.transcript_sequence,
    };
  }

  async commitBindCompaction(input: {
    commit: BindCompactionCommit;
    continuation: TranscriptCompactionContinuation;
    now?: number;
    /**
     * Host state that must move with the checkpoint, in the same commit: the
     * context-residency ledger's compaction transitions. Synchronous, keyed by
     * the compaction event on the host side, and not run on a replayed commit
     * because the first commit already carried it.
     */
    applyInTransaction?: () => void;
  }, executionFence?: TranscriptExecutionFence): Promise<void> {
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
      if (executionFence) {
        this.storage.transactionSync(() => {
          // A checkpoint alone is not authority to move the loop cursor. Exact
          // head identity proves this is the narrow historical crash window:
          // Bind committed this replacement but the singleton did not.
          this.assertBindHead(
            transition.loopId,
            transition.nextGeneration,
            transition.stateRevision,
          );
          this.ensureLoopBindRevisionAfterReplay(
            transition.loopId,
            executionFence,
            transition.stateRevision,
            now,
          );
        });
      }
      return;
    }
    const previous = this.readBindProjection(transition.loopId);
    const next = applyBindLoopTransition(previous, transition);
    const facts = await this.materializeProjectionFacts(transition, previous, next);
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
      this.writeBindState(transition, next, facts, now);
      if (input.applyInTransaction) {
        const returned = input.applyInTransaction() as unknown;
        if (returned && (typeof returned === "object" || typeof returned === "function")
          && "then" in returned) {
          throw new Error("compaction_host_state_must_be_synchronous");
        }
      }
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
      const insertedStatus = this.insertParticipantStatus({
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
      if (!insertedStatus) {
        enqueueSemanticRealtimeReference(
          this.sql,
          { kind: "transcript_turn", turnId: transition.compactionEventId },
          now,
        );
      }
      if (executionFence) {
        this.advanceLoopBindRevisionInTransaction(
          transition.loopId,
          executionFence,
          transition.stateRevision,
          now,
        );
      }
    });
    this.bindProjectionCache.set(transition.loopId, next);
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
              json_extract(payload.payload_json, '$.messages') AS messages_json,
              json_extract(payload.payload_json, '$.summary') AS summary
         FROM transcript_compaction_checkpoints checkpoint
         JOIN transcript_facts fact ON fact.fact_id = checkpoint.checkpoint_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE ${where}
        ORDER BY checkpoint.compacted_through_sequence DESC, checkpoint.updated_at DESC
        LIMIT 1`,
      ...params,
    ).toArray()[0];
  }

  recordProviderBoundary(boundary: BindProviderBoundary, now = Date.now()): void {
    if (boundary.projectedHash !== boundary.bindHash) throw new Error("bind_loop_projection_mismatch");
    this.storage.transactionSync(() => {
      const head = this.sql.exec<{
        generation: number;
        state_revision: number;
        system_projection_revision: number;
        projector_version: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT generation, state_revision, system_projection_revision, projector_version
           FROM bind_loop_heads WHERE loop_id = ?`,
        boundary.loopId,
      ).toArray()[0];
      if (!head || Number(head.state_revision) !== boundary.stateRevision) {
        throw new Error("bind_provider_boundary_stale_projection");
      }
      const existing = this.sql.exec<{
        generation: number;
        system_projection_revision: number;
        projector_version: string;
        projected_hash: string;
        bind_hash: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT generation, system_projection_revision, projector_version,
                projected_hash, bind_hash
           FROM bind_provider_boundaries
          WHERE loop_id = ? AND state_revision = ?`,
        boundary.loopId,
        boundary.stateRevision,
      ).toArray()[0];
      if (existing) {
        if (Number(existing.generation) !== boundary.generation
          || Number(existing.system_projection_revision) !== boundary.systemProjectionRevision
          || existing.projector_version !== boundary.projectorVersion
          || existing.projected_hash !== boundary.projectedHash
          || existing.bind_hash !== boundary.bindHash) {
          throw new Error("bind_provider_boundary_replay_conflict");
        }
        return;
      }
      if (Number(head.generation) !== boundary.generation
        || Number(head.system_projection_revision) !== boundary.systemProjectionRevision
        || head.projector_version !== boundary.projectorVersion) {
        throw new Error("bind_provider_boundary_stale_projection");
      }
      this.sql.exec(
        `INSERT INTO bind_provider_boundaries
           (loop_id, state_revision, generation, system_projection_revision,
            projector_version, projected_hash, bind_hash, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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

  /**
   * Commit one safe Bind step boundary. A durable stop consumes no steer rows;
   * terminal receipt publication closes the execution afterwards. Otherwise
   * every steer visible at the commit fence is promoted in input order and
   * appended to Bind in that same commit.
   */
  async settlePendingSteersAtStep(input: {
    loopId: string;
    executionId: string;
    executionEpoch: number;
    leaseOwner: string;
    expectedLoopRevision: number;
    expectedStepOrdinal: number;
    expectedBindGeneration: number;
    expectedBindStateRevision: number;
    assistantTurnId: string;
    modelTurnIndex: number;
    enqueueRegionalEffectsInTransaction: (
      deliveries: readonly PendingInputDeliveryEffectInput[],
    ) => void;
    /**
     * Model-only inputs a host authority wants appended at this boundary,
     * ahead of any participant steer. Delivered inside the same commit;
     * `markDerivedInputsDeliveredInTransaction` runs synchronously in that
     * commit with every key that was appended or found already projected.
     */
    derivedInputs?: readonly PendingDerivedInput[];
    markDerivedInputsDeliveredInTransaction?: (keys: readonly string[]) => void;
    now?: number;
  }): Promise<PendingSteerSettlementOutcome> {
    const now = input.now ?? Date.now();
    const loopStorage = new SubstreamLoopStorage(this.storage);
    const beforeLoop = loopStorage.loop();
    if (!beforeLoop || beforeLoop.loop_id !== input.loopId) {
      throw new Error("substream_loop_not_found");
    }
    const previous = this.readBindProjection(input.loopId);
    if (!previous
      || previous.generation !== input.expectedBindGeneration
      || previous.stateRevision !== input.expectedBindStateRevision) {
      throw new Error("bind_loop_head_conflict");
    }
    const derived = beforeLoop.stop_requested_at === null
      ? await this.prepareDerivedBindAppends(previous, input.derivedInputs ?? [])
      : { steps: [], next: previous, keys: [] };
    const pending = beforeLoop.stop_requested_at === null
      ? this.pendingSteersForCommit()
      : [];
    const prepared = await this.preparePendingBindAppends(derived.next, pending);
    // What lands under the steers is read by the step that answers them.
    const withoutRunInputs = beforeLoop.stop_requested_at === null
      ? this.inputsWithoutRunLandingAfter(prepared.map((append) => append.pending.input_id))
      : [];
    const withoutRunBind = withoutRunInputs.length > 0
      ? await this.prepareInputsWithoutRunSteps(prepared.at(-1)?.next ?? derived.next, withoutRunInputs)
      : null;

    const result = this.storage.transactionSync(() => {
      const loop = this.assertStepSettlementFence(input, now);
      const stop = loop.stop_requested_at !== null;
      const committedPrepared = stop ? [] : prepared;
      const currentPending = stop ? [] : this.pendingSteersForCommit();
      // Admission may interleave while the immutable Bind facts above are
      // hashed. The captured prefix is this boundary's durable high-water;
      // later steers stay pending for the next boundary instead of failing a
      // completed observable model/tool step.
      if (!stop && !sameOrderedInputPrefix(pending, currentPending)) {
        throw new Error("pending_steer_set_changed");
      }
      this.assertBindHead(input.loopId, input.expectedBindGeneration, input.expectedBindStateRevision);
      const reservation = this.sql.exec<{
        assistant_turn_sequence: number; state: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT assistant_turn_sequence, state FROM assistant_turn_reservations
          WHERE turn_id = ? AND loop_id = ?`,
        input.assistantTurnId,
        input.loopId,
      ).toArray()[0];
      if (!reservation || Number(reservation.assistant_turn_sequence) !== input.modelTurnIndex
        || reservation.state !== "materialized") {
        throw new Error("substream_loop_step_assistant_unsettled");
      }

      const turns: TranscriptTurn[] = [];
      const deliveryEffects: PendingInputDeliveryEffectInput[] = [];
      let projectedThrough = 0;
      // Derived inputs first: they belong to the batch that just ran, and a
      // participant steer admitted meanwhile reads after them, the order the
      // room would give if the tool had spoken and then the person had.
      const committedDerived = stop ? { steps: [], next: previous, keys: [] } : derived;
      for (const step of committedDerived.steps) {
        this.assertExpectedHead(step.previous, step.transition);
        for (const fact of step.facts.materials) this.insertFact(fact, now);
        this.writeBindState(step.transition, step.next, step.facts, now);
      }
      if (committedDerived.keys.length > 0 && input.markDerivedInputsDeliveredInTransaction) {
        const returned = input.markDerivedInputsDeliveredInTransaction(committedDerived.keys) as unknown;
        if (returned && (typeof returned === "object" || typeof returned === "function")
          && "then" in returned) {
          throw new Error("derived_input_delivery_mark_must_be_synchronous");
        }
      }
      for (let index = 0; index < committedPrepared.length; index += 1) {
        const append = committedPrepared[index]!;
        const delivered = this.promotePendingInputInTransaction(
          append.pending,
          append.material,
          now,
        );
        // What the gap-fill scanned, never the promoted turn's own sequence:
        // that sequence is allocated here, after the scan, and a turn written
        // between the two would sit below the mark without ever having been
        // looked at. The promoted turn is re-scanned on the next pass and
        // skipped by its provenance.
        projectedThrough = Math.max(projectedThrough, append.projectedThrough ?? 0);
        for (const step of append.steps) {
          this.assertExpectedHead(step.previous, step.transition);
          for (const fact of step.facts.materials) this.insertFact(fact, now);
          this.writeBindState(step.transition, step.next, step.facts, now);
        }
        this.markPendingDeliveredDirect(
          append.pending,
          delivered.attentionOrdinal,
          now,
        );
        const turn = this.participantTurn(append.pending.prepared_turn_id);
        if (!turn || turn.attentionOrdinal !== delivered.attentionOrdinal) {
          throw new Error("pending_input_turn_hydration_failed");
        }
        turns.push(turn);
        deliveryEffects.push(delivered.deliveryEffect);
      }
      // What waited behind the steers just delivered lands with them, before
      // the next model step can write a turn between them.
      const committedWithoutRunBind = stop ? null : withoutRunBind;
      const withoutRun = committedWithoutRunBind
        ? this.deliverPreparedInputsWithoutRunInTransaction(withoutRunInputs, committedWithoutRunBind.steps, now)
        : this.deliverLeadingInputsWithoutRunInTransaction(now);
      turns.push(...withoutRun.turns);
      deliveryEffects.push(...withoutRun.deliveryEffects);
      const nextBindStateRevision = committedWithoutRunBind?.next.stateRevision
        ?? committedPrepared.at(-1)?.next.stateRevision
        ?? committedDerived.next.stateRevision;
      // A safe step ends Bind's current model/tool iteration, not the durable
      // execution receipt. Keep ownership until terminal receipt publication
      // atomically closes the singleton; otherwise an isolate death between
      // these commits strands a running receipt behind an idle loop.
      const updated = this.sql.exec<{
          loop_id: string;
          revision: number;
        } & Record<string, SqlStorageValue>>(
          `UPDATE substream_loops
              SET step_ordinal = step_ordinal + 1, bind_state_revision = ?,
                  transcript_projected_through = MAX(transcript_projected_through, ?),
                  revision = revision + 1, updated_at = ?
            WHERE id = 1 AND revision = ? AND status = 'executing'
              AND active_execution_id = ? AND active_execution_epoch = ?
              AND lease_owner = ? AND step_ordinal = ?
              AND bind_state_revision = ?
            RETURNING loop_id, revision`,
          nextBindStateRevision,
          projectedThrough,
          now,
          loop.revision,
          input.executionId,
          input.executionEpoch,
          input.leaseOwner,
          input.expectedStepOrdinal,
          input.expectedBindStateRevision,
        ).toArray()[0];
      if (updated?.loop_id !== input.loopId || updated.revision !== loop.revision + 1) {
        throw new Error("substream_loop_revision_mismatch");
      }
      invokeSynchronousEffectEnqueue(
        input.enqueueRegionalEffectsInTransaction,
        deliveryEffects,
      );
      const committedLoop = loopStorage.loop();
      if (!committedLoop) throw new Error("substream_loop_not_found");
      return {
        transitions: [
          ...committedDerived.steps.map((step) => step.transition),
          ...committedPrepared.flatMap((append) =>
            append.steps.map((step) => step.transition)),
          ...committedWithoutRunBind?.steps.map((step) => step.transition) ?? [],
        ],
        turns,
        removedInputIds: [
          ...committedPrepared.map((append) => append.pending.input_id),
          ...withoutRun.removedInputIds,
        ],
        deliveryEffects,
        deliveredDerivedInputKeys: committedDerived.keys,
        stop,
        loop: committedLoop,
      };
    });
    const committedProjection = withoutRunBind?.next ?? prepared.at(-1)?.next
      ?? (derived.steps.length > 0 ? derived.next : undefined);
    if (committedProjection && !result.stop) {
      this.bindProjectionCache.set(input.loopId, committedProjection);
    }
    return result;
  }

  /**
   * Prepare the Bind appends for a host authority's derived inputs.
   *
   * One `protocol_user_appended` per input whose provenance the loop has not
   * already projected; an input whose provenance is already there is a replay
   * and is reported delivered without a second message. Hashing happens here,
   * before the settlement transaction, like every other prepared append.
   */
  private async prepareDerivedBindAppends(
    previous: BindLoopProjectionState,
    inputs: readonly PendingDerivedInput[],
  ): Promise<{ steps: PreparedPendingBindStep[]; next: BindLoopProjectionState; keys: string[] }> {
    const steps: PreparedPendingBindStep[] = [];
    const keys: string[] = [];
    if (inputs.length === 0) return { steps, next: previous, keys };
    // A derived input is a `protocol_user_appended` like any other, so any
    // withheld batch refuses it — and this preparer runs before the settlement
    // transaction, which means the throw failed the whole settled step rather
    // than the delivery. The predicate is the whole batch, not a question:
    // there is nothing loud to preserve on this path, because the throw becomes
    // a terminal `run_state_persistence_failed` on a step that had completed.
    // Undelivered is the honest outcome: nothing is marked delivered, and the
    // next settled step appends it.
    if (pendingBindToolBatch(previous) !== null) return { steps, next: previous, keys };
    const alreadyProjected = new Set(this.currentBindProvenanceKeys(
      previous.loopId,
      inputs.map((entry) => entry.provenance),
    ));
    let projection = previous;
    for (const entry of inputs) {
      if (entry.message.role !== "user") throw new Error("derived_input_role_invalid");
      if (entry.provenance.originKind !== "derived"
        || !entry.provenance.sourceKind?.trim()
        || !entry.provenance.sourceId?.trim()) {
        throw new Error("derived_input_provenance_required");
      }
      keys.push(entry.key);
      const provenanceKey = bindProvenanceKey(entry.provenance);
      if (alreadyProjected.has(provenanceKey)) continue;
      alreadyProjected.add(provenanceKey);
      const transition: ProtocolUserTransition = {
        kind: "protocol_user_appended",
        loopId: previous.loopId,
        generation: projection.generation,
        stateRevision: projection.stateRevision + 1,
        message: entry.message,
        provenance: entry.provenance,
        activationInputId: null,
      };
      const next = applyBindLoopTransition(projection, transition);
      const facts = await this.materializeProjectionFacts(transition, projection, next);
      const appended = facts.messageFacts[0];
      if (!appended
        || appended.position !== bindLoopNonSystemMessageCount(projection) + 1) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      steps.push({ previous: projection, transition, next, facts });
      projection = next;
    }
    return { steps, next: projection, keys };
  }

  /**
   * Atomically promote the oldest idle input, create its subordinate execution
   * receipt, and acquire the first lease for one cycle. An existing Bind head
   * receives the user append here; an absent head is initialized afterward
   * from the canonical turn, under the execution fence this commit acquires.
   */
  async activatePendingInput(input: {
    loopId: string;
    expectedInputId: string;
    expectedLoopRevision: number;
    /** `null` proves the caller observed no Bind head; revision must then be zero. */
    expectedBindGeneration: number | null;
    expectedBindStateRevision: number;
    receipt: PendingInputActivationReceipt;
    enqueueRegionalEffectsInTransaction: (
      deliveries: readonly PendingInputDeliveryEffectInput[],
    ) => void;
    now?: number;
  }): Promise<PendingInputActivationOutcome> {
    const now = input.now ?? Date.now();
    const loopStorage = new SubstreamLoopStorage(this.storage);
    const beforeLoop = loopStorage.loop();
    if (!beforeLoop || beforeLoop.loop_id !== input.loopId) {
      throw new Error("substream_loop_not_found");
    }
    const replay = this.activationReplay(input);
    if (replay) return replay;
    if (beforeLoop.status !== "idle") throw new Error("substream_loop_not_idle");
    const previous = this.readBindProjection(input.loopId);
    const initializesFromCanonicalHistory = previous === null;
    if (previous === null) {
      if (input.expectedBindGeneration !== null
        || input.expectedBindStateRevision !== 0
        || beforeLoop.bind_state_revision !== 0) {
        throw new Error("bind_loop_head_conflict");
      }
    } else if (previous.generation !== input.expectedBindGeneration
      || previous.stateRevision !== input.expectedBindStateRevision
      || beforeLoop.bind_state_revision !== input.expectedBindStateRevision) {
      throw new Error("bind_loop_head_conflict");
    }
    const pending = this.oldestActivationInput(previous);
    if (!pending || pending.input_id !== input.expectedInputId) {
      throw new Error("substream_loop_activation_input_changed");
    }
    const prepared = previous === null
      ? null
      : (await this.preparePendingBindAppends(previous, [pending]))[0] ?? null;
    const material = prepared?.material ?? parsePendingInputMaterial(pending);
    if (!initializesFromCanonicalHistory && !prepared) {
      throw new Error("substream_loop_activation_input_missing");
    }
    // Sent before this run starts, so this run reads it. A bootstrap reads the
    // canonical history up to the activated turn instead, and the next input's
    // gap-fill carries these.
    const withoutRunInputs = prepared ? this.inputsWithoutRunLandingAfter([pending.input_id]) : [];
    const withoutRunBind = prepared
      ? await this.prepareInputsWithoutRunSteps(prepared.next, withoutRunInputs)
      : null;
    const committedProjection = withoutRunBind?.next ?? prepared?.next ?? null;
    this.validateActivationReceipt(input.receipt, now);

    const result = this.storage.transactionSync(() => {
      const currentLoop = loopStorage.loop();
      if (!currentLoop || currentLoop.loop_id !== input.loopId
        || currentLoop.status !== "idle"
        || currentLoop.revision !== input.expectedLoopRevision
        || currentLoop.bind_state_revision !== input.expectedBindStateRevision) {
        throw new Error("substream_loop_revision_mismatch");
      }
      if (initializesFromCanonicalHistory) {
        if (this.readBindProjection(input.loopId) !== null) throw new Error("bind_loop_head_conflict");
      } else {
        const expectedGeneration = input.expectedBindGeneration;
        if (expectedGeneration === null) throw new Error("bind_loop_head_conflict");
        this.assertBindHead(
          input.loopId,
          expectedGeneration,
          input.expectedBindStateRevision,
        );
      }
      const currentPending = this.oldestActivationInput(previous);
      if (!currentPending || !samePendingInput(pending, currentPending)) {
        throw new Error("substream_loop_activation_input_changed");
      }
      const delivered = this.promotePendingInputInTransaction(
        pending,
        material,
        now,
      );
      if (prepared) {
        for (const step of prepared.steps) {
          this.assertExpectedHead(step.previous, step.transition);
          for (const fact of step.facts.materials) this.insertFact(fact, now);
          this.writeBindState(step.transition, step.next, step.facts, now);
        }
      }
      this.markPendingDeliveredDirect(pending, delivered.attentionOrdinal, now);
      const cycleOrdinal = currentLoop.cycle_ordinal + 1;
      this.sql.exec(
        `INSERT INTO runs
           (run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
            model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
            active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
            tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
            terminal_reason, origin, execution_principal_json, chain_depth, model,
            trigger_part_id, created_at, updated_at, substream_loop_id, loop_input_id,
            loop_cycle_ordinal, loop_execution_id,
            loop_execution_epoch, loop_execution_sequence, execution_context_json,
            execution_available_at, external_settled_at, last_settlement_error_code)
         VALUES (?, ?, NULL, 'running', '{}', 0, 0, '', ?, 0, ?,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        input.receipt.runId,
        input.receipt.substreamId,
        delivered.transcriptSequence,
        now,
        input.receipt.origin,
        input.receipt.executionPrincipalJson,
        input.receipt.model,
        pending.prepared_turn_id,
        now,
        now,
        input.loopId,
        pending.input_id,
        cycleOrdinal,
        input.receipt.runId,
        input.receipt.executionEpoch,
        currentLoop.next_execution_sequence,
        input.receipt.executionContextJson,
      );
      const activated = this.sql.exec<{
        loop_id: string;
        revision: number;
      } & Record<string, SqlStorageValue>>(
        `UPDATE substream_loops
            SET status = 'executing', cycle_ordinal = ?, step_ordinal = 0,
                bind_state_revision = ?, active_execution_id = ?,
                active_execution_epoch = ?, lease_owner = ?, lease_expires_at = ?,
                next_execution_sequence = next_execution_sequence + 1,
                transcript_projected_through = MAX(transcript_projected_through, ?),
                revision = revision + 1, updated_at = MAX(updated_at, ?)
          WHERE id = 1 AND revision = ? AND status = 'idle'
            AND bind_state_revision = ?
          RETURNING loop_id, revision`,
        cycleOrdinal,
        committedProjection?.stateRevision ?? 0,
        input.receipt.runId,
        input.receipt.executionEpoch,
        input.receipt.leaseOwner,
        input.receipt.leaseExpiresAt,
        // On a bootstrap the run reads the whole transcript up to the
        // activated turn, so the mark is that turn. Otherwise it is what the
        // gap-fill scanned before the input — never the input's own sequence,
        // which is allocated after the scan and would put a turn written in
        // between below the mark unseen.
        initializesFromCanonicalHistory
          ? delivered.transcriptSequence
          : prepared?.projectedThrough ?? 0,
        now,
        input.expectedLoopRevision,
        input.expectedBindStateRevision,
      ).toArray()[0];
      if (activated?.loop_id !== input.loopId
        || activated.revision !== input.expectedLoopRevision + 1) {
        throw new Error("substream_loop_revision_mismatch");
      }
      const turn = this.participantTurn(pending.prepared_turn_id);
      // What was sent behind the activated input without addressing Rally
      // lands directly under it, ahead of anything the new run writes.
      const withoutRun = withoutRunBind
        ? this.deliverPreparedInputsWithoutRunInTransaction(withoutRunInputs, withoutRunBind.steps, now)
        : this.deliverLeadingInputsWithoutRunInTransaction(now);
      const deliveryEffects = [delivered.deliveryEffect, ...withoutRun.deliveryEffects];
      invokeSynchronousEffectEnqueue(
        input.enqueueRegionalEffectsInTransaction,
        deliveryEffects,
      );
      const committedLoop = loopStorage.loop();
      if (!turn || turn.attentionOrdinal !== delivered.attentionOrdinal || !committedLoop) {
        throw new Error("pending_input_activation_hydration_failed");
      }
      return {
        outcome: "activated" as const,
        transitions: [...prepared?.steps ?? [], ...withoutRunBind?.steps ?? []]
          .map((step) => step.transition),
        turns: [turn, ...withoutRun.turns],
        removedInputIds: [pending.input_id, ...withoutRun.removedInputIds],
        deliveryEffects,
        loop: committedLoop,
        receiptRunId: input.receipt.runId,
      };
    });
    if (committedProjection) this.bindProjectionCache.set(input.loopId, committedProjection);
    return result;
  }

  async appendParticipantMessage(input: ParticipantMessageInput): Promise<number> {
    const prepared = await this.prepareParticipantMessage(input);
    return this.storage.transactionSync(() => this.appendPreparedParticipantMessage(prepared));
  }

  async prepareParticipantMessage(input: ParticipantMessageInput): Promise<PreparedParticipantMessage> {
    const now = Date.parse(input.createdAtUtc);
    if (!Number.isFinite(now)) throw new Error("invalid_participant_message_timestamp");
    const normalizedInput = {
      ...input,
      authorSnapshot: normalizedAuthorSnapshot(input, "participant_message"),
    };
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
      runId: normalizedInput.producedByRunId ?? null,
      turnId: normalizedInput.turnId,
      toolCallId: null,
    };
    const fact = await this.prepareFact(material);
    return { input: normalizedInput, fact, occurredAt: now };
  }

  /** Join an already-open object-local transaction; preparation performs no writes. */
  appendPreparedParticipantMessage(prepared: PreparedParticipantMessage): number {
    return this.appendPreparedParticipantMessageAtSequence(prepared, null);
  }

  /**
   * Materialize into an exact slot already owned by a durable reservation.
   * `null` is the ordinary participant path and allocates at commit time.
   */
  appendPreparedParticipantMessageAtSequence(
    prepared: PreparedParticipantMessage,
    reservedSequence: number | null,
  ): number {
      const { input, fact, occurredAt: now } = prepared;
      const existing = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
        `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
        input.turnId,
      ).toArray()[0];
      if (existing) {
        const sequence = Number(existing.transcript_sequence);
        if (reservedSequence !== null && sequence !== reservedSequence) {
          throw new Error("participant_turn_reserved_sequence_mismatch");
        }
        return sequence;
      }
      this.insertFact(fact, now);
      const sequence = reservedSequence ?? this.allocateTranscriptSequence(now);
      if (reservedSequence !== null) {
        if (!Number.isSafeInteger(reservedSequence) || reservedSequence < 1) {
          throw new Error("participant_turn_reserved_sequence_invalid");
        }
        const occupied = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
          `SELECT turn_id FROM participant_transcript_turns WHERE transcript_sequence = ?`,
          reservedSequence,
        ).toArray()[0];
        if (occupied) throw new Error("participant_turn_reserved_sequence_occupied");
        const counter = Number(this.sql.exec<{
          next_transcript_sequence: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
        ).one().next_transcript_sequence);
        if (counter <= reservedSequence) throw new Error("participant_turn_sequence_not_reserved");
      }
      this.sql.exec(
        `INSERT INTO participant_transcript_turns
           (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
            author_name_snapshot, author_avatar_url_snapshot,
            client_message_id, external_actor_json, message_type,
            root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
         VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
        sequence,
        input.turnId,
        input.actor,
        input.authorUserId,
        input.authorSnapshot?.displayName ?? null,
        input.authorSnapshot?.avatarUrl ?? null,
        input.clientMessageId ?? null,
        input.externalActorJson ?? null,
        input.messageType ?? "text",
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
      enqueueSemanticRealtimeReference(
        this.sql,
        { kind: "transcript_turn", turnId: input.turnId },
        now,
      );
      return sequence;
  }

  /**
   * Restore a checked-in local-development fixture directly into the canonical
   * transcript contract. Production rejects this operation at the object
   * boundary; keeping it typed here prevents the dev seed from resurrecting a
   * retired SQL table/view merely to express exact historical order.
   */
  async seedDevelopmentConversationTurn(input: DevelopmentConversationTurnInput): Promise<{
    outcome: "inserted" | "replayed";
    transcriptSequence: number;
  }> {
    const now = Date.parse(input.createdAtUtc);
    if (!Number.isFinite(now)) throw new Error("development_turn_timestamp_invalid");
    if (!Number.isInteger(input.expectedTranscriptSequence) || input.expectedTranscriptSequence < 1) {
      throw new Error("development_turn_sequence_invalid");
    }
    const authorSnapshot = normalizedAuthorSnapshot(input, "development_turn");
    const structuredContent = input.structuredContentJson === null
      ? null
      : JSON.parse(input.structuredContentJson) as unknown;
    const material: TranscriptFactMaterial = {
      factId: `${input.turnId}:development-seed`,
      factKind: "participant_message",
      audience: "shared",
      payload: {
        role: input.actor === "assistant" ? "assistant" : input.actor === "system" ? "system" : "user",
        content: input.text,
        structuredContent,
      },
      origin: canonicalOrigin(),
      runId: input.producedByRunId,
      turnId: input.turnId,
      toolCallId: null,
    };
    const fact = await this.prepareFact(material);
    return this.storage.transactionSync(() => {
      const existing = this.sql.exec<{
        transcript_sequence: number;
        actor: string;
        author_user_id: string | null;
        author_name_snapshot: string | null;
        author_avatar_url_snapshot: string | null;
        client_message_id: string | null;
        external_actor_json: string | null;
        message_type: string;
        payload_json: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT turn.transcript_sequence, turn.actor, turn.author_user_id,
                turn.author_name_snapshot, turn.author_avatar_url_snapshot,
                turn.client_message_id, turn.external_actor_json,
                turn.message_type, payload.payload_json
           FROM participant_transcript_turns turn
           JOIN transcript_facts root ON root.fact_id = turn.root_fact_id
           JOIN transcript_payloads payload ON payload.payload_id = root.payload_id
          WHERE turn.turn_id = ?`,
        input.turnId,
      ).toArray()[0];
      if (existing) {
        const expectedPayload = canonicalJson(material.payload);
        if (Number(existing.transcript_sequence) !== input.expectedTranscriptSequence
          || existing.actor !== input.actor
          || existing.author_user_id !== input.authorUserId
          || existing.author_name_snapshot !== (authorSnapshot?.displayName ?? null)
          || existing.author_avatar_url_snapshot !== (authorSnapshot?.avatarUrl ?? null)
          || existing.client_message_id !== input.clientMessageId
          || existing.external_actor_json !== input.externalActorJson
          || existing.message_type !== input.messageType
          || canonicalJson(JSON.parse(existing.payload_json)) !== expectedPayload) {
          throw new Error("development_turn_replay_conflict");
        }
        return {
          outcome: "replayed" as const,
          transcriptSequence: Number(existing.transcript_sequence),
        };
      }
      const nextSequence = Number(this.sql.exec<{
        next_transcript_sequence: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
      ).one().next_transcript_sequence);
      if (nextSequence !== input.expectedTranscriptSequence) {
        throw new Error("development_turn_sequence_mismatch");
      }
      this.insertFact(fact, now);
      const transcriptSequence = this.allocateTranscriptSequence(now);
      const attentionOrdinal = input.messageType === "tool" ? null : this.nextAttentionOrdinal();
      this.sql.exec(
        `INSERT INTO participant_transcript_turns
           (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
            author_name_snapshot, author_avatar_url_snapshot,
            client_message_id, external_actor_json, message_type, root_fact_id,
            activity_id, attention_ordinal, revision, created_at, updated_at)
         VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
        transcriptSequence,
        input.turnId,
        input.actor,
        input.authorUserId,
        authorSnapshot?.displayName ?? null,
        authorSnapshot?.avatarUrl ?? null,
        input.clientMessageId,
        input.externalActorJson,
        input.messageType,
        fact.factId,
        attentionOrdinal,
        now,
        now,
      );
      if (input.messageType === "tool") {
        const invocation = structuredContent && typeof structuredContent === "object"
          ? (structuredContent as {
            invocation?: { toolCallId?: unknown; toolName?: unknown; status?: unknown };
          }).invocation
          : undefined;
        const toolCallId = typeof invocation?.toolCallId === "string" ? invocation.toolCallId : null;
        const toolName = typeof invocation?.toolName === "string" ? invocation.toolName : null;
        const status = invocation?.status;
        if (!toolCallId || !toolName
          || !["planned", "started", "completed", "failed", "cancelled"].includes(String(status))) {
          throw new Error("development_tool_turn_invalid");
        }
        this.sql.exec(
          `INSERT INTO participant_transcript_blocks
             (turn_id, block_id, block_index, block_kind, fact_id, tool_call_id,
              tool_name, lifecycle_state, revision, updated_at)
           VALUES (?, ?, 0, 'tool', ?, ?, ?, ?, 1, ?)`,
          input.turnId,
          `${input.turnId}:tool:0`,
          fact.factId,
          toolCallId,
          toolName,
          status,
          now,
        );
      } else {
        this.sql.exec(
          `INSERT INTO participant_transcript_blocks
             (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
           VALUES (?, ?, 0, 'text', ?, 1, ?)`,
          input.turnId,
          `${input.turnId}:text:0`,
          fact.factId,
          now,
        );
        this.advanceAttention(now);
      }
      enqueueSemanticRealtimeReference(
        this.sql,
        { kind: "transcript_turn", turnId: input.turnId },
        now,
      );
      return { outcome: "inserted" as const, transcriptSequence };
    });
  }

  /**
   * Make one assistant turn the durable run-final response without copying it.
   *
   * Bind normally committed the turn already. A stopped stream is the one
   * exception: tokens may have reached the member before Bind accepted the
   * provider message, so finalization creates that missing participant turn.
   * Both branches assign the same attention ordinal in the caller's open
   * transaction. They never create a `workstream_message_record`; the ordered
   * participant turn is the canonical response.
   */
  finalizePreparedAssistantTurn(prepared: PreparedParticipantMessage):
    | { outcome: "published" | "replayed"; transcriptSequence: number; attentionOrdinal: number }
    | {
      outcome: "content_mismatch";
      reasons: Array<"actor" | "run_id" | "role" | "content">;
    } {
    const { input, fact, occurredAt: now } = prepared;
    if (input.actor !== "assistant" || input.producedByRunId === null
      || input.producedByRunId === undefined) {
      throw new Error("invalid_final_assistant_turn");
    }
    const existing = this.sql.exec<{
      transcript_sequence: number;
      attention_ordinal: number | null;
      actor: string;
      producer_run_id: string | null;
      payload_json: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT turn.transcript_sequence, turn.attention_ordinal, turn.actor,
              COALESCE(reservation.execution_id, root.run_id) AS producer_run_id,
              payload.payload_json
         FROM participant_transcript_turns turn
         JOIN transcript_facts root ON root.fact_id = turn.root_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = root.payload_id
         LEFT JOIN assistant_turn_reservations reservation ON reservation.turn_id = turn.turn_id
        WHERE turn.turn_id = ?`,
      input.turnId,
    ).toArray()[0];
    if (existing) {
      const payload = JSON.parse(existing.payload_json) as { role?: unknown; content?: unknown };
      const mismatchReasons: Array<"actor" | "run_id" | "role" | "content"> = [];
      if (existing.actor !== "assistant") mismatchReasons.push("actor");
      // Persistent Bind facts belong to the loop so they survive execution
      // receipts. The reservation is the immutable fact that names which
      // receipt produced this specific assistant turn; host-created turns that
      // predate a reservation continue to carry their receipt on the root fact.
      if (existing.producer_run_id !== input.producedByRunId) mismatchReasons.push("run_id");
      if (payload.role !== "assistant") mismatchReasons.push("role");
      if (payload.content !== input.text) mismatchReasons.push("content");
      if (mismatchReasons.length > 0) {
        return { outcome: "content_mismatch", reasons: mismatchReasons };
      }
      if (existing.attention_ordinal !== null) {
        return {
          outcome: "replayed",
          transcriptSequence: Number(existing.transcript_sequence),
          attentionOrdinal: Number(existing.attention_ordinal),
        };
      }
      const attentionOrdinal = this.nextAttentionOrdinal();
      this.sql.exec(
        `UPDATE participant_transcript_turns
            SET attention_ordinal = ?, revision = revision + 1, updated_at = ?
          WHERE turn_id = ? AND attention_ordinal IS NULL`,
        attentionOrdinal,
        now,
        input.turnId,
      );
      this.advanceAttention(now);
      enqueueSemanticRealtimeReference(
        this.sql,
        { kind: "transcript_turn", turnId: input.turnId },
        now,
      );
      return {
        outcome: "published",
        transcriptSequence: Number(existing.transcript_sequence),
        attentionOrdinal,
      };
    }

    this.insertFact(fact, now);
    const transcriptSequence = this.allocateTranscriptSequence(now);
    const attentionOrdinal = this.nextAttentionOrdinal();
    this.sql.exec(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
          root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
       VALUES (?, ?, 'conversation', 'assistant', NULL, ?, ?, ?, 1, ?, ?)`,
      transcriptSequence,
      input.turnId,
      fact.factId,
      `${input.turnId}:activity`,
      attentionOrdinal,
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
    this.advanceAttention(now);
    enqueueSemanticRealtimeReference(
      this.sql,
      { kind: "transcript_turn", turnId: input.turnId },
      now,
    );
    return { outcome: "published", transcriptSequence, attentionOrdinal };
  }

  async upsertToolLifecycle(input: {
    toolCallId: string;
    pluginId: string | null;
    toolName: string;
    status: "started" | "completed" | "failed" | "ambiguous" | "cancelled";
    participantSafeInput?: unknown;
    participantSafeResult?: unknown;
    error?: string | null;
    occurredAtUtc: string;
  }): Promise<void> {
    const prepared = await this.prepareToolLifecycle(input);
    this.storage.transactionSync(() => this.upsertPreparedToolLifecycle(prepared));
  }

  async prepareToolLifecycle(input: {
    toolCallId: string;
    pluginId?: string | null;
    toolName?: string;
    status: "started" | "completed" | "failed" | "ambiguous" | "cancelled";
    participantSafeInput?: unknown;
    participantSafeResult?: unknown;
    error?: string | null;
    occurredAtUtc: string;
  }): Promise<PreparedToolLifecycle> {
    const now = Date.parse(input.occurredAtUtc);
    if (!Number.isFinite(now)) throw new Error("invalid_tool_lifecycle_timestamp");
    const existingBlock = this.sql.exec<{
      payload_json: string;
      fact_id: string;
      revision: number;
      plugin_id: string | null;
      tool_name: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT payload.payload_json, block.fact_id, block.revision,
              block.plugin_id, block.tool_name
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
    return {
      toolCallId: input.toolCallId,
      pluginId: input.pluginId ?? existingBlock.plugin_id,
      toolName: input.toolName ?? existingBlock.tool_name ?? "Tool",
      status: input.status,
      occurredAt: now,
      expectedFactId: existingBlock.fact_id,
      expectedRevision: Number(existingBlock.revision),
      fact,
    };
  }

  upsertPreparedToolLifecycle(prepared: PreparedToolLifecycle): void {
    const block = this.sql.exec<{
      turn_id: string;
      lifecycle_state: string;
      fact_id: string;
      revision: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT turn_id, lifecycle_state, fact_id, revision
         FROM participant_transcript_blocks WHERE tool_call_id = ?`,
      prepared.toolCallId,
    ).toArray()[0];
    if (!block) throw new Error("participant_tool_plan_missing");
    // A terminal tool fact is immutable. Same-status delivery is an
    // idempotent replay; a different terminal delivery is stale authority and
    // must not let the receipt settle to a fact the transcript did not adopt.
    if (terminalToolStatus(String(block.lifecycle_state))) {
      if (block.lifecycle_state === prepared.status) return;
      throw new Error("participant_tool_lifecycle_terminal_conflict");
    }
    if (block.fact_id !== prepared.expectedFactId || Number(block.revision) !== prepared.expectedRevision) {
      throw new Error("participant_tool_lifecycle_source_moved");
    }
    this.insertFact(prepared.fact, prepared.occurredAt);
    this.sql.exec(
        `UPDATE participant_transcript_blocks
            SET fact_id = ?, plugin_id = COALESCE(plugin_id, ?),
                tool_name = ?, lifecycle_state = ?, activity_id = ?,
                revision = revision + 1, updated_at = ?
          WHERE tool_call_id = ?`,
      prepared.fact.factId,
      prepared.pluginId,
      prepared.toolName,
      prepared.status,
      `${prepared.toolCallId}:activity`,
      prepared.occurredAt,
      prepared.toolCallId,
    );
    this.sql.exec(
        `UPDATE participant_transcript_turns
            SET revision = revision + 1, updated_at = ?
          WHERE turn_id = ?`,
      prepared.occurredAt,
      block.turn_id,
    );
    enqueueSemanticRealtimeReference(
      this.sql,
      { kind: "transcript_turn", turnId: block.turn_id },
      prepared.occurredAt,
    );
  }

  upsertActivity(edge: ActivityEdge): TranscriptActivity {
    const occurredAt = Date.parse(edge.occurredAtUtc);
    if (!Number.isFinite(occurredAt)) throw new Error("invalid_activity_timestamp");
    this.storage.transactionSync(() => {
      const existing = this.sql.exec<ActivityRow>(
        `SELECT activity_id, parent_activity_id, scope, subject_id, call_index, label, connector_type,
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
           (activity_id, parent_activity_id, scope, subject_id, call_index, label, connector_type,
            lifecycle_state, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(activity_id) DO UPDATE SET
           label = excluded.label,
           connector_type = COALESCE(excluded.connector_type, transcript_activities.connector_type),
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
        edge.connectorType ?? null,
        nextState,
        edge.revision,
        occurredAt,
        occurredAt,
      );
      if (edge.action === "start") {
        this.sql.exec(
          `INSERT INTO transcript_activity_intervals
             (activity_id, interval_id, started_at, stopped_at, duration_ms,
              boundary_source, timing_accuracy, revision)
           VALUES (?, ?, ?, NULL, NULL, 'rally', 'observed', ?)
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
      enqueueSemanticRealtimeReference(
        this.sql,
        {
          kind: "transcript_activity",
          activityId: edge.activityId,
          snapshotAtUtc: edge.occurredAtUtc,
        },
        occurredAt,
      );
    });
    const activity = this.activity(edge.activityId);
    if (!activity) throw new Error("activity_upsert_failed");
    return activity;
  }

  /** Close only the interrupted assistant subtree; its response may continue. */
  private closeRecoveredAssistantActivities(turnId: string, recoveredAt: number): void {
    const rootActivityId = `${turnId}:activity`;
    this.sql.exec(
      `WITH RECURSIVE recovered_activities(activity_id) AS (
         SELECT activity_id FROM transcript_activities WHERE activity_id = ?
         UNION ALL
         SELECT child.activity_id
           FROM transcript_activities child
           JOIN recovered_activities parent
             ON child.parent_activity_id = parent.activity_id
       )
       UPDATE transcript_activity_intervals
          SET stopped_at = ?, duration_ms = MAX(0, ? - started_at),
              boundary_source = 'recovered', timing_accuracy = 'upper_bound',
              revision = revision + 1
        WHERE activity_id IN (SELECT activity_id FROM recovered_activities)
          AND stopped_at IS NULL`,
      rootActivityId,
      recoveredAt,
      recoveredAt,
    );
    const closed = this.sql.exec<{ activity_id: string } & Record<string, SqlStorageValue>>(
      `WITH RECURSIVE recovered_activities(activity_id) AS (
         SELECT activity_id FROM transcript_activities WHERE activity_id = ?
         UNION ALL
         SELECT child.activity_id
           FROM transcript_activities child
           JOIN recovered_activities parent
             ON child.parent_activity_id = parent.activity_id
       )
       UPDATE transcript_activities
          SET lifecycle_state = CASE
                WHEN scope = 'tool_call' THEN COALESCE((
                  SELECT CASE
                    WHEN block.lifecycle_state = 'completed' THEN 'completed'
                    WHEN block.lifecycle_state = 'cancelled' THEN 'cancelled'
                    WHEN block.lifecycle_state = 'ambiguous' THEN 'ambiguous'
                    ELSE 'failed'
                  END
                    FROM participant_transcript_blocks block
                   WHERE block.turn_id = ? AND block.tool_call_id = transcript_activities.subject_id
                ), 'abandoned')
                WHEN scope = 'plugin' THEN CASE
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = ?
                       AND block.plugin_id = transcript_activities.subject_id
                       AND block.lifecycle_state = 'ambiguous'
                  ) THEN 'ambiguous'
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = ?
                       AND block.plugin_id = transcript_activities.subject_id
                       AND block.lifecycle_state = 'failed'
                  ) THEN 'failed'
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = ?
                       AND block.plugin_id = transcript_activities.subject_id
                       AND block.lifecycle_state = 'cancelled'
                  ) THEN 'cancelled'
                  ELSE 'completed'
                END
                WHEN scope = 'assistant_turn' THEN CASE
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = ? AND block.block_kind = 'tool'
                       AND block.lifecycle_state = 'ambiguous'
                  ) THEN 'ambiguous'
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = ? AND block.block_kind = 'tool'
                       AND block.lifecycle_state = 'failed'
                  ) THEN 'failed'
                  WHEN EXISTS (
                    SELECT 1 FROM participant_transcript_blocks block
                     WHERE block.turn_id = ? AND block.block_kind = 'tool'
                       AND block.lifecycle_state = 'cancelled'
                  ) THEN 'cancelled'
                  ELSE 'completed'
                END
                ELSE 'abandoned'
              END,
              revision = revision + 1, updated_at = ?
        WHERE activity_id IN (SELECT activity_id FROM recovered_activities)
          AND lifecycle_state = 'active'
        RETURNING activity_id`,
      rootActivityId,
      turnId,
      turnId,
      turnId,
      turnId,
      turnId,
      turnId,
      turnId,
      recoveredAt,
    ).toArray();
    for (const activity of closed) {
      enqueueSemanticRealtimeReference(this.sql, {
        kind: "transcript_activity",
        activityId: activity.activity_id,
        snapshotAtUtc: new Date(recoveredAt).toISOString(),
      }, recoveredAt);
    }
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
      const pendingInputs = this.pendingTranscriptInputs();
      const openingTurns = opening.ranges.flatMap((range) => range.turns);
      const activities = this.activitiesForTurns([...openingTurns, ...activeTurns], now, true);
      const pluginRuns = this.pluginRunsForTurns([...openingTurns, ...activeTurns], now);
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
        pluginRuns,
        activeTurns,
        pendingInputs,
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
      pluginRuns: includeActivities
        ? this.pluginRunsForTurns(turns, snapshotAt)
        : [],
    };
  }

  /**
   * Replace one indivisible inline turn with a small, sequence-owning
   * placeholder envelope: same identity, same transcript sequence, blocks
   * deliberately omitted. Nothing in the product can produce a turn whose
   * serialized blocks alone exceed the realtime frame budget today, so the
   * envelope is the entire oversized-turn story — the client renders a
   * placeholder, order and coverage stay exact, and the durable payloads are
   * untouched for whatever feature one day actually needs them delivered.
   */
  omittedTurnEnvelope(turn: TranscriptTurn): TranscriptTurn {
    return {
      ...turn,
      blocks: [],
      blockCount: turn.blocks.length,
      blocksOmitted: true,
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

  pendingTranscriptInputs(): PendingTranscriptInput[] {
    return new SubstreamLoopStorage(this.storage).pendingInputs()
      .map((pending) => this.hydratePendingTranscriptInput(pending));
  }

  pendingTranscriptInput(inputId: string): PendingTranscriptInput | null {
    const pending = new SubstreamLoopStorage(this.storage).input(inputId);
    return pending ? this.hydratePendingTranscriptInput(pending) : null;
  }

  transcriptActivity(activityId: string, snapshotAt = Date.now()): TranscriptActivity | null {
    const row = this.sql.exec<ActivityRow>(
      `SELECT activity_id, parent_activity_id, scope, subject_id, call_index,
              label, connector_type, lifecycle_state, revision
         FROM transcript_activities WHERE activity_id = ?`,
      activityId,
    ).toArray()[0];
    return row ? this.hydrateActivities([row], snapshotAt)[0] ?? null : null;
  }

  private hydratePendingTranscriptInput(pending: PendingLoopInputRow): PendingTranscriptInput {
    const material = parsePendingInputMaterial(pending);
    return PendingTranscriptInputSchema.parse({
        inputId: pending.input_id,
        futureTurnId: pending.prepared_turn_id,
        inputSequence: Number(pending.input_sequence),
        deliveryMode: pending.mode,
        afterTranscriptSequence: Number(pending.admitted_after_transcript_sequence),
        actor: pending.actor,
        authorUserId: pending.author_user_id,
        authorSnapshot: pending.author_user_id === null || pending.author_name_snapshot === null
          ? null
          : {
            userId: pending.author_user_id,
            displayName: pending.author_name_snapshot,
            avatarUrl: pending.author_avatar_url_snapshot,
          },
        clientMessageId: pending.client_message_id,
        externalActor: parseExternalActor(pending.external_actor_json),
        block: {
          type: "text",
          blockId: `${pending.prepared_turn_id}:text:0`,
          blockIndex: 0,
          text: material.payload.content,
          streaming: false,
          mentions: material.mentions.map((mention) => ({
            type: mention.mentionKind,
            userId: mention.targetUserId,
            connectorType: mention.connectorType,
            startOffset: mention.startOffset,
            endOffset: mention.endOffset,
          })),
          attachments: material.attachments.map(pendingAttachmentForSnapshot),
          messageType: pending.message_type,
          structuredContent: material.payload.structuredContent,
        },
        admittedAtUtc: new Date(Number(pending.created_at)).toISOString(),
      });
  }

  participantTurnForTool(toolCallId: string): TranscriptTurn | null {
    const row = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM participant_transcript_blocks WHERE tool_call_id = ?`,
      toolCallId,
    ).toArray()[0];
    return row ? this.participantTurn(row.turn_id) : null;
  }

  /**
   * Move a turn's revision, and send it to the room again, in the caller's
   * transaction: for a turn whose canonical content is unchanged but whose
   * read joins in state that moved (a Sidekick run's row).
   */
  reviseParticipantTurnInTransaction(turnId: string, now: number): void {
    const revised = this.sql.exec(
      `UPDATE participant_transcript_turns SET revision = revision + 1, updated_at = ? WHERE turn_id = ? RETURNING turn_id`,
      now, turnId,
    ).toArray().length > 0;
    if (!revised) throw new Error("transcript_turn_not_found");
    enqueueSemanticRealtimeReference(this.sql, { kind: "transcript_turn", turnId }, now);
  }

  setParticipantTurnAttentionOrdinal(input: {
    turnId: string;
    attentionOrdinal: number;
  }): TranscriptTurn | null {
    const now = Date.now();
    this.storage.transactionSync(() => {
      const changed = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
        `UPDATE participant_transcript_turns
            SET attention_ordinal = ?, revision = revision + 1, updated_at = ?
          WHERE turn_id = ?
            AND (attention_ordinal IS NULL OR attention_ordinal = ?)
          RETURNING turn_id`,
        input.attentionOrdinal,
        now,
        input.turnId,
        input.attentionOrdinal,
      ).toArray()[0];
      if (changed) {
        enqueueSemanticRealtimeReference(
          this.sql,
          { kind: "transcript_turn", turnId: input.turnId },
          now,
        );
      }
    });
    return this.participantTurn(input.turnId);
  }

  /**
   * Rewrite each loop-state tool result that still holds non-text parts to its
   * text alone, and return how many changed. Before 2026-10-29 the harness
   * persisted a tool's image parts in the loop state, so every later step and
   * restart reloaded every image a Thread had ever produced, until the object
   * ran past its memory limit. The harness now relays those parts to the next
   * provider request only; this brings state written before then to the same
   * shape. The rewrite keeps each fact's identity and moves it to a new
   * payload, so receipts and positions that reference the fact are untouched.
   * Hashing is async, so it cannot run as a schema migration, and it reads one
   * payload at a time so a Thread too large to load whole can still recover.
   */
  async retireInlineToolMessageContent(loopId: string): Promise<number> {
    const factIds = this.sql.exec<{ fact_id: string } & Record<string, SqlStorageValue>>(
      // Canonical JSON sorts keys, so a tool message with array content starts
      // with this prefix; it spares parsing every other message on each start.
      `SELECT fact.fact_id
         FROM bind_loop_state_messages projected
         JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE projected.loop_id = ?
          AND payload.payload_json LIKE '{"content":[%'
          AND json_extract(payload.payload_json, '$.role') = 'tool'
          AND EXISTS (
            SELECT 1 FROM json_each(payload.payload_json, '$.content') part
             WHERE json_extract(part.value, '$.type') IS NOT 'text'
          )`,
      loopId,
    ).toArray().map((row) => row.fact_id);
    let rewritten = 0;
    for (const factId of factIds) {
      const row = this.sql.exec<{
        fact_kind: string;
        payload_id: string;
        origin_kind: BindLoopMessageOrigin["originKind"];
        source_kind: string | null;
        source_id: string | null;
        source_revision: number | null;
        run_id: string | null;
        turn_id: string | null;
        tool_call_id: string | null;
        payload_json: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT fact.fact_kind, fact.payload_id, fact.origin_kind, fact.source_kind,
                fact.source_id, fact.source_revision, fact.run_id, fact.turn_id,
                fact.tool_call_id, payload.payload_json
           FROM transcript_facts fact
           JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
          WHERE fact.fact_id = ?`,
        factId,
      ).one();
      const message = JSON.parse(row.payload_json) as { content: Array<{ type: string; text?: unknown }> };
      const text = message.content.filter((part) => part.type === "text");
      const fact = await this.prepareFact({
        factId,
        factKind: row.fact_kind,
        audience: "model",
        payload: { ...message, content: text.length === 1 ? String(text[0]!.text) : text },
        origin: {
          originKind: row.origin_kind,
          sourceKind: row.source_kind,
          sourceId: row.source_id,
          sourceRevision: row.source_revision,
        } as TranscriptFactMaterial["origin"],
        runId: row.run_id,
        turnId: row.turn_id,
        toolCallId: row.tool_call_id,
      });
      const previousPayloadId = row.payload_id;
      this.storage.transactionSync(() => {
        const current = this.sql.exec<{ payload_id: string } & Record<string, SqlStorageValue>>(
          `SELECT payload_id FROM transcript_facts WHERE fact_id = ?`,
          factId,
        ).toArray()[0];
        if (current?.payload_id !== previousPayloadId) return;
        this.insertFact(fact, Date.now());
        this.sql.exec(
          `DELETE FROM transcript_payloads
            WHERE payload_id = ?
              AND NOT EXISTS (SELECT 1 FROM transcript_facts WHERE payload_id = ?)`,
          previousPayloadId,
          previousPayloadId,
        );
        // A boundary recorded at the current revision hashed the old bytes, so
        // a resumed request at that revision would read as a conflicting
        // replay. Earlier revisions are history and are never replayed.
        this.sql.exec(
          `DELETE FROM bind_provider_boundaries
            WHERE loop_id = ?
              AND state_revision = (SELECT state_revision FROM bind_loop_heads WHERE loop_id = ?)`,
          loopId,
          loopId,
        );
        rewritten += 1;
      });
    }
    if (rewritten > 0) this.bindProjectionCache.delete(loopId);
    return rewritten;
  }

  readBindProjection(loopId: string): BindLoopProjectionState | null {
    const head = this.sql.exec<{
      generation: number;
      state_revision: number;
      system_projection_revision: number;
      system_renderer_version: string;
      system_input_hash: string;
      last_model_turn_index: number | null;
      last_assistant_reservation_json: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT generation, state_revision, system_projection_revision,
              system_renderer_version, system_input_hash,
              last_model_turn_index, last_assistant_reservation_json
         FROM bind_loop_heads WHERE loop_id = ?`,
      loopId,
    ).toArray()[0];
    if (!head) {
      this.bindProjectionCache.delete(loopId);
      return null;
    }
    const cached = this.bindProjectionCache.get(loopId);
    if (cached
      && cached.generation === Number(head.generation)
      && cached.stateRevision === Number(head.state_revision)
      && cached.systemProjection.revision === Number(head.system_projection_revision)) {
      return cached;
    }
    const messages = this.messageRows(loopId);
    if (messages.length === 0) throw new Error("bind_loop_state_empty");
    const projection: BindLoopProjectionState = {
      loopId,
      generation: Number(head.generation),
      stateRevision: Number(head.state_revision),
      lastModelTurnIndex: Number(head.last_model_turn_index ?? 0),
      lastAssistantReservation: head.last_assistant_reservation_json === null
        ? null
        : JSON.parse(head.last_assistant_reservation_json) as BindLoopProjectionState["lastAssistantReservation"],
      systemProjection: {
        revision: Number(head.system_projection_revision),
        rendererVersion: head.system_renderer_version,
        inputHash: head.system_input_hash,
        message: JSON.parse(messages[0]!.payload_json) as BindLoopMessage,
      },
      nonSystemMessageTail: bindLoopMessageChain(messages.slice(1).map((row) =>
        JSON.parse(row.payload_json) as BindLoopMessage)),
    };
    this.bindProjectionCache.set(loopId, projection);
    return projection;
  }

  /**
   * A relocated loop may keep immutable historical turn IDs. Admit only a
   * settled local reservation, against the exact current head. This is read-only:
   * the next ordinary assistant reservation replaces the historical pointer.
   */
  validateHistoricalAssistantReservation(projection: BindLoopProjectionState): boolean {
    const current = this.readBindProjection(projection.loopId);
    const reservation = current?.lastAssistantReservation;
    const supplied = projection.lastAssistantReservation;
    if (!current || !reservation || !supplied
      || current.generation !== projection.generation
      || current.stateRevision !== projection.stateRevision
      || current.lastModelTurnIndex !== projection.lastModelTurnIndex
      || reservation.turnId !== supplied.turnId
      || reservation.modelTurnIndex !== supplied.modelTurnIndex
      || reservation.transcriptSequence !== supplied.transcriptSequence
      || reservation.status !== supplied.status
      || !["accepted", "failed", "stopped"].includes(reservation.status)
      || reservation.modelTurnIndex !== current.lastModelTurnIndex
      || reservation.transcriptSequence === null
      || reservation.turnId === `${current.loopId}:turn:${current.lastModelTurnIndex}`
      || pendingBindToolBatch(current) !== null) return false;

    return this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT r.turn_id
         FROM assistant_turn_reservations r
         JOIN substream_loops l ON l.loop_id = r.loop_id
         JOIN participant_transcript_turns t ON t.turn_id = r.materialized_turn_id
        WHERE r.turn_id = ? AND r.loop_id = ?
          AND r.assistant_turn_sequence = ? AND r.transcript_sequence = ?
          AND r.state = 'materialized' AND r.outcome = ?
          AND t.turn_id = r.turn_id AND t.transcript_sequence = r.transcript_sequence
          AND t.actor = ?
          AND l.bind_state_revision = ? AND l.next_assistant_turn_sequence = ?
          AND NOT EXISTS (
            SELECT 1 FROM assistant_turn_reservations WHERE state IN ('reserved', 'streaming')
          )
          AND NOT EXISTS (
            SELECT 1 FROM assistant_turn_reservations
             WHERE loop_id = l.loop_id AND assistant_turn_sequence = l.next_assistant_turn_sequence
          )
          AND NOT EXISTS (
            SELECT 1 FROM participant_transcript_turns
             WHERE turn_id = l.loop_id || ':turn:' || (r.assistant_turn_sequence + 1)
          )`,
      reservation.turnId, current.loopId, current.lastModelTurnIndex,
      reservation.transcriptSequence, reservation.status === "accepted" ? "accepted" : "error",
      reservation.status === "accepted" ? "assistant" : "system",
      current.stateRevision, current.lastModelTurnIndex + 1,
    ).toArray().length === 1;
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
    // Hydrate only the newest suffix that fits the existing transport budget.
    // A single oversized newest turn is retained for the socket's placeholder.
    const latestTurns: TranscriptTurn[] = [];
    const encoder = new TextEncoder();
    let latestBytes = 0;
    for (const row of this.sql.exec<{ transcript_sequence: number }>(
      `SELECT transcript_sequence FROM participant_transcript_turns
        WHERE transcript_sequence <= ? ORDER BY transcript_sequence DESC`, snapshotThrough,
    )) {
      const turnRange = this.range(fence, {
        startInclusive: row.transcript_sequence, endExclusive: row.transcript_sequence + 1,
      });
      const nextBytes = latestBytes + encoder.encode(JSON.stringify(turnRange)).byteLength;
      if (latestTurns.length > 0 && nextBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) break;
      latestBytes = nextBytes;
      latestTurns.push(...turnRange.turns);
      if (latestBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) break;
    }
    latestTurns.reverse();
    const latestRange = latestTurns.length ? {
      startInclusive: latestTurns[0]!.transcriptSequence, endExclusive: snapshotThrough + 1,
    } : null;
    const latest = latestRange ? {
      purpose: "latest" as const, requested: latestRange, covered: latestRange,
      turns: latestTurns, activities: [], pluginRuns: [],
    } : null;
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
      && latest && unreadRange.startInclusive >= latestRange.startInclusive
      && unreadRange.endExclusive <= latestRange.endExclusive) {
      return {
        ranges: [{ ...latest, purpose: "unread_and_latest" }],
        unreadAnchorSequence,
        unreadReason: null,
      };
    }
    return {
      ranges: [
        ...(unreadRange ? [this.range(fence, unreadRange, "unread" as const, false)] : []),
        ...(latest ? [latest] : []),
      ],
      unreadAnchorSequence,
      unreadReason: unreadAttentionOrdinal === null
        ? "no_unread"
        : unreadRange ? null : "anchor_unavailable",
    };
  }

  private turnsInRange(startInclusive: number, endExclusive: number): TranscriptTurn[] {
    if (endExclusive <= startInclusive) return [];
    return this.hydrateTurnRows(this.sql.exec<TurnRow>(
      `SELECT turn.transcript_sequence, turn.turn_id, turn.entry_kind, turn.actor,
              turn.author_user_id, turn.author_name_snapshot, turn.author_avatar_url_snapshot,
              turn.client_message_id, turn.external_actor_json,
              turn.activity_id, turn.attention_ordinal, turn.revision, turn.created_at
         FROM participant_transcript_turns AS turn INDEXED BY participant_transcript_sequence_idx
        WHERE turn.transcript_sequence >= ? AND turn.transcript_sequence < ?
        ORDER BY turn.transcript_sequence`,
      startInclusive,
      endExclusive,
    ).toArray());
  }

  /**
   * Human, external, and imported assistant text turns, and Sidekick posts, in
   * `[startInclusive, endExclusive)` — what the gap-fill considers. Filtered
   * here so a wide range hydrates only what it will use.
   */
  private conversationTurnsInRange(startInclusive: number, endExclusive: number): TranscriptTurn[] {
    if (endExclusive <= startInclusive) return [];
    return this.hydrateTurnRows(this.sql.exec<TurnRow>(
      `SELECT turn.transcript_sequence, turn.turn_id, turn.entry_kind, turn.actor,
              turn.author_user_id, turn.author_name_snapshot, turn.author_avatar_url_snapshot,
              turn.client_message_id, turn.external_actor_json,
              turn.activity_id, turn.attention_ordinal, turn.revision, turn.created_at
         FROM participant_transcript_turns AS turn INDEXED BY participant_transcript_sequence_idx
        WHERE turn.transcript_sequence >= ? AND turn.transcript_sequence < ?
          AND turn.entry_kind = 'conversation'
          AND (((turn.actor IN ('human', 'external') OR
            (turn.actor = 'assistant' AND EXISTS (
              SELECT 1 FROM transcript_facts source_fact
               WHERE source_fact.fact_id = turn.root_fact_id AND source_fact.run_id IS NULL)))
            AND turn.message_type = 'text')
            OR (turn.actor = 'system' AND turn.message_type = 'automation_activation'))
        ORDER BY turn.transcript_sequence`,
      startInclusive,
      endExclusive,
    ).toArray());
  }

  /**
   * Blocks, mentions and attachments for a set of turn rows. Each `IN` list is
   * chunked under the engine's bound-parameter ceiling, so a range of any
   * width hydrates; a turn's own rows always fall in one chunk, so their order
   * within the turn is kept.
   */
  private hydrateTurnRows(turns: TurnRow[]): TranscriptTurn[] {
    if (turns.length === 0) return [];
    const chunks = boundParameterChunks(turns.map((turn) => turn.turn_id));
    const blocks = chunks.flatMap((ids) => this.sql.exec<BlockRow>(
      `SELECT block.turn_id, block.block_id, block.block_index, block.block_kind,
              payload.payload_json, block.tool_call_id, block.plugin_id,
              block.tool_name, block.call_index, block.lifecycle_state, block.activity_id,
              turn.message_type
         FROM participant_transcript_blocks block
         JOIN participant_transcript_turns turn ON turn.turn_id = block.turn_id
         JOIN transcript_facts fact ON fact.fact_id = block.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE block.turn_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY block.turn_id, block.block_index`,
      ...ids,
    ).toArray());
    const mentions = chunks.flatMap((ids) => this.sql.exec<TranscriptMentionRow>(
      `SELECT turn_id AS part_id, mention_kind, target_user_id, connector_type,
              start_offset, end_offset
         FROM participant_transcript_mentions
        WHERE turn_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY turn_id, mention_index`,
      ...ids,
    ).toArray());
    const mentionsByTurn = new Map<string, TranscriptMentionRow[]>();
    for (const mention of mentions) {
      const current = mentionsByTurn.get(mention.part_id) ?? [];
      current.push(mention);
      mentionsByTurn.set(mention.part_id, current);
    }
    const attachments = chunks.flatMap((ids) => this.sql.exec<TranscriptAttachmentRow>(
      `SELECT attachment.turn_id AS part_id, attachment.resource_id, attachment.position,
              json_extract(link.resource_json, '$.title') AS title,
              json_extract(link.resource_json, '$.mimeType') AS mime_type,
              json_extract(link.resource_json, '$.contentRef') AS content_ref,
              json_extract(link.resource_json, '$.metadata') AS metadata_json,
              attachment.attachment_json, link.attached_at
         FROM participant_transcript_attachments attachment
         JOIN workstream_resource_links link ON link.resource_id = attachment.resource_id
        WHERE attachment.turn_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY attachment.turn_id, attachment.position`,
      ...ids,
    ).toArray());
    const attachmentsByTurn = new Map<string, TranscriptAttachmentRow[]>();
    for (const attachment of attachments) {
      const current = attachmentsByTurn.get(attachment.part_id) ?? [];
      current.push(attachment);
      attachmentsByTurn.set(attachment.part_id, current);
    }
    const blocksByTurn = new Map<string, TranscriptBlock[]>();
    const hydratedBlocks = blocks.map((block) => hydrateBlock(
        block,
        mentionsByTurn.get(block.turn_id) ?? [],
        attachmentsByTurn.get(block.turn_id) ?? [],
      ));
    const elicitationIds = hydratedBlocks.flatMap((block) => {
      if (block.type !== "text" || block.messageType !== "elicitation"
        || !block.structuredContent) return [];
      const source = "elicitation" in block.structuredContent
        ? block.structuredContent.elicitation : block.structuredContent;
      return source && typeof source === "object" && "id" in source
        && typeof source.id === "string" ? [source.id] : [];
    });
    const cancelledElicitations = new Set(boundParameterChunks(elicitationIds)
      .flatMap((ids) => this.sql.exec<{ elicitation_id: string } & Record<string, SqlStorageValue>>(
        `SELECT elicitation_id FROM elicitation_requests WHERE status = 'cancelled'
          AND elicitation_id IN (${ids.map(() => "?").join(", ")})`,
        ...ids,
      ).toArray().map((row) => row.elicitation_id)));
    // A Sidekick run's row shows the run as it stands, which its projection
    // row holds; read only when a page holds one.
    const runRows = sidekickRunRowFacts(this.sql, hydratedBlocks.flatMap((block, index) =>
      block.type === "text" && block.messageType === "automation_activation" ? [blocks[index]!.turn_id] : []));
    for (const [index, block] of blocks.entries()) {
      const hydrated = hydratedBlocks[index]!;
      const runRow = hydrated.type === "text" ? runRows.get(block.turn_id) : undefined;
      if (runRow && hydrated.type === "text" && hydrated.structuredContent) {
        hydrated.structuredContent = { ...hydrated.structuredContent, run: runRow };
        hydrated.text = sidekickRunRowText(runRow.state, runRow.reply);
      }
      if (hydrated.type === "text" && hydrated.messageType === "elicitation"
        && hydrated.structuredContent) {
        const wrapped = "elicitation" in hydrated.structuredContent;
        const source = wrapped ? hydrated.structuredContent.elicitation : hydrated.structuredContent;
        if (source && typeof source === "object" && "id" in source
          && typeof source.id === "string" && cancelledElicitations.has(source.id)) {
          const resolved = { ...source, status: "cancelled", answer: null };
          hydrated.structuredContent = wrapped
            ? { ...hydrated.structuredContent, elicitation: resolved }
            : resolved;
        }
      }
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
      authorSnapshot: turn.author_user_id && turn.author_name_snapshot ? {
        userId: turn.author_user_id,
        displayName: turn.author_name_snapshot,
        avatarUrl: turn.author_avatar_url_snapshot,
      } : null,
      clientMessageId: turn.client_message_id,
      externalActor: parseExternalActor(turn.external_actor_json),
      attentionOrdinal: turn.attention_ordinal === null ? null : Number(turn.attention_ordinal),
      createdAtUtc: new Date(Number(turn.created_at)).toISOString(),
      revision: Number(turn.revision),
      blocks: blocksByTurn.get(turn.turn_id) ?? [],
      blockCount: (blocksByTurn.get(turn.turn_id) ?? []).length,
      activityId: turn.activity_id,
    }));
  }

  private activeTurns(snapshotThrough: number): TranscriptTurn[] {
    const rows = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT turn.transcript_sequence
         FROM transcript_activities activity INDEXED BY transcript_active_activity_idx
         JOIN participant_transcript_turns turn INDEXED BY participant_transcript_activity_idx
           ON turn.activity_id = activity.activity_id
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

  /**
   * The plugin work inside a set of turns, resolved into the shape a client
   * renders.
   *
   * This deliberately does not reuse `activitiesForTurns`. That walk seeds from
   * `turn.activity_id` and `block.activity_id` — both nullable columns — and
   * then recurses *upward* to parents, so a plugin activity reaches a snapshot
   * only when one of its own tool blocks happened to carry an `activity_id`. A
   * block written but never settled leaves the plugin's timing out of the
   * snapshot entirely, and the client had no way to say so.
   *
   * Here the seed is the turn's own id, which is never null, and the walk goes
   * *down*: an `assistant_turn` activity is found by `subject_id`, its plugin
   * children by `parent_activity_id`, and their tool calls the same way. The
   * result depends on no nullable join key.
   */
  private pluginRunsForTurns(
    turns: TranscriptTurn[],
    snapshotAt: number,
  ): TranscriptPluginRun[] {
    const turnIds = [...new Set(turns.map((turn) => turn.turnId))];
    if (turnIds.length === 0) return [];
    // Every `IN` list here is caller-sized — a wide opening window, or a turn
    // that used many plugins — and the engine refuses a statement binding more
    // than 100 parameters outright, failing the whole transcript open rather
    // than returning less. `bound-parameters.ts` owns that ceiling.
    const pluginRows = boundParameterChunks(turnIds).flatMap((ids) => this.sql.exec<{
      activity_id: string;
      subject_id: string;
      label: string;
      connector_type: string | null;
      lifecycle_state: string;
      turn_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT plugin.activity_id, plugin.subject_id, plugin.label, plugin.connector_type,
              plugin.lifecycle_state, turn_activity.subject_id AS turn_id
         FROM transcript_activities plugin
         JOIN transcript_activities turn_activity
           ON plugin.parent_activity_id = turn_activity.activity_id
        WHERE plugin.scope = 'plugin'
          AND turn_activity.scope = 'assistant_turn'
          AND turn_activity.subject_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY plugin.created_at, plugin.call_index, plugin.activity_id`,
      ...ids,
    ).toArray());
    if (pluginRows.length === 0) return [];
    const pluginIds = pluginRows.map((row) => row.activity_id);
    const callRows = boundParameterChunks(pluginIds).flatMap((ids) => this.sql.exec<{
      parent_activity_id: string;
      subject_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT parent_activity_id, subject_id
         FROM transcript_activities
        WHERE scope = 'tool_call'
          AND parent_activity_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY call_index, created_at`,
      ...ids,
    ).toArray());
    const callsByPlugin = new Map<string, string[]>();
    for (const row of callRows) {
      const current = callsByPlugin.get(row.parent_activity_id) ?? [];
      current.push(row.subject_id);
      callsByPlugin.set(row.parent_activity_id, current);
    }
    const intervalRows = boundParameterChunks(pluginIds).flatMap((ids) => this.sql.exec<{
      activity_id: string;
      started_at: number;
      stopped_at: number | null;
      duration_ms: number | null;
      timing_accuracy: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT activity_id, started_at, stopped_at, duration_ms, timing_accuracy
         FROM transcript_activity_intervals
        WHERE activity_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY activity_id, started_at`,
      ...ids,
    ).toArray());
    const intervalsByPlugin = new Map<string, typeof intervalRows>();
    for (const interval of intervalRows) {
      const current = intervalsByPlugin.get(interval.activity_id) ?? [];
      current.push(interval);
      intervalsByPlugin.set(interval.activity_id, current);
    }
    return pluginRows.map((row) => {
      const intervals = intervalsByPlugin.get(row.activity_id) ?? [];
      let completedMs = 0;
      let elapsedMs: number | null = null;
      // A stopped interval that never recorded a duration makes the total
      // unknowable rather than smaller: reporting the rest of the sum would
      // understate the work by exactly the piece that is missing.
      let durationKnown = intervals.length > 0;
      let upperBound = false;
      for (const interval of intervals) {
        if (interval.timing_accuracy === "upper_bound") upperBound = true;
        if (interval.stopped_at === null) {
          elapsedMs = (elapsedMs ?? 0)
            + Math.max(0, snapshotAt - Number(interval.started_at));
          continue;
        }
        if (interval.duration_ms === null) {
          durationKnown = false;
          continue;
        }
        completedMs += Number(interval.duration_ms);
      }
      return {
        pluginRunId: row.activity_id,
        turnId: row.turn_id,
        pluginId: row.subject_id,
        displayName: row.label,
        ...(row.connector_type ? { connectorType: row.connector_type } : {}),
        state: row.lifecycle_state as TranscriptPluginRun["state"],
        durationMs: durationKnown ? completedMs : null,
        elapsedMsAtSnapshot: elapsedMs,
        timingAccuracy: upperBound ? "upper_bound" as const : "observed" as const,
        toolCallIds: callsByPlugin.get(row.activity_id) ?? [],
      };
    });
  }

  private activitiesForIds(
    activityIds: string[],
    snapshotAt: number,
    includeActive: boolean,
  ): TranscriptActivity[] {
    if (activityIds.length === 0 && !includeActive) return [];
    const seedClauses = [
      ...(activityIds.length > 0
        ? ["SELECT activity_id FROM transcript_activities WHERE activity_id IN (SELECT value FROM json_each(?))"]
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
              activity.subject_id, activity.call_index, activity.label, activity.connector_type,
              activity.lifecycle_state, activity.revision
         FROM transcript_activities activity
         JOIN selected ON selected.activity_id = activity.activity_id
        ORDER BY activity.created_at, activity.parent_activity_id, activity.call_index`,
      ...(activityIds.length > 0 ? [JSON.stringify(activityIds)] : []),
    ).toArray();
    return this.hydrateActivities(rows, snapshotAt);
  }

  private activity(activityId: string): TranscriptActivity | null {
    return this.transcriptActivity(activityId);
  }

  private hydrateActivities(rows: ActivityRow[], snapshotAt: number): TranscriptActivity[] {
    if (rows.length === 0) return [];
    const intervals = this.sql.exec<IntervalRow>(
      `SELECT activity_id, interval_id, started_at, stopped_at, duration_ms,
              boundary_source, timing_accuracy, revision
         FROM transcript_activity_intervals
        WHERE activity_id IN (SELECT value FROM json_each(?))
        ORDER BY activity_id, started_at`,
      JSON.stringify(rows.map((row) => row.activity_id)),
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
      ...(row.connector_type ? { connectorType: row.connector_type } : {}),
      state: row.lifecycle_state as TranscriptActivity["state"],
      intervals: (intervalsByActivity.get(row.activity_id) ?? []).map((interval) => ({
        intervalId: interval.interval_id,
        startedAtUtc: new Date(Number(interval.started_at)).toISOString(),
        stoppedAtUtc: interval.stopped_at === null ? null : new Date(Number(interval.stopped_at)).toISOString(),
        durationMs: interval.duration_ms === null ? null : Number(interval.duration_ms),
        elapsedMsAtSnapshot: interval.stopped_at === null
          ? Math.max(0, snapshotAt - Number(interval.started_at))
          : null,
        boundarySource: interval.boundary_source as TranscriptActivity["intervals"][number]["boundarySource"],
        timingAccuracy: interval.timing_accuracy as TranscriptActivity["intervals"][number]["timingAccuracy"],
        revision: Number(interval.revision),
      })),
      revision: Number(row.revision),
    })));
  }

  private async materializeProjectionFacts(
    transition: BindLoopTransition,
    previous: BindLoopProjectionState | null,
    next: BindLoopProjectionState,
  ): Promise<PreparedBindProjectionFacts> {
    const materials: PreparedTranscriptFact[] = [];
    const messageFacts: Array<{ position: number; factId: string }> = [];
    let appendedFactId: string | null = null;
    const previousCount = previous === null
      ? 0
      : bindLoopNonSystemMessageCount(previous) + 1;
    const nextCount = bindLoopNonSystemMessageCount(next) + 1;
    let changedMessages: Array<{ position: number; message: BindLoopMessage }>;
    if (transition.kind === "state_initialized" || transition.kind === "state_replaced") {
      changedMessages = projectBindLoopMessages(next)
        .map((message, position) => ({ position, message }));
    } else if (transition.kind === "system_projection_changed") {
      if (nextCount !== previousCount) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      changedMessages = [{ position: 0, message: next.systemProjection.message }];
    } else if (transition.kind === "assistant_accepted"
      || transition.kind === "tool_result_accepted"
      || transition.kind === "protocol_user_appended") {
      if (nextCount !== previousCount + 1) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      changedMessages = [{ position: nextCount - 1, message: transition.message }];
    } else {
      if (nextCount !== previousCount) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      return { materials, messageFacts, messageCount: nextCount, appendedFactId };
    }
    for (const { position, message } of changedMessages) {
      const suffix = position === nextCount - 1
        && ["assistant_accepted", "tool_result_accepted", "protocol_user_appended"].includes(transition.kind)
        ? transition.kind
        : `message:${position}`;
      const factId = `${transition.loopId}:state:${transition.stateRevision}:${suffix}`;
      // An activation append and its replay alias must agree on the record's
      // one kind: a fact re-minted as `model_message` here and
      // `activation_input` on the alias path is the same datum classified two
      // ways, and the receipt join is how that shows up.
      const activationAppend = transition.kind === "protocol_user_appended"
        && transition.activationInputId !== null
        && position === nextCount - 1;
      const material: TranscriptFactMaterial = {
        factId,
        factKind: position === 0
          ? "system_projection"
          : activationAppend ? "activation_input" : "model_message",
        audience: position === 0 ? "model" : participantShareable(message) ? "shared" : "model",
        payload: message,
        origin: this.messageOrigin(transition, position, next.systemProjection),
        runId: transition.loopId,
        turnId: "turnId" in transition ? transition.turnId : null,
        toolCallId: "toolCallId" in transition ? transition.toolCallId : null,
      };
      const prepared = await this.prepareFact(material);
      materials.push(prepared);
      messageFacts.push({ position, factId });
      if (suffix === "assistant_accepted"
        || suffix === "tool_result_accepted"
        || suffix === "protocol_user_appended") {
        appendedFactId = factId;
      }
    }
    return { materials, messageFacts, messageCount: nextCount, appendedFactId };
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
    facts: PreparedBindProjectionFacts,
    now: number,
  ): void {
    this.sql.exec(
      `INSERT INTO bind_loop_heads
         (loop_id, generation, state_revision, system_projection_revision,
          transition_kind, system_renderer_version, system_input_hash,
          projector_version, last_model_turn_index,
          last_assistant_reservation_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(loop_id) DO UPDATE SET
         generation = excluded.generation,
         state_revision = excluded.state_revision,
         system_projection_revision = excluded.system_projection_revision,
         transition_kind = excluded.transition_kind,
         system_renderer_version = excluded.system_renderer_version,
         system_input_hash = excluded.system_input_hash,
         projector_version = excluded.projector_version,
         last_model_turn_index = excluded.last_model_turn_index,
         last_assistant_reservation_json = excluded.last_assistant_reservation_json,
         updated_at = excluded.updated_at`,
      next.loopId,
      next.generation,
      next.stateRevision,
      next.systemProjection.revision,
      transition.kind,
      next.systemProjection.rendererVersion,
      next.systemProjection.inputHash,
      BIND_LOOP_PROJECTOR_VERSION,
      next.lastModelTurnIndex,
      next.lastAssistantReservation === null
        ? null
        : JSON.stringify(next.lastAssistantReservation),
      now,
    );
    const replaceAll = transition.kind === "state_initialized" || transition.kind === "state_replaced";
    if (replaceAll) {
      this.sql.exec(`DELETE FROM bind_loop_state_messages WHERE loop_id = ?`, next.loopId);
    }
    for (const replacement of facts.messageFacts) {
      const position = replacement.position;
      const sequence = this.allocateLoopSequence(now);
      if (!replaceAll && transition.kind === "system_projection_changed") {
        this.sql.exec(
          `UPDATE bind_loop_state_messages
              SET loop_sequence = ?, fact_id = ?
            WHERE loop_id = ? AND message_position = ?`,
          sequence,
          replacement.factId,
          next.loopId,
          position,
        );
      } else {
        this.sql.exec(
          `INSERT INTO bind_loop_state_messages
             (loop_id, message_position, loop_sequence, fact_id)
           VALUES (?, ?, ?, ?)`,
          next.loopId,
          position,
          sequence,
          replacement.factId,
        );
      }
    }
    if (transition.kind === "protocol_user_appended" && transition.activationInputId !== null) {
      this.sql.exec(
        `INSERT INTO bind_activation_inputs
           (loop_id, activation_input_id, fact_id, admitted_state_revision, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        next.loopId,
        transition.activationInputId,
        facts.appendedFactId!,
        next.stateRevision,
        now,
      );
    }
  }

  private projectAssistantTurn(
    transition: Extract<BindLoopTransition, { kind: "assistant_accepted" }>,
    rootFactId: string,
    now: number,
  ): PendingInputDeliveryEffectInput | null {
    const existing = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM participant_transcript_turns WHERE turn_id = ?`,
      transition.turnId,
    ).toArray()[0];
    if (existing) return null;
    if (transition.transcriptSequence === null) {
      throw new Error("workstream_assistant_reservation_missing_sequence");
    }
    const reservation = this.sql.exec<{
      transcript_sequence: number; state: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT transcript_sequence, state FROM assistant_turn_reservations
        WHERE turn_id = ? AND loop_id = ?`,
      transition.turnId,
      transition.loopId,
    ).toArray()[0];
    if (!reservation
      || Number(reservation.transcript_sequence) !== transition.transcriptSequence
      || (reservation.state !== "reserved" && reservation.state !== "streaming")) {
      throw new Error("workstream_assistant_reservation_mismatch");
    }
    const message = transition.message as {
      content?: unknown;
      tool_calls?: Array<{ id: string; type: string; function?: { name?: string; arguments?: string } }>;
    };
    const sequence = transition.transcriptSequence;
    const activityId = `${transition.turnId}:activity`;
    const content = typeof message.content === "string" ? message.content : "";
    const mentions = this.authoritativeAssistantPersonMentions(content);
    const attentionOrdinal = mentions.length > 0 ? this.nextAttentionOrdinal() : null;
    this.sql.exec(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
          root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
       VALUES (?, ?, 'conversation', 'assistant', NULL, ?, ?, ?, 1, ?, ?)`,
      sequence,
      transition.turnId,
      rootFactId,
      activityId,
      attentionOrdinal,
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
    if (content.length > 0) {
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
    if (attentionOrdinal !== null) {
      this.insertPendingMentions(transition.turnId, attentionOrdinal, mentions, now);
      const advanced = this.sql.exec<{
        next_attention_ordinal: number;
      } & Record<string, SqlStorageValue>>(
        `UPDATE workstream
            SET next_attention_ordinal = next_attention_ordinal + 1, updated_at = ?
          WHERE id = 1 AND next_attention_ordinal = ?
          RETURNING next_attention_ordinal`,
        now,
        attentionOrdinal,
      ).toArray()[0];
      if (advanced?.next_attention_ordinal !== attentionOrdinal + 1) {
        throw new Error("assistant_mention_attention_changed");
      }
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
    const materialized = this.sql.exec<{
      turn_id: string;
    } & Record<string, SqlStorageValue>>(
      `UPDATE assistant_turn_reservations
          SET state = 'materialized', outcome = 'accepted',
              materialized_turn_id = turn_id, materialized_at = ?, updated_at = ?
        WHERE turn_id = ? AND state IN ('reserved', 'streaming')
        RETURNING turn_id`,
      now,
      now,
      transition.turnId,
    ).toArray()[0];
    if (materialized?.turn_id !== transition.turnId) {
      throw new Error("workstream_assistant_reservation_materialization_failed");
    }
    enqueueSemanticRealtimeReference(
      this.sql,
      { kind: "transcript_turn", turnId: transition.turnId },
      now,
    );
    if (attentionOrdinal === null) return null;
    const mentionedUserIds = [...new Set(mentions.map((mention) => mention.targetUserId!))];
    return {
      inputId: transition.turnId,
      turnId: transition.turnId,
      transcriptSequence: sequence,
      attentionOrdinal,
      actor: "assistant",
      authorUserId: null,
      authorNameSnapshot: null,
      text: content,
      mentionedUserIds,
      confirmedParticipantUserIds: [],
      affectedUserIds: mentionedUserIds,
      activatedParticipants: [],
    };
  }

  /**
   * Model text can name an identity, but it cannot grant one. Only canonical
   * links whose ids still belong to active participants become transcript
   * mention authority; every other link remains ordinary rendered text.
   */
  private authoritativeAssistantPersonMentions(text: string): PendingInputMentionDescriptor[] {
    const ranges = personMentionMarkdownRanges(text);
    if (ranges.length === 0) return [];
    const activeUserIds = new Set(boundParameterChunks([
      ...new Set(ranges.map((range) => range.personId)),
    ]).flatMap((ids) => this.sql.exec<{
      user_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT user_id FROM participants
        WHERE status = 'active' AND user_id IN (${ids.map(() => "?").join(", ")})`,
      ...ids,
    ).toArray().map((row) => row.user_id.toLowerCase())));
    return ranges
      .filter((range) => activeUserIds.has(range.personId))
      .map((range, mentionIndex) => ({
        mentionIndex,
        mentionKind: "person" as const,
        targetUserId: range.personId,
        connectorType: null,
        startOffset: range.startOffset,
        endOffset: range.endOffset,
      }));
  }

  private insertParticipantStatus(input: {
    turnId: string;
    factId: string;
    activityId: string;
    now: number;
  }): boolean {
    const existing = this.sql.exec<{ turn_id: string } & Record<string, SqlStorageValue>>(
      `SELECT turn_id FROM participant_transcript_turns WHERE turn_id = ?`,
      input.turnId,
    ).toArray()[0];
    if (existing) return false;
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
    enqueueSemanticRealtimeReference(
      this.sql,
      { kind: "transcript_turn", turnId: input.turnId },
      input.now,
    );
    return true;
  }

  private messageRows(loopId: string): MessageProjectionRow[] {
    return this.sql.exec<MessageProjectionRow>(
      `SELECT projected.message_position, projected.fact_id, payload.payload_json
         FROM bind_loop_state_messages projected
         JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE projected.loop_id = ?
        ORDER BY projected.message_position`,
      loopId,
    ).toArray();
  }

  /**
   * Activation identity is an immutable receipt, not current-projection state.
   * Compaction may replace every message in the head, so replay detection must
   * consult the receipt rows rather than only the current message set.
   */
  private bindActivationInputs(loopId: string, activationInputIds: readonly string[]): Array<{
    activationInputId: string;
    messageJson: string;
    provenanceKey: string;
  }> {
    const uniqueIds = [...new Set(activationInputIds)];
    if (uniqueIds.length === 0) return [];
    return this.sql.exec<{
      activation_input_id: string;
      payload_json: string;
      origin_kind: BindLoopMessageOrigin["originKind"];
      source_kind: string | null;
      source_id: string | null;
      source_revision: number | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT receipt.activation_input_id, payload.payload_json,
              fact.origin_kind, fact.source_kind, fact.source_id, fact.source_revision
         FROM bind_activation_inputs receipt
         JOIN transcript_facts fact ON fact.fact_id = receipt.fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE receipt.loop_id = ?
          AND receipt.activation_input_id IN (${uniqueIds.map(() => "?").join(", ")})
        ORDER BY receipt.admitted_state_revision, receipt.activation_input_id`,
      loopId,
      ...uniqueIds,
    ).toArray().map((row) => ({
        activationInputId: row.activation_input_id,
        messageJson: canonicalJson(JSON.parse(row.payload_json)),
        provenanceKey: bindProvenanceKey({
          originKind: row.origin_kind,
          sourceKind: row.source_kind,
          sourceId: row.source_id,
          sourceRevision: row.source_revision,
        }),
      }));
  }

  /**
   * The projected positions (0 = system) of every message in the loop's
   * current state whose provenance names one of `sourceKinds`. The compaction
   * summariser is given the transcript without them: the ledger that owns
   * them carries them forward itself.
   */
  bindMessagePositionsBySourceKind(loopId: string, sourceKinds: readonly string[]): number[] {
    if (sourceKinds.length === 0) return [];
    const placeholders = sourceKinds.map(() => "?").join(", ");
    return this.sql.exec<{ message_position: number } & Record<string, SqlStorageValue>>(
      `SELECT projected.message_position
         FROM bind_loop_state_messages AS projected
         JOIN transcript_facts AS fact ON fact.fact_id = projected.fact_id
        WHERE projected.loop_id = ? AND fact.origin_kind = 'derived'
          AND fact.source_kind IN (${placeholders})
        ORDER BY projected.message_position`,
      loopId,
      ...sourceKinds,
    ).toArray().map((row) => Number(row.message_position));
  }

  private currentBindProvenanceKeys(
    loopId: string,
    provenances: readonly BindLoopMessageOrigin[],
  ): string[] {
    const unique = new Map(provenances.map((provenance) => [
      bindProvenanceKey(provenance),
      provenance,
    ]));
    return [...unique].flatMap(([key, provenance]) => {
      const match = this.sql.exec<{ fact_id: string } & Record<string, SqlStorageValue>>(
        `SELECT fact.fact_id
           FROM transcript_facts AS fact INDEXED BY transcript_facts_source_idx
           JOIN bind_loop_state_messages AS projected
             INDEXED BY bind_loop_state_messages_fact_idx
             ON projected.loop_id = ? AND projected.fact_id = fact.fact_id
          WHERE fact.origin_kind = ? AND fact.source_kind = ? AND fact.source_id = ?
            AND fact.source_revision IS ?
          LIMIT 1`,
        loopId,
        provenance.originKind,
        provenance.sourceKind,
        provenance.sourceId,
        provenance.sourceRevision,
      ).toArray()[0];
      return match ? [key] : [];
    });
  }

  private async prepareFact(fact: TranscriptFactMaterial): Promise<PreparedTranscriptFact> {
    return prepareTranscriptFact(fact);
  }

  private insertFact(fact: PreparedTranscriptFact, now: number): void {
    insertPreparedTranscriptFact(this.sql, fact, now);
  }

  /**
   * The steers a safe step may promote: those ahead of the first queued
   * message that starts no run. That message was sent before any steer behind
   * it, and it lands only after this step's promotions, so a steer past it
   * would be read — by the room and by the model — before it.
   */
  private pendingSteersForCommit(): PendingLoopInputRow[] {
    const steers: PendingLoopInputRow[] = [];
    for (const pending of this.visibleSteersAndInputsWithoutRun()) {
      if (pending.starts_run === 0) break;
      steers.push(pending);
    }
    return steers;
  }

  private visibleSteersAndInputsWithoutRun(): PendingLoopInputRow[] {
    return this.sql.exec<PendingLoopInputRow>(
      `SELECT input_id, loop_id, input_sequence, prepared_turn_id,
              admitted_after_transcript_sequence, mode, actor, author_user_id,
              author_name_snapshot, author_avatar_url_snapshot, client_message_id,
              external_actor_json, message_type, prepared_payload_id, prepared_fact_id,
              prepared_payload_audience, prepared_payload_media_type,
              prepared_payload_json, prepared_payload_sha256,
              prepared_payload_byte_length, bind_payload_json, provenance_json, authorization_json,
              attachments_json, mentions_json, starts_run, created_at, updated_at
         FROM pending_loop_inputs
        WHERE (mode = 'steer' OR starts_run = 0)
          AND NOT EXISTS (
            SELECT 1 FROM pending_loop_input_mailbox preparing
             WHERE preparing.loop_id = pending_loop_inputs.loop_id
               AND preparing.state = 'preparing'
               AND preparing.input_sequence < pending_loop_inputs.input_sequence
          )
        ORDER BY input_sequence`,
    ).toArray();
  }

  private visibleActivationInputs(): PendingLoopInputRow[] {
    return this.sql.exec<PendingLoopInputRow>(
      `SELECT input_id, loop_id, input_sequence, prepared_turn_id,
              admitted_after_transcript_sequence, mode, actor, author_user_id,
              author_name_snapshot, author_avatar_url_snapshot, client_message_id,
              external_actor_json, message_type, prepared_payload_id, prepared_fact_id,
              prepared_payload_audience, prepared_payload_media_type,
              prepared_payload_json, prepared_payload_sha256,
              prepared_payload_byte_length, bind_payload_json, provenance_json, authorization_json,
              attachments_json, mentions_json, starts_run, created_at, updated_at
         FROM pending_loop_inputs
        WHERE starts_run = 1
          AND NOT EXISTS (
            SELECT 1 FROM pending_loop_input_mailbox preparing
             WHERE preparing.loop_id = pending_loop_inputs.loop_id
               AND preparing.state = 'preparing'
               AND preparing.input_sequence < pending_loop_inputs.input_sequence
          )
        ORDER BY input_sequence`,
    ).toArray();
  }

  /**
   * The inputs at the head of the visible queue that start no run.
   *
   * Each waited only for what was sent before it, so the moment nothing is
   * ahead it lands. Nothing about it touches Bind: it is a canonical turn like
   * any message the room did not address to Rally, and the gap-fill appends it
   * to the model's context ahead of the next input that does.
   */
  private leadingInputsWithoutRun(): PendingLoopInputRow[] {
    const leading: PendingLoopInputRow[] = [];
    for (const pending of new SubstreamLoopStorage(this.storage).pendingInputs()) {
      if (pending.starts_run !== 0) break;
      leading.push(pending);
    }
    return leading;
  }

  /** Whether an input that starts no run can land now. */
  hasLeadingInputWithoutRun(): boolean {
    return new SubstreamLoopStorage(this.storage).visibleHeadStartsNoRun();
  }

  /**
   * The inputs that start no run and will lead the queue once `landingIds`
   * are delivered: what lands in the same transaction, right under them.
   */
  private inputsWithoutRunLandingAfter(landingIds: readonly string[]): PendingLoopInputRow[] {
    const landing = new Set(landingIds);
    const following: PendingLoopInputRow[] = [];
    for (const pending of new SubstreamLoopStorage(this.storage).pendingInputs()) {
      if (landing.has(pending.input_id)) continue;
      if (pending.starts_run !== 0) break;
      following.push(pending);
    }
    return following;
  }

  /**
   * The Bind appends that let a run read what the room said right after the
   * input it is about to answer, as the gap-fill would have: overheard, keyed
   * by the turn it lands as, so a later gap-fill skips it by provenance.
   */
  private async prepareInputsWithoutRunSteps(
    previous: BindLoopProjectionState,
    inputs: readonly PendingLoopInputRow[],
  ): Promise<{ steps: PreparedPendingBindStep[]; next: BindLoopProjectionState }> {
    const steps: PreparedPendingBindStep[] = [];
    let projection = previous;
    for (const pending of inputs) {
      const material = parsePendingInputMaterial(pending);
      const message = projectParticipantTextMessage({
        author: {
          type: "human",
          userId: pending.author_user_id,
          displayName: pending.author_name_snapshot,
        },
        structuredContent: material.payload.structuredContent,
        text: material.payload.content,
        mentions: material.mentions.map((mention) => ({
          type: mention.mentionKind,
          userId: mention.targetUserId,
          displayName: null,
        })),
        overheard: true,
      });
      if (!message) continue;
      const transition: PendingSettlementTransition = {
        kind: "protocol_user_appended",
        loopId: previous.loopId,
        generation: projection.generation,
        stateRevision: projection.stateRevision + 1,
        message: modelMessageWithoutProvenance(message),
        provenance: {
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: pending.prepared_turn_id,
          sourceRevision: 1,
        },
        activationInputId: null,
      };
      const next = applyBindLoopTransition(projection, transition);
      const facts = await this.materializeProjectionFacts(transition, projection, next);
      const appended = facts.messageFacts[0];
      if (!appended
        || appended.position !== bindLoopNonSystemMessageCount(projection) + 1) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      steps.push({ previous: projection, transition, next, facts });
      projection = next;
    }
    return { steps, next: projection };
  }

  /**
   * Land the leading inputs that start no run and write the Bind appends
   * prepared for them. What was prepared must be exactly what leads now: the
   * appends chain from the projection they were prepared on.
   */
  private deliverPreparedInputsWithoutRunInTransaction(
    expected: readonly PendingLoopInputRow[],
    steps: readonly PreparedPendingBindStep[],
    now: number,
  ): ReturnType<WorkstreamTranscriptStorage["deliverLeadingInputsWithoutRunInTransaction"]> {
    const delivered = this.deliverLeadingInputsWithoutRunInTransaction(now);
    if (expected.some((pending, index) => delivered.removedInputIds[index] !== pending.input_id)) {
      throw new Error("pending_input_without_run_changed");
    }
    for (const step of steps) {
      this.assertExpectedHead(step.previous, step.transition);
      for (const fact of step.facts.materials) this.insertFact(fact, now);
      this.writeBindState(step.transition, step.next, step.facts, now);
    }
    return delivered;
  }

  private deliverLeadingInputsWithoutRunInTransaction(now: number): {
    turns: TranscriptTurn[];
    removedInputIds: string[];
    deliveryEffects: PendingInputDeliveryEffectInput[];
  } {
    const turns: TranscriptTurn[] = [];
    const removedInputIds: string[] = [];
    const deliveryEffects: PendingInputDeliveryEffectInput[] = [];
    for (const pending of this.leadingInputsWithoutRun()) {
      const delivered = this.promotePendingInputInTransaction(
        pending,
        parsePendingInputMaterial(pending),
        now,
      );
      this.markPendingDeliveredDirect(pending, delivered.attentionOrdinal, now);
      const turn = this.participantTurn(pending.prepared_turn_id);
      if (!turn || turn.attentionOrdinal !== delivered.attentionOrdinal) {
        throw new Error("pending_input_turn_hydration_failed");
      }
      turns.push(turn);
      removedInputIds.push(pending.input_id);
      deliveryEffects.push(delivered.deliveryEffect);
    }
    return { turns, removedInputIds, deliveryEffects };
  }

  /**
   * Land the inputs that start no run and have nothing left ahead of them, on
   * an idle loop. An executing loop lands them at its next safe step instead,
   * or in the activation that delivered what they were waiting for.
   */
  deliverLeadingInputsWithoutRun(input: {
    loopId: string;
    enqueueRegionalEffectsInTransaction: (
      deliveries: readonly PendingInputDeliveryEffectInput[],
    ) => void;
    now: number;
  }): void {
    this.storage.transactionSync(() => {
      const loop = new SubstreamLoopStorage(this.storage).loop();
      if (!loop || loop.loop_id !== input.loopId) throw new Error("substream_loop_not_found");
      if (loop.status !== "idle") return;
      invokeSynchronousEffectEnqueue(
        input.enqueueRegionalEffectsInTransaction,
        this.deliverLeadingInputsWithoutRunInTransaction(input.now).deliveryEffects,
      );
    });
  }

  /**
   * Land the input at the head of the queue as a canonical turn and start no
   * run for it, because this conversation refused to act on it: input to a
   * Sidekick run the Sidekick no longer continues.
   *
   * Delivered rather than left pending, because a pending input at the head
   * holds every input behind it, and delivered rather than deleted, because
   * the sender's words are still what they said. Nothing touches Bind: like a
   * message that started no run, the turn reaches the model through the
   * gap-fill of whatever run comes next, as said to the room.
   *
   * Fenced on the idle loop at the revision the caller read and on the input
   * still being the next one Bind would take, so a concurrent activation or a
   * reorder is refused rather than overtaken. The caller owns the transaction
   * and enqueues the returned delivery effects in it.
   */
  deliverRefusedInputInTransaction(input: {
    loopId: string;
    inputId: string;
    expectedLoopRevision: number;
    now: number;
  }): PendingInputDeliveryEffectInput[] {
    const loop = new SubstreamLoopStorage(this.storage).loop();
    if (!loop || loop.loop_id !== input.loopId) throw new Error("substream_loop_not_found");
    if (loop.status !== "idle" || loop.revision !== input.expectedLoopRevision) {
      throw new Error("substream_loop_refusal_fenced");
    }
    const pending = this.nextActivationInput(input.loopId);
    if (pending?.input_id !== input.inputId) throw new Error("substream_loop_refusal_fenced");
    const delivered = this.promotePendingInputInTransaction(
      pending,
      parsePendingInputMaterial(pending),
      input.now,
    );
    this.markPendingDeliveredDirect(pending, delivered.attentionOrdinal, input.now);
    return [delivered.deliveryEffect];
  }

  private oldestActivationInput(
    projection: BindLoopProjectionState | null,
  ): PendingLoopInputRow | undefined {
    return this.inputsBindCanAccept(projection, this.visibleActivationInputs())[0];
  }

  /**
   * The pending input that can start this loop's next cycle, or `undefined`
   * while nothing in the queue can move it on.
   */
  nextActivationInput(loopId: string): PendingLoopInputRow | undefined {
    return this.oldestActivationInput(this.readBindProjection(loopId));
  }

  /**
   * The withheld calls owned by elicitation requests, and nothing else.
   *
   * A batch withheld for any other reason is nobody's to close by answering:
   * only a live execution can repair it from the tool receipts, which is what
   * `unsettledToolBatchBlockingRelease` below keeps the loop alive for.
   *
   * A cancelled request still owns a withheld call until promotion appends its
   * cancellation result. It is eligible to move with the next pending input,
   * so the release guard may let the idle loop wait for that input.
   */
  private openQuestionToolCallIds(projection: BindLoopProjectionState): Set<string> {
    const withheld = pendingBindToolBatch(projection);
    if (!withheld) return new Set();
    // One statement per chunk rather than one per call. This selector answers
    // for both release paths *and* every activation check, so a parallel batch
    // of N questions used to cost N round trips on each of them; the release
    // guard this replaced had always read them in a single `IN (…)`.
    const open = new Set(boundParameterChunks(
      withheld.calls.map((call) => call.receiptToolCallId),
    ).flatMap((receiptToolCallIds) =>
      this.sql.exec<{ tool_call_id: string } & Record<string, SqlStorageValue>>(
        `SELECT tool_call_id FROM elicitation_requests
          WHERE status IN ('pending', 'answered', 'cancelled')
            AND tool_call_id IN (${receiptToolCallIds.map(() => "?").join(", ")})`,
        ...receiptToolCallIds,
      ).toArray().map((row) => String(row.tool_call_id))));
    return open.size === withheld.calls.length ? open : new Set();
  }

  private cancelledQuestionRequests(projection: BindLoopProjectionState): Array<{
    elicitationId: string;
    toolCallId: string;
  }> {
    const withheld = pendingBindToolBatch(projection);
    if (!withheld || withheld.calls.length === 0) return [];
    return boundParameterChunks(withheld.calls.map((call) => call.receiptToolCallId))
      .flatMap((ids) => this.sql.exec<{
        elicitation_id: string; tool_call_id: string;
      } & Record<string, SqlStorageValue>>(
        `SELECT elicitation_id, tool_call_id FROM elicitation_requests
          WHERE status = 'cancelled'
            AND tool_call_id IN (${ids.map(() => "?").join(", ")})
          ORDER BY created_at, elicitation_id`,
        ...ids,
      ).toArray())
      .map((row) => ({ elicitationId: row.elicitation_id, toolCallId: row.tool_call_id }));
  }

  /**
   * The tool batch that must be settled before this loop may go back to `idle`,
   * or `null` when nothing holds the release.
   *
   * Only a *running* execution can settle such a batch:
   * `recoverInterruptedToolBatch` reads the durable tool receipts and appends
   * the missing results, and every write it makes is fenced on a live lease.
   * So a loop released to `idle` with the batch still open can never be
   * repaired — the only route back to an execution is admitting a pending
   * input, and `applyBindLoopTransition` refuses a `protocol_user_appended`
   * while the last assistant step is unsettled. The refusal is correct and the
   * repair is unreachable, which leaves the loop wedged: every drain throws
   * `bind_loop_protocol_user_invalid`, nothing durable changes, and the queue
   * still looks like work to `nextLoopWorkAt`, which re-arms at `now`.
   *
   * On 2026-09-19 one substream sat in exactly that state for a day, logging
   * about six `substream_loop_drain_failed` a second — 397k of them before it
   * was found, and found only because somebody was reading the logs for
   * something else. The release that produced it checked for an unmaterialized
   * assistant turn and not for this.
   *
   * A batch of elicitation calls is the one exception: an answer or a newer
   * message supplies its result through pending-input promotion.
   */
  unsettledToolBatchBlockingRelease(loopId: string): PendingBindToolBatch | null {
    const projection = this.readBindProjection(loopId);
    if (!projection) return null;
    const withheld = pendingBindToolBatch(projection);
    if (!withheld) return null;
    return this.openQuestionToolCallIds(projection).size === withheld.calls.length
      ? null
      : withheld;
  }

  /**
   * Pending inputs in the order Bind will take them.
   *
   * The queue is FIFO because that is the order the room said things in. Bind's
   * protocol is not: while the last assistant step holds an unanswered
   * question, every user message is refused, because a tool result has to
   * follow its own call directly. The one input that moves the loop on is the
   * answer to that question — and it is admitted *behind* whatever was queued
   * while the question was on screen. Handing Bind the queue head there threw
   * on every attempt, and a pending input that throws stays where it is: the
   * queue stopped at its head, the answer behind it was never promoted, and
   * the question could not be dismissed by anyone, because the card is drawn
   * from the canonical turn the promotion writes. The answer therefore goes
   * first. That is a reordering, not a hold: the tool result an answer appends
   * settles the batch, so the rest of the queue follows it in the same pass, in
   * arrival order. Only a question still unanswered holds anything back.
   */
  private inputsBindCanAccept(
    projection: BindLoopProjectionState | null,
    pendingInputs: readonly PendingLoopInputRow[],
  ): PendingLoopInputRow[] {
    if (projection === null) return [...pendingInputs];
    const withheld = pendingBindToolBatch(projection);
    if (!withheld) return [...pendingInputs];
    const openToolCallIds = this.openQuestionToolCallIds(projection);
    // A withheld batch that is not entirely open questions belongs to the host
    // repair, not to this queue, and nothing here can be appended until that
    // repair runs: Bind refuses every `protocol_user_appended` while the last
    // assistant step is unsettled, whatever is queued behind it.
    //
    // Returning the queue anyway is not a harmless optimism. It made the head
    // look like executable work, so `nextLoopWorkAt` derived a wake at `now`,
    // `armNextAlarm` floored it at `now + 1`, and the object re-entered as fast
    // as it could return — each pass throwing `bind_loop_protocol_user_invalid`
    // and changing nothing. Holding the queue is what makes the stall quiet and
    // visible instead: `nextLoopWorkAt` derives no instant, and the loop is
    // reported once through `substream_loop_parked_with_queued_input`.
    if (openToolCallIds.size === 0) return [];
    const cancelled = new Set(this.cancelledQuestionRequests(projection).map((row) => row.toolCallId));
    const answers = new Map<string, PendingLoopInputRow>();
    for (const pending of pendingInputs) {
      const toolCallId = this.answeredQuestionToolCallId(pending);
      if (toolCallId === null || !openToolCallIds.has(toolCallId)) continue;
      if (!answers.has(toolCallId)) answers.set(toolCallId, pending);
    }
    const closing = [...answers.values()];
    // Every question answered, or none of the queue moves. One question still
    // open leaves the batch unsettled, and `lastAssistantStepIsSettled` is
    // false for an unsettled batch however many of its siblings are closed —
    // so appending anything else here is the exact refusal this selector
    // exists to avoid, not a queue that could have drained a little further.
    // The rest is parked, not dropped: it is the same queue on the next pass,
    // and the last answer releases it.
    if (answers.size + [...openToolCallIds].filter((id) => cancelled.has(id)).length
      !== openToolCallIds.size) return closing;
    const closed = new Set(closing);
    return [...closing, ...pendingInputs.filter((pending) => !closed.has(pending))];
  }

  /** The withheld tool call this pending input closes, when it is an answer to one. */
  private answeredQuestionToolCallId(pending: PendingLoopInputRow): string | null {
    const { elicitationId } = parsePendingInputMaterial(pending).authorization;
    if (elicitationId === null) return null;
    const row = this.sql.exec<{ tool_call_id: string } & Record<string, SqlStorageValue>>(
      `SELECT tool_call_id FROM elicitation_requests WHERE elicitation_id = ?`,
      elicitationId,
    ).toArray()[0];
    return row === undefined ? null : String(row.tool_call_id);
  }

  private async preparePendingBindAppends(
    previous: BindLoopProjectionState,
    pendingInputs: readonly PendingLoopInputRow[],
  ): Promise<PreparedPendingBindAppend[]> {
    const prepared: PreparedPendingBindAppend[] = [];
    let projection = previous;
    // Where the projection has looked so far. Every text input below first
    // appends the conversation turns between this mark and its own admission,
    // then itself, so the model reads the room in the order the room happened.
    let projectedThrough = new SubstreamLoopStorage(this.storage).loop()
      ?.transcript_projected_through ?? 0;
    // Everything the transcript holds at this instant, read once for the pass.
    // Not each input's admission fence: that is the high-water at reservation,
    // and a turn written between reservation and this drain — someone talking
    // while a steer waits for the next safe step, or while an activation's
    // alarm is on its way — sits above it. Scanning to the live mark takes
    // every such turn, and takes them in transcript order ahead of every input
    // in the pass, which is also the order the room saw them in.
    const scanThrough = this.transcriptThrough();
    const appendedInThisPass = new Set<string>();
    const cancelledQuestions = this.cancelledQuestionRequests(previous);
    for (const pending of this.inputsBindCanAccept(previous, pendingInputs)) {
      const material = parsePendingInputMaterial(pending);
      // The transition below appends `bindPayload`, which is always the user
      // message the model reads; the canonical payload's role follows the
      // actor and is `system` for an automation's posted result. Testing the
      // canonical role here threw on every such activation, and a pending
      // input that throws never leaves the queue, so the room stopped
      // processing anything after it.
      if (material.bindPayload.role !== "user") {
        throw new Error("pending_input_bind_role_invalid");
      }
      const steps: PreparedPendingBindStep[] = [];
      if (pending.message_type === "elicitation" && !material.authorization.elicitationId) {
        throw new Error("elicitation_pending_input_identity_missing");
      }
      // Every promoted input can be the one that resumes a batch with a
      // cancelled sibling, including an answer to another question in it.
      for (const question of cancelledQuestions) {
        if (!pendingBindToolBatch(projection)?.calls.some((call) =>
          call.receiptToolCallId === question.toolCallId)) continue;
        const cancellation = await this.prepareElicitationAnswerToolResult(
          projection, question.elicitationId,
        );
        steps.push(cancellation);
        projection = cancellation.next;
      }
      if (material.authorization.elicitationId) {
        const answerStep = await this.prepareElicitationAnswerToolResult(
          projection,
          material.authorization.elicitationId,
        );
        steps.push(answerStep);
        projection = answerStep.next;
        // The delayed tool result is the model-protocol answer. The canonical
        // participant turn is still promoted below for the shared UI, but
        // appending its model derivative as a user message would tell the model
        // the same answer twice and change the semantics of a suspended tool.
        // It scans nothing and advances nothing: a tool result has to follow
        // its call directly, so a turn written while the question was open
        // waits for the next text input, which appends it after this result.
        prepared.push({ pending, material, steps, next: projection, projectedThrough: null });
        continue;
      }
      // The turns nobody admitted. A message that started no run is a
      // canonical turn and nothing else, and until now it stayed that way:
      // visible to every member, invisible to the model. Appended here, in
      // transcript order, ahead of the input that follows them — an aside
      // between two questions reads as an aside, not as an afterthought.
      for (const gap of await this.unprojectedConversationTurnSteps(
        projection,
        projectedThrough,
        scanThrough,
        appendedInThisPass,
      )) {
        steps.push(gap);
        projection = gap.next;
      }
      projectedThrough = Math.max(projectedThrough, scanThrough);
      const transition: ProtocolUserTransition = {
        kind: "protocol_user_appended",
        loopId: previous.loopId,
        generation: projection.generation,
        stateRevision: projection.stateRevision + 1,
        message: material.bindPayload,
        provenance: {
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: pending.prepared_turn_id,
          sourceRevision: 1,
        },
        activationInputId: null,
      };
      const next = applyBindLoopTransition(projection, transition);
      const facts = await this.materializeProjectionFacts(transition, projection, next);
      const appended = facts.messageFacts[0];
      if (!appended
        || appended.position !== bindLoopNonSystemMessageCount(projection) + 1) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      steps.push({ previous: projection, transition, next, facts });
      prepared.push({ pending, material, steps, next, projectedThrough });
      projection = next;
    }
    return prepared;
  }

  /**
   * The conversation turns in `(fromExclusive, toInclusive]` the projection has
   * never seen, each as the transition that appends it.
   *
   * Human, external, and imported assistant text turns qualify, and so does a
   * Sidekick's `conversation_post`: the post does not wake this agent, but it is
   * still something said in the room, attributed to the Sidekick and never to
   * a person. The query says so rather
   * than hydrating every turn in the range and discarding most of them: the
   * range spans everything since the last admission, a long run's tool rows
   * included. Rally assistant turns are produced by the projection itself; status
   * rows are not conversation; an elicitation answer is a pending input by
   * construction and carries no text of its own. A turn that *was* a pending
   * input is already here under exactly the provenance built below, which is
   * why that provenance is copied from the admission path rather than invented
   * — the same key is what lets `currentBindProvenanceKeys` say "already
   * projected" and skip it. Those keys are looked up for the whole range at
   * once.
   *
   * A turn appended here is rendered as what it is: something said to the
   * room, by a named author, that nobody asked Rally about. The admission path
   * renders a request; this path renders the conversation around it, and the
   * model is told which is which. A mention inside such a turn carries the
   * person's id and no display name — the object holds no roster, and the
   * canonical text already carries the name the author typed.
   */
  private async unprojectedConversationTurnSteps(
    previous: BindLoopProjectionState,
    fromExclusive: number,
    toInclusive: number,
    appendedInThisPass: Set<string>,
  ): Promise<PreparedPendingBindStep[]> {
    if (toInclusive <= fromExclusive) return [];
    const candidates = this.conversationTurnsInRange(fromExclusive + 1, toInclusive + 1)
      .flatMap((turn) => {
        const text = turn.blocks.find((block) => block.type === "text");
        if (!text || text.type !== "text") return [];
        if (turn.actor === "assistant" && text.structuredContent?.kind !== "imported_session") return [];
        const provenance: BindLoopMessageOrigin = {
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: turn.turnId,
          sourceRevision: 1,
        };
        return [{ turn, text, provenance, key: bindProvenanceKey(provenance) }];
      });
    const alreadyProjected = new Set(this.currentBindProvenanceKeys(
      previous.loopId,
      candidates.map((candidate) => candidate.provenance),
    ));
    const steps: PreparedPendingBindStep[] = [];
    let projection = previous;
    const externalFraming = candidates.some(({ turn }) => turn.actor === "external")
      ? this.externalInputFraming()
      : "request";
    for (const { turn, text, provenance, key } of candidates) {
      if (appendedInThisPass.has(key) || alreadyProjected.has(key)) continue;
      const imported = ImportedMessageProvenanceSchema.safeParse(text.structuredContent);
      const mentions = (text.mentions ?? []).map((mention) => ({
        type: mention.type,
        userId: mention.userId,
        displayName: null,
      }));
      const message = imported.success ? projectImportedSourceMessage({
        provider: imported.data.source.provider,
        role: turn.actor === 'assistant' ? 'assistant' : 'user',
        text: text.text,
        revised: Boolean(imported.data.supersedesTurnId),
      }) : turn.actor === "assistant" ? null : turn.actor === "system" ? projectSidekickPostMessage({
        structuredContent: text.structuredContent,
        deliveredAt: turn.createdAtUtc,
        text: text.text,
        mentions,
        overheard: true,
      }) : projectParticipantTextMessage({
        author: turn.actor === "external" && turn.externalActor
          ? {
              type: "external",
              actor: {
                provider: turn.externalActor.provider,
                displayName: turn.externalActor.displayName,
                providerUserId: turn.externalActor.providerUserId,
              },
            }
          : {
              type: "human",
              userId: turn.authorUserId,
              displayName: turn.authorSnapshot?.displayName ?? null,
            },
        structuredContent: text.structuredContent,
        externalFraming,
        text: text.text,
        mentions,
        overheard: true,
      });
      if (!message) continue;
      const transition: PendingSettlementTransition = { kind: "protocol_user_appended", loopId: previous.loopId,
        generation: projection.generation, stateRevision: projection.stateRevision + 1,
        message: modelMessageWithoutProvenance(message), provenance, activationInputId: null };
      const next = applyBindLoopTransition(projection, transition);
      const facts = await this.materializeProjectionFacts(transition, projection, next);
      const appended = facts.messageFacts[0];
      if (!appended
        || appended.position !== bindLoopNonSystemMessageCount(projection) + 1) {
        throw new Error("bind_loop_projection_delta_invalid");
      }
      steps.push({ previous: projection, transition, next, facts });
      appendedInThisPass.add(key);
      projection = next;
    }
    return steps;
  }

  private async prepareElicitationAnswerToolResult(
    previous: BindLoopProjectionState,
    elicitationId: string,
  ): Promise<PreparedPendingBindStep> {
    const row = this.sql.exec<{
      tool_call_id: string;
      status: string;
      answer_json: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT tool_call_id, status, answer_json
         FROM elicitation_requests WHERE elicitation_id = ?`,
      elicitationId,
    ).toArray()[0];
    if (!row || (row.status !== "answered" && row.status !== "cancelled")) {
      throw new Error("elicitation_answer_not_committed");
    }
    const position = /^(.*:turn:\d+):tool:(\d+)$/u.exec(row.tool_call_id);
    const turnId = position?.[1];
    const callIndex = Number(position?.[2]);
    if (!turnId || !Number.isSafeInteger(callIndex) || callIndex < 0
      || turnId !== previous.lastAssistantReservation?.turnId
      || previous.lastAssistantReservation.status !== "accepted") {
      throw new Error("elicitation_tool_call_identity_invalid");
    }
    const messages = projectBindLoopMessages(previous);
    let assistantIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        assistantIndex = index;
        break;
      }
    }
    const assistant = messages[assistantIndex];
    const calls = assistant && Array.isArray(assistant.tool_calls) ? assistant.tool_calls : [];
    const call = calls[callIndex];
    const providerToolCallId = call && typeof call === "object"
      && typeof (call as { id?: unknown }).id === "string"
      ? (call as { id: string }).id
      : null;
    const acceptedToolResults = messages.slice(assistantIndex + 1)
      .filter((message) => message.role === "tool");
    if (!providerToolCallId || acceptedToolResults.some((message) =>
      message.tool_call_id === providerToolCallId)) {
      throw new Error("elicitation_tool_call_identity_invalid");
    }
    const transition: Extract<BindLoopTransition, { kind: "tool_result_accepted" }> = {
      kind: "tool_result_accepted",
      loopId: previous.loopId,
      generation: previous.generation,
      stateRevision: previous.stateRevision + 1,
      message: {
        role: "tool",
        tool_call_id: providerToolCallId,
        content: canonicalJson({
          success: true,
          data: {
            elicitationId,
            answer: row.answer_json === null ? null : JSON.parse(row.answer_json),
            ...(row.status === "cancelled" ? { cancelled: true } : {}),
            // An answered question has a null answer only when it was skipped:
            // the answer path validates every other answer as non-empty. A
            // flag rather than a sentinel string, which a text answer could be.
            ...(row.status === "answered" && row.answer_json === null ? { skipped: true } : {}),
          },
        }),
      },
      turnId,
      toolCallId: providerToolCallId,
      callIndex,
      resultOrdinal: acceptedToolResults.length,
    };
    const next = applyBindLoopTransition(previous, transition);
    const facts = await this.materializeProjectionFacts(transition, previous, next);
    return { previous, transition, next, facts };
  }

  private assertBindHead(loopId: string, generation: number, stateRevision: number): void {
    const current = this.sql.exec<{
      generation: number; state_revision: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT generation, state_revision FROM bind_loop_heads WHERE loop_id = ?`,
      loopId,
    ).toArray()[0];
    if (!current || Number(current.generation) !== generation
      || Number(current.state_revision) !== stateRevision) {
      throw new Error("bind_loop_head_conflict");
    }
  }

  private advanceLoopBindRevisionInTransaction(
    loopId: string,
    fence: TranscriptExecutionFence,
    nextBindStateRevision: number,
    now: number,
  ): void {
    if (nextBindStateRevision !== fence.expectedBindStateRevision + 1) {
      throw new Error("substream_loop_bind_revision_mismatch");
    }
    const updated = this.sql.exec<{
      loop_id: string;
      bind_state_revision: number;
    } & Record<string, SqlStorageValue>>(
      `UPDATE substream_loops
          SET bind_state_revision = ?, revision = revision + 1, updated_at = ?
        WHERE id = 1 AND loop_id = ? AND status = 'executing'
          AND active_execution_id = ? AND active_execution_epoch = ?
          AND lease_owner = ? AND lease_expires_at > ?
          AND bind_state_revision = ?
        RETURNING loop_id, bind_state_revision`,
      nextBindStateRevision,
      now,
      loopId,
      fence.executionId,
      fence.executionEpoch,
      fence.leaseOwner,
      now,
      fence.expectedBindStateRevision,
    ).toArray()[0];
    if (updated?.loop_id !== loopId
      || updated.bind_state_revision !== nextBindStateRevision) {
      throw new Error("substream_loop_bind_revision_mismatch");
    }
  }

  private assertLoopExecutionBindFence(
    fence: TranscriptExecutionFence,
    loopId: string,
    now: number,
  ): void {
    const loop = new SubstreamLoopStorage(this.storage).loop();
    if (!loop || loop.loop_id !== loopId || loop.status !== "executing"
      || loop.active_execution_id !== fence.executionId
      || loop.active_execution_epoch !== fence.executionEpoch
      || loop.lease_owner !== fence.leaseOwner
      || loop.lease_expires_at === null || loop.lease_expires_at <= now) {
      throw new Error("substream_loop_execution_fence_mismatch");
    }
    if (loop.bind_state_revision !== fence.expectedBindStateRevision) {
      throw new Error("substream_loop_bind_revision_mismatch");
    }
  }

  private advanceLoopBindRevisionBatchInTransaction(
    loopId: string,
    fence: TranscriptExecutionFence,
    nextBindStateRevision: number,
    now: number,
  ): void {
    if (nextBindStateRevision <= fence.expectedBindStateRevision) {
      throw new Error("substream_loop_bind_revision_mismatch");
    }
    const updated = this.sql.exec<{
      loop_id: string;
      bind_state_revision: number;
    } & Record<string, SqlStorageValue>>(
      `UPDATE substream_loops
          SET bind_state_revision = ?, revision = revision + 1, updated_at = ?
        WHERE id = 1 AND loop_id = ? AND status = 'executing'
          AND active_execution_id = ? AND active_execution_epoch = ?
          AND lease_owner = ? AND lease_expires_at > ?
          AND bind_state_revision = ?
        RETURNING loop_id, bind_state_revision`,
      nextBindStateRevision,
      now,
      loopId,
      fence.executionId,
      fence.executionEpoch,
      fence.leaseOwner,
      now,
      fence.expectedBindStateRevision,
    ).toArray()[0];
    if (updated?.loop_id !== loopId
      || updated.bind_state_revision !== nextBindStateRevision) {
      throw new Error("substream_loop_bind_revision_mismatch");
    }
  }

  private ensureLoopBindRevisionAfterReplay(
    loopId: string,
    fence: TranscriptExecutionFence,
    nextBindStateRevision: number,
    now: number,
  ): void {
    const loop = new SubstreamLoopStorage(this.storage).loop();
    if (!loop || loop.loop_id !== loopId || loop.status !== "executing"
      || loop.active_execution_id !== fence.executionId
      || loop.active_execution_epoch !== fence.executionEpoch
      || loop.lease_owner !== fence.leaseOwner
      || loop.lease_expires_at === null || loop.lease_expires_at <= now) {
      throw new Error("substream_loop_execution_fence_mismatch");
    }
    if (loop.bind_state_revision === nextBindStateRevision) return;
    this.advanceLoopBindRevisionInTransaction(loopId, fence, nextBindStateRevision, now);
  }

  private assertStepSettlementFence(input: {
    loopId: string;
    executionId: string;
    executionEpoch: number;
    leaseOwner: string;
    expectedLoopRevision: number;
    expectedStepOrdinal: number;
    expectedBindStateRevision: number;
  }, now: number): SubstreamLoopRow {
    const loop = new SubstreamLoopStorage(this.storage).loop();
    if (!loop || loop.loop_id !== input.loopId) throw new Error("substream_loop_not_found");
    if (loop.revision < input.expectedLoopRevision
      || loop.step_ordinal !== input.expectedStepOrdinal
      || loop.bind_state_revision !== input.expectedBindStateRevision) {
      throw new Error("substream_loop_revision_mismatch");
    }
    if (loop.status !== "executing" || loop.active_execution_id !== input.executionId
      || loop.active_execution_epoch !== input.executionEpoch
      || loop.lease_owner !== input.leaseOwner
      || loop.lease_expires_at === null || loop.lease_expires_at <= now) {
      throw new Error("substream_loop_execution_fence_mismatch");
    }
    return loop;
  }

  private markPendingDeliveredDirect(
    pending: PendingLoopInputRow,
    attentionOrdinal: number,
    now: number,
  ): void {
    const receipt = this.sql.exec<{
      input_id: string;
    } & Record<string, SqlStorageValue>>(
      `INSERT INTO delivered_loop_inputs
         (input_id, loop_id, input_sequence, delivered_turn_id,
          delivered_attention_ordinal, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?)
        RETURNING input_id`,
      pending.input_id,
      pending.loop_id,
      pending.input_sequence,
      pending.prepared_turn_id,
      attentionOrdinal,
      now,
    ).toArray()[0];
    if (receipt?.input_id !== pending.input_id) {
      throw new Error("pending_loop_input_delivery_conflict");
    }
    const removed = this.sql.exec<{
      input_id: string;
    } & Record<string, SqlStorageValue>>(
      `DELETE FROM pending_loop_inputs WHERE input_id = ? RETURNING input_id`,
      pending.input_id,
    ).toArray()[0];
    if (removed?.input_id !== pending.input_id) {
      throw new Error("pending_loop_input_delivery_conflict");
    }
    // A canonical delivery now owns the attachment holds. Preparation recovery
    // and the mailbox carry no forward-path information after this commit.
    this.sql.exec(
      `DELETE FROM pending_attachment_reservation_recovery WHERE input_id = ?`,
      pending.input_id,
    );
    this.sql.exec(`DELETE FROM pending_loop_input_mailbox WHERE input_id = ?`, pending.input_id);
  }

  private validateActivationReceipt(receipt: PendingInputActivationReceipt, now: number): void {
    if (!receipt.runId || !receipt.substreamId || !Number.isSafeInteger(receipt.executionEpoch)
      || receipt.executionEpoch < 1 || !receipt.leaseOwner
      || !Number.isSafeInteger(receipt.leaseExpiresAt) || receipt.leaseExpiresAt <= now
      || !receipt.origin) {
      throw new Error("substream_loop_activation_receipt_invalid");
    }
    requiredRecord(receipt.executionContextJson, "substream_loop_activation_context_invalid");
    requiredRecord(receipt.executionPrincipalJson, "substream_loop_activation_principal_invalid");
  }

  private activationReplay(input: {
    loopId: string;
    expectedInputId: string;
    receipt: PendingInputActivationReceipt;
  }): PendingInputActivationOutcome | null {
    const existing = this.sql.exec<{
      substream_id: string; substream_loop_id: string | null; loop_input_id: string | null;
      loop_execution_id: string | null; execution_context_json: string | null;
      execution_principal_json: string; origin: string; model: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT substream_id, substream_loop_id, loop_input_id, loop_execution_id,
              execution_context_json, execution_principal_json, origin, model
         FROM runs WHERE run_id = ?`,
      input.receipt.runId,
    ).toArray()[0];
    if (!existing) return null;
    if (existing.substream_id !== input.receipt.substreamId
      || existing.substream_loop_id !== input.loopId
      || existing.loop_input_id !== input.expectedInputId
      || existing.loop_execution_id !== input.receipt.runId
      || existing.execution_context_json !== input.receipt.executionContextJson
      || existing.execution_principal_json !== input.receipt.executionPrincipalJson
      || existing.origin !== input.receipt.origin
      || existing.model !== input.receipt.model) {
      throw new Error("substream_loop_activation_replay_mismatch");
    }
    const delivered = new SubstreamLoopStorage(this.storage).deliveredInput(input.expectedInputId);
    const turn = delivered
      ? this.participantTurn(delivered.delivered_turn_id)
      : undefined;
    const loop = new SubstreamLoopStorage(this.storage).loop();
    if (!delivered || !turn || turn.attentionOrdinal === null
      || turn.attentionOrdinal !== delivered.delivered_attention_ordinal || !loop) {
      throw new Error("substream_loop_activation_replay_incomplete");
    }
    return {
      outcome: "reused",
      transitions: [],
      turns: [turn],
      removedInputIds: [delivered.input_id],
      deliveryEffects: [],
      loop,
      receiptRunId: input.receipt.runId,
    };
  }

  private promotePendingInputInTransaction(
    pending: PendingLoopInputRow,
    prepared: ParsedPendingInputMaterial,
    now: number,
  ): {
    transcriptSequence: number;
    attentionOrdinal: number;
    deliveryEffect: PendingInputDeliveryEffectInput;
  } {
    this.insertPendingPayload(pending);
    this.insertPendingFact(pending, prepared.provenance);
    const transcriptSequence = this.allocateTranscriptSequence(now);
    const attentionOrdinal = this.nextAttentionOrdinal();
    const participantOutcome = this.applyPendingParticipantAuthority(
      pending,
      prepared,
      attentionOrdinal,
      now,
    );
    this.sql.exec(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
          author_name_snapshot, author_avatar_url_snapshot, client_message_id,
          external_actor_json, message_type, root_fact_id, activity_id,
          attention_ordinal, revision, created_at, updated_at)
       VALUES (?, ?, 'conversation', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?)`,
      transcriptSequence,
      pending.prepared_turn_id,
      pending.actor,
      pending.author_user_id,
      pending.author_name_snapshot,
      pending.author_avatar_url_snapshot,
      pending.client_message_id,
      pending.external_actor_json,
      pending.message_type,
      pending.prepared_fact_id,
      attentionOrdinal,
      pending.created_at,
      now,
    );
    this.sql.exec(
      `INSERT INTO participant_transcript_blocks
         (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
       VALUES (?, ?, 0, 'text', ?, 1, ?)`,
      pending.prepared_turn_id,
      `${pending.prepared_turn_id}:text:0`,
      pending.prepared_fact_id,
      now,
    );
    this.insertPendingAttachments(pending.prepared_turn_id, prepared.attachments);
    this.insertPendingMentions(
      pending.prepared_turn_id,
      attentionOrdinal,
      prepared.mentions,
      now,
    );
    const advanced = this.sql.exec<{
      next_attention_ordinal: number;
    } & Record<string, SqlStorageValue>>(
      `UPDATE workstream
          SET next_sequence_number = next_sequence_number + 1,
              next_attention_ordinal = next_attention_ordinal + 1,
              last_people_activity_at = ?, updated_at = ?
        WHERE id = 1 AND next_attention_ordinal = ?
        RETURNING next_attention_ordinal`,
      now,
      now,
      attentionOrdinal,
    ).toArray()[0];
    if (advanced?.next_attention_ordinal !== attentionOrdinal + 1) {
      throw new Error("pending_input_attention_changed");
    }
    const mentionedUserIds = [...new Set(prepared.mentions.flatMap((mention) =>
      mention.mentionKind === "person" && mention.targetUserId ? [mention.targetUserId] : []))];
    const eligibleParticipantIds = new Set(participantOutcome.eligibleParticipantUserIds);
    const activeMentionedParticipantIds = new Set(mentionedUserIds.length === 0 ? [] : this.sql.exec<{
      user_id: string;
    } & Record<string, SqlStorageValue>>(
      `SELECT user_id FROM participants
        WHERE status = 'active'
          AND user_id IN (${mentionedUserIds.map(() => "?").join(", ")})`,
      ...mentionedUserIds,
    ).toArray().map((row) => row.user_id));
    const workstreamIsWorkspaceScoped = mentionedUserIds.length > 0
      && this.sql.exec<{ scope: "personal" | "workspace" } & Record<string, SqlStorageValue>>(
        "SELECT scope FROM workstream WHERE id = 1",
      ).one().scope === "workspace";
    // The canonical mention records what the sender submitted. Regional
    // notification delivery rechecks current workspace membership. Workspace
    // scope itself grants access without seating the recipient; personal scope
    // still requires active participation when delivery commits.
    const deliveredMentionedUserIds = workstreamIsWorkspaceScoped
      ? mentionedUserIds
      : mentionedUserIds.filter((userId) => activeMentionedParticipantIds.has(userId));
    const deliveredConfirmedParticipantUserIds = prepared.authorization.confirmedParticipantUserIds
      .filter((userId) => eligibleParticipantIds.has(userId));
    const deliveredAuthorUserId = pending.author_user_id === null
      || eligibleParticipantIds.has(pending.author_user_id)
      ? pending.author_user_id : null;
    enqueueSemanticRealtimeReference(
      this.sql,
      { kind: "transcript_turn", turnId: pending.prepared_turn_id },
      now,
    );
    enqueueSemanticRealtimeReference(
      this.sql,
      { kind: "loop_input_removed", inputId: pending.input_id, outcome: "delivered" },
      now,
    );
    return {
      transcriptSequence,
      attentionOrdinal,
      deliveryEffect: {
        inputId: pending.input_id,
        attachmentResourceIds: prepared.attachments.map((attachment) => attachment.resourceId),
        turnId: pending.prepared_turn_id,
        transcriptSequence,
        attentionOrdinal,
        actor: pending.actor,
        authorUserId: pending.author_user_id,
        authorNameSnapshot: pending.author_name_snapshot,
        text: prepared.payload.content,
        mentionedUserIds: deliveredMentionedUserIds,
        confirmedParticipantUserIds: deliveredConfirmedParticipantUserIds,
        affectedUserIds: [...new Set([
          ...(deliveredAuthorUserId ? [deliveredAuthorUserId] : []),
          ...deliveredMentionedUserIds,
          ...deliveredConfirmedParticipantUserIds,
        ])],
        activatedParticipants: participantOutcome.activatedParticipants,
      },
    };
  }

  private applyPendingParticipantAuthority(
    pending: PendingLoopInputRow,
    prepared: ParsedPendingInputMaterial,
    attentionOrdinal: number,
    now: number,
  ): {
    activatedParticipants: Array<{ userId: string; participantEpoch: number }>;
    eligibleParticipantUserIds: string[];
  } {
    if (pending.actor !== "human" || pending.author_user_id === null) {
      return { activatedParticipants: [], eligibleParticipantUserIds: [] };
    }
    const authorUserId = pending.author_user_id;
    const root = this.sql.exec<{
      unread_tracking_start_ordinal: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT unread_tracking_start_ordinal FROM workstream WHERE id = 1`,
    ).one();
    const confirmedAtAdmission = prepared.authorization.confirmedParticipantUserIds
      .filter((userId) => userId !== authorUserId);
    const admittedParticipantUserIds = [authorUserId, ...confirmedAtAdmission];
    const previous = new Map(admittedParticipantUserIds.map((userId) => {
      const row = this.sql.exec<{
        status: string; participant_epoch: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT status, participant_epoch FROM participants WHERE user_id = ?`,
        userId,
      ).toArray()[0];
      return [userId, row] as const;
    }));
    // Admission freezes the one command's execution context, but it must not
    // undo a later participant removal. Epoch equality distinguishes a row
    // that is still the admission-time identity from one explicitly revoked or
    // re-added while the input waited for a safe boundary.
    const participantUserIds = admittedParticipantUserIds.filter((userId) => {
      const expectedEpoch = prepared.authorization.participantEpochs[userId];
      const currentEpoch = previous.get(userId)?.participant_epoch ?? null;
      return currentEpoch === expectedEpoch;
    });
    const confirmed = participantUserIds.filter((userId) => userId !== authorUserId);
    if (participantUserIds.includes(authorUserId) && previous.get(authorUserId)?.status === "active") {
      // Opening metadata is local; an already active participant must not be
      // re-granted by message delivery after its roster authority has moved.
      this.sql.exec(`UPDATE participants SET first_opened_at = COALESCE(first_opened_at, ?), updated_at = ?
        WHERE user_id = ? AND status = 'active'`,now,now,authorUserId);
    } else if (participantUserIds.includes(authorUserId)) this.sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, first_opened_at, updated_at)
       VALUES (?, 'message', ?, 'active', 0, ?, NULL, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         status = 'active', removed_at = NULL,
         participant_epoch = CASE WHEN participants.status = 'removed'
           THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
         participation_reason = CASE WHEN participants.status = 'removed'
           THEN 'message' ELSE participants.participation_reason END,
         added_by_user_id = CASE WHEN participants.status = 'removed'
           THEN excluded.added_by_user_id ELSE participants.added_by_user_id END,
         added_at = CASE WHEN participants.status = 'removed'
           THEN excluded.added_at ELSE participants.added_at END,
         first_opened_at = COALESCE(participants.first_opened_at, excluded.first_opened_at),
         updated_at = excluded.updated_at`,
      pending.author_user_id,
      pending.author_user_id,
      now,
      now,
      now,
    );
    for (const userId of confirmed) {
      if (previous.get(userId)?.status === "active") continue;
      this.sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, NULL, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           status = 'active', removed_at = NULL,
           participant_epoch = CASE WHEN participants.status = 'removed'
             THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
           participation_reason = CASE WHEN participants.status = 'removed'
             THEN 'explicit' ELSE participants.participation_reason END,
           added_by_user_id = CASE WHEN participants.status = 'removed'
             THEN excluded.added_by_user_id ELSE participants.added_by_user_id END,
           added_at = CASE WHEN participants.status = 'removed'
             THEN excluded.added_at ELSE participants.added_at END,
           first_opened_at = CASE WHEN participants.status = 'removed'
             THEN NULL ELSE participants.first_opened_at END,
           updated_at = excluded.updated_at`,
        userId,
        pending.author_user_id,
        now,
        now,
      );
      startReadCursorAtLatest(this.sql, userId, now, false);
    }
    if (participantUserIds.includes(authorUserId)) this.sql.exec(
      `INSERT INTO member_attention
         (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
          manual_unread_from_ordinal, latest_mention_attention_ordinal,
          last_seen_at, version, updated_at)
       VALUES (?, ?, ?, NULL, 0, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         seen_attention_ordinal = MAX(
           member_attention.seen_attention_ordinal,
           excluded.seen_attention_ordinal
         ),
         manual_unread_from_ordinal = NULL,
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at`,
      pending.author_user_id,
      root.unread_tracking_start_ordinal,
      attentionOrdinal,
      now,
      now,
    );
    const activatedParticipants = participantUserIds.flatMap((userId) => {
      const before = previous.get(userId);
      if (before?.status === "active") return [];
      const after = this.sql.exec<{
        participant_epoch: number;
      } & Record<string, SqlStorageValue>>(
        `SELECT participant_epoch FROM participants WHERE user_id = ? AND status = 'active'`,
        userId,
      ).one();
      return [{ userId, participantEpoch: Number(after.participant_epoch) }];
    });
    return { activatedParticipants, eligibleParticipantUserIds: participantUserIds };
  }

  private insertPendingPayload(pending: PendingLoopInputRow): void {
    this.sql.exec(
      `INSERT INTO transcript_payloads
         (payload_id, audience, media_type, payload_json, payload_sha256,
          byte_length, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      pending.prepared_payload_id,
      pending.prepared_payload_audience,
      pending.prepared_payload_media_type,
      pending.prepared_payload_json,
      pending.prepared_payload_sha256,
      pending.prepared_payload_byte_length,
      pending.created_at,
    );
    const stored = this.sql.exec<{
      audience: string; media_type: string; payload_json: string;
      payload_sha256: string; byte_length: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT audience, media_type, payload_json, payload_sha256, byte_length
         FROM transcript_payloads WHERE payload_id = ?`,
      pending.prepared_payload_id,
    ).toArray()[0];
    if (!stored || stored.audience !== pending.prepared_payload_audience
      || stored.media_type !== pending.prepared_payload_media_type
      || stored.payload_json !== pending.prepared_payload_json
      || stored.payload_sha256 !== pending.prepared_payload_sha256
      || Number(stored.byte_length) !== pending.prepared_payload_byte_length) {
      throw new Error("pending_input_payload_conflict");
    }
  }

  private insertPendingFact(
    pending: PendingLoopInputRow,
    provenance: PendingInputProvenance,
  ): void {
    this.sql.exec(
      `INSERT INTO transcript_facts
         (fact_id, fact_kind, payload_id, origin_kind, source_kind, source_id,
          source_revision, run_id, turn_id, tool_call_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_id) DO NOTHING`,
      pending.prepared_fact_id,
      provenance.factKind,
      pending.prepared_payload_id,
      provenance.originKind,
      provenance.sourceKind,
      provenance.sourceId,
      provenance.sourceRevision,
      provenance.runId,
      pending.prepared_turn_id,
      provenance.toolCallId,
      pending.created_at,
    );
    const stored = this.sql.exec<{
      fact_kind: string; payload_id: string; origin_kind: string;
      source_kind: string | null; source_id: string | null;
      source_revision: number | null; run_id: string | null;
      turn_id: string | null; tool_call_id: string | null;
    } & Record<string, SqlStorageValue>>(
      `SELECT fact_kind, payload_id, origin_kind, source_kind, source_id,
              source_revision, run_id, turn_id, tool_call_id
         FROM transcript_facts WHERE fact_id = ?`,
      pending.prepared_fact_id,
    ).toArray()[0];
    if (!stored || stored.fact_kind !== provenance.factKind
      || stored.payload_id !== pending.prepared_payload_id
      || stored.origin_kind !== provenance.originKind
      || stored.source_kind !== provenance.sourceKind
      || stored.source_id !== provenance.sourceId
      || stored.source_revision !== provenance.sourceRevision
      || stored.run_id !== provenance.runId
      || stored.turn_id !== pending.prepared_turn_id
      || stored.tool_call_id !== provenance.toolCallId) {
      throw new Error("pending_input_fact_conflict");
    }
  }

  private insertPendingAttachments(
    turnId: string,
    attachments: readonly PendingInputAttachmentDescriptor[],
  ): void {
    for (const attachment of attachments) {
      this.sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource_id) DO NOTHING`,
        attachment.resourceId,
        attachment.attachedByUserId,
        attachment.watchEnabled ? 1 : 0,
        attachment.relationshipType,
        attachment.resourceJson,
        attachment.attachedAt,
        attachment.updatedAt,
      );
      this.sql.exec(
        `INSERT INTO participant_transcript_attachments
           (turn_id, resource_id, position, attachment_json)
         VALUES (?, ?, ?, ?)`,
        turnId,
        attachment.resourceId,
        attachment.position,
        attachment.attachmentJson,
      );
    }
  }

  private insertPendingMentions(
    turnId: string,
    attentionOrdinal: number,
    mentions: readonly PendingInputMentionDescriptor[],
    now: number,
  ): void {
    const root = this.sql.exec<{
      unread_tracking_start_ordinal: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT unread_tracking_start_ordinal FROM workstream WHERE id = 1`,
    ).one();
    for (const mention of mentions) {
      this.sql.exec(
        `INSERT INTO participant_transcript_mentions
           (turn_id, mention_index, mention_kind, target_user_id, connector_type,
            start_offset, end_offset, attention_ordinal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        turnId,
        mention.mentionIndex,
        mention.mentionKind,
        mention.targetUserId,
        mention.connectorType,
        mention.startOffset,
        mention.endOffset,
        attentionOrdinal,
      );
      if (mention.mentionKind === "person" && mention.targetUserId !== null) {
        this.sql.exec(
          `INSERT INTO member_attention
             (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
              manual_unread_from_ordinal, latest_mention_attention_ordinal,
              last_seen_at, version, updated_at)
           VALUES (?, ?, ?, NULL, ?, ?, 0, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             latest_mention_attention_ordinal = MAX(
               member_attention.latest_mention_attention_ordinal,
               excluded.latest_mention_attention_ordinal
             ), updated_at = excluded.updated_at`,
          mention.targetUserId,
          root.unread_tracking_start_ordinal,
          root.unread_tracking_start_ordinal,
          attentionOrdinal,
          now,
          now,
        );
      }
    }
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
        transition.recoverySource === "not_run" ? "tool_recovery_not_run" : "tool_receipt",
        `${transition.turnId}:tool:${transition.callIndex}`,
        transition.callIndex,
      );
    }
    if (transition.kind === "protocol_user_appended") {
      return transition.provenance;
    }
    if (transition.kind === "state_replaced") return protocolOrigin();
    throw new Error("bind_loop_message_origin_unavailable");
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

  private nextAttentionOrdinal(): number {
    return Number(this.sql.exec<{
      next_attention_ordinal: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT next_attention_ordinal FROM workstream WHERE id = 1`,
    ).one().next_attention_ordinal);
  }

  private advanceAttention(now: number): void {
    this.sql.exec(
      `UPDATE workstream
          SET next_attention_ordinal = next_attention_ordinal + 1,
              last_people_activity_at = ?, updated_at = ?
        WHERE id = 1`,
      now,
      now,
    );
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
  const prepared = await prepareCanonicalTranscriptFact(fact);
  return {
    ...fact,
    canonical: prepared.canonical,
    hash: prepared.hash,
    payloadId: prepared.payloadId,
  };
}

export function insertPreparedTranscriptFact(
  sql: SqlStorage,
  fact: PreparedTranscriptFact,
  now: number,
): void {
  insertPreparedCanonicalTranscriptFact(sql, {
    canonical: fact.canonical,
    hash: fact.hash,
    payloadId: fact.payloadId,
    material: fact,
  }, now);
}

export async function prepareConversationTurn(
  input: ConversationTurnInput,
): Promise<PreparedConversationTurn> {
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
      text: typeof payload.content === "string" ? payload.content : "",
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
      messageType: isParticipantMessageType(row.message_type)
        ? row.message_type
        : "text",
      structuredContent: payload.structuredContent !== null
        && typeof payload.structuredContent === "object"
        && !Array.isArray(payload.structuredContent)
        ? payload.structuredContent as Record<string, unknown>
        : null,
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
  const structuredContent = payload.structuredContent;
  const structured = structuredContent && typeof structuredContent === "object"
    ? structuredContent as Record<string, unknown>
    : null;
  const legacyInvocation = structured?.invocation && typeof structured.invocation === "object"
    ? structured.invocation as Record<string, unknown>
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
      : toolInvocationError(legacyInvocation),
    activityId: row.activity_id,
  };
}

interface ParsedPendingInputMaterial {
  payload: BindLoopMessage & {
    role: "user" | "system";
    content: string;
    structuredContent: Record<string, unknown> | null;
  };
  bindPayload: BindLoopMessage & { role: "user"; content: unknown };
  provenance: PendingInputProvenance;
  authorization: {
    confirmedParticipantUserIds: string[];
    participantEpochs: Record<string, number | null>;
    elicitationId: string | null;
  };
  attachments: PendingInputAttachmentDescriptor[];
  mentions: PendingInputMentionDescriptor[];
}

function samePendingInput(left: PendingLoopInputRow, right: PendingLoopInputRow): boolean {
  return left.input_id === right.input_id
    && left.input_sequence === right.input_sequence
    && left.updated_at === right.updated_at;
}

function sameOrderedInputPrefix(
  captured: readonly PendingLoopInputRow[],
  current: readonly PendingLoopInputRow[],
): boolean {
  return current.length >= captured.length
    && captured.every((pending, index) => {
      const currentPending = current[index];
      return currentPending !== undefined && samePendingInput(pending, currentPending);
    });
}

function invokeSynchronousEffectEnqueue(
  enqueue: ((deliveries: readonly PendingInputDeliveryEffectInput[]) => void) | undefined,
  deliveries: readonly PendingInputDeliveryEffectInput[],
): void {
  if (!enqueue) return;
  const returned = enqueue(deliveries) as unknown;
  if (returned && (typeof returned === "object" || typeof returned === "function")
    && "then" in returned) {
    throw new Error("pending_input_effect_enqueue_must_be_synchronous");
  }
}

function parsePendingInputMaterial(pending: PendingLoopInputRow): ParsedPendingInputMaterial {
  const payload = requiredRecord(pending.prepared_payload_json, "pending_input_payload_invalid");
  const expectedRole = pending.actor === "system" ? "system" : "user";
  if (payload.role !== expectedRole || typeof payload.content !== "string"
    || (payload.structuredContent !== null
      && (typeof payload.structuredContent !== "object"
        || Array.isArray(payload.structuredContent)))) {
    throw new Error("pending_input_payload_invalid");
  }
  const content = payload.content;
  const bindPayload = requiredRecord(
    pending.bind_payload_json,
    "pending_input_bind_payload_invalid",
  );
  if (bindPayload.role !== "user" || !("content" in bindPayload)
    || canonicalJson(bindPayload) !== pending.bind_payload_json
    || "structuredContent" in bindPayload) {
    throw new Error("pending_input_bind_payload_invalid");
  }
  if (pending.prepared_payload_audience !== "shared"
    || pending.prepared_payload_media_type !== "application/json"
    || canonicalJson(payload) !== pending.prepared_payload_json
    || new TextEncoder().encode(pending.prepared_payload_json).byteLength
      !== pending.prepared_payload_byte_length) {
    throw new Error("pending_input_payload_descriptor_mismatch");
  }
  if (!isParticipantMessageType(pending.message_type) || pending.message_type === "suggestion") {
    throw new Error("pending_input_message_type_invalid");
  }
  if (pending.actor === "human") {
    if (pending.author_user_id === null || pending.author_name_snapshot === null
      || pending.external_actor_json !== null) {
      throw new Error("pending_input_human_provenance_invalid");
    }
  } else if (pending.author_user_id !== null || pending.author_name_snapshot !== null
    || pending.author_avatar_url_snapshot !== null) {
    throw new Error("pending_input_nonhuman_author_invalid");
  }
  const externalActor = parseExternalActor(pending.external_actor_json);
  if ((pending.actor === "external") !== (externalActor !== null)
    || (pending.actor !== "external" && pending.external_actor_json !== null)) {
    throw new Error("pending_input_external_actor_invalid");
  }
  const provenanceRecord = requiredRecord(
    pending.provenance_json,
    "pending_input_fact_provenance_invalid",
  );
  const originKind = provenanceRecord.originKind;
  if (originKind !== "canonical" && originKind !== "protocol"
    && originKind !== "derived" && originKind !== "system_projection") {
    throw new Error("pending_input_fact_provenance_invalid");
  }
  const sourceKind = nullableString(provenanceRecord.sourceKind);
  const sourceId = nullableString(provenanceRecord.sourceId);
  const sourceRevision = nullableNonnegativeInteger(provenanceRecord.sourceRevision);
  if ((sourceKind === null) !== (sourceId === null)
    || (sourceId === null && sourceRevision !== null)
    || ((originKind === "canonical" || originKind === "protocol") && sourceId !== null)
    || ((originKind === "derived" || originKind === "system_projection") && sourceId === null)) {
    throw new Error("pending_input_fact_provenance_invalid");
  }
  if (typeof provenanceRecord.factKind !== "string" || provenanceRecord.factKind.length === 0) {
    throw new Error("pending_input_fact_provenance_invalid");
  }
  const authorization = requiredRecord(
    pending.authorization_json,
    "pending_input_authorization_invalid",
  );
  const rawConfirmedParticipantUserIds = authorization.confirmedParticipantUserIds ?? [];
  if (!Array.isArray(rawConfirmedParticipantUserIds)
    || rawConfirmedParticipantUserIds.some((userId) =>
      typeof userId !== "string" || userId.length === 0)
    || new Set(rawConfirmedParticipantUserIds).size
      !== rawConfirmedParticipantUserIds.length) {
    throw new Error("pending_input_authorization_invalid");
  }
  const confirmedParticipantUserIds = rawConfirmedParticipantUserIds as string[];
  const elicitationId = nullableString(authorization.elicitationId);
  if (authorization.elicitationId !== undefined && elicitationId === null) {
    throw new Error("pending_input_authorization_invalid");
  }
  const rawParticipantEpochs = authorization.participantEpochs;
  const participantEpochs = rawParticipantEpochs
    && typeof rawParticipantEpochs === "object" && !Array.isArray(rawParticipantEpochs)
    ? rawParticipantEpochs as Record<string, unknown>
    : {};
  if (pending.actor === "human") {
    const principal = authorization.executionPrincipal;
    if (!principal || typeof principal !== "object" || Array.isArray(principal)
      || (principal as Record<string, unknown>).type !== "user"
      || (principal as Record<string, unknown>).userId !== pending.author_user_id) {
      throw new Error("pending_input_authorization_invalid");
    }
    const expectedParticipantIds = new Set([
      pending.author_user_id,
      ...confirmedParticipantUserIds,
    ]);
    if (Object.keys(participantEpochs).length !== expectedParticipantIds.size
      || Object.entries(participantEpochs).some(([userId, epoch]) =>
        !expectedParticipantIds.has(userId)
        || (epoch !== null && (!Number.isSafeInteger(epoch) || Number(epoch) < 0)))) {
      throw new Error("pending_input_authorization_invalid");
    }
  } else if (confirmedParticipantUserIds.length > 0) {
    throw new Error("pending_input_authorization_invalid");
  }
  const attachments = parsePendingAttachments(pending.attachments_json);
  const mentions = parsePendingMentions(pending.mentions_json);
  if (mentions.some((mention) => mention.endOffset > content.length)) {
    throw new Error("pending_input_mentions_invalid");
  }
  return {
    payload: payload as ParsedPendingInputMaterial["payload"],
    bindPayload: bindPayload as ParsedPendingInputMaterial["bindPayload"],
    provenance: {
      factKind: provenanceRecord.factKind,
      originKind,
      sourceKind,
      sourceId,
      sourceRevision,
      runId: nullableString(provenanceRecord.runId),
      toolCallId: nullableString(provenanceRecord.toolCallId),
    },
    authorization: {
      confirmedParticipantUserIds,
      participantEpochs: Object.fromEntries(Object.entries(participantEpochs)
        .map(([userId, epoch]) => [userId, epoch === null ? null : Number(epoch)])),
      elicitationId,
    },
    attachments,
    mentions,
  };
}

function parsePendingAttachments(value: string): PendingInputAttachmentDescriptor[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("pending_input_attachments_invalid");
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("pending_input_attachments_invalid");
    }
    const row = candidate as Record<string, unknown>;
    if (typeof row.resourceId !== "string" || row.resourceId.length === 0
      || row.position !== index || typeof row.attachmentJson !== "string"
      || (row.attachedByUserId !== null && typeof row.attachedByUserId !== "string")
      || typeof row.watchEnabled !== "boolean"
      || typeof row.relationshipType !== "string" || row.relationshipType.length === 0
      || typeof row.resourceJson !== "string"
      || !Number.isSafeInteger(row.attachedAt) || Number(row.attachedAt) < 0
      || !Number.isSafeInteger(row.updatedAt) || Number(row.updatedAt) < Number(row.attachedAt)) {
      throw new Error("pending_input_attachments_invalid");
    }
    requiredRecord(row.attachmentJson, "pending_input_attachments_invalid");
    requiredRecord(row.resourceJson, "pending_input_attachments_invalid");
    return {
      resourceId: row.resourceId,
      position: index,
      attachmentJson: row.attachmentJson,
      attachedByUserId: row.attachedByUserId as string | null,
      watchEnabled: row.watchEnabled,
      relationshipType: row.relationshipType,
      resourceJson: row.resourceJson,
      attachedAt: Number(row.attachedAt),
      updatedAt: Number(row.updatedAt),
    };
  });
}

function parsePendingMentions(value: string): PendingInputMentionDescriptor[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("pending_input_mentions_invalid");
  return parsed.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("pending_input_mentions_invalid");
    }
    const row = candidate as Record<string, unknown>;
    const kind = row.mentionKind;
    const person = kind === "person" && typeof row.targetUserId === "string"
      && row.connectorType === null;
    const connector = kind === "connector" && row.targetUserId === null
      && typeof row.connectorType === "string";
    if (row.mentionIndex !== index || (!person && !connector)
      || !Number.isSafeInteger(row.startOffset) || Number(row.startOffset) < 0
      || !Number.isSafeInteger(row.endOffset)
      || Number(row.endOffset) <= Number(row.startOffset)) {
      throw new Error("pending_input_mentions_invalid");
    }
    return {
      mentionIndex: index,
      mentionKind: kind,
      targetUserId: row.targetUserId as string | null,
      connectorType: row.connectorType as string | null,
      startOffset: Number(row.startOffset),
      endOffset: Number(row.endOffset),
    };
  });
}

function pendingAttachmentForSnapshot(
  attachment: PendingInputAttachmentDescriptor,
): NonNullable<PendingTranscriptInput["block"]["attachments"]>[number] {
  const resource = requiredRecord(attachment.resourceJson, "pending_input_attachment_resource_invalid");
  const metadata = resource.metadata && typeof resource.metadata === "object"
    && !Array.isArray(resource.metadata)
    ? resource.metadata as Record<string, unknown>
    : {};
  const attached = requiredRecord(attachment.attachmentJson, "pending_input_attachment_invalid");
  const size = Number(metadata.size ?? 0);
  const createdAt = typeof attached.attachedAt === "string"
    && Number.isFinite(Date.parse(attached.attachedAt))
    ? attached.attachedAt
    : new Date(attachment.attachedAt).toISOString();
  return {
    id: attachment.resourceId,
    fileName: truncateUtf16Safe(
      typeof resource.title === "string" ? resource.title : attachment.resourceId,
      300,
    ),
    mimeType: truncateUtf16Safe(
      typeof resource.mimeType === "string" && resource.mimeType.length > 0
        ? resource.mimeType
        : "application/octet-stream",
      160,
    ),
    sizeBytes: Number.isFinite(size) ? Math.max(0, Math.trunc(size)) : 0,
    contentAvailable: typeof resource.contentRef === "string",
    createdAt,
  };
}

function requiredRecord(value: string, code: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(code);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(code);
  return parsed as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("pending_input_fact_provenance_invalid");
  return value;
}

function nullableNonnegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error("pending_input_fact_provenance_invalid");
  }
  return Number(value);
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

function isParticipantMessageType(
  value: string | null,
): value is "text" | "system" | "elicitation" | "suggestion" | "automation_activation" {
  return value === "text"
    || value === "system"
    || value === "elicitation"
    || value === "suggestion"
    || value === "automation_activation";
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
  return status === "completed" || status === "failed" || status === "ambiguous" || status === "cancelled";
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
      || (left.activityId < right.activityId ? -1 : left.activityId > right.activityId ? 1 : 0));
    for (const activity of siblings) {
      ordered.push(activity);
      visit(activity.activityId);
    }
  };
  visit(null);
  return ordered;
}

function canonicalJson(value: unknown): string {
  return canonicalTranscriptJson(value);
}

function bindProvenanceKey(provenance: BindLoopMessageOrigin): string {
  return canonicalJson([
    provenance.originKind,
    provenance.sourceKind,
    provenance.sourceId,
    provenance.sourceRevision,
  ]);
}

function modelRoleForAuthor(
  authorType: ConversationTurnInput["authorType"],
): NonNullable<ConversationTurnInput["role"]> {
  if (authorType === "agent") return "assistant";
  if (authorType === "system") return "system";
  return "user";
}

function toolInvocationError(invocation: Record<string, unknown> | null): string | null {
  if (!invocation?.error || typeof invocation.error !== "object") return null;
  const message = (invocation.error as Record<string, unknown>).message;
  return typeof message === "string" ? message : null;
}
