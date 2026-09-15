import type { DurableObjectSqliteMigration } from './sqlite-migrations';

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
