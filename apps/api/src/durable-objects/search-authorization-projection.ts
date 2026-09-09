import type { Env } from '../env';
import { logInfo, logWarn } from '../observability/logger';

const changedColumns: Record<string, string[]> = {
  resources: ['provider', 'resource_type', 'uploaded_by_user_id', 'attachment_status', 'connection_id'],
  connector_connections: ['scope', 'owner_user_id', 'status'],
  notes: ['scope', 'owner_user_id', 'archived_at'],
  workspace_workstream_directory: ['scope', 'archived_at'],
  workspace_workstream_viewers: ['is_participant'],
  automation_directory: ['scope', 'author_user_id', 'owning_workstream_id', 'lifecycle', 'source_version'],
  // Inventories are republished by the child outbox on roster and attachment changes.
  authorization_inventories: ['validated_at'],
};
const targets: Record<string, { kind: string; column: string }> = {
  resources: { kind: 'resource', column: 'id' }, notes: { kind: 'resource', column: 'resource_id' },
  connector_connections: { kind: 'connection', column: 'id' },
  workspace_workstream_directory: { kind: 'parent', column: 'workstream_id' },
  workspace_workstream_viewers: { kind: 'parent', column: 'workstream_id' },
  automation_directory: { kind: 'parent', column: 'automation_id' },
  authorization_inventories: { kind: 'parent', column: 'parent_id' },
};
export const SEARCH_AUTHORIZATION_PUSH_MIGRATION = [
  `CREATE INDEX search_authorization_resources_connection ON resources(connection_id, provider, provider_resource_id, id)`,
  `CREATE TABLE search_authorization_keys (cache_key TEXT PRIMARY KEY, generation INTEGER NOT NULL,
    resource_id TEXT, parent_id TEXT) STRICT`,
  `CREATE INDEX search_authorization_keys_resource ON search_authorization_keys(resource_id, cache_key)`,
  `CREATE INDEX search_authorization_keys_parent ON search_authorization_keys(parent_id, cache_key)`,
  `CREATE TABLE search_authorization_dependencies (parent_id TEXT NOT NULL, cache_key TEXT NOT NULL,
    PRIMARY KEY(parent_id, cache_key)) STRICT`,
  `CREATE INDEX search_authorization_dependencies_key ON search_authorization_dependencies(cache_key)`,
  `CREATE TABLE search_authorization_push (kind TEXT NOT NULL, target_id TEXT NOT NULL, revision INTEGER NOT NULL,
    not_before INTEGER NOT NULL, first_mutated_at INTEGER, timing_origin TEXT NOT NULL, PRIMARY KEY(kind, target_id)) STRICT`,
  ...Object.entries(changedColumns).flatMap(([table, columns]) => ['INSERT', 'UPDATE', 'DELETE'].map((operation) => {
    const target = targets[table]!;
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    return `CREATE TRIGGER search_authz_${table}_${operation.toLowerCase()} AFTER ${operation === 'UPDATE' ? `UPDATE OF ${columns.join(', ')}` : operation} ON ${table}
     ${operation === 'UPDATE' && table !== 'authorization_inventories' ? `WHEN ${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}` : ''}
     BEGIN INSERT INTO search_authorization_push VALUES ('${target.kind}', ${row}.${target.column}, 1, 0, CAST(unixepoch('subsec') * 1000 AS INTEGER), 'workspace_mutation')
     ON CONFLICT(kind, target_id) DO UPDATE SET revision = revision + 1,
       timing_origin = CASE WHEN first_mutated_at IS NULL THEN excluded.timing_origin ELSE timing_origin END,
       first_mutated_at = COALESCE(first_mutated_at, excluded.first_mutated_at); END`;
  })),
];

export function nextSearchAuthorizationPush(sql: SqlStorage): number | null {
  return sql.exec<{ due: number | null }>('SELECT MIN(not_before) AS due FROM search_authorization_push').one().due;
}

export async function flushSearchAuthorizationPush(sql: SqlStorage, env: Env, workspaceId: string) {
  // Queue sendBatch accepts at most 100 messages; remaining intents stay durable.
  const rows = sql.exec<{ kind: string; target_id: string; revision: number; first_mutated_at: number | null; timing_origin: string }>(
    'SELECT kind, target_id, revision, first_mutated_at, timing_origin FROM search_authorization_push WHERE not_before <= ? LIMIT 100', Date.now()).toArray();
  if (!rows.length) return;
  const enqueuedAt = Date.now();
  try {
    await env.ACTIVITY_QUEUE.sendBatch(rows.map((row) => ({ body: { type: 'search_authorization_push_v1',
      region: env.AVALON_REGION, workspaceId, target: { kind: row.kind, id: row.target_id }, ...(row.first_mutated_at === null ? {} : { timing: { mutationAt: row.first_mutated_at, origin: row.timing_origin, enqueuedAt } }) } })));
    for (const row of rows) logInfo(env, 'authz_push_enqueued', { workspace_id: workspaceId, target_kind: row.kind, target_id: row.target_id,
      mutation_at: row.first_mutated_at, enqueued_at: enqueuedAt, outbox_ms: row.first_mutated_at === null ? null : enqueuedAt - row.first_mutated_at });
    for (const row of rows) sql.exec('DELETE FROM search_authorization_push WHERE kind = ? AND target_id = ? AND revision = ?',
      row.kind, row.target_id, row.revision);
  } catch (error) {
    logWarn(env, 'authz_push_enqueue_failed', { workspace_id: workspaceId, pending_targets: rows.length,
      oldest_pending_ms: rows.some((row) => row.first_mutated_at !== null) ? Date.now() - Math.min(...rows.flatMap((row) => row.first_mutated_at === null ? [] : [row.first_mutated_at])) : null });
    // Existing authorization outbox transport retry; this never expires a decision.
    for (const row of rows) sql.exec('UPDATE search_authorization_push SET not_before = ? WHERE kind = ? AND target_id = ?',
      Date.now() + 5_000, row.kind, row.target_id);
    throw error;
  }
}
