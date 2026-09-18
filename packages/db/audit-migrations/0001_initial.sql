-- Independent audit storage. Identity IDs are references, not cross-database foreign keys.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'workspace', 'system', 'connector')),
  actor_user_id TEXT,
  workstream_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX audit_events_workspace_idx ON audit_events(workspace_id, created_at DESC);
