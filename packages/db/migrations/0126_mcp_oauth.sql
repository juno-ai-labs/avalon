-- Rally's user MCP server authorizes Claude, ChatGPT and other MCP clients
-- with OAuth 2.1. A grant is an ordinary workspace session, so membership,
-- incarnation, revocation and renewal all apply to it unchanged; these tables
-- only register the clients, hold the short-lived authorization codes, and
-- mark which sessions an MCP client holds. See `docs/rally-mcp.md`.
--
-- Migration-first: the Worker before this one never reads these tables.

-- One dynamically registered client (RFC 7591). Every client is public and
-- proves possession with PKCE, so nothing secret is stored.
CREATE TABLE mcp_oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL CHECK (json_valid(redirect_uris)),
  created_at TEXT NOT NULL
) STRICT;

-- An approved authorization request waiting for its code to be exchanged.
-- Only the code's hash is stored. A code is consumed once: the exchange sets
-- consumed_at in the same statement that reads it.
CREATE TABLE mcp_oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > created_at),
  consumed_at TEXT
) STRICT;

-- A session an MCP client holds. Its access tokens carry the `rally-mcp`
-- audience, which reaches only the routes the MCP server calls, and only the
-- MCP token endpoint refreshes it; the desktop refresh refuses it. A client
-- with grants cannot be deleted: the desktop refresh reads a session with no
-- grant as its own, so dropping the grant would hand the session the desktop
-- audience. Revoke the client's sessions first.
CREATE TABLE mcp_oauth_grants (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL
) STRICT;
