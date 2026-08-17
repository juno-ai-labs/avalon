import {
  ActiveStreamCheckpointsSchema,
  ServerSocketEventSchema,
  type ActiveStreamCheckpoint,
  type ServerSocketEvent,
} from "@avalon/contracts";
import { z } from "zod";

import { applyWorkstreamObjectSchema } from "./workstream-object-schema";

const LEGACY_ROOM_IDENTITY_KEY = "roomIdentity";
const LEGACY_EVENT_SEQUENCE_KEY = "eventSequence";
const LEGACY_ACTIVE_CHECKPOINT_KEY = "activeStreamCheckpoints";
const LEGACY_ACTIVE_CHUNK_PREFIX = "activeStreamCheckpointText:";
const LEGACY_HYPERSIGHT_KEY = "pendingHyperSightRefresh";
const LEGACY_SOCKET_TICKET_PREFIX = "socket-ticket:";
const LEGACY_KV_CAMPAIGN_ID = "workstream-room-kv-to-sql-v1";
const HYPERSIGHT_JOB_KEY = "hypersight_refresh";
const ACTIVE_OUTPUT_CHUNK_MAX_BYTES = 60 * 1024;
const SOCKET_TICKET_RECEIPT_RETENTION_MS = 5 * 60_000;

const RoomIdentitySchema = z.object({
  workspaceId: z.string().uuid(),
  workstreamId: z.string().uuid(),
});

const PendingHyperSightRefreshSchema = RoomIdentitySchema.extend({
  triggerSequence: z.number().int().nonnegative(),
  firstQueuedAt: z.number().int().nonnegative(),
});

const StoredLegacyActiveCheckpointSchema = z.object({
  messageId: z.string().uuid(),
  harnessRunId: z.string().uuid(),
  turnId: z.string().min(1).max(180),
  epoch: z.number().int().nonnegative(),
  streamSeq: z.number().int().nonnegative(),
  seenTurnIds: z.array(z.string().min(1).max(180)),
  textChunkCount: z.number().int().nonnegative(),
  turnStartOffset: z.number().int().nonnegative(),
  roomSequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
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

interface DueWorkRow extends Record<string, SqlStorageValue> {
  payload_json: string;
}

interface DataMigrationRow extends Record<string, SqlStorageValue> {
  phase: string;
  status: string;
}

export type WorkstreamObjectIdentity = z.infer<typeof RoomIdentitySchema>;
export type PendingHyperSightRefresh = z.infer<typeof PendingHyperSightRefreshSchema>;

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

function runTerminalState(event: ServerSocketEvent): "completed" | "failed" | "needs_input" | null {
  if (event.type !== "harness_status_changed") return null;
  if (event.status === "failed") return "failed";
  if (event.status === "needs_input") return "needs_input";
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

async function readLegacyActiveStreamCheckpoints(
  storage: DurableObjectStorage,
  storedValue: unknown,
): Promise<{ checkpoints: ActiveStreamCheckpoint[]; keys: string[] }> {
  const legacy = ActiveStreamCheckpointsSchema.safeParse(storedValue);
  if (legacy.success) return { checkpoints: legacy.data, keys: [LEGACY_ACTIVE_CHECKPOINT_KEY] };

  const stored = StoredLegacyActiveCheckpointSchema.safeParse(storedValue);
  if (!stored.success) return { checkpoints: [], keys: [] };
  const keys = [LEGACY_ACTIVE_CHECKPOINT_KEY];
  const chunks: string[] = [];
  for (let index = 0; index < stored.data.textChunkCount; index += 1) {
    const key = `${LEGACY_ACTIVE_CHUNK_PREFIX}${String(index).padStart(8, "0")}`;
    const chunk = await storage.get(key);
    if (typeof chunk !== "string") throw new Error("legacy_active_checkpoint_chunk_missing");
    keys.push(key);
    chunks.push(chunk);
  }
  const hydrated = ActiveStreamCheckpointsSchema.parse([{ ...stored.data, text: chunks.join("") }]);
  return { checkpoints: hydrated, keys };
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
    storage.sql.exec(
      `INSERT INTO workstream
         (id, workstream_key, parent_workspace_key, parent_do_id, parent_generation,
          region, authority_mode, title, description, preview, scope, exact_state,
          state_reason_code, next_sequence_number, next_attention_ordinal,
          authority_epoch, scope_epoch, source_authorization_floor, listing_epoch,
          deletion_epoch, run_revision, created_at, last_people_activity_at,
          state_changed_at, completed_at, updated_at)
       VALUES (1, ?, ?, NULL, 0, ?, 'preparing', '', '', '', 'workspace', 'restoring',
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

async function deleteLegacyKeys(storage: DurableObjectStorage, keys: string[]): Promise<void> {
  for (let start = 0; start < keys.length; start += 128) {
    await storage.delete(keys.slice(start, start + 128));
  }
}

function completeLegacyKvMigration(storage: DurableObjectStorage, now: number): void {
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO _data_migrations
         (campaign_id, target_version, phase, cursor, source_fence, source_hash,
          result_hash, pitr_bookmark, status, attempts, last_error_code, updated_at)
       VALUES (?, 1, 'completed', NULL, NULL, NULL, NULL, NULL, 'completed', 1, NULL, ?)
       ON CONFLICT(campaign_id) DO UPDATE SET
         phase = 'completed', status = 'completed', last_error_code = NULL,
         updated_at = excluded.updated_at`,
      LEGACY_KV_CAMPAIGN_ID,
      now,
    );
    storage.sql.exec(
      `UPDATE object_versions
          SET data_version = MAX(data_version, 1), updated_at = ?
        WHERE id = 1 AND data_version < 1`,
      now,
    );
  });
}

async function migrateLegacyKv(
  storage: DurableObjectStorage,
  region: "global" | "eu",
): Promise<void> {
  const existingMigration = first(storage.sql.exec<DataMigrationRow>(
    `SELECT phase, status FROM _data_migrations WHERE campaign_id = ?`,
    LEGACY_KV_CAMPAIGN_ID,
  ));
  if (existingMigration?.status === "completed") {
    storage.sql.exec(
      `UPDATE object_versions SET data_version = 1, updated_at = ?
        WHERE id = 1 AND data_version < 1`,
      Date.now(),
    );
    return;
  }

  const values = await storage.get([
    LEGACY_ROOM_IDENTITY_KEY,
    LEGACY_EVENT_SEQUENCE_KEY,
    LEGACY_ACTIVE_CHECKPOINT_KEY,
    LEGACY_HYPERSIGHT_KEY,
  ]);
  const ticketEntries = await storage.list<number>({ prefix: LEGACY_SOCKET_TICKET_PREFIX });
  const chunkEntries = await storage.list<string>({ prefix: LEGACY_ACTIVE_CHUNK_PREFIX });
  const legacyKeys = [...new Set([
    ...values.keys(),
    ...ticketEntries.keys(),
    ...chunkEntries.keys(),
  ])];
  const now = Date.now();

  // A prior activation committed the relational copy but stopped during the
  // asynchronous KV cleanup. The SQL copy is already the recovery source, so
  // parsing a now-partial legacy checkpoint would turn a harmless cleanup
  // retry into an outage. Finish deleting only the known legacy key families.
  if (existingMigration?.phase === "copied") {
    await deleteLegacyKeys(storage, legacyKeys);
    completeLegacyKvMigration(storage, now);
    return;
  }

  const active = await readLegacyActiveStreamCheckpoints(
    storage,
    values.get(LEGACY_ACTIVE_CHECKPOINT_KEY),
  );
  const identity = RoomIdentitySchema.safeParse(values.get(LEGACY_ROOM_IDENTITY_KEY));
  const sequence = z.number().int().nonnegative().safeParse(values.get(LEGACY_EVENT_SEQUENCE_KEY));
  const hypersight = PendingHyperSightRefreshSchema.safeParse(values.get(LEGACY_HYPERSIGHT_KEY));
  if (legacyKeys.length === 0) {
    completeLegacyKvMigration(storage, now);
    return;
  }
  if (values.has(LEGACY_ROOM_IDENTITY_KEY) && !identity.success) {
    throw new Error("legacy_room_identity_invalid");
  }
  if (values.has(LEGACY_EVENT_SEQUENCE_KEY) && !sequence.success) {
    throw new Error("legacy_event_sequence_invalid");
  }
  if (values.has(LEGACY_ACTIVE_CHECKPOINT_KEY) && active.keys.length === 0) {
    throw new Error("legacy_active_checkpoint_invalid");
  }
  if (values.has(LEGACY_HYPERSIGHT_KEY) && !hypersight.success) {
    throw new Error("legacy_hypersight_refresh_invalid");
  }
  for (const [key, expiresAt] of ticketEntries) {
    const ticketId = key.slice(LEGACY_SOCKET_TICKET_PREFIX.length);
    if (!z.string().uuid().safeParse(ticketId).success || !Number.isFinite(expiresAt)) {
      throw new Error("legacy_socket_ticket_invalid");
    }
  }

  storage.transactionSync(() => {
    if (identity.success) insertIdentity(storage, identity.data, region, now);
    if (sequence.success) {
      storage.sql.exec(
        `INSERT INTO realtime_state(id, event_sequence, updated_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           event_sequence = MAX(realtime_state.event_sequence, excluded.event_sequence),
           updated_at = excluded.updated_at`,
        sequence.data,
        now,
      );
    }
    if (active.checkpoints.length > 0) {
      if (!identity.success) throw new Error("legacy_active_checkpoint_identity_missing");
      writeActiveStreamCheckpoints(storage, active.checkpoints, null);
    }
    if (hypersight.success) {
      storage.sql.exec(
        `INSERT INTO due_work(job_key, kind, due_at, epoch, payload_json, attempts, last_error_code, updated_at)
         VALUES (?, 'hypersight_refresh', ?, 0, ?, 0, NULL, ?)
         ON CONFLICT(job_key) DO UPDATE SET
           due_at = MIN(due_work.due_at, excluded.due_at),
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
        HYPERSIGHT_JOB_KEY,
        now,
        JSON.stringify(hypersight.data),
        now,
      );
    }
    for (const [key, expiresAt] of ticketEntries) {
      const ticketId = key.slice(LEGACY_SOCKET_TICKET_PREFIX.length);
      storage.sql.exec(
        `INSERT OR IGNORE INTO durable_inbox_receipts
           (channel, source_kind, source_id, source_generation, message_id,
            partition_key, source_version, source_epoch, request_hash,
            result_code, result_hash, received_at)
         VALUES ('socket_ticket', 'regional_service', 'socket_edge', 1, ?,
                 'socket_ticket', 1, 0, ?, 'consumed', ?, ?)`,
        ticketId,
        `expires:${expiresAt}`,
        `expires:${expiresAt}`,
        Math.max(0, expiresAt * 1_000 - 60_000),
      );
    }
    storage.sql.exec(
      `INSERT INTO _data_migrations
         (campaign_id, target_version, phase, cursor, source_fence, source_hash,
          result_hash, pitr_bookmark, status, attempts, last_error_code, updated_at)
       VALUES (?, 1, 'copied', NULL, NULL, NULL, NULL, NULL, 'running', 1, NULL, ?)
       ON CONFLICT(campaign_id) DO UPDATE SET
         phase = 'copied', status = 'running', attempts = _data_migrations.attempts + 1,
         last_error_code = NULL, updated_at = excluded.updated_at`,
      LEGACY_KV_CAMPAIGN_ID,
      now,
    );
  });

  await deleteLegacyKeys(storage, legacyKeys);
  completeLegacyKvMigration(storage, Date.now());
}

export class WorkstreamObjectStore {
  private readonly ready: Promise<void>;

  constructor(
    private readonly storage: DurableObjectStorage,
    workerVersionId: string,
    region: "global" | "eu",
  ) {
    this.ready = (async () => {
      applyWorkstreamObjectSchema(storage, workerVersionId);
      await migrateLegacyKv(storage, region);
    })();
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
    return { workstreamId: row.workstream_key, workspaceId: row.parent_workspace_key };
  }

  databaseSize(): number {
    return this.storage.sql.databaseSize;
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
      return event;
    });
  }

  activeStreamCheckpoints(): ActiveStreamCheckpoint[] {
    return readActiveStreamCheckpoints(this.storage);
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
      const result = this.storage.sql.exec(
        `INSERT OR IGNORE INTO durable_inbox_receipts
           (channel, source_kind, source_id, source_generation, message_id,
            partition_key, source_version, source_epoch, request_hash,
            result_code, result_hash, received_at)
         VALUES ('socket_ticket', 'regional_service', 'socket_edge', 1, ?,
                 'socket_ticket', 1, 0, ?, 'consumed', ?, ?)`,
        ticketId,
        requestHash,
        requestHash,
        receivedAt,
      );
      return result.rowsWritten === 1;
    });
  }

  pendingHyperSightRefresh(): PendingHyperSightRefresh | null {
    const row = first(this.storage.sql.exec<DueWorkRow>(
      `SELECT payload_json FROM due_work WHERE job_key = ?`,
      HYPERSIGHT_JOB_KEY,
    ));
    if (!row) return null;
    const parsed = PendingHyperSightRefreshSchema.safeParse(JSON.parse(row.payload_json));
    return parsed.success ? parsed.data : null;
  }

  putPendingHyperSightRefresh(pending: PendingHyperSightRefresh, dueAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO due_work(job_key, kind, due_at, epoch, payload_json, attempts, last_error_code, updated_at)
       VALUES (?, 'hypersight_refresh', ?, 0, ?, 0, NULL, ?)
       ON CONFLICT(job_key) DO UPDATE SET
         due_at = excluded.due_at,
         payload_json = excluded.payload_json,
         last_error_code = NULL,
         updated_at = excluded.updated_at`,
      HYPERSIGHT_JOB_KEY,
      dueAt,
      JSON.stringify(pending),
      Date.now(),
    );
  }

  deletePendingHyperSightRefresh(): void {
    this.storage.sql.exec(`DELETE FROM due_work WHERE job_key = ?`, HYPERSIGHT_JOB_KEY);
  }

  failPendingHyperSightRefresh(pending: PendingHyperSightRefresh, dueAt: number): void {
    this.storage.sql.exec(
      `INSERT INTO due_work(job_key, kind, due_at, epoch, payload_json, attempts, last_error_code, updated_at)
       VALUES (?, 'hypersight_refresh', ?, 0, ?, 1, 'refresh_failed', ?)
       ON CONFLICT(job_key) DO UPDATE SET
         due_at = excluded.due_at,
         payload_json = excluded.payload_json,
         attempts = due_work.attempts + 1,
         last_error_code = excluded.last_error_code,
         updated_at = excluded.updated_at`,
      HYPERSIGHT_JOB_KEY,
      dueAt,
      JSON.stringify(pending),
      Date.now(),
    );
  }
}
