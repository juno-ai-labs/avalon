-- A message in a Canvas's Chat can be reported: its conversation's parent kind
-- is `canvas` (docs/canvases.md). SQLite cannot widen a CHECK in place, so the
-- table is rebuilt; nothing references it.
CREATE TABLE message_issues_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  reporter_user_id TEXT NOT NULL,
  impersonator_user_id TEXT,
  session_id TEXT NOT NULL,
  region TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation', 'space', 'canvas')),
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

INSERT INTO message_issues_v2 SELECT * FROM message_issues;
DROP TABLE message_issues;
ALTER TABLE message_issues_v2 RENAME TO message_issues;
CREATE INDEX message_issues_message ON message_issues(workspace_id, parent_id, substream_id, message_id);
