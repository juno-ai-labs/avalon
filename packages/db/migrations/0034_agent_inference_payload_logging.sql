ALTER TABLE workspaces
ADD COLUMN log_agent_inference INTEGER NOT NULL DEFAULT 0
CHECK (log_agent_inference IN (0, 1));

CREATE TABLE agent_inference_payload_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  parent_request_id TEXT,
  workstream_id TEXT,
  turn_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('workstream', 'automation_compiler', 'inline_child')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  outcome TEXT CHECK (outcome IN ('success', 'retry', 'defect', 'fallback', 'failed', 'cancelled')),
  failure_classification TEXT,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  context_tokens INTEGER,
  reasoning_tokens INTEGER,
  cached_tokens INTEGER,
  cost_microusd INTEGER,
  response_bytes INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_agent_inference_payload_logs_request
ON agent_inference_payload_logs(workspace_id, request_id, created_at DESC);

CREATE INDEX idx_agent_inference_payload_logs_workstream
ON agent_inference_payload_logs(workspace_id, workstream_id, created_at DESC);
