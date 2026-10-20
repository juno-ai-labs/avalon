import { applyDurableObjectSqliteMigrations, type ApplyDurableObjectSqliteMigrationsOptions, type DurableObjectSqliteMigration } from './sqlite-migrations';

/** Keep deletion addresses, never meeting content, until every external copy is gone. */
export const MEETING_NOTES_RETIREMENT_MIGRATION: DurableObjectSqliteMigration = {
  version: 57,
  description: 'retire built-in meeting notes and preserve cleanup addresses',
  statements: [
    `CREATE TABLE retired_meeting_resources (
      resource_id TEXT PRIMARY KEY, note_id TEXT, content_ref TEXT, model_content_ref TEXT,
      objects_deleted INTEGER NOT NULL DEFAULT 0 CHECK (objects_deleted IN (0, 1))
    ) STRICT`,
    `INSERT INTO retired_meeting_resources(resource_id, note_id, content_ref, model_content_ref)
       SELECT r.id, n.id, r.content_ref, r.model_content_ref FROM resources r
       LEFT JOIN notes n ON n.resource_id = r.id WHERE r.provider = 'avalon_note' OR n.id IS NOT NULL`,
    `INSERT OR IGNORE INTO retired_meeting_resources(resource_id, content_ref, model_content_ref)
       SELECT resource_id, content_ref, model_content_ref FROM note_resource_deletion_outbox`,
    `DELETE FROM pending_attachment_reservations
       WHERE resource_id IN (SELECT resource_id FROM retired_meeting_resources)`,
    `DELETE FROM automation_resources
       WHERE resource_id IN (SELECT resource_id FROM retired_meeting_resources)`,
    `DELETE FROM project_default_resources
       WHERE resource_id IN (SELECT resource_id FROM retired_meeting_resources)`,
    // The existing resource triggers enqueue every currently referenced byte object.
    `DELETE FROM resources WHERE id IN (SELECT resource_id FROM retired_meeting_resources)`,
    `DELETE FROM note_transcript_segments`,
    `DELETE FROM notes`,
    `DELETE FROM note_privacy_change_outbox`,
    `DELETE FROM note_resource_deletion_outbox`,
    `DELETE FROM workspace_batch_dispatch_note_targets`,
    // Keep tables until external cleanup is verified; reject old writers immediately.
    `CREATE TRIGGER notes_retired BEFORE INSERT ON notes
       BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,
    `CREATE TRIGGER meeting_resources_retired BEFORE INSERT ON resources
       WHEN NEW.provider = 'avalon_note'
       BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,
    `CREATE TRIGGER meeting_resource_updates_retired BEFORE UPDATE ON resources
       WHEN NEW.provider = 'avalon_note'
       BEGIN SELECT RAISE(ABORT, 'meeting_notes_retired'); END`,
  ],
};

/** One resource per call; a failure leaves its address available for the next pass. */
export async function purgeRetiredMeetingObjects(
  storage: DurableObjectStorage,
  bucket: R2Bucket,
  region: string,
  workspaceId: string,
  resourceId?: string,
): Promise<{ remaining: number; deletedObjects: number }> {
  const row = storage.sql.exec<{
    resource_id: string; content_ref: string | null; model_content_ref: string | null;
  }>(resourceId
    ? 'SELECT resource_id, content_ref, model_content_ref FROM retired_meeting_resources WHERE resource_id = ?'
    : 'SELECT resource_id, content_ref, model_content_ref FROM retired_meeting_resources WHERE objects_deleted = 0 ORDER BY resource_id LIMIT 1',
    ...(resourceId ? [resourceId] : []),
  ).toArray()[0];
  let deletedObjects = 0;
  if (row) {
    // Reverification of a completed resource becomes pending before any external await.
    storage.sql.exec('UPDATE retired_meeting_resources SET objects_deleted = 0 WHERE resource_id = ?', row.resource_id);
    const prefix = `${region}/${workspaceId}/resources/${row.resource_id}/`;
    // Delete a page and list from the beginning again: no cursor can skip survivors.
    const page = await bucket.list({ prefix });
    if (page.objects.length) {
      await bucket.delete(page.objects.map((object) => object.key));
      deletedObjects += page.objects.length;
    }
    if (!page.truncated) {
      // Older objects may use a key outside the current versioned prefix.
      for (const ref of new Set([row.content_ref, row.model_content_ref])) {
        if (ref && await bucket.head(ref)) { await bucket.delete(ref); deletedObjects += 1; }
      }
      storage.sql.exec('UPDATE retired_meeting_resources SET objects_deleted = 1 WHERE resource_id = ?', row.resource_id);
    }
  }
  return {
    remaining: storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM retired_meeting_resources WHERE objects_deleted = 0').one().count,
    deletedObjects,
  };
}


/**
 * Commit retirement before considering finalization. A restored/populated
 * workspace must remain reachable at 57 so operator cleanup RPCs can run.
 * Keep the adopted-schema shim around 57 alone, never around other migrations.
 */
export function applyMeetingRetirementMigrations(
  options: ApplyDurableObjectSqliteMigrationsOptions,
): readonly number[] {
  const { storage } = options;
  const ledgerExists = storage.sql.exec("SELECT 1 FROM sqlite_schema WHERE name = '_sql_schema_migrations'").toArray().length > 0;
  const version = ledgerExists
    ? storage.sql.exec<{ version: number }>('SELECT COALESCE(MAX(version), 0) AS version FROM _sql_schema_migrations').one().version
    : 0;
  const applied: number[] = [];
  const applyThrough = (through: number) => applyDurableObjectSqliteMigrations({
    ...options, migrations: options.migrations.filter(m => m.version <= through),
  });
  if (version < 57) {
    applied.push(...applyThrough(56));
    applied.push(...withMeetingRetirementPrerequisites(storage, () => applyThrough(57)));
  }
  if (version < 58 && storage.sql.exec(`SELECT 1 FROM retired_meeting_resources WHERE objects_deleted = 0
    UNION ALL SELECT 1 FROM search_authorization_keys WHERE resource_id IN
      (SELECT resource_id FROM retired_meeting_resources) LIMIT 1`).toArray().length) {
    // Validate already-applied hashes even when cleanup prevents advancement.
    if (version === 57) applyThrough(57);
    return applied;
  }
  return [...applied, ...applyDurableObjectSqliteMigrations(options)];
}

/**
 * Older adopted workspaces omitted this already-retired Sidekick join table.
 * Migration 57 has shipped, so preserve its hash and supply an empty relation
 * only while its DELETE runs. The outer transaction never exposes the shim.
 */
function withMeetingRetirementPrerequisites<T>(storage: DurableObjectStorage, migrate: () => T): T {
  const sql = storage.sql;
  const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray().map(row => row.name));
  if (!tables.has('_sql_schema_migrations') || tables.has('automation_resources')
    || sql.exec('SELECT version FROM _sql_schema_migrations WHERE version = 57').toArray().length) return migrate();
  return storage.transactionSync(() => {
    sql.exec('CREATE TABLE automation_resources (resource_id TEXT) STRICT');
    const result = migrate();
    sql.exec('DROP TABLE automation_resources');
    return result;
  });
}

/** Apply only after external cleanup; a failed guard leaves the old schema intact. */
export const MEETING_NOTES_FINALIZATION_MIGRATION: DurableObjectSqliteMigration = {
  version: 58,
  description: 'drop retired meeting tables after verified external cleanup',
  statements: [
    `CREATE TABLE meeting_retirement_cleanup_guard (remaining INTEGER CHECK (remaining = 0)) STRICT`,
    `INSERT INTO meeting_retirement_cleanup_guard SELECT
      (SELECT COUNT(*) FROM retired_meeting_resources WHERE objects_deleted = 0) +
      (SELECT COUNT(*) FROM search_authorization_keys WHERE resource_id IN
        (SELECT resource_id FROM retired_meeting_resources))`,
    `DROP TABLE meeting_retirement_cleanup_guard`,
    `DELETE FROM resource_search_versions WHERE resource_id IN (SELECT resource_id FROM retired_meeting_resources)`,
    `DELETE FROM workspace_sidebar_list_state WHERE list = 'notes'`,
    `DROP TABLE note_transcript_segments`,
    `DROP TABLE note_privacy_change_outbox`,
    `DROP TABLE note_resource_deletion_outbox`,
    `DROP TABLE workspace_batch_dispatch_note_targets`,
    `DROP TABLE notes`,
  ],
};
