ALTER TABLE workstreams ADD COLUMN latest_attention_sequence_number INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workstreams ADD COLUMN unread_tracking_start_sequence_number INTEGER NOT NULL DEFAULT 0;

UPDATE workstreams
SET latest_attention_sequence_number = COALESCE((
      SELECT MAX(messages.sequence_number)
      FROM messages
      WHERE messages.workstream_id = workstreams.id
        AND messages.message_type <> 'tool'
        AND messages.author_type IN ('human', 'agent', 'system')
    ), 0),
    -- Do not light up every historical work stream as unread on rollout. This
    -- baseline applies only until a user gets their own durable read cursor.
    unread_tracking_start_sequence_number = COALESCE((
      SELECT MAX(messages.sequence_number)
      FROM messages
      WHERE messages.workstream_id = workstreams.id
        AND messages.message_type <> 'tool'
        AND messages.author_type IN ('human', 'agent', 'system')
    ), 0);

CREATE TABLE workstream_read_states (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_through_sequence_number INTEGER NOT NULL DEFAULT 0
    CHECK (read_through_sequence_number >= 0),
  manual_unread_from_sequence_number INTEGER
    CHECK (manual_unread_from_sequence_number IS NULL OR manual_unread_from_sequence_number >= 0),
  manual_unread_generation INTEGER NOT NULL DEFAULT 0
    CHECK (manual_unread_generation >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, user_id)
);

CREATE INDEX workstream_read_states_user_idx
ON workstream_read_states(workspace_id, user_id, updated_at DESC);
