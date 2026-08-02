DROP INDEX IF EXISTS workstreams_sidebar_idx;

CREATE INDEX IF NOT EXISTS workstreams_sidebar_recency_idx
  ON workstreams(workspace_id, last_activity_at DESC)
  WHERE archived_at IS NULL;
