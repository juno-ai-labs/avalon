-- Inline sub-agents are durable harness runs, but they never participate in
-- the ordinary per-workstream admission queue or mutate workstream status.
-- `parent_harness_run_id` is already used by ordinary elicitation continuations;
-- a non-null parent tool-call receipt is therefore the inline-child discriminator
-- and the durable idempotency key for child admission.

ALTER TABLE harness_runs ADD COLUMN parent_tool_call_id TEXT;
ALTER TABLE harness_runs ADD COLUMN chain_root_harness_run_id TEXT REFERENCES harness_runs(id) ON DELETE CASCADE;
ALTER TABLE harness_runs ADD COLUMN chain_depth INTEGER NOT NULL DEFAULT 0 CHECK (chain_depth >= 0 AND chain_depth <= 16);
ALTER TABLE harness_runs ADD COLUMN delegated_task_hash TEXT;
ALTER TABLE harness_runs ADD COLUMN inherited_scope_hash TEXT;
ALTER TABLE harness_runs ADD COLUMN child_result_json TEXT;
ALTER TABLE harness_runs ADD COLUMN child_result_hash TEXT;

CREATE UNIQUE INDEX harness_runs_parent_tool_call_idx
  ON harness_runs(parent_harness_run_id, parent_tool_call_id)
  WHERE parent_harness_run_id IS NOT NULL AND parent_tool_call_id IS NOT NULL;

CREATE INDEX harness_runs_chain_idx
  ON harness_runs(chain_root_harness_run_id, chain_depth, created_at);

CREATE INDEX harness_runs_active_children_idx
  ON harness_runs(workspace_id, parent_harness_run_id, status, lease_expires_at)
  WHERE parent_tool_call_id IS NOT NULL;
