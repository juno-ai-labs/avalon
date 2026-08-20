-- The last thing standing between the verified scrub and an open region.
--
-- These eight triggers are legacy bookkeeping: they re-enqueue R2 object
-- cleanup and bump work-stream resource inventory revisions whenever a note,
-- resource, attachment, or work-stream resource link is deleted or retargeted.
-- The scrub deletes exactly those rows, so each one fires mid-scrub and writes
-- into `resource_object_deletion_outbox`, `note_resource_deletion_outbox`, or
-- `workstream_resource_inventory_revisions` — all fenced — aborting activation
-- with `workspace_do_authoritative` after every route had already imported and
-- verified. Emptying the outboxes first, as the scrub does, cannot help: the
-- deletes themselves refill them.
--
-- Relaxing those fences would be the wrong repair. WorkspaceDO owns object
-- lifecycle and resource inventory after the cutover, so a D1 row written here
-- is precisely the second authority the fences exist to prevent — it would
-- schedule the deletion of an R2 object the object store still considers live.
-- Each trigger is instead confined to the phases where D1 is still the
-- authority, which is the only window in which its work means anything.


DROP TRIGGER message_attachments_inventory_before_delete;
CREATE TRIGGER message_attachments_inventory_before_delete
BEFORE DELETE ON message_attachments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT message.workspace_id, message.workstream_id, 1, datetime('now')
    FROM messages message WHERE message.id = OLD.message_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

DROP TRIGGER notes_resource_inventory_after_delete;
CREATE TRIGGER notes_resource_inventory_after_delete
AFTER DELETE ON notes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT OLD.workspace_id, wr.workstream_id, 1, datetime('now')
    FROM workstream_resources wr WHERE wr.resource_id = OLD.resource_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

DROP TRIGGER workstream_resources_inventory_after_delete;
CREATE TRIGGER workstream_resources_inventory_after_delete
AFTER DELETE ON workstream_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT workspace_id, OLD.workstream_id, 1, datetime('now') FROM workstreams WHERE id = OLD.workstream_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

DROP TRIGGER note_resources_enqueue_before_delete;
CREATE TRIGGER note_resources_enqueue_before_delete
BEFORE DELETE ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
  AND (OLD.provider = 'avalon_note')
BEGIN
  INSERT OR IGNORE INTO note_resource_deletion_outbox
    (resource_id, content_ref, model_content_ref, created_at)
    VALUES (OLD.id, OLD.content_ref, OLD.model_content_ref, datetime('now'));
END;

DROP TRIGGER resources_enqueue_objects_before_delete;
CREATE TRIGGER resources_enqueue_objects_before_delete
BEFORE DELETE ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
BEGIN
  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now')
    WHERE OLD.content_ref IS NOT NULL;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.model_content_ref, OLD.workspace_id, OLD.id, 'derivative', datetime('now'), datetime('now')
    WHERE OLD.model_content_ref IS NOT NULL;

END;

DROP TRIGGER resources_invalidate_attachment_receipts_before_delete;
CREATE TRIGGER resources_invalidate_attachment_receipts_before_delete
BEFORE DELETE ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
BEGIN
  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    SELECT invocation.output_ref, OLD.workspace_id, OLD.id, 'receipt', datetime('now'), datetime('now')
      FROM attachment_tool_receipts receipt
      JOIN tool_invocations invocation
        ON invocation.id = receipt.tool_invocation_id
       AND invocation.workspace_id = receipt.workspace_id
     WHERE receipt.workspace_id = OLD.workspace_id
       AND receipt.resource_id = OLD.id
       AND invocation.output_ref IS NOT NULL;

  DELETE FROM tool_invocations
   WHERE workspace_id = OLD.workspace_id
     AND id IN (
       SELECT tool_invocation_id FROM attachment_tool_receipts
        WHERE workspace_id = OLD.workspace_id AND resource_id = OLD.id
     );
END;

DROP TRIGGER resources_track_model_content_after_update;
CREATE TRIGGER resources_track_model_content_after_update
AFTER UPDATE OF model_content_ref ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
BEGIN
  DELETE FROM resource_object_deletion_outbox
   WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.model_content_ref;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.model_content_ref, OLD.workspace_id, OLD.id, 'derivative', datetime('now'), datetime('now')
    WHERE OLD.model_content_ref IS NOT NULL
      AND OLD.model_content_ref IS NOT NEW.model_content_ref;
END;

DROP TRIGGER resources_track_original_after_update;
CREATE TRIGGER resources_track_original_after_update
AFTER UPDATE OF content_ref ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  IN ('legacy_open', 'maintenance_draining')
  AND (OLD.content_ref IS NOT NEW.content_ref AND OLD.content_ref IS NOT NULL)
BEGIN
  DELETE FROM resource_object_deletion_outbox
   WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.content_ref;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    VALUES (OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now'));
END;
