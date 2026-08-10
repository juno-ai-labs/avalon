CREATE TABLE notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
  scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'workspace')),
  title TEXT NOT NULL,
  recording_status TEXT NOT NULL DEFAULT 'idle'
    CHECK (recording_status IN ('idle', 'recording', 'complete')),
  manual_notes_markdown TEXT NOT NULL DEFAULT '',
  live_notes_markdown TEXT NOT NULL DEFAULT '',
  notes_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (notes_through_sequence >= 0),
  next_segment_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_segment_sequence >= 1),
  recorded_ms INTEGER NOT NULL DEFAULT 0 CHECK (recorded_ms >= 0),
  started_at TEXT,
  ended_at TEXT,
  generated_at TEXT,
  privacy_changed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE INDEX notes_sidebar_idx
  ON notes(workspace_id, archived_at, last_activity_at DESC, id DESC);

CREATE INDEX notes_owner_idx
  ON notes(workspace_id, owner_user_id, archived_at, last_activity_at DESC);

CREATE TABLE note_transcript_segments (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  client_segment_id TEXT NOT NULL,
  sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
  start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
  end_offset_ms INTEGER NOT NULL CHECK (end_offset_ms >= start_offset_ms),
  captured_at TEXT NOT NULL,
  speaker_label TEXT,
  text_content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(note_id, client_segment_id),
  UNIQUE(note_id, sequence_number)
);

CREATE INDEX note_transcript_segments_note_sequence_idx
  ON note_transcript_segments(note_id, sequence_number);

CREATE TABLE automation_resources (
  automation_subscription_id TEXT NOT NULL
    REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  attached_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  relationship_type TEXT NOT NULL DEFAULT 'context',
  attached_at TEXT NOT NULL,
  PRIMARY KEY (automation_subscription_id, resource_id)
);

CREATE INDEX automation_resources_resource_idx
  ON automation_resources(resource_id, automation_subscription_id);

CREATE TABLE note_privacy_change_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  note_title TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
);

CREATE INDEX note_privacy_change_outbox_pending_idx
  ON note_privacy_change_outbox(processed_at, created_at);

CREATE TRIGGER notes_enqueue_public_to_private_change
AFTER UPDATE OF scope ON notes
WHEN OLD.scope = 'workspace' AND NEW.scope = 'personal'
BEGIN
  INSERT INTO note_privacy_change_outbox
    (id, workspace_id, note_id, resource_id, note_title, actor_user_id, created_at, processed_at)
    VALUES (
      lower(hex(randomblob(16))),
      NEW.workspace_id,
      NEW.id,
      NEW.resource_id,
      NEW.title,
      COALESCE(NEW.privacy_changed_by_user_id, NEW.owner_user_id),
      NEW.updated_at,
      NULL
    );
END;

CREATE TABLE note_resource_deletion_outbox (
  resource_id TEXT PRIMARY KEY,
  content_ref TEXT,
  model_content_ref TEXT,
  created_at TEXT NOT NULL
);

-- A note is the owner of its Avalon resource. This also handles cascaded note
-- deletion (for example, when its creator is deleted) without leaving readable
-- resource metadata attached to an automation. R2 cleanup is durable through
-- the outbox because a SQLite trigger cannot call the object-store API.
CREATE TRIGGER note_resources_enqueue_before_delete
BEFORE DELETE ON resources
WHEN OLD.provider = 'avalon_note'
BEGIN
  INSERT OR IGNORE INTO note_resource_deletion_outbox
    (resource_id, content_ref, model_content_ref, created_at)
    VALUES (OLD.id, OLD.content_ref, OLD.model_content_ref, datetime('now'));
END;

CREATE TRIGGER notes_delete_owned_resource
AFTER DELETE ON notes
BEGIN
  DELETE FROM resources WHERE id = OLD.resource_id AND provider = 'avalon_note';
END;
