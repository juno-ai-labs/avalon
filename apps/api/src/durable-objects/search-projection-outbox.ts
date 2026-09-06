import type { Env } from '../env';
import { searchIndexingConfigured } from '../services/search-embedding';
import { z } from 'zod';
import { SubstreamIdSchema, WorkspaceIdSchema, IdSchema } from '@rally/contracts';

export const SearchProjectionMessageSchema = z.strictObject({
  type: z.literal('search_projection_v1'),
  region: z.enum(['global', 'eu']),
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
  substreamId: SubstreamIdSchema,
  turnId: z.string().min(1),
  revision: z.number().int().positive(),
});

export function nextSearchProjectionDueAt(sql: SqlStorage, env?: Env): number | null {
  if (env && !searchIndexingConfigured(env)) return null;
  return sql.exec<{ due_at: number | null }>(
    `SELECT MIN(not_before) AS due_at FROM durable_outbox
     WHERE channel = 'search_projection_v1' AND state = 'pending'`,
  ).toArray()[0]?.due_at ?? null;
}

/** Queue messages contain references only; consumers reload the latest revision. */
export async function drainSearchProjectionOutbox(
  sql: SqlStorage,
  queue: Queue,
  identity: Omit<z.infer<typeof SearchProjectionMessageSchema>, 'type' | 'turnId' | 'revision'>,
): Promise<void> {
  // Cloudflare's sendBatch maximum is 100 messages. References are bounded IDs.
  const rows = sql.exec<{ message_id: string; payload_json: string; source_version: number }>(
    `SELECT message_id, payload_json, source_version FROM durable_outbox
     WHERE channel = 'search_projection_v1' AND state = 'pending' AND not_before <= ?
     ORDER BY source_version LIMIT 100`, Date.now(),
  ).toArray();
  if (!rows.length) return;
  try {
    await queue.sendBatch(rows.map((row) => ({ body: SearchProjectionMessageSchema.parse({
      ...identity, type: 'search_projection_v1', revision: row.source_version,
      turnId: z.object({ turnId: z.string() }).parse(JSON.parse(row.payload_json)).turnId,
    }) })));
    for (const row of rows) sql.exec(
      `DELETE FROM durable_outbox WHERE channel = 'search_projection_v1' AND message_id = ? AND source_version = ?`, row.message_id, row.source_version,
    );
  } catch (error) {
    // Same dispatch retry interval as the existing regional-effect outbox.
    for (const row of rows) sql.exec(
      `UPDATE durable_outbox SET attempts = attempts + 1, not_before = ?
       WHERE channel = 'search_projection_v1' AND message_id = ? AND source_version = ?`, Date.now() + 5_000, row.message_id, row.source_version,
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
