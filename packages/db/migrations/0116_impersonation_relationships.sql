-- Identity delegation is regional control-plane authority, alongside membership.
CREATE TABLE impersonation_relationships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  represented_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  authority_basis TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (workspace_id, operator_user_id, represented_user_id)
);
