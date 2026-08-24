-- The regional inference lakehouse supersedes the workspace-opt-in D1 index
-- and its request-only R2 objects. Runtime inference_attempts remain in each
-- owning SubstreamAgent's SQLite; this migration removes only the regional
-- diagnostic path and its no-longer-exposed workspace preference.
DROP TABLE agent_inference_payload_logs;

ALTER TABLE workspaces
DROP COLUMN log_agent_inference;
