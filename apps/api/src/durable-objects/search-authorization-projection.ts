
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

/**
 * The keys memory search registered, a set per agent run, under a subject whose
 * `delegation` is `memory-search:v1:<run context>`. Nothing registers one since
 * memory search began checking each run with `resolveMemoryAccess`
 * (docs/text-search.md, 2026-09-28), and a key names its run, so none is read
 * again; each still cost a re-check on every push that reached its scope.
 *
 * The delegation is stored only in the snapshot, so the snapshot is how a key is
 * found, and the rows keyed by `cache_key` go with it. A push row is keyed by its
 * target, which for a memory key is the scope id in `resource_id`: it goes only
 * when no other key still names that target, and before the keys that find it.
 * The four tables declare no foreign keys between them.
 */
const MEMORY_SEARCH_KEY = `substr(json_extract(snapshot_json, '$.subject.delegation'), 1, 17) = 'memory-search:v1:'`;
const MEMORY_SEARCH_KEYS = `SELECT cache_key FROM authorization_snapshots WHERE ${MEMORY_SEARCH_KEY}`;
export const MEMORY_SEARCH_KEY_PURGE_MIGRATION = [
  `DELETE FROM search_authorization_push WHERE kind = 'resource'
    AND target_id IN (SELECT resource_id FROM search_authorization_keys WHERE cache_key IN (${MEMORY_SEARCH_KEYS}))
    AND NOT EXISTS (SELECT 1 FROM search_authorization_keys other
      WHERE other.resource_id = search_authorization_push.target_id AND other.cache_key NOT IN (${MEMORY_SEARCH_KEYS}))`,
  `DELETE FROM search_authorization_dependencies WHERE cache_key IN (${MEMORY_SEARCH_KEYS})`,
  `DELETE FROM search_authorization_keys WHERE cache_key IN (${MEMORY_SEARCH_KEYS})`,
  `DELETE FROM authorization_snapshots WHERE ${MEMORY_SEARCH_KEY}`,
];
