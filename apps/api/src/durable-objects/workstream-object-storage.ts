import {
  AgentCompactionStateSchema,
  ActiveStreamCheckpointsSchema,
  ServerSocketEventSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  asWorkspaceId,
  asWorkstreamId,
  type AgentCompactionState,
  type ActiveStreamCheckpoint,
  type ServerSocketEvent,
} from "@avalon/contracts";
import { z } from "zod";

import { uuidV7 } from "../lib/uuid-v7";
import { applyWorkstreamObjectSchema } from "./workstream-object-schema";
import { BlockDashboardContextFenceSchema } from "./block-dashboard-protocol";
import {
  WorkstreamRegionalEffectSchema,
  WorkstreamRegionalEffectEnvelopeSchema,
  isPersonNotificationEffect,
  workstreamRegionalEffectHash,
  type WorkstreamRegionalEffect,
  type WorkstreamRegionalEffectEnvelope,
} from "./workstream-regional-effect";

const BLOCK_DASHBOARD_JOB_KEY = "block_dashboard_refresh";
const ACTIVE_OUTPUT_CHUNK_MAX_BYTES = 60 * 1024;
const SOCKET_TICKET_RECEIPT_RETENTION_MS = 5 * 60_000;
const REGIONAL_EFFECT_CHANNEL = "regional_effect_v1";
const REGIONAL_EFFECT_RETRY_BASE_MS = 5_000;
const REGIONAL_EFFECT_RETRY_MAX_MS = 5 * 60_000;

const RoomIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
});

const PendingBlockDashboardRefreshSchema = RoomIdentitySchema.extend({
  triggerSequence: z.number().int().nonnegative(),
  contextFence: BlockDashboardContextFenceSchema,
  firstQueuedAt: z.number().int().nonnegative(),
});

interface RealtimeStateRow extends Record<string, SqlStorageValue> {
  event_sequence: number;
}

interface ActiveOutputRow extends Record<string, SqlStorageValue> {
  run_id: string;
  attempt_epoch: number;
  turn_id: string;
  message_id: string;
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

interface DueWorkRow extends Record<string, SqlStorageValue> {
  payload_json: string;
}

interface DueWorkTimeRow extends Record<string, SqlStorageValue> {
  due_at: number;
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
  region: "global" | "eu";
  authority_mode: string;
  authority_generation: number;
}

export interface RegionalEffectCommand {
  partitionKey: string;
  effect: WorkstreamRegionalEffect;
  /** Required for immutable activity/notification effects. */
  sourceVersion?: number;
  /** Stable across retries; required for immutable activity/notification effects. */
  dedupeKey?: string;
  /** The user projection that must be visible before a mention can be delivered. */
  dependsOnProjectionKey?: string;
}

export type WorkstreamObjectIdentity = z.infer<typeof RoomIdentitySchema>;
export type PendingBlockDashboardRefresh = z.infer<typeof PendingBlockDashboardRefreshSchema>;

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
    return checkpoints.filter((checkpoint) => checkpoint.messageId !== event.message.id);
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
  const existing = activeCheckpoints.find((checkpoint) => checkpoint.messageId === event.messageId);
  if (event.type === "stream_delta" && !existing) return checkpoints;
  if (existing) {
    if (event.sequence <= existing.roomSequence) return checkpoints;
    if (event.turnId === existing.turnId) {
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
    messageId: event.messageId,
    harnessRunId,
    turnId: event.turnId,
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
    `SELECT run_id, attempt_epoch, turn_id, message_id, seen_turn_ids_json,
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
      messageId: row.message_id,
      harnessRunId: row.run_id,
      turnId: row.turn_id,
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

function applyActiveCompactionEvent(
  storage: DurableObjectStorage,
  event: ServerSocketEvent,
): void {
  if (event.type === "compaction_started") {
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

function runTerminalState(event: ServerSocketEvent): "cancelled" | "completed" | "failed" | "needs_input" | null {
  if (event.type !== "harness_status_changed") return null;
  if (event.status === "failed") return "failed";
  if (event.status === "needs_input") return "needs_input";
  if (event.status === "stopped") return "cancelled";
  if (event.status === "completed" || event.status === "idle") return "completed";
  return null;
}

function writeActiveStreamCheckpoints(
  storage: DurableObjectStorage,
  checkpoints: ActiveStreamCheckpoint[],
  event: ServerSocketEvent | null,
): void {
  const sql = storage.sql;
  const desiredRunIds = new Set(checkpoints.map((checkpoint) => checkpoint.harnessRunId));
  const activeRunIds = sql.exec<{ run_id: string }>(
    `SELECT run_id FROM active_output_turns`,
  ).toArray().map((row) => row.run_id);
  const now = Date.now();
  const terminal = event ? runTerminalState(event) : null;
  for (const runId of activeRunIds) {
    if (desiredRunIds.has(runId)) continue;
    sql.exec(`DELETE FROM active_output_turns WHERE run_id = ?`, runId);
    if (event?.type === "stream_completed" || terminal) continue;
    sql.exec(
      `UPDATE runs
          SET status = ?, terminal_reason = ?, revision = revision + 1, updated_at = ?
        WHERE run_id = ? AND status IN ('admitted', 'running', 'waiting', 'steering')`,
      "cancelled",
      "superseded_active_output",
      now,
      runId,
    );
  }
  if (terminal) {
    // `stream_completed` closes one model response, not necessarily the whole
    // loop, and therefore removes the active turn before the later harness
    // terminal event arrives. That terminal event carries no run id. Admission
    // permits one root run per room, so settle every still-open local run rather
    // than requiring an active-output row to survive until loop completion.
    sql.exec(
      `UPDATE runs
          SET status = ?, terminal_reason = ?, revision = revision + 1, updated_at = ?
        WHERE status IN ('admitted', 'running', 'waiting', 'steering')`,
      terminal,
      terminal,
      now,
    );
  }

  for (const checkpoint of checkpoints) {
    const startedAt = Date.parse(checkpoint.createdAt);
    const effectiveStartedAt = Number.isFinite(startedAt) ? startedAt : now;
    sql.exec(
      `INSERT INTO runs
         (run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
          model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
          tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
          terminal_reason, created_at, updated_at)
       VALUES (?, '0', NULL, 'running', '{}', ?, 0, '', 0, 0, ?,
               0, 0, 0, 0, 0, 0, 0, 0, 0, ?, NULL, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status = 'running',
         attempt_epoch = excluded.attempt_epoch,
         output_bytes = excluded.output_bytes,
         terminal_reason = NULL,
         revision = runs.revision + 1,
         updated_at = excluded.updated_at`,
      checkpoint.harnessRunId,
      checkpoint.epoch,
      effectiveStartedAt,
      new TextEncoder().encode(checkpoint.text).byteLength,
      effectiveStartedAt,
      now,
    );
    sql.exec(`DELETE FROM active_output_turns WHERE run_id = ?`, checkpoint.harnessRunId);
    const chunks = splitActiveStreamCheckpointText(checkpoint.text);
    sql.exec(
      `INSERT INTO active_output_turns
         (run_id, attempt_epoch, turn_id, substream_id, status, durable_event_seq,
          durable_through_frame_seq, next_chunk_index, message_id, seen_turn_ids_json,
          turn_start_offset, started_at, checkpointed_at, updated_at)
       VALUES (?, ?, ?, '0', 'streaming', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      checkpoint.harnessRunId,
      checkpoint.epoch,
      checkpoint.turnId,
      checkpoint.roomSequence,
      checkpoint.streamSeq,
      chunks.length,
      checkpoint.messageId,
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
  region: "global" | "eu",
  now: number,
): void {
  const existing = first(storage.sql.exec<{ workstream_key: string; parent_workspace_key: string }>(
    `SELECT workstream_key, parent_workspace_key FROM workstream WHERE id = 1`,
  ));
  if (existing) {
    if (
      existing.workstream_key !== identity.workstreamId
      || existing.parent_workspace_key !== identity.workspaceId
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
         (id, workstream_key, parent_workspace_key, parent_do_id, parent_generation,
          region, authority_mode, title, description, preview, scope, exact_state,
          state_reason_code, next_sequence_number, next_attention_ordinal,
          authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
          deletion_epoch, run_revision, created_at, last_people_activity_at,
          state_changed_at, completed_at, updated_at)
       VALUES (1, ?, ?, NULL, 0, ?, 'preparing', '', '', '', 'personal', 'restoring',
               'awaiting_authoritative_import', 1, 1, 0, 0, 0, 0, 0, 0, ?, ?, ?, NULL, ?)`,
      identity.workstreamId,
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
        return_mode, origin_part_id, owner_user_id, audience, tool_policy, status,
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
    _region: "global" | "eu",
  ) {
    void _region;
    applyWorkstreamObjectSchema(storage, workerVersionId);
    this.ready = Promise.resolve();
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  ensureIdentity(identity: WorkstreamObjectIdentity, region: "global" | "eu"): void {
    this.storage.transactionSync(() => insertIdentity(this.storage, identity, region, Date.now()));
  }

  identity(): WorkstreamObjectIdentity | null {
    const row = first(this.storage.sql.exec<{ workstream_key: string; parent_workspace_key: string }>(
      `SELECT workstream_key, parent_workspace_key FROM workstream WHERE id = 1`,
    ));
    if (!row) return null;
    return { workstreamId: asWorkstreamId(row.workstream_key), workspaceId: asWorkspaceId(row.parent_workspace_key) };
  }

  databaseSize(): number {
    return this.storage.sql.databaseSize;
  }

  /**
   * Whether this object may still be written through as the work stream's
   * authority.
   *
   * The check `executeWorkstreamRuntimeSql` makes before it runs any routed
   * statement. The typed object ports replaced that path and each re-checks
   * identity, so this is the half they need to keep: a `preparing` or
   * `quarantined` object is not the one whose writes count, and the routed
   * statement would have been refused.
   */
  isAuthoritative(): boolean {
    return first(this.storage.sql.exec<{ authority_mode: string }>(
      `SELECT authority_mode FROM workstream WHERE id = 1`,
    ))?.authority_mode === "authoritative";
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
      const event = ServerSocketEventSchema.parse({ ...unsequencedEvent, sequence });
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
        if (next !== checkpoints) writeActiveStreamCheckpoints(this.storage, next, event);
      }
      applyActiveCompactionEvent(this.storage, event);
      return event;
    });
  }

  activeStreamCheckpoints(): ActiveStreamCheckpoint[] {
    return readActiveStreamCheckpoints(this.storage);
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

  pendingBlockDashboardRefresh(): PendingBlockDashboardRefresh | null {
    const row = first(this.storage.sql.exec<DueWorkRow>(
      `SELECT payload_json FROM due_work WHERE job_key = ?`,
      BLOCK_DASHBOARD_JOB_KEY,
    ));
    if (!row) return null;
    const parsed = PendingBlockDashboardRefreshSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  }

  nextBlockDashboardDueAt(): number | null {
    const row = first(this.storage.sql.exec<DueWorkTimeRow>(
      `SELECT due_at FROM due_work WHERE job_key = ?`,
      BLOCK_DASHBOARD_JOB_KEY,
    ));
    return row?.due_at ?? null;
  }

  putPendingBlockDashboardRefresh(pending: PendingBlockDashboardRefresh, dueAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO due_work(job_key, kind, due_at, epoch, payload_json, attempts, last_error_code, updated_at)
       VALUES (?, 'block_dashboard_refresh', ?, 0, ?, 0, NULL, ?)
       ON CONFLICT(job_key) DO UPDATE SET
         due_at = excluded.due_at,
         payload_json = excluded.payload_json,
         last_error_code = NULL,
         updated_at = excluded.updated_at`,
      BLOCK_DASHBOARD_JOB_KEY,
      dueAt,
      JSON.stringify(pending),
      Date.now(),
    );
  }

  deletePendingBlockDashboardRefresh(): void {
    this.storage.sql.exec(`DELETE FROM due_work WHERE job_key = ?`, BLOCK_DASHBOARD_JOB_KEY);
  }

  failPendingBlockDashboardRefresh(pending: PendingBlockDashboardRefresh, dueAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO due_work(job_key, kind, due_at, epoch, payload_json, attempts, last_error_code, updated_at)
       VALUES (?, 'block_dashboard_refresh', ?, 0, ?, 1, 'refresh_failed', ?)
       ON CONFLICT(job_key) DO UPDATE SET
         due_at = excluded.due_at,
         payload_json = excluded.payload_json,
         attempts = due_work.attempts + 1,
         last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
      BLOCK_DASHBOARD_JOB_KEY,
      dueAt,
      JSON.stringify(pending),
      Date.now(),
    );
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
  ): Promise<{ result: T; enqueued: number }> {
    const committed = this.storage.transactionSync(() => {
      const authority = first(this.storage.sql.exec<AuthorityRow>(
        `SELECT workstream_key, parent_workspace_key, region, authority_mode, authority_generation
           FROM workstream WHERE id = 1`,
      ));
      if (
        !authority
        || authority.authority_mode !== "authoritative"
        || authority.authority_generation <= 0
      ) throw new Error("workstream_regional_effect_authority_fenced");

      const result = mutate(this.storage.sql);
      const commands = typeof effects === "function"
        ? effects(this.storage.sql, result)
        : effects;
      const messageIds = commands.map(() => uuidV7());
      let enqueued = 0;
      for (const [index, command] of commands.entries()) {
        const effect = WorkstreamRegionalEffectSchema.parse(command.effect);
        const projectionKey = effect.kind === "directory_common"
          ? "common"
          : effect.kind === "directory_user"
            ? `user:${effect.userId}`
            : null;
        let sourceVersion: number;
        let messageId: string;
        let requiredProjectionVersion: number | null = null;
        let payloadHash = workstreamRegionalEffectHash(effect);

        if (projectionKey) {
          const previous = first(this.storage.sql.exec<ProjectionKeyRow>(
            `SELECT next_version, last_payload_hash, last_enqueued_message_id
               FROM projection_keys WHERE projection_key = ?`,
            projectionKey,
          ));
          if (previous?.last_payload_hash === payloadHash) continue;
          sourceVersion = previous?.next_version ?? 1;
          messageId = messageIds[index]!;
          this.storage.sql.exec(
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
            payloadHash = workstreamRegionalEffectHash(effect, requiredProjectionVersion);
          } else if (command.dependsOnProjectionKey !== undefined) {
            throw new Error("workstream_regional_effect_dependency_not_supported");
          }
        }

        const envelope = WorkstreamRegionalEffectEnvelopeSchema.parse({
          kind: "workstream_regional_effect",
          contractVersion: 1,
          region: authority.region,
          workspaceId: authority.parent_workspace_key,
          workstreamId: authority.workstream_key,
          generation: authority.authority_generation,
          messageId,
          partitionKey: projectionKey ?? command.partitionKey,
          sourceVersion,
          requiredProjectionVersion,
          payloadHash,
          effect,
        });
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
      return { result, enqueued };
    });
    if (committed.enqueued > 0) await this.storage.setAlarm(Date.now());
    return committed;
  }

  dueRegionalEffects(now = Date.now(), limit = 10): WorkstreamRegionalEffectEnvelope[] {
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
      const parsed = WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json));
      if (parsed.messageId !== row.message_id || parsed.payloadHash !== row.payload_hash) {
        throw new Error("workstream_regional_effect_outbox_corrupt");
      }
      return parsed;
    });
  }

  regionalEffect(messageId: string, payloadHash: string): WorkstreamRegionalEffectEnvelope | null {
    const row = first(this.storage.sql.exec<RegionalEffectOutboxRow>(
      `SELECT message_id, payload_json, payload_hash, attempts
         FROM durable_outbox
        WHERE channel = ? AND message_id = ? AND payload_hash = ?
          AND state IN ('pending', 'inflight')`,
      REGIONAL_EFFECT_CHANNEL,
      messageId,
      payloadHash,
    ));
    if (!row) return null;
    const parsed = WorkstreamRegionalEffectEnvelopeSchema.parse(JSON.parse(row.payload_json));
    if (parsed.messageId !== row.message_id || parsed.payloadHash !== row.payload_hash) {
      throw new Error("workstream_regional_effect_outbox_corrupt");
    }
    return parsed;
  }

  markRegionalEffectsQueued(messages: readonly WorkstreamRegionalEffectEnvelope[]): void {
    const now = Date.now();
    this.storage.transactionSync(() => {
      for (const message of messages) {
        const row = first(this.storage.sql.exec<{ attempts: number }>(
          `SELECT attempts FROM durable_outbox
            WHERE message_id = ? AND payload_hash = ? AND state IN ('pending', 'inflight')`,
          message.messageId,
          message.payloadHash,
        ));
        if (!row) continue;
        const attempts = row.attempts + 1;
        const delay = Math.min(
          REGIONAL_EFFECT_RETRY_MAX_MS,
          REGIONAL_EFFECT_RETRY_BASE_MS * 2 ** Math.min(attempts - 1, 6),
        );
        this.storage.sql.exec(
          `UPDATE durable_outbox
              SET state = 'inflight', attempts = ?, not_before = ?
            WHERE message_id = ? AND payload_hash = ?`,
          attempts,
          now + delay,
          message.messageId,
          message.payloadHash,
        );
      }
    });
  }

  deferRegionalEffects(
    messages: readonly WorkstreamRegionalEffectEnvelope[],
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

  acknowledgeRegionalEffect(messageId: string, payloadHash: string): boolean {
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
}
