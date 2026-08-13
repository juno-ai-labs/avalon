-- Forward-only regional D1 migration. The migration runner applies each
-- filename once. If a rebase claims this sequence, renumber this migration and
-- its dependents instead of rerunning these ALTER TABLE statements.

ALTER TABLE resources ADD COLUMN content_sha256 TEXT;
ALTER TABLE resources ADD COLUMN model_content_status TEXT
  CHECK (model_content_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported'));
ALTER TABLE resources ADD COLUMN model_content_extractor_version TEXT;
ALTER TABLE resources ADD COLUMN model_content_character_count INTEGER
  CHECK (model_content_character_count IS NULL OR model_content_character_count >= 0);
ALTER TABLE resources ADD COLUMN model_content_extracted_at TEXT;
ALTER TABLE resources ADD COLUMN model_content_error_code TEXT;
ALTER TABLE resources ADD COLUMN model_content_claimed_at TEXT;
ALTER TABLE resources ADD COLUMN model_content_claim_id TEXT;

-- Checkpoints created before attachment visibility became principal-scoped are
-- unsafe to reuse. They are derived cache state, so discard them and recreate
-- the table with the execution principal in the primary key. This also permits
-- collaborators to retain independent checkpoints for one work stream.
DROP TABLE workstream_context_compactions;

CREATE TABLE workstream_context_compactions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  execution_principal_key TEXT NOT NULL,
  resource_visibility_fingerprint TEXT NOT NULL,
  checkpoint_template_version INTEGER NOT NULL DEFAULT 1
    CHECK (checkpoint_template_version >= 1),
  harness_run_id TEXT NOT NULL,
  compacted_through_sequence INTEGER NOT NULL CHECK (compacted_through_sequence >= 0),
  messages_json TEXT NOT NULL CHECK (json_valid(messages_json)),
  summary TEXT NOT NULL,
  model TEXT NOT NULL,
  context_tokens_before_compaction INTEGER NOT NULL CHECK (context_tokens_before_compaction >= 0),
  context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, execution_principal_key),
  UNIQUE (workspace_id, workstream_id, execution_principal_key)
);

CREATE INDEX idx_workstream_context_compactions_workspace
  ON workstream_context_compactions(workspace_id, updated_at DESC);

CREATE TABLE resource_object_deletion_outbox (
  object_ref TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('original', 'derivative', 'receipt')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_resource_object_deletion_outbox_created
  ON resource_object_deletion_outbox(created_at, object_ref);

-- Writers pre-register unique model generations in the outbox before R2 put.
-- A successful pointer compare-and-swap cancels that pending deletion and
-- enqueues the former pointer; failed/stale publishers remain reaper-owned.
CREATE TRIGGER resources_track_model_content_after_update
AFTER UPDATE OF model_content_ref ON resources
BEGIN
  DELETE FROM resource_object_deletion_outbox
   WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.model_content_ref;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.model_content_ref, OLD.workspace_id, OLD.id, 'derivative', datetime('now'), datetime('now')
    WHERE OLD.model_content_ref IS NOT NULL
      AND OLD.model_content_ref IS NOT NEW.model_content_ref;
END;

-- Connector refreshes replace original objects without deleting the resource.
-- Queue the former generation only after a successful compare-and-swap.
CREATE TRIGGER resources_track_original_after_update
AFTER UPDATE OF content_ref ON resources
WHEN OLD.content_ref IS NOT NEW.content_ref AND OLD.content_ref IS NOT NULL
BEGIN
  DELETE FROM resource_object_deletion_outbox
   WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.content_ref;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
    VALUES (OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now'));
END;

-- This trigger applies to every resource owner. Relationship detachment never
-- fires it; only deleting the resource's lifecycle row schedules object cleanup.
CREATE TRIGGER resources_enqueue_objects_before_delete
BEFORE DELETE ON resources
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

-- Tool-receipt dependencies are part of the same attachment lifecycle and are
-- tenant-scoped even when their invocation/resource identifiers are known.
CREATE TABLE attachment_tool_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,
  derivative_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, tool_invocation_id)
);

CREATE INDEX idx_attachment_tool_receipts_invocation
  ON attachment_tool_receipts(workspace_id, tool_invocation_id, resource_id);

CREATE TRIGGER resources_invalidate_attachment_receipts_before_delete
BEFORE DELETE ON resources
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

CREATE TRIGGER resources_invalidate_attachment_receipts_before_derivative_change
BEFORE UPDATE OF model_content_sha256 ON resources
WHEN OLD.model_content_sha256 IS NOT NEW.model_content_sha256
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
       AND receipt.derivative_sha256 IS NOT COALESCE(NEW.model_content_sha256, '')
       AND invocation.output_ref IS NOT NULL;

  DELETE FROM tool_invocations
   WHERE workspace_id = OLD.workspace_id
     AND id IN (
       SELECT tool_invocation_id
         FROM attachment_tool_receipts
        WHERE workspace_id = OLD.workspace_id
          AND resource_id = OLD.id
          AND derivative_sha256 IS NOT COALESCE(NEW.model_content_sha256, '')
     );
END;

-- One monotonic inventory revision makes cursor invalidation and compaction
-- stability O(1). It contains no principal data; checkpoints/cursors bind the
-- principal separately, while every relationship/resource/note mutation that
-- can change a principal's view advances the shared work-stream revision.
CREATE TABLE workstream_resource_inventory_revisions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, workstream_id)
);

CREATE TRIGGER workstream_resources_inventory_after_insert
AFTER INSERT ON workstream_resources
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT workspace_id, NEW.workstream_id, 1, datetime('now') FROM workstreams WHERE id = NEW.workstream_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER workstream_resources_inventory_after_update
AFTER UPDATE OF workstream_id, resource_id, relationship_type, attached_at ON workstream_resources
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT workspace_id, id, 1, datetime('now') FROM workstreams
   WHERE id IN (OLD.workstream_id, NEW.workstream_id)
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER workstream_resources_inventory_after_delete
AFTER DELETE ON workstream_resources
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT workspace_id, OLD.workstream_id, 1, datetime('now') FROM workstreams WHERE id = OLD.workstream_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER resources_inventory_after_update
AFTER UPDATE OF title, mime_type, content_ref, content_sha256 ON resources
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT NEW.workspace_id, wr.workstream_id, 1, datetime('now')
    FROM workstream_resources wr WHERE wr.resource_id = NEW.id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER notes_resource_inventory_after_insert
AFTER INSERT ON notes
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT NEW.workspace_id, wr.workstream_id, 1, datetime('now')
    FROM workstream_resources wr WHERE wr.resource_id = NEW.resource_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER notes_resource_inventory_after_update
AFTER UPDATE OF resource_id, scope, owner_user_id, archived_at ON notes
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT workstream.workspace_id, wr.workstream_id, 1, datetime('now')
    FROM workstream_resources wr
    JOIN workstreams workstream ON workstream.id = wr.workstream_id
   WHERE wr.resource_id IN (OLD.resource_id, NEW.resource_id)
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER notes_resource_inventory_after_delete
AFTER DELETE ON notes
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT OLD.workspace_id, wr.workstream_id, 1, datetime('now')
    FROM workstream_resources wr WHERE wr.resource_id = OLD.resource_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER message_attachments_inventory_after_insert
AFTER INSERT ON message_attachments
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT message.workspace_id, message.workstream_id, 1, datetime('now')
    FROM messages message WHERE message.id = NEW.message_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER message_attachments_inventory_before_delete
BEFORE DELETE ON message_attachments
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT message.workspace_id, message.workstream_id, 1, datetime('now')
    FROM messages message WHERE message.id = OLD.message_id
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER message_attachments_inventory_after_update
AFTER UPDATE ON message_attachments
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT message.workspace_id, message.workstream_id, 1, datetime('now')
    FROM messages message WHERE message.id IN (OLD.message_id, NEW.message_id)
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;

CREATE TRIGGER messages_attachment_inventory_after_update
AFTER UPDATE OF workspace_id, workstream_id ON messages
WHEN EXISTS (SELECT 1 FROM message_attachments WHERE message_id = NEW.id)
BEGIN
  INSERT INTO workstream_resource_inventory_revisions (workspace_id, workstream_id, revision, updated_at)
  SELECT workspace_id, id, 1, datetime('now') FROM workstreams
   WHERE id IN (OLD.workstream_id, NEW.workstream_id)
  ON CONFLICT(workstream_id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
END;
