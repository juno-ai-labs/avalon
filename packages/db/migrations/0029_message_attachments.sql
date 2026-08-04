ALTER TABLE resources ADD COLUMN uploaded_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE resources ADD COLUMN attachment_status TEXT NOT NULL DEFAULT 'attached'
  CHECK (attachment_status IN ('draft', 'attached'));

CREATE TABLE IF NOT EXISTS message_attachments (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  attached_at TEXT NOT NULL,
  PRIMARY KEY (message_id, resource_id),
  UNIQUE (message_id, position)
);

CREATE INDEX IF NOT EXISTS message_attachments_resource_idx
  ON message_attachments(resource_id);

CREATE INDEX IF NOT EXISTS resources_draft_owner_idx
  ON resources(workspace_id, uploaded_by_user_id, attachment_status)
  WHERE provider = 'avalon_upload';
