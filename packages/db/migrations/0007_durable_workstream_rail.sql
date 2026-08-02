-- Keep the persisted background-task and output rail fast as work streams grow.
CREATE INDEX IF NOT EXISTS tool_invocations_workstream_idx
  ON tool_invocations(workspace_id, workstream_id, started_at DESC);

CREATE INDEX IF NOT EXISTS artifacts_workstream_idx
  ON artifacts(workspace_id, workstream_id, created_at DESC);
