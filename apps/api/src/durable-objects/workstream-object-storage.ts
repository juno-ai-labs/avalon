import type { Region } from "@rally/contracts/regions";
import { ConversationParentKindSchema, type ConversationParentKind } from "@rally/contracts/conversation-parent";
import { z } from "zod";
import {
  AgentCompactionStateSchema,
  InferenceDelayStateSchema,
  type InferenceDelayState,
  ActiveStreamCheckpointsSchema,
  ServerSocketEventSchema,
  asWorkspaceId,
  type AgentCompactionState,
  type ActiveStreamCheckpoint,
  type ServerSocketEvent,
  type WorkspaceId,
} from "@rally/contracts";

import { ApiError } from "../lib/api-error";
import { uuidV7 } from "../lib/uuid-v7";
import { applyWorkstreamObjectSchema } from "./workstream-object-schema";
import {
  ConversationEffectEnvelopeSchema,
  ConversationEffectSchema,
  conversationEffectHash,
  isPersonNotificationEffect,
  type ConversationEffect,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import {
  acknowledgeSemanticRealtimeReference,
  deferSemanticRealtimeReference,
  dueSemanticRealtimeReferences,
  nextSemanticRealtimeDueAt,
  type SequencedSemanticRealtimeReference,
} from "./workstream-semantic-realtime-outbox";

const ACTIVE_OUTPUT_CHUNK_MAX_BYTES = 60 * 1024;
const SOCKET_TICKET_RECEIPT_RETENTION_MS = 5 * 60_000;
const REGIONAL_EFFECT_CHANNEL = "regional_effect_v1";

interface RealtimeStateRow extends Record<string, SqlStorageValue> {
  event_sequence: number;
}

interface ActiveOutputRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_epoch: number;
  turn_id: string;
  transcript_sequence: number;
  stream_id: string;
  seen_turn_ids_json: string;
  turn_start_offset: number;
  durable_event_seq: number;
  durable_through_frame_seq: number;
  started_at: number;
}

interface ActiveOutputChunkRow extends Record<string, SqlStorageValue> {
  text: string;
}

interface ActiveCompactionRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_id: string;
  compaction_index: number;
  trigger: "manual" | "auto";
  started_at: number;
}

interface RegionalEffectOutboxRow extends Record<string, SqlStorageValue> {
  message_id: string;
  payload_json: string;
  payload_hash: string;
  attempts: number;
}

interface ProjectionKeyRow extends Record<string, SqlStorageValue> {
  next_version: number;
  last_payload_hash: string;
  last_enqueued_message_id: string;
}

interface AuthorityRow extends Record<string, SqlStorageValue> {
  workstream_key: string;
  parent_workspace_key: string;
  parent_kind: ConversationParentKind;
  region: Region;
  authority_mode: string;
  authority_generation: number;
}

export interface RegionalEffectCommand {
  partitionKey: string;
  effect: ConversationEffect;
  /** Required for immutable activity/notification effects. */
  sourceVersion?: number;
  /** Stable across retries; required for immutable activity/notification effects. */
  dedupeKey?: string;
  /** The user projection that must be visible before a mention can be delivered. */
  dependsOnProjectionKey?: string;
}

/** The parents a conversation object is hosted under. */
export const HostedConversationParentKindSchema = z.enum(["automation", "canvas"]);
export type HostedConversationParentKind = z.infer<typeof HostedConversationParentKindSchema>;

/** A stored parent kind, refusing the retired Thread and Space kinds by name. */
export function hostedConversationParentKind(stored: string): HostedConversationParentKind {
  const kind = ConversationParentKindSchema.parse(stored);
  if (kind === "workstream" || kind === "space") {
    // The message is the code with the kind: a Durable Object RPC hop keeps
    // only the message, and the kind is what an operator needs.
    throw new ApiError(409, "conversation_parent_kind_retired", `conversation_parent_kind_retired:${kind}`,
      undefined, `conversation_parent_kind_retired:${kind}`);
  }
  return kind;
}

/**
 * What this conversation object is: the workspace it lives in and the parent
 * it belongs to. `parentId` is stored in the root row's `workstream_key`
 * column (the name predates typed parents and is held by released migration
 * text); `parentKind` says whether that id names a work stream, an automation,
 * or a Space. Only a Sidekick (`automation`) or a Canvas is hosted now; a
 * stored `workstream` or `space` names a conversation whose parent was retired
 * (plan step B-7), and reading it is refused with
 * `conversation_parent_kind_retired:<kind>` rather than served as a parent
 * that no longer exists.
 */
export interface WorkstreamObjectIdentity {
  workspaceId: WorkspaceId;
  parentKind: HostedConversationParentKind;
  parentId: string;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function eventCanChangeActiveStreamCheckpoint(event: ServerSocketEvent): boolean {
  return event.type === "stream_started"
    || event.type === "stream_delta"
    || event.type === "stream_completed"
    || (event.type === "harness_status_changed"
      && (event.status === "needs_input"
        || event.status === "completed"
        || event.status === "failed"
        || event.status === "stopped"
        || event.status === "idle"));
}

/** Split by encoded bytes without ending on half of a UTF-16 surrogate pair. */
export function splitActiveStreamCheckpointText(text: string): string[] {
  if (text.length === 0) return [""];
  const chunks: string[] = [];
  let chunkStart = 0;
  let chunkBytes = 0;
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const codeUnits = codePoint > 0xFFFF ? 2 : 1;
    const encodedBytes = codePoint <= 0x7F
      ? 1
      : codePoint <= 0x7FF
        ? 2
        : codePoint <= 0xFFFF
          ? 3
          : 4;
    if (chunkBytes + encodedBytes > ACTIVE_OUTPUT_CHUNK_MAX_BYTES && index > chunkStart) {
      chunks.push(text.slice(chunkStart, index));
      chunkStart = index;
      chunkBytes = 0;
    }
    chunkBytes += encodedBytes;
    index += codeUnits;
  }
  chunks.push(text.slice(chunkStart));
  return chunks;
}

/** Pure fold shared by live commits, legacy import, and renderer-contract tests. */
export function applyActiveStreamCheckpointEvent(
  checkpoints: ActiveStreamCheckpoint[],
  event: ServerSocketEvent,
): ActiveStreamCheckpoint[] {
  if (event.type === "stream_completed") {
    return checkpoints.filter((checkpoint) => checkpoint.streamId !== event.streamId);
  }
  if (
    event.type === "harness_status_changed"
    && (event.status === "needs_input"
      || event.status === "completed"
      || event.status === "failed"
      || event.status === "stopped"
      || event.status === "idle")
  ) {
    return [];
  }
  if (event.type !== "stream_started" && event.type !== "stream_delta") return checkpoints;

  const activeCheckpoints = event.type === "stream_started"
    ? checkpoints.filter((checkpoint) => checkpoint.harnessRunId === event.harnessRunId)
    : checkpoints;
  const existing = activeCheckpoints.find((checkpoint) => checkpoint.streamId === event.streamId);
  if (event.type === "stream_delta" && !existing) return checkpoints;
  if (existing) {
    if (event.sequence <= existing.roomSequence) return checkpoints;
    if (event.turnId === existing.turnId) {
      if (event.transcriptSequence !== existing.transcriptSequence) {
        throw new Error("active_stream_transcript_reservation_mismatch");
      }
      if (event.epoch < existing.epoch) return checkpoints;
      if (event.epoch === existing.epoch && event.streamSeq <= existing.streamSeq) {
        return checkpoints;
      }
    } else if (existing.seenTurnIds.includes(event.turnId)) {
      return checkpoints;
    }
  }

  const startsNewTurn = !existing || event.turnId !== existing.turnId;
  const turnStartOffset = startsNewTurn ? existing?.text.length ?? 0 : existing.turnStartOffset;
  const replacesAttempt = event.reset
    || (existing !== undefined && !startsNewTurn && event.epoch > existing.epoch);
  const text = event.type === "stream_started"
    ? (replacesAttempt ? (existing?.text ?? "").slice(0, turnStartOffset) : existing?.text ?? "")
    : replacesAttempt
      ? `${(existing?.text ?? "").slice(0, turnStartOffset)}${event.delta}`
      : `${existing?.text ?? ""}${event.delta}`;
  const seenTurnIds = existing?.seenTurnIds.includes(event.turnId)
    ? existing.seenTurnIds
    : [...(existing?.seenTurnIds ?? []), event.turnId];
  const harnessRunId = event.type === "stream_started"
    ? event.harnessRunId
    : existing?.harnessRunId;
  if (!harnessRunId) return checkpoints;
  return [{
    streamId: event.streamId,
    harnessRunId,
    turnId: event.turnId,
    transcriptSequence: event.transcriptSequence,
    epoch: event.epoch,
    streamSeq: event.streamSeq,
    seenTurnIds,
    text,
    turnStartOffset,
    roomSequence: event.sequence,
    createdAt: existing?.createdAt ?? event.occurredAt,
  }];
}

function parseSeenTurnIds(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return z.array(z.string().min(1).max(180)).parse(parsed);
  } catch {
    return [];
  }
}

function readActiveStreamCheckpoints(storage: DurableObjectStorage): ActiveStreamCheckpoint[] {
  const rows = storage.sql.exec<ActiveOutputRow>(
    `SELECT run_id, attempt_epoch, turn_id, transcript_sequence, stream_id, seen_turn_ids_json,
            turn_start_offset, durable_event_seq, durable_through_frame_seq, started_at
       FROM active_output_turns
      ORDER BY started_at, run_id`,
  ).toArray();
  const checkpoints = rows.map((row) => {
    const text = storage.sql.exec<ActiveOutputChunkRow>(
      `SELECT text
         FROM active_output_chunks
        WHERE run_id = ? AND attempt_epoch = ?
        ORDER BY chunk_index`,
      row.run_id,
      row.attempt_epoch,
    ).toArray().map((chunk) => chunk.text).join("");
    return {
      streamId: row.stream_id,
      harnessRunId: row.run_id,
      turnId: row.turn_id,
      transcriptSequence: row.transcript_sequence,
      epoch: row.attempt_epoch,
      streamSeq: row.durable_through_frame_seq,
      seenTurnIds: parseSeenTurnIds(row.seen_turn_ids_json),
      text,
      turnStartOffset: row.turn_start_offset,
      roomSequence: row.durable_event_seq,
      createdAt: new Date(row.started_at).toISOString(),
    };
  });
  const parsed = ActiveStreamCheckpointsSchema.safeParse(checkpoints);
  return parsed.success ? parsed.data : [];
}

function readActiveCompaction(storage: DurableObjectStorage): AgentCompactionState | null {
  const row = first(storage.sql.exec<ActiveCompactionRow>(
    `SELECT run_id, attempt_id, compaction_index, trigger, started_at
       FROM active_agent_compaction WHERE id = 1`,
  ));
  if (!row) return null;
  const startedAt = new Date(row.started_at);
  if (!Number.isFinite(startedAt.getTime())) return null;
  const parsed = AgentCompactionStateSchema.safeParse({
    harnessRunId: row.run_id,
    attemptId: row.attempt_id,
    compactionIndex: row.compaction_index,
    trigger: row.trigger,
    startedAt: startedAt.toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

/** A settled inference keeps a tombstone until its run ends, rejecting late notices. */
function applyInferenceDelayEvent(storage: DurableObjectStorage, event: ServerSocketEvent): ServerSocketEvent {
  if (event.type === "harness_status_changed" && event.status !== "running") {
    storage.sql.exec(`DELETE FROM inference_delay_status`);
  }
  if (event.type !== "inference_delay_changed") return event;
  const owned = first(storage.sql.exec<{ run_id: string }>(
    `SELECT execution.run_id FROM runs execution JOIN runs root ON root.run_id = ?
     WHERE execution.run_id = ? AND execution.legacy_attempt_id = ?
       AND execution.status = 'running' AND root.status = 'running'
       AND root.legacy_attempt_id = ? AND root.lease_expires_at > ?
       AND execution.lease_expires_at > ?
       AND (execution.run_id = root.run_id OR execution.chain_root_run_id = root.run_id)`,
    event.harnessRunId, event.executionId, event.attemptId, event.parentAttemptId ?? event.attemptId, Date.now(), Date.now(),
  ));
  if (!owned) {
    // Settlement can race lease renewal. Clear its own checkpoint even while
    // the lease is expired, so a subsequent renewal cannot restore the notice.
    if (!event.active) storage.sql.exec(
      `UPDATE inference_delay_status SET active = 0
       WHERE inference_request_id = ? AND run_id = ? AND execution_id = ? AND attempt_id = ?`,
      event.inferenceRequestId, event.harnessRunId, event.executionId, event.attemptId,
    );
    return { ...event, active: false };
  }
  storage.sql.exec(
    `INSERT INTO inference_delay_status
       (inference_request_id, run_id, execution_id, root_attempt_id, attempt_id, turn_id, active)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(inference_request_id) DO UPDATE SET active = MIN(inference_delay_status.active, excluded.active)`,
    event.inferenceRequestId, event.harnessRunId, event.executionId, event.parentAttemptId ?? event.attemptId, event.attemptId, event.turnId,
    event.active ? 1 : 0,
  );
  const row = first(storage.sql.exec<{ active: number }>(
    `SELECT active FROM inference_delay_status WHERE inference_request_id = ?`, event.inferenceRequestId,
  ));
  return { ...event, active: row?.active === 1 };
}

function applyActiveCompactionEvent(
  storage: DurableObjectStorage,
  event: ServerSocketEvent,
): void {
  if (event.type === "compaction_started") {
    const owned = first(storage.sql.exec<{ run_id: string }>(
      `SELECT run_id FROM runs
        WHERE run_id = ? AND legacy_attempt_id = ?
          AND status = 'running' AND terminalized_at IS NULL
          AND lease_expires_at > ?`,
      event.compaction.harnessRunId,
      event.compaction.attemptId,
      Date.now(),
    ));
    if (!owned) return;
    const startedAt = Date.parse(event.compaction.startedAt);
    storage.sql.exec(
      `INSERT INTO active_agent_compaction
         (id, run_id, attempt_id, compaction_index, trigger, started_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         run_id = excluded.run_id,
         attempt_id = excluded.attempt_id,
         compaction_index = excluded.compaction_index,
         trigger = excluded.trigger,
         started_at = excluded.started_at,
         updated_at = excluded.updated_at`,
      event.compaction.harnessRunId,
      event.compaction.attemptId,
      event.compaction.compactionIndex,
      event.compaction.trigger,
      startedAt,
      Date.now(),
    );
    return;
  }
  if (event.type === "compaction_finished") {
    // A delayed finish for an earlier checkpoint must not erase a newer one.
    storage.sql.exec(
      `DELETE FROM active_agent_compaction
        WHERE id = 1 AND run_id = ? AND attempt_id = ? AND compaction_index = ?`,
      event.harnessRunId,
      event.attemptId,
      event.compactionIndex,
    );
    return;
  }
  if (
    event.type === "harness_status_changed"
    && (event.status === "needs_input"
      || event.status === "completed"
      || event.status === "failed"
      || event.status === "stopped"
      || event.status === "idle")
  ) {
    storage.sql.exec(`DELETE FROM active_agent_compaction WHERE id = 1`);
  }
}

function writeActiveStreamCheckpoints(
  storage: DurableObjectStorage,
  checkpoints: ActiveStreamCheckpoint[],
): void {
  const sql = storage.sql;
  const desiredRunIds = new Set(checkpoints.map((checkpoint) => checkpoint.harnessRunId));
  const activeRunIds = sql.exec<{ run_id: string }>(
    `SELECT run_id FROM active_output_turns`,
  ).toArray().map((row) => row.run_id);
  const now = Date.now();
  for (const runId of activeRunIds) {
    if (desiredRunIds.has(runId)) continue;
    sql.exec(`DELETE FROM active_output_turns WHERE run_id = ?`, runId);
  }

  for (const checkpoint of checkpoints) {
    const owner = first(sql.exec<{ active_execution_id: string | null }>(
      `SELECT active_execution_id
         FROM substream_loops
        WHERE id = 1 AND status = 'executing'`,
    ));
    if (owner?.active_execution_id !== checkpoint.harnessRunId) {
      throw new Error("active_stream_execution_fence_mismatch");
    }
    const startedAt = Date.parse(checkpoint.createdAt);
    const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : now;
    sql.exec(`DELETE FROM active_output_turns WHERE run_id = ?`, checkpoint.harnessRunId);
    const chunks = splitActiveStreamCheckpointText(checkpoint.text);
    sql.exec(
      `INSERT INTO active_output_turns
         (run_id, attempt_epoch, turn_id, transcript_sequence, substream_id, status, durable_event_seq,
          durable_through_frame_seq, next_chunk_index, stream_id, seen_turn_ids_json,
          turn_start_offset, started_at, checkpointed_at, updated_at)
       VALUES (?, ?, ?, ?, '0', 'streaming', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      checkpoint.harnessRunId,
      checkpoint.epoch,
      checkpoint.turnId,
      checkpoint.transcriptSequence,
      checkpoint.roomSequence,
      checkpoint.streamSeq,
      chunks.length,
      checkpoint.streamId,
      JSON.stringify(checkpoint.seenTurnIds),
      checkpoint.turnStartOffset,
      effectiveStartedAt,
      now,
      now,
    );
    chunks.forEach((text, chunkIndex) => {
      sql.exec(
        `INSERT INTO active_output_chunks
           (run_id, attempt_epoch, chunk_index, text, byte_length, first_frame_seq,
            through_frame_seq, content_hash, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        checkpoint.harnessRunId,
        checkpoint.epoch,
        chunkIndex,
        text,
        new TextEncoder().encode(text).byteLength,
        checkpoint.streamSeq,
        fnv1a64(text),
        now,
      );
    });
  }
}

function insertIdentity(
  storage: DurableObjectStorage,
  identity: WorkstreamObjectIdentity,
  region: Region,
  now: number,
): void {
  const existing = first(storage.sql.exec<{
    workstream_key: string;
    parent_workspace_key: string;
    parent_kind: string;
  }>(
    `SELECT workstream_key, parent_workspace_key, parent_kind FROM workstream WHERE id = 1`,
  ));
  if (existing) {
    if (
      existing.workstream_key !== identity.parentId
      || existing.parent_workspace_key !== identity.workspaceId
      || existing.parent_kind !== identity.parentKind
    ) {
      throw new Error("workstream_object_identity_mismatch");
    }
  } else {
    // The placeholder scope is `personal`, and it is load-bearing rather than
    // cosmetic: the runtime compat insert writes `COALESCE(NEW.scope, scope)`,
    // so a caller that names no scope keeps whatever this row was born with.
    // Born private, a path that forgot to say is readable by its participants
    // and nobody else; born `workspace`, the same omission publishes it to the
    // whole workspace. The paths whose audience really is the workspace — the
    // automation inserts — say so in their own SQL.
    storage.sql.exec(
      `INSERT INTO workstream
         (id, workstream_key, parent_kind, parent_workspace_key, parent_do_id, parent_generation,
          region, authority_mode, title, description, preview, scope, exact_state,
          state_reason_code, next_sequence_number, next_attention_ordinal,
          authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
          deletion_epoch, run_revision, created_at, last_people_activity_at,
          state_changed_at, completed_at, updated_at)
       VALUES (1, ?, ?, ?, NULL, 0, ?, 'preparing', '', '', '', 'personal', 'restoring',
               'awaiting_authoritative_import', 1, 1, 0, 0, 0, 0, 0, 0, ?, ?, ?, NULL, ?)`,
      identity.parentId,
      identity.parentKind,
      identity.workspaceId,
      region,
      now,
      now,
      now,
      now,
    );
  }
  storage.sql.exec(
    `INSERT OR IGNORE INTO substreams
       (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq, depth,
        return_mode, origin_message_id, owner_user_id, audience, tool_policy, status,
        created_at, closed_at)
     VALUES ('0', 'main', 'none', NULL, NULL, 0, 'none', NULL, NULL,
             'workspace', 'full', 'open', ?, NULL)`,
    now,
  );
  storage.sql.exec(
    `INSERT OR IGNORE INTO realtime_state(id, event_sequence, updated_at) VALUES (1, 0, ?)`,
    now,
  );
}

export class WorkstreamObjectStore {
  private readonly ready: Promise<void>;

  constructor(
    private readonly storage: DurableObjectStorage,
    workerVersionId: string,
    _region: Region,
  ) {
    void _region;
    applyWorkstreamObjectSchema(storage, workerVersionId);
    this.ready = Promise.resolve();
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  ensureIdentity(identity: WorkstreamObjectIdentity, region: Region): void {
    this.storage.transactionSync(() => insertIdentity(this.storage, identity, region, Date.now()));
  }

  identity(): WorkstreamObjectIdentity | null {
    const stored = this.identityForRetirement();
    return stored ? { ...stored, parentKind: hostedConversationParentKind(stored.parentKind) } : null;
  }

  /**
   * The stored identity with its parent kind unnarrowed, for the two callers
   * that must reach a conversation whose parent was retired: the operator
   * dump before a Thread is retired (`conversationTranscriptText`) and the
   * constructor, which has to stay constructible so `retireObject` can close
   * it. Everything else reads {@link identity}, which refuses those kinds.
   */
  identityForRetirement(): (Omit<WorkstreamObjectIdentity, "parentKind"> & { parentKind: ConversationParentKind }) | null {
    const row = first(this.storage.sql.exec<{
      workstream_key: string;
      parent_workspace_key: string;
      parent_kind: string;
    }>(
      `SELECT workstream_key, parent_workspace_key, parent_kind FROM workstream WHERE id = 1`,
    ));
    if (!row) return null;
    return {
      parentKind: ConversationParentKindSchema.parse(row.parent_kind),
      parentId: row.workstream_key,
      workspaceId: asWorkspaceId(row.parent_workspace_key),
    };
  }

  databaseSize(): number {
    return this.storage.sql.databaseSize;
  }

  /**
   * Whether this object may still be written through as the work stream's
   * authority.
   *
   * The fence the retired generic SQL endpoint put in front of every routed
   * statement, which the typed object ports have to keep now that they are the
   * path. It was written in two places rather than one, and both count: that
   * function refuses a `preparing` or `quarantined` object outright, and it
   * then ran every batch — directory-affecting or not — through
   * `commitRuntimeMutation`, whose `commitWithRegionalEffects` additionally
   * refuses `authority_generation <= 0`.
   *
   * Reading only `authority_mode` here would restore half of it, and the half
   * left out is the one nothing else covers: the wake-up mutations still reach
   * `commitRuntimeMutation` and so keep the generation check by their own
   * route, while the writes that do not — compaction checkpoints, plugin
   * activation hints, both description-evaluation writes, and the receipt
   * writes beside them — would have had no generation fence at
   * all. `isRealtimeWritable` deliberately admits generation zero; that is
   * room state, and this is not.
   */
  isAuthoritative(): boolean {
    const row = first(this.storage.sql.exec<{
      authority_mode: string; authority_generation: number;
    }>(
      `SELECT authority_mode, authority_generation FROM workstream WHERE id = 1`,
    ));
    return row?.authority_mode === "authoritative" && row.authority_generation > 0;
  }

  /** Legacy generation zero and an activated imported generation may emit room state. */
  isRealtimeWritable(): boolean {
    const row = first(this.storage.sql.exec<{
      authority_mode: string;
      authority_generation: number;
    }>(
      `SELECT authority_mode, authority_generation FROM workstream WHERE id = 1`,
    ));
    return row?.authority_generation === 0 || row?.authority_mode === "authoritative";
  }

  /** Generation this object's realtime authority was activated under. */
  realtimeAuthorityGeneration(): number | null {
    const row = first(this.storage.sql.exec<{ authority_generation: number }>(
      `SELECT authority_generation FROM workstream WHERE id = 1`,
    ));
    return row?.authority_generation ?? null;
  }

  currentSequence(canonicalFloor = 0): number {
    return this.storage.transactionSync(() => {
      const row = first(this.storage.sql.exec<RealtimeStateRow>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ));
      const sequence = Math.max(row?.event_sequence ?? 0, canonicalFloor);
      if (row && sequence === row.event_sequence) return sequence;
      this.storage.sql.exec(
        `INSERT INTO realtime_state(id, event_sequence, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           event_sequence = MAX(realtime_state.event_sequence, excluded.event_sequence),
           updated_at = excluded.updated_at`,
        sequence,
        Date.now(),
      );
      return sequence;
    });
  }

  allocateSequence(requested?: number): number {
    return this.storage.transactionSync(() => {
      if (!this.isRealtimeWritable()) throw new Error("workstream_realtime_authority_fenced");
      const row = first(this.storage.sql.exec<RealtimeStateRow>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ));
      const current = row?.event_sequence ?? 0;
      const next = Math.max(current + 1, requested ?? 0);
      this.storage.sql.exec(
        `INSERT INTO realtime_state(id, event_sequence, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           event_sequence = excluded.event_sequence,
           updated_at = excluded.updated_at`,
        next,
        Date.now(),
      );
      return next;
    });
  }

  commitRealtimeEvent(
    unsequencedEvent: ServerSocketEvent,
    requestedSequence?: number,
  ): ServerSocketEvent {
    return this.storage.transactionSync(() => {
      if (!this.isRealtimeWritable()) throw new Error("workstream_realtime_authority_fenced");
      const row = first(this.storage.sql.exec<RealtimeStateRow>(
        `SELECT event_sequence FROM realtime_state WHERE id = 1`,
      ));
      const current = row?.event_sequence ?? 0;
      const sequence = Math.max(current + 1, requestedSequence ?? 0);
      const parsedEvent = ServerSocketEventSchema.parse({ ...unsequencedEvent, sequence });
      const event = applyInferenceDelayEvent(this.storage, parsedEvent);
      this.storage.sql.exec(
        `INSERT INTO realtime_state(id, event_sequence, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           event_sequence = excluded.event_sequence,
           updated_at = excluded.updated_at`,
        sequence,
        Date.now(),
      );
      if (eventCanChangeActiveStreamCheckpoint(event)) {
        const checkpoints = readActiveStreamCheckpoints(this.storage);
        const next = applyActiveStreamCheckpointEvent(checkpoints, event);
        if (next !== checkpoints) writeActiveStreamCheckpoints(this.storage, next);
      }
      applyActiveCompactionEvent(this.storage, event);
      return event;
    });
  }

  activeStreamCheckpoints(): ActiveStreamCheckpoint[] {
    return readActiveStreamCheckpoints(this.storage);
  }

  activeInferenceDelays(): InferenceDelayState[] {
    return this.storage.sql.exec<{
      run_id: string; execution_id: string; root_attempt_id: string; attempt_id: string; inference_request_id: string; turn_id: string;
    }>(
      `SELECT delay.run_id, delay.execution_id, delay.root_attempt_id, delay.attempt_id, delay.inference_request_id, delay.turn_id
       FROM inference_delay_status delay
       JOIN runs execution ON execution.run_id = delay.execution_id
       JOIN runs root ON root.run_id = delay.run_id
       WHERE delay.active = 1 AND execution.status = 'running' AND root.status = 'running'
         AND EXISTS (SELECT 1 FROM workstream WHERE id = 1 AND exact_state = 'running')
         AND root.run_id = (SELECT run_id FROM runs WHERE parent_tool_call_id IS NULL
                            ORDER BY created_at DESC, run_id DESC LIMIT 1)
         AND root.legacy_attempt_id = delay.root_attempt_id AND root.lease_expires_at > ?
         AND execution.legacy_attempt_id = delay.attempt_id AND execution.lease_expires_at > ?
       ORDER BY delay.inference_request_id`, Date.now(), Date.now(),
    ).toArray().map((row) => InferenceDelayStateSchema.parse({
      harnessRunId: row.run_id, executionId: row.execution_id, attemptId: row.attempt_id,
      ...(row.execution_id !== row.run_id ? { parentAttemptId: row.root_attempt_id } : {}),
      inferenceRequestId: row.inference_request_id, turnId: row.turn_id,
    }));
  }

  activeCompaction(): AgentCompactionState | null {
    return readActiveCompaction(this.storage);
  }

  consumeSocketTicket(
    ticketId: string,
    expiresAt: number,
    nowEpochSeconds = Math.floor(Date.now() / 1_000),
  ): boolean {
    if (expiresAt <= nowEpochSeconds) return false;
    return this.storage.transactionSync(() => {
      const receivedAt = nowEpochSeconds * 1_000;
      this.storage.sql.exec(
        `DELETE FROM durable_inbox_receipts
          WHERE channel = 'socket_ticket' AND received_at < ?`,
        receivedAt - SOCKET_TICKET_RECEIPT_RETENTION_MS,
      );
      const requestHash = `expires:${expiresAt}`;
      const result = this.storage.sql.exec<{ message_id: string }>(
        `INSERT OR IGNORE INTO durable_inbox_receipts
           (channel, source_kind, source_id, source_generation, message_id,
            partition_key, source_version, source_epoch, request_hash,
            result_code, result_hash, received_at)
         VALUES ('socket_ticket', 'regional_service', 'socket_edge', 1, ?,
                 'socket_ticket', 1, 0, ?, 'consumed', ?, ?)
         RETURNING message_id`,
        ticketId,
        requestHash,
        requestHash,
        receivedAt,
      );
      return result.toArray().length === 1;
    });
  }

  /**
   * Enqueue effects for this conversation's parent inside a caller-owned SQLite
   * transaction.
   *
   * This is intentionally synchronous: transcript promotion uses it before
   * its canonical turn and pending-input state can commit. The caller remains
   * responsible for arming the object alarm after the outer transaction; the
   * outbox row is the durable authority and activation recovery also sees it.
   * The envelope names the parent by kind and id and this substream by id, so
   * the Queue consumer that carries it needs nothing but the message.
   */
  enqueueEffectsInCurrentTransaction(commands: readonly RegionalEffectCommand[], receipts?: ConversationEffectEnvelope[]): number {
    const authority = first(this.storage.sql.exec<AuthorityRow>(
      `SELECT workstream_key, parent_workspace_key, parent_kind, region, authority_mode,
              authority_generation
         FROM workstream WHERE id = 1`,
    ));
    if (!authority || authority.authority_mode !== "authoritative"
      || authority.authority_generation <= 0) {
      throw new Error("workstream_regional_effect_authority_fenced");
    }
    const substreamId = first(this.storage.sql.exec<{ external_substream_id: string }>(
      `SELECT external_substream_id FROM substream_agent_identity WHERE id = 1`,
    ))?.external_substream_id ?? "0";
    const messageIds = commands.map(() => uuidV7());
    let enqueued = 0;
    for (const [index, command] of commands.entries()) {
      const effect = ConversationEffectSchema.parse(command.effect);
      const projectionKey = effect.kind === "directory_common"
        ? "common"
        : effect.kind === "directory_user"
          ? `user:${effect.userId}`
          : null;
      let sourceVersion: number;
      let messageId: string;
      let duplicate = false;
      let requiredProjectionVersion: number | null = null;
      let payloadHash = conversationEffectHash(effect);

      if (projectionKey) {
        const previous = first(this.storage.sql.exec<ProjectionKeyRow>(
          `SELECT next_version, last_payload_hash, last_enqueued_message_id
             FROM projection_keys WHERE projection_key = ?`,
          projectionKey,
        ));
        duplicate = previous?.last_payload_hash === payloadHash;
        sourceVersion = duplicate ? previous!.next_version - 1 : previous?.next_version ?? 1;
        messageId = duplicate ? previous!.last_enqueued_message_id : messageIds[index]!;
        if (!duplicate) this.storage.sql.exec(
          `INSERT INTO projection_keys
             (projection_key, next_version, last_payload_hash,
              last_enqueued_message_id, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(projection_key) DO UPDATE SET
             next_version = excluded.next_version,
             last_payload_hash = excluded.last_payload_hash,
             last_enqueued_message_id = excluded.last_enqueued_message_id,
             updated_at = excluded.updated_at`,
          projectionKey,
          sourceVersion + 1,
          payloadHash,
          messageId,
          Date.now(),
        );
      } else {
        sourceVersion = z.number().int().positive().parse(command.sourceVersion);
        const dedupeKey = z.string().min(1).max(450).parse(command.dedupeKey);
        messageId = `effect:${dedupeKey}`;
        if (isPersonNotificationEffect(effect)) {
          const requiredKey = `user:${effect.recipientUserId}`;
          if (command.dependsOnProjectionKey !== requiredKey) {
            throw new Error("workstream_notification_projection_dependency_missing");
          }
          const dependency = first(this.storage.sql.exec<ProjectionKeyRow>(
            `SELECT next_version, last_payload_hash, last_enqueued_message_id
               FROM projection_keys WHERE projection_key = ?`,
            requiredKey,
          ));
          requiredProjectionVersion = (dependency?.next_version ?? 1) - 1;
          if (requiredProjectionVersion <= 0) {
            throw new Error("workstream_notification_projection_dependency_uncommitted");
          }
          payloadHash = conversationEffectHash(effect, requiredProjectionVersion);
        } else if (command.dependsOnProjectionKey !== undefined) {
          throw new Error("workstream_regional_effect_dependency_not_supported");
        }
      }

      const envelope = ConversationEffectEnvelopeSchema.parse({
        kind: "conversation_effect",
        contractVersion: 1,
        region: authority.region,
        workspaceId: authority.parent_workspace_key,
        parentKind: authority.parent_kind,
        parentId: authority.workstream_key,
        substreamId,
        generation: authority.authority_generation,
        messageId,
        partitionKey: projectionKey ?? command.partitionKey,
        sourceVersion,
        requiredProjectionVersion,
        payloadHash,
        effect,
      });
      // Return the exact committed projection receipt even after queue delivery
      // deleted its outbox row. Its identity/version/hash are durable in projection_keys.
      receipts?.push(envelope);
      if (duplicate) continue;
      const inserted = this.storage.sql.exec<{ message_id: string }>(
        `INSERT OR IGNORE INTO durable_outbox
           (message_id, channel, destination_kind, destination_id, partition_key,
            source_version, source_epoch, contract_version, payload_json, payload_ref,
            payload_hash, state, attempts, not_before, created_at, acked_at)
         VALUES (?, ?, 'queue', ?, ?, ?, ?, 1, ?, NULL, ?, 'pending', 0, ?, ?, NULL)
         RETURNING message_id`,
        messageId,
        REGIONAL_EFFECT_CHANNEL,
        authority.region,
        envelope.partitionKey,
        envelope.sourceVersion,
        envelope.generation,
        JSON.stringify(envelope),
        payloadHash,
        Date.now(),
        Date.now(),
      );
      if (inserted.toArray().length === 0) {
        const existing = first(this.storage.sql.exec<{ payload_hash: string }>(
          `SELECT payload_hash FROM durable_outbox WHERE message_id = ?`,
          messageId,
        ));
        if (existing?.payload_hash !== payloadHash) {
          throw new Error("workstream_regional_effect_idempotency_conflict");
        }
        continue;
      }
      enqueued += 1;
    }
    return enqueued;
  }

  /**
   * Commit projection/notification intents in the same SQLite transaction as
   * the product mutation that created them. Future authoritative write paths
   * pass their local SQL work through `mutate`; publishing never sits on the
   * user response path.
   */
  async commitWithRegionalEffects<T>(
    mutate: (sql: SqlStorage) => T,
    effects: readonly RegionalEffectCommand[]
      | ((sql: SqlStorage, result: T) => readonly RegionalEffectCommand[]),
  ): Promise<{ result: T; enqueued: number; envelopes: ConversationEffectEnvelope[] }> {
    const committed = this.storage.transactionSync(() => {
      const result = mutate(this.storage.sql);
      const commands = typeof effects === "function"
        ? effects(this.storage.sql, result)
        : effects;
      const envelopes: ConversationEffectEnvelope[] = [];
      const enqueued = this.enqueueEffectsInCurrentTransaction(commands, envelopes);
      return { result, enqueued, envelopes };
    });
    if (committed.enqueued > 0) await this.storage.setAlarm(Date.now());
    return committed;
  }

  dueRegionalEffects(now = Date.now(), limit = 10): ConversationEffectEnvelope[] {
    const rows = this.storage.sql.exec<RegionalEffectOutboxRow>(
      `SELECT message_id, payload_json, payload_hash, attempts
         FROM durable_outbox
        WHERE channel = ? AND state IN ('pending', 'inflight') AND not_before <= ?
        ORDER BY created_at,
                 CASE json_extract(payload_json, '$.effect.kind')
                   WHEN 'directory_common' THEN 0
                   WHEN 'directory_user' THEN 1
                   ELSE 2
                 END,
                 partition_key, source_version, message_id
        LIMIT ?`,
      REGIONAL_EFFECT_CHANNEL,
      now,
      Math.max(1, Math.min(limit, 100)),
    ).toArray();
    return rows.map((row) => {
      const parsed = ConversationEffectEnvelopeSchema.parse(JSON.parse(row.payload_json));
      if (parsed.messageId !== row.message_id || parsed.payloadHash !== row.payload_hash) {
        throw new Error("workstream_regional_effect_outbox_corrupt");
      }
      return parsed;
    });
  }

  deferRegionalEffects(
    messages: readonly ConversationEffectEnvelope[],
    notBefore: number,
  ): void {
    this.storage.transactionSync(() => {
      for (const message of messages) {
        this.storage.sql.exec(
          `UPDATE durable_outbox
              SET state = 'pending', attempts = attempts + 1, not_before = ?
            WHERE channel = ? AND message_id = ? AND payload_hash = ?
              AND state IN ('pending', 'inflight')`,
          notBefore,
          REGIONAL_EFFECT_CHANNEL,
          message.messageId,
          message.payloadHash,
        );
      }
    });
  }

  /** Drop one outbox row the Queue has taken; from here retry is the Queue's. */
  deleteRegionalEffect(messageId: string, payloadHash: string): boolean {
    return this.storage.sql.exec<{ message_id: string }>(
      `DELETE FROM durable_outbox
        WHERE channel = ? AND message_id = ? AND payload_hash = ?
        RETURNING message_id`,
      REGIONAL_EFFECT_CHANNEL,
      messageId,
      payloadHash,
    ).toArray().length === 1;
  }

  nextRegionalEffectDueAt(): number | null {
    const row = first(this.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM durable_outbox
        WHERE channel = ? AND state IN ('pending', 'inflight')`,
      REGIONAL_EFFECT_CHANNEL,
    ));
    return row?.due_at ?? null;
  }

  dueSemanticRealtime(
    now = Date.now(),
    limit = 100,
  ): SequencedSemanticRealtimeReference[] {
    return dueSemanticRealtimeReferences(this.storage.sql, now, limit);
  }

  acknowledgeSemanticRealtime(messageId: string, sequence: number): boolean {
    return acknowledgeSemanticRealtimeReference(
      this.storage.sql,
      messageId,
      sequence,
    );
  }

  deferSemanticRealtime(messageId: string, sequence: number, notBefore: number): void {
    deferSemanticRealtimeReference(this.storage.sql, messageId, sequence, notBefore);
  }

  nextSemanticRealtimeDueAt(): number | null {
    return nextSemanticRealtimeDueAt(this.storage.sql);
  }
}
