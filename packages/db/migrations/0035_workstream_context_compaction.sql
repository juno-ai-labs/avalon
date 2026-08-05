CREATE TABLE workstream_context_compactions (
  workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
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
  UNIQUE (workspace_id, workstream_id)
);

CREATE INDEX idx_workstream_context_compactions_workspace
ON workstream_context_compactions(workspace_id, updated_at DESC);
