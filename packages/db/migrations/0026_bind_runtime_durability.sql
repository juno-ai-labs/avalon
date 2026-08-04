-- Bind 10 becomes the execution engine while D1 remains the durable authority.
-- This is a prototype cutover: unfinished pre-Bind attempts are failed in place
-- and historical messages remain untouched.

ALTER TABLE harness_runs ADD COLUMN attempt_id TEXT;
ALTER TABLE harness_runs ADD COLUMN attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0);
ALTER TABLE harness_runs ADD COLUMN lease_owner TEXT;
ALTER TABLE harness_runs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE harness_runs ADD COLUMN heartbeat_at TEXT;
ALTER TABLE harness_runs ADD COLUMN cancellation_requested_at TEXT;
ALTER TABLE harness_runs ADD COLUMN cancellation_reason TEXT;
ALTER TABLE harness_runs ADD COLUMN final_message_id TEXT;
ALTER TABLE harness_runs ADD COLUMN terminalized_at TEXT;

-- Agent final messages carry the durable attempt that was authorized to write
-- them. Historical display rows intentionally remain NULL during the clean
-- prototype cutover.
ALTER TABLE messages ADD COLUMN harness_run_id TEXT;
ALTER TABLE messages ADD COLUMN harness_attempt_id TEXT;

ALTER TABLE tool_invocations ADD COLUMN attempt_id TEXT;
ALTER TABLE tool_invocations ADD COLUMN execution_plan_hash TEXT;
ALTER TABLE tool_invocations ADD COLUMN execution_plan_json TEXT;
ALTER TABLE tool_invocations ADD COLUMN provider_idempotency_key TEXT;
ALTER TABLE tool_invocations ADD COLUMN lease_expires_at TEXT;
ALTER TABLE tool_invocations ADD COLUMN checkpoint_index INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_index >= 0);
ALTER TABLE tool_invocations ADD COLUMN last_checkpoint_at TEXT;

CREATE TABLE harness_run_scopes (
  harness_run_id TEXT PRIMARY KEY REFERENCES harness_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  execution_principal_json TEXT NOT NULL,
  eligible_connection_ids_json TEXT NOT NULL DEFAULT '[]',
  eligible_capabilities_json TEXT NOT NULL DEFAULT '[]',
  eligible_connection_capabilities_json TEXT NOT NULL DEFAULT '{}',
  trigger_policy_json TEXT NOT NULL DEFAULT '{}',
  routing_policy_version TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  tool_surface_hash TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  scope_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (harness_run_id, attempt_id)
);

CREATE TRIGGER harness_run_scopes_are_immutable
BEFORE UPDATE ON harness_run_scopes
BEGIN
  SELECT RAISE(ABORT, 'harness_run_scope_immutable');
END;

CREATE TABLE workstream_plugin_activation_hints (
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  last_authorized_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, plugin_id)
);

CREATE TABLE harness_run_plugin_activations (
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  tool_surface_hash TEXT NOT NULL,
  authorized_at TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (harness_run_id, plugin_id)
);

CREATE TABLE harness_run_lifecycle_events (
  id TEXT PRIMARY KEY,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT,
  member_safe_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (harness_run_id, event_key)
);

CREATE TRIGGER harness_run_lifecycle_events_are_immutable
BEFORE UPDATE ON harness_run_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'harness_run_lifecycle_event_immutable');
END;

CREATE TABLE inference_attempts (
  id TEXT PRIMARY KEY,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  endpoint_attempt INTEGER NOT NULL DEFAULT 1 CHECK (endpoint_attempt > 0),
  fallback_attempt INTEGER NOT NULL DEFAULT 0 CHECK (fallback_attempt >= 0),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  credential_source_hash TEXT,
  workspace_identity_hash TEXT NOT NULL,
  routing_decision_json TEXT NOT NULL DEFAULT '{}',
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'retry', 'defect', 'fallback', 'failed', 'cancelled')),
  failure_classification TEXT,
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  ttft_ms INTEGER CHECK (ttft_ms IS NULL OR ttft_ms >= 0),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  cached_tokens INTEGER CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
  cost_microusd INTEGER CHECK (cost_microusd IS NULL OR cost_microusd >= 0),
  response_bytes INTEGER CHECK (response_bytes IS NULL OR response_bytes >= 0),
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER inference_attempts_are_immutable
BEFORE UPDATE ON inference_attempts
BEGIN
  SELECT RAISE(ABORT, 'inference_attempt_immutable');
END;

CREATE TABLE tool_invocation_checkpoints (
  id TEXT PRIMARY KEY,
  tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  checkpoint_index INTEGER NOT NULL CHECK (checkpoint_index >= 0),
  phase TEXT NOT NULL,
  member_safe_payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tool_invocation_id, checkpoint_index)
);

CREATE TRIGGER tool_invocation_checkpoints_are_immutable
BEFORE UPDATE ON tool_invocation_checkpoints
BEGIN
  SELECT RAISE(ABORT, 'tool_invocation_checkpoint_immutable');
END;

CREATE INDEX harness_runs_active_lease_idx
  ON harness_runs(workspace_id, workstream_id, status, lease_expires_at);
CREATE INDEX harness_runs_stale_lease_idx
  ON harness_runs(status, lease_expires_at, terminalized_at);
CREATE INDEX harness_run_lifecycle_events_run_idx
  ON harness_run_lifecycle_events(harness_run_id, created_at);
CREATE INDEX inference_attempts_run_idx
  ON inference_attempts(harness_run_id, created_at);
CREATE INDEX inference_attempts_failure_idx
  ON inference_attempts(provider, model, outcome, failure_classification, created_at);
CREATE INDEX tool_invocation_checkpoints_invocation_idx
  ON tool_invocation_checkpoints(tool_invocation_id, checkpoint_index);

UPDATE harness_runs
SET status = 'failed',
    completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    error_json = '{"code":"runtime_cutover","message":"The prototype run ended during the Bind 10 runtime cutover"}',
    terminalized_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IN ('scheduled', 'running');

UPDATE automation_runs
SET status = 'failed',
    completed_at = COALESCE(completed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    result_summary = COALESCE(result_summary, 'Ended during the Bind 10 runtime cutover')
WHERE status IN ('scheduled', 'running');

UPDATE workstreams
SET harness_status = 'failed',
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE harness_status IN ('scheduled', 'running');
