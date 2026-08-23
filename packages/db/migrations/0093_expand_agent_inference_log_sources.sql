-- Block Dashboard and meeting-notes inference callers already identify
-- themselves with these sources. Keep the opt-in payload ledger's database
-- vocabulary in step with its typed runtime contract.
ALTER TABLE agent_inference_payload_logs
RENAME TO agent_inference_payload_logs_before_source_expansion;

CREATE TABLE agent_inference_payload_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  parent_request_id TEXT,
  workstream_id TEXT,
  turn_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (
    source IN (
      'workstream',
      'automation_compiler',
      'inline_child',
      'block_dashboard',
      'meeting_notes'
    )
  ),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_model TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  outcome TEXT CHECK (
    outcome IN ('success', 'retry', 'defect', 'fallback', 'failed', 'cancelled')
  ),
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

INSERT INTO agent_inference_payload_logs (
  id,
  workspace_id,
  request_id,
  parent_request_id,
  workstream_id,
  turn_id,
  source,
  provider,
  model,
  provider_model,
  metadata_json,
  object_key,
  payload_sha256,
  payload_bytes,
  outcome,
  failure_classification,
  latency_ms,
  ttft_ms,
  input_tokens,
  output_tokens,
  context_tokens,
  reasoning_tokens,
  cached_tokens,
  cost_microusd,
  response_bytes,
  created_at,
  completed_at
)
SELECT
  id,
  workspace_id,
  request_id,
  parent_request_id,
  workstream_id,
  turn_id,
  source,
  provider,
  model,
  provider_model,
  metadata_json,
  object_key,
  payload_sha256,
  payload_bytes,
  outcome,
  failure_classification,
  latency_ms,
  ttft_ms,
  input_tokens,
  output_tokens,
  context_tokens,
  reasoning_tokens,
  cached_tokens,
  cost_microusd,
  response_bytes,
  created_at,
  completed_at
FROM agent_inference_payload_logs_before_source_expansion;

DROP TABLE agent_inference_payload_logs_before_source_expansion;

CREATE INDEX idx_agent_inference_payload_logs_request
ON agent_inference_payload_logs(workspace_id, request_id, created_at DESC);

CREATE INDEX idx_agent_inference_payload_logs_workstream
ON agent_inference_payload_logs(workspace_id, workstream_id, created_at DESC);
