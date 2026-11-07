import { RegionSchema } from "@rally/contracts/regions";
import type { Env } from '../env';
import { searchIndexingConfigured } from '../services/search-embedding';
import { z } from 'zod';
import { SubstreamIdSchema, WorkspaceIdSchema, IdSchema } from '@rally/contracts';

export const SearchProjectionMessageSchema = z.strictObject({
  type: z.literal('search_projection_v1'),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  turnId: z.string().min(1),
  revision: z.number().int().positive(),
});

/**
 * A conversation's title or archive state changed. The job names the
 * conversation only; the consumer reads the current display from the object
 * and patches the index, so a stale delivery can never write an old title.
 */
export const SearchConversationProjectionMessageSchema = z.strictObject({
  type: z.literal('search_conversation_projection_v1'),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
});

const SEARCH_OUTBOX_CHANNELS = ['search_projection_v1', 'search_conversation_v1'] as const;
type SearchOutboxChannel = (typeof SEARCH_OUTBOX_CHANNELS)[number];

export function nextSearchProjectionDueAt(sql: SqlStorage, env?: Env): number | null {
  if (env && !searchIndexingConfigured(env)) return null;
  return sql.exec<{ due_at: number | null }>(
    `SELECT MIN(not_before) AS due_at FROM durable_outbox
     WHERE channel IN ('search_projection_v1', 'search_conversation_v1') AND state = 'pending'`,
  ).toArray()[0]?.due_at ?? null;
}

/** Queue messages contain references only; consumers reload the latest revision. */
export async function drainSearchProjectionOutbox(
  sql: SqlStorage,
  queue: Queue,
  identity: Omit<z.infer<typeof SearchProjectionMessageSchema>, 'type' | 'turnId' | 'revision'>,
): Promise<void> {
  for (const channel of SEARCH_OUTBOX_CHANNELS) await drainSearchChannel(sql, queue, identity, channel);
}

async function drainSearchChannel(
  sql: SqlStorage,
  queue: Queue,
  identity: Omit<z.infer<typeof SearchProjectionMessageSchema>, 'type' | 'turnId' | 'revision'>,
  channel: SearchOutboxChannel,
): Promise<void> {
  // Cloudflare's sendBatch maximum is 100 messages. References are bounded IDs.
  const rows = sql.exec<{ message_id: string; payload_json: string; source_version: number }>(
    `SELECT message_id, payload_json, source_version FROM durable_outbox
     WHERE channel = ? AND state = 'pending' AND not_before <= ?
     ORDER BY source_version LIMIT 100`, channel, Date.now(),
  ).toArray();
  if (!rows.length) return;
  try {
    await queue.sendBatch(rows.map((row) => ({ body: channel === 'search_projection_v1'
      ? SearchProjectionMessageSchema.parse({
        ...identity, type: 'search_projection_v1', revision: row.source_version,
        turnId: z.object({ turnId: z.string() }).parse(JSON.parse(row.payload_json)).turnId,
      })
      : SearchConversationProjectionMessageSchema.parse({ ...identity, type: 'search_conversation_projection_v1' }) })));
    for (const row of rows) sql.exec(
      `DELETE FROM durable_outbox WHERE channel = ? AND message_id = ? AND source_version = ?`, channel, row.message_id, row.source_version,
    );
  } catch (error) {
    // Same dispatch retry interval as the existing regional-effect outbox.
    for (const row of rows) sql.exec(
      `UPDATE durable_outbox SET attempts = attempts + 1, not_before = ?
       WHERE channel = ? AND message_id = ? AND source_version = ?`, Date.now() + 5_000, channel, row.message_id, row.source_version,
    );
    throw error;
  }
}


/** One pending reference per turn, committed by every transcript writer. */
export const TRANSCRIPT_SEARCH_MIGRATION_STATEMENTS = [
  ...(['INSERT', 'UPDATE', 'DELETE'] as const).map((operation) => {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    const revision = `${row}.revision${operation === 'DELETE' ? ' + 1' : ''}`;
    return `CREATE TRIGGER participant_turn_search_${operation.toLowerCase()}
      AFTER ${operation} ON participant_transcript_turns
      WHEN EXISTS (SELECT 1 FROM workstream WHERE id = 1)
      BEGIN
        INSERT INTO durable_outbox
          (message_id, channel, destination_kind, destination_id, partition_key,
           source_version, source_epoch, contract_version, payload_json, payload_ref,
           payload_hash, state, attempts, not_before, created_at, acked_at)
        VALUES ('search-turn:' || ${row}.turn_id, 'search_projection_v1', 'queue', 'activity', 'search',
          ${revision}, 0, 1, json_object('turnId', ${row}.turn_id), NULL,
          'search-turn:' || ${row}.turn_id, 'pending', 0, 0, ${row}.updated_at, NULL)
        ON CONFLICT(message_id) DO UPDATE SET source_version = excluded.source_version,
          state = 'pending', not_before = 0;
      END`;
  }),
  `INSERT INTO durable_outbox
    (message_id, channel, destination_kind, destination_id, partition_key,
     source_version, source_epoch, contract_version, payload_json, payload_ref,
     payload_hash, state, attempts, not_before, created_at, acked_at)
   SELECT 'search-turn:' || turn_id, 'search_projection_v1', 'queue', 'activity', 'search',
     revision, 0, 1, json_object('turnId', turn_id), NULL, 'search-turn:' || turn_id,
     'pending', 0, 0, updated_at, NULL
   FROM participant_transcript_turns WHERE EXISTS (SELECT 1 FROM workstream WHERE id = 1)`,
];

/**
 * Migration 52: the index carries each conversation's title and archive state
 * beside its text, so a rename or an archive must reach every indexed row.
 * One coalesced outbox row per conversation names the change; the consumer
 * reads the current display and patches. Existing turns are re-queued once so
 * rows written before the display attributes existed are rewritten with them.
 */
export const CONVERSATION_DISPLAY_SEARCH_MIGRATION_STATEMENTS = [
  `CREATE TRIGGER workstream_search_display_update
    AFTER UPDATE OF title, archived_at ON workstream
    WHEN NEW.title IS NOT OLD.title OR NEW.archived_at IS NOT OLD.archived_at
    BEGIN
      INSERT INTO durable_outbox
        (message_id, channel, destination_kind, destination_id, partition_key,
         source_version, source_epoch, contract_version, payload_json, payload_ref,
         payload_hash, state, attempts, not_before, created_at, acked_at)
      VALUES ('search-conversation', 'search_conversation_v1', 'queue', 'activity', 'search',
        NEW.updated_at, 0, 1, json_object(), NULL, 'search-conversation', 'pending', 0, 0, NEW.updated_at, NULL)
      ON CONFLICT(message_id) DO UPDATE SET source_version = excluded.source_version,
        state = 'pending', not_before = 0;
    END`,
  `INSERT INTO durable_outbox
    (message_id, channel, destination_kind, destination_id, partition_key,
     source_version, source_epoch, contract_version, payload_json, payload_ref,
     payload_hash, state, attempts, not_before, created_at, acked_at)
   SELECT 'search-turn:' || turn_id, 'search_projection_v1', 'queue', 'activity', 'search',
     revision, 0, 1, json_object('turnId', turn_id), NULL, 'search-turn:' || turn_id,
     'pending', 0, 0, updated_at, NULL
   FROM participant_transcript_turns WHERE EXISTS (SELECT 1 FROM workstream WHERE id = 1)
   ON CONFLICT(message_id) DO UPDATE SET
     source_version = MAX(excluded.source_version, durable_outbox.source_version),
     state = 'pending', not_before = 0`,
];

/**
 * Migration 53: the 2026-09-10 deploy dead-lettered document jobs whose
 * publish intent the outbox had already cleared (docs/text-search.md, "Version
 * skew between producers and the consumer"). The retry log names no turn, so
 * the lost rows cannot be listed; every committed turn is re-queued once
 * instead, the same pass migration 52 ran, at a cost already measured. The
 * statement is a copy of 52's rather than a shared constant: 52's text is
 * hashed into a receipt on every migrated object, and an edit to a shared
 * constant would fail every AgentLoopDO constructor in both regions.
 *
 * A delivered reference is recreated as pending; one still waiting keeps the
 * newer of the two revisions and becomes due now. The consumer rewrites each
 * lexical row in place and skips the embedding provider for every batch whose
 * chunk rows already exist; a turn whose document job never wrote them (one
 * that dead-lettered before its chunks were planned) is embedded as if new.
 * Only turns still in `participant_transcript_turns` are covered: a deletion
 * tombstone whose job dead-lettered is not repaired by this pass.
 */
export const CONVERSATION_SEARCH_REPROJECTION_MIGRATION_STATEMENTS = [
  `INSERT INTO durable_outbox
    (message_id, channel, destination_kind, destination_id, partition_key,
     source_version, source_epoch, contract_version, payload_json, payload_ref,
     payload_hash, state, attempts, not_before, created_at, acked_at)
   SELECT 'search-turn:' || turn_id, 'search_projection_v1', 'queue', 'activity', 'search',
     revision, 0, 1, json_object('turnId', turn_id), NULL, 'search-turn:' || turn_id,
     'pending', 0, 0, updated_at, NULL
   FROM participant_transcript_turns WHERE EXISTS (SELECT 1 FROM workstream WHERE id = 1)
   ON CONFLICT(message_id) DO UPDATE SET
     source_version = MAX(excluded.source_version, durable_outbox.source_version),
     state = 'pending', not_before = 0`,
];

/**
 * Migration 70: every message and captured link written before search rows
 * carried an audience (docs/PRDs/2026-09-26_search-audience-filtering) is
 * re-queued once so the consumer rewrites it with one. Links ride their turn's
 * job. A copy of 53's statement, not a shared constant, for 53's reason: each
 * migration's text is hashed into a receipt on every migrated object.
 *
 * A link whose capture failed before is captured again by this pass. Its
 * lexical row is written first, so it still gains an audience, but a capture
 * that fails again exhausts the Queue's retries and dead-letters; see
 * docs/text-search.md, Operations.
 */
export const CONVERSATION_SEARCH_AUDIENCE_MIGRATION_STATEMENTS = [
  `INSERT INTO durable_outbox
    (message_id, channel, destination_kind, destination_id, partition_key,
     source_version, source_epoch, contract_version, payload_json, payload_ref,
     payload_hash, state, attempts, not_before, created_at, acked_at)
   SELECT 'search-turn:' || turn_id, 'search_projection_v1', 'queue', 'activity', 'search',
     revision, 0, 1, json_object('turnId', turn_id), NULL, 'search-turn:' || turn_id,
     'pending', 0, 0, updated_at, NULL
   FROM participant_transcript_turns WHERE EXISTS (SELECT 1 FROM workstream WHERE id = 1)
   ON CONFLICT(message_id) DO UPDATE SET
     source_version = MAX(excluded.source_version, durable_outbox.source_version),
     state = 'pending', not_before = 0`,
];
