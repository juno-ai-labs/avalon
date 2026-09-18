-- Browser credentials address ordinary sessions; workspace selection is per request.
CREATE TABLE browser_sessions (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  credential_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE browser_workspace_sessions (
  browser_session_id TEXT NOT NULL REFERENCES browser_sessions(session_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
  PRIMARY KEY (browser_session_id, workspace_id)
);
