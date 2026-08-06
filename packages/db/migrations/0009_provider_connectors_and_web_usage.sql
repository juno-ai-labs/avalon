PRAGMA defer_foreign_keys = ON;
PRAGMA legacy_alter_table = ON;

ALTER TABLE connector_connections RENAME TO connector_connections_before_provider_apps;

CREATE TABLE connector_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('google', 'generic_webhook', 'github', 'linear', 'notion')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider_account_id TEXT,
  display_name TEXT NOT NULL,
  encrypted_credentials TEXT,
  credential_iv TEXT,
  credential_key_version INTEGER,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  next_poll_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
);

INSERT INTO connector_connections (
  id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
  display_name, encrypted_credentials, credential_iv, credential_key_version,
  granted_scopes_json, status, cursor_json, config_json, last_sync_at,
  next_poll_at, error_json, created_at, updated_at
)
SELECT
  id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
  display_name, encrypted_credentials, credential_iv, credential_key_version,
  granted_scopes_json, status, cursor_json, config_json, last_sync_at,
  next_poll_at, error_json, created_at, updated_at
FROM connector_connections_before_provider_apps;

DROP TABLE connector_connections_before_provider_apps;

CREATE INDEX connector_connections_poll_idx
  ON connector_connections(workspace_id, next_poll_at, status);
CREATE INDEX connector_connections_provider_account_idx
  ON connector_connections(connector_type, provider_account_id, status);

PRAGMA legacy_alter_table = OFF;
PRAGMA defer_foreign_keys = OFF;

CREATE TABLE provider_webhook_challenges (
  provider TEXT NOT NULL CHECK (provider IN ('notion')),
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  encrypted_token TEXT NOT NULL,
  token_iv TEXT NOT NULL,
  credential_key_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (provider, region)
);

CREATE TABLE web_usage_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL CHECK (tool_name IN ('avalon.web_search', 'avalon.web_fetch')),
  url_count INTEGER NOT NULL CHECK (url_count > 0),
  credits_used REAL NOT NULL CHECK (credits_used >= 0),
  estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX web_usage_workspace_created_idx
  ON web_usage_log(workspace_id, created_at DESC);
