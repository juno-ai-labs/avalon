import { RegionSchema } from "@rally/contracts/regions";
import { z } from 'zod';
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from '@rally/contracts';

export const AuthorizationProjectionJobSchema = z.strictObject({
  type: z.literal('authorization_projection_v1'), region: RegionSchema,
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema.optional(), mutationAt: z.number().int().nonnegative().optional(),
});
export type AuthorizationProjectionJob = z.infer<typeof AuthorizationProjectionJobSchema>;

/** Triggers commit a reference alongside every attachment or membership change. */
export const AUTHORIZATION_PROJECTION_MIGRATION = [
  `CREATE TABLE authorization_projection_outbox (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, not_before INTEGER NOT NULL) STRICT`,
  ...['workstream', 'workstream_resource_links', 'participants', 'private_child_membership_authority'].flatMap((table) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER authorization_${table}_${operation.toLowerCase()}
      AFTER ${operation === 'UPDATE' && table === 'workstream' ? 'UPDATE OF scope' : operation} ON ${table} BEGIN
        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)
        ON CONFLICT(id) DO UPDATE SET revision = revision + 1;
      END`)),
  `INSERT INTO authorization_projection_outbox(id, revision, not_before)
   SELECT 1, 1, 0 WHERE EXISTS (SELECT 1 FROM workstream)`,
];

/** Preserve the earliest pending source mutation across coalescing and retries. */
export const AUTHORIZATION_PROJECTION_TIMING_MIGRATION = [
  `ALTER TABLE authorization_projection_outbox ADD COLUMN first_mutated_at INTEGER`,
  `CREATE TRIGGER authorization_projection_timestamp AFTER INSERT ON authorization_projection_outbox
   WHEN NEW.first_mutated_at IS NULL BEGIN
     UPDATE authorization_projection_outbox SET first_mutated_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE id = NEW.id;
   END`,
];

export function nextAuthorizationProjectionAt(sql: SqlStorage): number | null {
  return sql.exec<{ not_before: number }>('SELECT not_before FROM authorization_projection_outbox WHERE id = 1').toArray()[0]?.not_before ?? null;
}

export async function flushAuthorizationProjection(sql: SqlStorage, queue: Queue, job: AuthorizationProjectionJob): Promise<void> {
  const row = sql.exec<{ revision: number; first_mutated_at: number | null }>('SELECT revision, first_mutated_at FROM authorization_projection_outbox WHERE id = 1 AND not_before <= ?', Date.now()).toArray()[0];
  if (!row) return;
  try {
    await queue.send({ ...job, ...(row.first_mutated_at === null ? {} : { mutationAt: row.first_mutated_at }) });
    sql.exec('DELETE FROM authorization_projection_outbox WHERE id = 1 AND revision = ?', row.revision);
  } catch (error) {
    // Match the established regional outbox dispatch retry, rather than hot-looping an alarm.
    sql.exec('UPDATE authorization_projection_outbox SET not_before = ? WHERE id = 1', Date.now() + 5_000);
    throw error;
  }
}

/** Preserve same-key intent accepted while the previous batch is in flight. */
export async function flushAuthorizationDeliveries(sql: SqlStorage, queue: Queue, now: number): Promise<void> {
  // Cloudflare Queue sendBatch accepts at most 100 messages.
  const rows = sql.exec<{ job_key: string; payload_json: string; revision: number }>(
    'SELECT job_key, payload_json, revision FROM authorization_delivery WHERE not_before <= ? ORDER BY job_key LIMIT 100', now,
  ).toArray();
  if (!rows.length) return;
  try {
    await queue.sendBatch(rows.map((row) => ({ body: AuthorizationProjectionJobSchema.parse(JSON.parse(row.payload_json)) })));
    for (const row of rows) sql.exec('DELETE FROM authorization_delivery WHERE job_key = ? AND revision = ?', row.job_key, row.revision);
  } catch (error) {
    // A newer revision is still waiting on the same unavailable Queue; defer it too.
    for (const row of rows) sql.exec('UPDATE authorization_delivery SET not_before = ? WHERE job_key = ?', now + 5_000, row.job_key);
    throw error;
  }
}
