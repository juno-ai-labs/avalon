import { z } from "zod";

/**
 * Object-local, canonical references waiting to become room events.
 *
 * The authoritative mutation and this reference share one SQLite transaction.
 * Payload bytes are deliberately not copied into the outbox: delivery hydrates
 * the current canonical projection and a reconnect snapshot remains the final
 * recovery authority.
 */
export const SemanticRealtimeReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("participant_changed"), userId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("transcript_turn"), turnId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("elicitation_cancelled"), elicitationId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("loop_input_upserted"),
    inputId: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("loop_input_removed"),
    inputId: z.string().min(1),
    outcome: z.enum(["delivered", "cancelled"]),
  }),
  z.strictObject({
    kind: z.literal("transcript_activity"),
    activityId: z.string().min(1),
    snapshotAtUtc: z.string().datetime({ offset: true }),
  }),
]);

export type SemanticRealtimeReference = z.infer<typeof SemanticRealtimeReferenceSchema>;

export interface SequencedSemanticRealtimeReference {
  messageId: string;
  sequence: number;
  occurredAtUtc: string;
  reference: SemanticRealtimeReference;
}

const SEMANTIC_REALTIME_CHANNEL = "semantic_realtime_v1";
const SEMANTIC_REALTIME_PARTITION = "room";

interface SemanticRealtimeOutboxRow extends Record<string, SqlStorageValue> {
  message_id: string;
  source_version: number;
  payload_json: string;
  not_before: number;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

/** Join the caller's already-open authoritative mutation transaction. */
export function enqueueSemanticRealtimeReference(
  sql: SqlStorage,
  reference: SemanticRealtimeReference,
  now: number,
): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("semantic_realtime_timestamp_invalid");
  }
  const authority = first(sql.exec<{
    authority_mode: string;
    authority_generation: number;
  } & Record<string, SqlStorageValue>>(
    `SELECT authority_mode, authority_generation FROM workstream WHERE id = 1`,
  ));
  // The storage component's SQL tests deliberately exercise transcript state
  // before a product root exists. A routed production mutation cannot reach
  // that state: the object boundary requires identity first. Once a root does
  // exist, use the same generation-zero/authoritative fence as room events.
  if (authority && authority.authority_generation !== 0
    && authority.authority_mode !== "authoritative") {
    throw new Error("workstream_realtime_authority_fenced");
  }
  const current = first(sql.exec<{
    event_sequence: number;
  } & Record<string, SqlStorageValue>>(
    `SELECT event_sequence FROM realtime_state WHERE id = 1`,
  ))?.event_sequence ?? 0;
  const sequence = Number(current) + 1;
  const occurredAtUtc = new Date(now).toISOString();
  const payloadJson = JSON.stringify({
    occurredAtUtc,
    reference: SemanticRealtimeReferenceSchema.parse(reference),
  });
  const messageId = `semantic-realtime:${sequence}`;
  sql.exec(
    `INSERT INTO realtime_state(id, event_sequence, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       event_sequence = excluded.event_sequence,
       updated_at = excluded.updated_at`,
    sequence,
    now,
  );
  sql.exec(
    `INSERT INTO durable_outbox
       (message_id, channel, destination_kind, destination_id, partition_key,
        source_version, source_epoch, contract_version, payload_json, payload_ref,
        payload_hash, state, attempts, not_before, created_at, acked_at)
     VALUES (?, ?, 'durable_object', 'self', ?, ?, ?, 1, ?, NULL, ?,
             'pending', 0, ?, ?, NULL)`,
    messageId,
    SEMANTIC_REALTIME_CHANNEL,
    SEMANTIC_REALTIME_PARTITION,
    sequence,
    authority?.authority_generation ?? 0,
    payloadJson,
    messageId,
    now,
    now,
  );
  return sequence;
}

export function dueSemanticRealtimeReferences(
  sql: SqlStorage,
  now = Date.now(),
  limit = 100,
): SequencedSemanticRealtimeReference[] {
  const rows = sql.exec<SemanticRealtimeOutboxRow>(
    `SELECT message_id, source_version, payload_json, not_before
       FROM durable_outbox
      WHERE channel = ? AND state IN ('pending', 'inflight')
      ORDER BY source_version, message_id
      LIMIT ?`,
    SEMANTIC_REALTIME_CHANNEL,
    Math.max(1, Math.min(limit, 100)),
  ).toArray();
  // A deferred predecessor still owns the room's next sequence. Filtering it
  // out in SQL would let a later due frame overtake it on the next drain.
  const blocked = rows.findIndex((row) => row.not_before > now);
  return rows.slice(0, blocked < 0 ? undefined : blocked).map((row) => {
    const payload = z.strictObject({
      occurredAtUtc: z.string().datetime({ offset: true }),
      reference: SemanticRealtimeReferenceSchema,
    }).parse(JSON.parse(row.payload_json));
    const sequence = Number(row.source_version);
    if (row.message_id !== `semantic-realtime:${sequence}`) {
      throw new Error("semantic_realtime_outbox_corrupt");
    }
    return {
      messageId: row.message_id,
      sequence,
      occurredAtUtc: payload.occurredAtUtc,
      reference: payload.reference,
    };
  });
}

export function acknowledgeSemanticRealtimeReference(
  sql: SqlStorage,
  messageId: string,
  sequence: number,
): boolean {
  return sql.exec<{ message_id: string } & Record<string, SqlStorageValue>>(
    `DELETE FROM durable_outbox
      WHERE channel = ? AND message_id = ? AND source_version = ?
      RETURNING message_id`,
    SEMANTIC_REALTIME_CHANNEL,
    messageId,
    sequence,
  ).toArray().length === 1;
}

export function deferSemanticRealtimeReference(
  sql: SqlStorage,
  messageId: string,
  sequence: number,
  notBefore: number,
): void {
  sql.exec(
    `UPDATE durable_outbox
        SET state = 'pending', attempts = attempts + 1, not_before = ?
      WHERE channel = ? AND message_id = ? AND source_version = ?
        AND state IN ('pending', 'inflight')`,
    notBefore,
    SEMANTIC_REALTIME_CHANNEL,
    messageId,
    sequence,
  );
}

export function nextSemanticRealtimeDueAt(sql: SqlStorage): number | null {
  return first(sql.exec<{ due_at: number | null } & Record<string, SqlStorageValue>>(
    `SELECT not_before AS due_at FROM durable_outbox
      WHERE channel = ? AND state IN ('pending', 'inflight')
      ORDER BY source_version, message_id LIMIT 1`,
    SEMANTIC_REALTIME_CHANNEL,
  ))?.due_at ?? null;
}
