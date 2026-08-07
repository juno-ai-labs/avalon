CREATE TABLE IF NOT EXISTS connector_oauth_attempts (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'linear', 'notion', 'slack')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
  connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
  error_code TEXT,
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_oauth_attempts_expiry_idx
  ON connector_oauth_attempts(status, expires_at);
