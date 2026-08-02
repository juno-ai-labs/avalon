PRAGMA foreign_keys = OFF;

-- A person can authenticate before choosing or joining an organization. The
-- session is bound to a workspace only after setup or invitation acceptance.
CREATE TABLE sessions_identity_first (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  refresh_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO sessions_identity_first
  (id, user_id, workspace_id, region, refresh_token_hash, expires_at, revoked_at, created_at)
SELECT id, user_id, workspace_id, region, refresh_token_hash, expires_at, revoked_at, created_at
FROM sessions;

DROP TABLE sessions;
ALTER TABLE sessions_identity_first RENAME TO sessions;
CREATE INDEX sessions_user_idx ON sessions(user_id, expires_at);

CREATE TABLE desktop_login_tickets_identity_first (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  desktop_attempt_id TEXT,
  desktop_code_challenge TEXT
);

INSERT INTO desktop_login_tickets_identity_first
  (id, ticket_hash, user_id, workspace_id, region, expires_at, consumed_at, created_at,
   desktop_attempt_id, desktop_code_challenge)
SELECT id, ticket_hash, user_id, workspace_id, region, expires_at, consumed_at, created_at,
       desktop_attempt_id, desktop_code_challenge
FROM desktop_login_tickets;

DROP TABLE desktop_login_tickets;
ALTER TABLE desktop_login_tickets_identity_first RENAME TO desktop_login_tickets;
CREATE UNIQUE INDEX desktop_login_tickets_attempt_idx
  ON desktop_login_tickets(desktop_attempt_id)
  WHERE desktop_attempt_id IS NOT NULL;

PRAGMA foreign_keys = ON;
