-- Slack is both a user-scoped MCP connector and a workspace-scoped messaging
-- agent. D1 keeps foreign keys enabled inside its implicit migration
-- transaction, so dropping this FK parent immediately runs every CASCADE and
-- SET NULL action. Snapshot the exact affected rows/columns first and restore
-- them after the stable parent name exists again.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE _slack_restore_activities AS SELECT * FROM activities;
CREATE TABLE _slack_restore_activity_suggestions AS SELECT * FROM activity_suggestions;
CREATE TABLE _slack_restore_resource_watches AS SELECT * FROM resource_watches;
CREATE TABLE _slack_restore_schedules AS SELECT * FROM schedules;
CREATE TABLE _slack_restore_webhook_receipts AS SELECT * FROM webhook_receipts;
CREATE TABLE _slack_restore_resource_connections AS
  SELECT id, connection_id FROM resources WHERE connection_id IS NOT NULL;
CREATE TABLE _slack_restore_run_activities AS
  SELECT id, trigger_activity_id FROM automation_runs WHERE trigger_activity_id IS NOT NULL;
CREATE TABLE _slack_restore_tool_connections AS
  SELECT id, connection_id FROM tool_invocations WHERE connection_id IS NOT NULL;

CREATE TABLE connector_connections_with_slack (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('google', 'generic_webhook', 'github', 'linear', 'notion', 'slack')),
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

INSERT INTO connector_connections_with_slack
SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       NULL, NULL,
       granted_scopes_json, status, cursor_json, config_json, last_sync_at,
       next_poll_at, error_json, created_at, updated_at, model_plugin_id
FROM connector_connections;

DROP TABLE connector_connections;
ALTER TABLE connector_connections_with_slack RENAME TO connector_connections;

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

INSERT INTO activities SELECT * FROM _slack_restore_activities;
UPDATE resources
SET connection_id = (
  SELECT restored.connection_id FROM _slack_restore_resource_connections restored
  WHERE restored.id = resources.id
)
WHERE id IN (SELECT id FROM _slack_restore_resource_connections);
UPDATE automation_runs
SET trigger_activity_id = (
  SELECT restored.trigger_activity_id FROM _slack_restore_run_activities restored
  WHERE restored.id = automation_runs.id
)
WHERE id IN (SELECT id FROM _slack_restore_run_activities);
INSERT INTO activity_suggestions SELECT * FROM _slack_restore_activity_suggestions;
INSERT INTO resource_watches SELECT * FROM _slack_restore_resource_watches;
UPDATE tool_invocations
SET connection_id = (
  SELECT restored.connection_id FROM _slack_restore_tool_connections restored
  WHERE restored.id = tool_invocations.id
)
WHERE id IN (SELECT id FROM _slack_restore_tool_connections);
INSERT OR IGNORE INTO schedules SELECT * FROM _slack_restore_schedules;
INSERT INTO webhook_receipts SELECT * FROM _slack_restore_webhook_receipts;

DROP TABLE _slack_restore_activities;
DROP TABLE _slack_restore_activity_suggestions;
DROP TABLE _slack_restore_resource_watches;
DROP TABLE _slack_restore_schedules;
DROP TABLE _slack_restore_webhook_receipts;
DROP TABLE _slack_restore_resource_connections;
DROP TABLE _slack_restore_run_activities;
DROP TABLE _slack_restore_tool_connections;

PRAGMA defer_foreign_keys = OFF;

-- Global contains only the opaque team-to-region directory. A Slack team can
-- belong to one Avalon workspace, while one Avalon workspace may own many teams.
CREATE TABLE slack_installation_routes (
  team_id TEXT PRIMARY KEY CHECK (length(team_id) BETWEEN 2 AND 100),
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT
);

CREATE INDEX slack_installation_routes_active_idx
  ON slack_installation_routes(team_id, status, region);

CREATE TABLE slack_user_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, slack_user_id),
  UNIQUE (workspace_id, connection_id, user_id)
);

CREATE INDEX slack_user_links_user_idx
  ON slack_user_links(workspace_id, user_id, status);

CREATE TABLE slack_agent_contexts (
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, slack_user_id)
);

CREATE TABLE slack_delivery_preferences (
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_user_id TEXT NOT NULL,
  notify_needs_input INTEGER NOT NULL DEFAULT 1 CHECK (notify_needs_input IN (0, 1)),
  notify_automation_completed INTEGER NOT NULL DEFAULT 1 CHECK (notify_automation_completed IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, user_id)
);

CREATE TABLE slack_agent_feedback (
  id TEXT PRIMARY KEY,
  ingress_job_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  rating TEXT NOT NULL CHECK (rating IN ('helpful', 'needs_improvement')),
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE slack_link_challenges (
  token_hash TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE slack_agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  slack_stream_ts TEXT,
  last_delivery_key TEXT,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  context_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (connection_id, slack_channel_id, slack_thread_ts),
  UNIQUE (workstream_id)
);

CREATE INDEX slack_agent_sessions_workstream_idx
  ON slack_agent_sessions(workspace_id, workstream_id);

CREATE TABLE slack_agent_thread_claims (
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, slack_channel_id, slack_thread_ts)
);

CREATE TABLE slack_ingress_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('event', 'interaction', 'command')),
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_expires_at TEXT,
  error_code TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX slack_ingress_jobs_team_idx
  ON slack_ingress_jobs(team_id, received_at DESC);

-- Delivery is frozen when an automation is saved. The target is validated as
-- an active workspace bot installation linked to the personal automation owner.
CREATE TABLE automation_delivery_targets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('slack_agent_dm')),
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_input', 'disabled')),
  last_delivered_at TEXT,
  last_delivered_workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
  last_error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (automation_subscription_id, target_type)
);

CREATE INDEX automation_delivery_targets_connection_idx
  ON automation_delivery_targets(connection_id, status);
