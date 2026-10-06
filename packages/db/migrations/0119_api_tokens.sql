-- API tokens. See docs/api-tokens.md.
--
-- A long-lived credential an operator mints for one user, traded at
-- POST /auth/token/exchange for an ordinary identity-only session. Only the
-- token's SHA-256 is stored. expires_at is nullable on purpose: a token's
-- lifetime is the team's number to set, and NULL is the open value.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT
) STRICT;
CREATE INDEX api_tokens_user_idx ON api_tokens(user_id);
