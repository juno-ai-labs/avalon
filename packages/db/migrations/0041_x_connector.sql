-- Add X to the connector type constraint while preserving every child row of
-- connector_connections across D1's required table rebuild.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE _x_restore_activities AS SELECT * FROM activities;
CREATE TABLE _x_restore_activity_suggestions AS SELECT * FROM activity_suggestions;
CREATE TABLE _x_restore_resource_watches AS SELECT * FROM resource_watches;
CREATE TABLE _x_restore_schedules AS SELECT * FROM schedules;
CREATE TABLE _x_restore_webhook_receipts AS SELECT * FROM webhook_receipts;
CREATE TABLE _x_restore_resource_connections AS
  SELECT id, connection_id FROM resources WHERE connection_id IS NOT NULL;
CREATE TABLE _x_restore_run_activities AS
  SELECT id, trigger_activity_id FROM automation_runs WHERE trigger_activity_id IS NOT NULL;
CREATE TABLE _x_restore_tool_connections AS
  SELECT id, connection_id FROM tool_invocations WHERE connection_id IS NOT NULL;
CREATE TABLE _x_restore_slack_user_links AS SELECT * FROM slack_user_links;
CREATE TABLE _x_restore_slack_agent_contexts AS SELECT * FROM slack_agent_contexts;
CREATE TABLE _x_restore_slack_delivery_preferences AS SELECT * FROM slack_delivery_preferences;
CREATE TABLE _x_restore_slack_agent_feedback AS SELECT * FROM slack_agent_feedback;
CREATE TABLE _x_restore_slack_link_challenges AS SELECT * FROM slack_link_challenges;
CREATE TABLE _x_restore_slack_agent_sessions AS SELECT * FROM slack_agent_sessions;
CREATE TABLE _x_restore_slack_agent_thread_claims AS SELECT * FROM slack_agent_thread_claims;
CREATE TABLE _x_restore_slack_ingress_jobs AS SELECT * FROM slack_ingress_jobs;
CREATE TABLE _x_restore_automation_delivery_targets AS SELECT * FROM automation_delivery_targets;

CREATE TABLE connector_connections_with_x (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('google', 'generic_webhook', 'github', 'linear', 'notion', 'slack', 'x')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider_account_id TEXT,
  display_name TEXT NOT NULL,
  encrypted_credentials TEXT,
  credential_iv TEXT,
  credential_key_version INTEGER,
  credential_refresh_lease_id TEXT,
  credential_refresh_lease_expires_at TEXT,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  next_poll_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  model_plugin_id TEXT NOT NULL,
  CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
);

INSERT INTO connector_connections_with_x
SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       credential_refresh_lease_id, credential_refresh_lease_expires_at,
       granted_scopes_json, status, cursor_json, config_json, last_sync_at,
       next_poll_at, error_json, created_at, updated_at, model_plugin_id
FROM connector_connections;

DROP TABLE connector_connections;
ALTER TABLE connector_connections_with_x RENAME TO connector_connections;

CREATE INDEX connector_connections_poll_idx
  ON connector_connections(workspace_id, next_poll_at, status);
CREATE INDEX connector_connections_provider_account_idx
  ON connector_connections(connector_type, provider_account_id, status);
CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
  ON connector_connections(workspace_id, model_plugin_id)
  WHERE status <> 'disabled';
CREATE UNIQUE INDEX connector_connections_linear_workspace_active_account_uq
  ON connector_connections(workspace_id, connector_type, provider_account_id)
  WHERE connector_type = 'linear' AND scope = 'workspace' AND status <> 'disabled';
CREATE UNIQUE INDEX connector_connections_linear_personal_active_account_uq
  ON connector_connections(workspace_id, connector_type, owner_user_id, provider_account_id)
  WHERE connector_type = 'linear' AND scope = 'personal' AND status <> 'disabled';
CREATE UNIQUE INDEX connector_connections_slack_workspace_active_team_uq
  ON connector_connections(connector_type, provider_account_id)
  WHERE connector_type = 'slack' AND scope = 'workspace' AND status <> 'disabled';
CREATE UNIQUE INDEX connector_connections_slack_personal_active_user_uq
  ON connector_connections(workspace_id, owner_user_id, provider_account_id)
  WHERE connector_type = 'slack' AND scope = 'personal' AND status <> 'disabled';

CREATE TRIGGER connector_connections_model_plugin_id_required_insert
BEFORE INSERT ON connector_connections
FOR EACH ROW
WHEN length(NEW.model_plugin_id) < 8
  OR length(NEW.model_plugin_id) > 70
  OR NEW.model_plugin_id NOT GLOB 'plugin_[a-z]*'
  OR substr(NEW.model_plugin_id, 8) GLOB '*[^a-z0-9_]*'
BEGIN
  SELECT RAISE(ABORT, 'connector_connections.model_plugin_id must match the API contract');
END;

CREATE TRIGGER connector_connections_model_plugin_id_required_update
BEFORE UPDATE OF model_plugin_id ON connector_connections
FOR EACH ROW
WHEN length(NEW.model_plugin_id) < 8
  OR length(NEW.model_plugin_id) > 70
  OR NEW.model_plugin_id NOT GLOB 'plugin_[a-z]*'
  OR substr(NEW.model_plugin_id, 8) GLOB '*[^a-z0-9_]*'
BEGIN
  SELECT RAISE(ABORT, 'connector_connections.model_plugin_id must match the API contract');
END;

CREATE TRIGGER connector_connections_web_monitor_removed_insert
BEFORE INSERT ON connector_connections
FOR EACH ROW WHEN NEW.connector_type = 'web_monitor'
BEGIN SELECT RAISE(ABORT, 'web_monitor connector has been removed'); END;

CREATE TRIGGER connector_connections_web_monitor_removed_update
BEFORE UPDATE OF connector_type ON connector_connections
FOR EACH ROW WHEN NEW.connector_type = 'web_monitor'
BEGIN SELECT RAISE(ABORT, 'web_monitor connector has been removed'); END;

INSERT INTO activities SELECT * FROM _x_restore_activities;
UPDATE resources
SET connection_id = (
  SELECT restored.connection_id FROM _x_restore_resource_connections restored
  WHERE restored.id = resources.id
)
WHERE id IN (SELECT id FROM _x_restore_resource_connections);
UPDATE automation_runs
SET trigger_activity_id = (
  SELECT restored.trigger_activity_id FROM _x_restore_run_activities restored
  WHERE restored.id = automation_runs.id
)
WHERE id IN (SELECT id FROM _x_restore_run_activities);
INSERT INTO activity_suggestions SELECT * FROM _x_restore_activity_suggestions;
INSERT INTO resource_watches SELECT * FROM _x_restore_resource_watches;
UPDATE tool_invocations
SET connection_id = (
  SELECT restored.connection_id FROM _x_restore_tool_connections restored
  WHERE restored.id = tool_invocations.id
)
WHERE id IN (SELECT id FROM _x_restore_tool_connections);
INSERT OR IGNORE INTO schedules SELECT * FROM _x_restore_schedules;
INSERT INTO webhook_receipts SELECT * FROM _x_restore_webhook_receipts;
INSERT INTO slack_user_links SELECT * FROM _x_restore_slack_user_links;
INSERT INTO slack_agent_contexts SELECT * FROM _x_restore_slack_agent_contexts;
INSERT INTO slack_delivery_preferences SELECT * FROM _x_restore_slack_delivery_preferences;
INSERT INTO slack_agent_feedback SELECT * FROM _x_restore_slack_agent_feedback;
INSERT INTO slack_link_challenges SELECT * FROM _x_restore_slack_link_challenges;
INSERT INTO slack_agent_sessions SELECT * FROM _x_restore_slack_agent_sessions;
INSERT INTO slack_agent_thread_claims SELECT * FROM _x_restore_slack_agent_thread_claims;
INSERT INTO slack_ingress_jobs SELECT * FROM _x_restore_slack_ingress_jobs;
INSERT INTO automation_delivery_targets SELECT * FROM _x_restore_automation_delivery_targets;

DROP TABLE _x_restore_activities;
DROP TABLE _x_restore_activity_suggestions;
DROP TABLE _x_restore_resource_watches;
DROP TABLE _x_restore_schedules;
DROP TABLE _x_restore_webhook_receipts;
DROP TABLE _x_restore_resource_connections;
DROP TABLE _x_restore_run_activities;
DROP TABLE _x_restore_tool_connections;
DROP TABLE _x_restore_slack_user_links;
DROP TABLE _x_restore_slack_agent_contexts;
DROP TABLE _x_restore_slack_delivery_preferences;
DROP TABLE _x_restore_slack_agent_feedback;
DROP TABLE _x_restore_slack_link_challenges;
DROP TABLE _x_restore_slack_agent_sessions;
DROP TABLE _x_restore_slack_agent_thread_claims;
DROP TABLE _x_restore_slack_ingress_jobs;
DROP TABLE _x_restore_automation_delivery_targets;

PRAGMA defer_foreign_keys = OFF;
