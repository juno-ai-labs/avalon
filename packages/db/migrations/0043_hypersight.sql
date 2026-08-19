CREATE TABLE hypersight_configuration_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json)),
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE (workstream_id, version_number)
);

CREATE INDEX hypersight_configuration_versions_latest_idx
  ON hypersight_configuration_versions(workspace_id, workstream_id, version_number DESC);

CREATE TRIGGER hypersight_configuration_versions_are_immutable
BEFORE UPDATE ON hypersight_configuration_versions
BEGIN
  SELECT RAISE(ABORT, 'hypersight_configuration_version_immutable');
END;

CREATE TABLE hypersight_user_preferences (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  visible INTEGER NOT NULL DEFAULT 0 CHECK (visible IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, user_id)
);

CREATE INDEX hypersight_user_preferences_user_idx
  ON hypersight_user_preferences(workspace_id, user_id, updated_at DESC);

CREATE TABLE hypersight_block_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  configuration_version_id TEXT NOT NULL REFERENCES hypersight_configuration_versions(id) ON DELETE CASCADE,
  block_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
  harness_run_id TEXT NOT NULL UNIQUE REFERENCES harness_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stopped')),
  markdown TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (configuration_version_id, block_id, trigger_sequence)
);

CREATE INDEX hypersight_block_runs_latest_idx
  ON hypersight_block_runs(workspace_id, workstream_id, block_id, created_at DESC);

CREATE INDEX hypersight_block_runs_harness_idx
  ON hypersight_block_runs(harness_run_id);
