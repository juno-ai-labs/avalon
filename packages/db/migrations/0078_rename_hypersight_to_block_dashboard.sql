-- Migration identity is the complete filename. Keep the already-deployed
-- 0043_hypersight.sql immutable and move its internal persistence vocabulary
-- forward here instead of making D1 treat a renamed historical file as new.

ALTER TABLE hypersight_configuration_versions
  RENAME TO block_dashboard_configuration_versions;
ALTER TABLE hypersight_user_preferences
  RENAME TO block_dashboard_user_preferences;
ALTER TABLE hypersight_block_runs
  RENAME TO block_dashboard_block_runs;

DROP INDEX hypersight_configuration_versions_latest_idx;
CREATE INDEX block_dashboard_configuration_versions_latest_idx
  ON block_dashboard_configuration_versions(workspace_id, workstream_id, version_number DESC);

DROP TRIGGER hypersight_configuration_versions_are_immutable;
CREATE TRIGGER block_dashboard_configuration_versions_are_immutable
BEFORE UPDATE ON block_dashboard_configuration_versions
BEGIN
  SELECT RAISE(ABORT, 'block_dashboard_configuration_version_immutable');
END;

DROP INDEX hypersight_user_preferences_user_idx;
CREATE INDEX block_dashboard_user_preferences_user_idx
  ON block_dashboard_user_preferences(workspace_id, user_id, updated_at DESC);

DROP INDEX hypersight_block_runs_latest_idx;
CREATE INDEX block_dashboard_block_runs_latest_idx
  ON block_dashboard_block_runs(workspace_id, workstream_id, block_id, created_at DESC);

DROP INDEX hypersight_block_runs_harness_idx;
CREATE INDEX block_dashboard_block_runs_harness_idx
  ON block_dashboard_block_runs(harness_run_id);
