-- Global identity credentials. Provisioning is private to engineering MCP.
CREATE TABLE user_password_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

-- Addresses are hashed. Unknown addresses receive the same budget and work.
CREATE TABLE password_login_attempts (
  account_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX password_login_attempts_expiry_idx ON password_login_attempts(expires_at);
