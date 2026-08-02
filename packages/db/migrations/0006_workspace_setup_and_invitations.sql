PRAGMA foreign_keys = ON;

ALTER TABLE oauth_states ADD COLUMN workspace_name TEXT;
ALTER TABLE oauth_states ADD COLUMN invitation_id TEXT REFERENCES workspace_invitations(id) ON DELETE SET NULL;

ALTER TABLE workspace_invitations
  ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member'));
ALTER TABLE workspace_invitations
  ADD COLUMN accepted_by_user_id TEXT REFERENCES users(id);
ALTER TABLE workspace_invitations ADD COLUMN revoked_at TEXT;

CREATE TRIGGER IF NOT EXISTS workspaces_region_immutable
BEFORE UPDATE OF region ON workspaces
WHEN NEW.region <> OLD.region
BEGIN
  SELECT RAISE(ABORT, 'workspace_region_immutable');
END;

CREATE INDEX IF NOT EXISTS workspace_invitations_workspace_idx
  ON workspace_invitations(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_active_email_idx
  ON workspace_invitations(workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
