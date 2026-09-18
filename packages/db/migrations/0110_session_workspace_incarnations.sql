-- A session belongs to the membership that admitted it. Removing somebody and
-- inviting them again must not revive credentials from their earlier access.
ALTER TABLE sessions ADD COLUMN workspace_incarnation TEXT;

UPDATE sessions SET workspace_incarnation = (
  SELECT incarnation FROM workspace_members
  WHERE workspace_members.workspace_id = sessions.workspace_id
    AND workspace_members.user_id = sessions.user_id
) WHERE workspace_id IS NOT NULL;

CREATE TRIGGER sessions_bind_workspace_incarnation_insert AFTER INSERT ON sessions
WHEN NEW.workspace_id IS NOT NULL
BEGIN
  UPDATE sessions SET workspace_incarnation = (
    SELECT incarnation FROM workspace_members
    WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND status = 'active'
  ) WHERE id = NEW.id;
END;

-- Workspace selection rebinds a workspace-less session or moves a session to a
-- different membership. Changes within one relationship, including promotion,
-- do not rotate this binding and do not revive sessions after removal/rejoin.
CREATE TRIGGER sessions_bind_workspace_incarnation_update AFTER UPDATE OF workspace_id ON sessions
WHEN NEW.workspace_id IS NOT OLD.workspace_id
BEGIN
  UPDATE sessions SET workspace_incarnation = (
    SELECT incarnation FROM workspace_members
    WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id AND status = 'active'
  ) WHERE id = NEW.id;
END;
