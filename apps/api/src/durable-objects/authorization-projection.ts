import { z } from 'zod';
import { IdSchema, SubstreamIdSchema, WorkspaceIdSchema } from '@rally/contracts';

export const AuthorizationProjectionJobSchema = z.strictObject({
  type: z.literal('authorization_projection_v1'), region: z.enum(['global', 'eu']),
  workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamId: SubstreamIdSchema.optional(),
});
export type AuthorizationProjectionJob = z.infer<typeof AuthorizationProjectionJobSchema>;

/** Triggers commit a reference alongside every attachment or membership change. */
export const AUTHORIZATION_PROJECTION_MIGRATION = [
  `CREATE TABLE authorization_projection_outbox (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, not_before INTEGER NOT NULL) STRICT`,
  ...['workstream', 'workstream_resource_links', 'participants', 'private_child_membership_authority'].flatMap((table) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER authorization_${table}_${operation.toLowerCase()}
      AFTER ${operation === 'UPDATE' && table === 'workstream' ? 'UPDATE OF scope' : operation} ON ${table} BEGIN
        INSERT INTO authorization_projection_outbox(id, revision, not_before) VALUES (1, 1, 0)
        ON CONFLICT(id) DO UPDATE SET revision = revision + 1, not_before = 0;
      END`)),
  `INSERT INTO authorization_projection_outbox(id, revision, not_before)
   SELECT 1, 1, 0 WHERE EXISTS (SELECT 1 FROM workstream)`,
];

export function nextAuthorizationProjectionAt(sql: SqlStorage): number | null {
  return sql.exec<{ not_before: number }>('SELECT not_before FROM authorization_projection_outbox WHERE id = 1').toArray()[0]?.not_before ?? null;
}

export async function flushAuthorizationProjection(sql: SqlStorage, queue: Queue, job: AuthorizationProjectionJob): Promise<void> {
  const row = sql.exec<{ revision: number }>('SELECT revision FROM authorization_projection_outbox WHERE id = 1 AND not_before <= ?', Date.now()).toArray()[0];
  if (!row) return;
  try {
    await queue.send(job);
    sql.exec('DELETE FROM authorization_projection_outbox WHERE id = 1 AND revision = ?', row.revision);
  } catch (error) {
    // Match the established regional outbox dispatch retry, rather than hot-looping an alarm.
    sql.exec('UPDATE authorization_projection_outbox SET not_before = ? WHERE id = 1 AND revision = ?', Date.now() + 5_000, row.revision);
    throw error;
  }
}
