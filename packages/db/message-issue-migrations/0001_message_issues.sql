CREATE TABLE message_issues (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  impersonator_user_id TEXT,
  session_id TEXT NOT NULL,
  region TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space')),
  parent_id TEXT NOT NULL,
  substream_id TEXT,
  thread_id TEXT,
  breakout_id TEXT,
  channel_id TEXT,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  request_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX message_issues_message ON message_issues(workspace_id, parent_id, substream_id, message_id);
