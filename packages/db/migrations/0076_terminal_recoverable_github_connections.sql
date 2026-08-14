DROP TRIGGER workstream_terminal_repositories_workspace_guard_insert;

CREATE TRIGGER workstream_terminal_repositories_workspace_guard_insert
BEFORE INSERT ON workstream_terminal_repositories
WHEN NOT EXISTS (
  SELECT 1 FROM workstreams
   WHERE id = NEW.workstream_id AND workspace_id = NEW.workspace_id
) OR NOT EXISTS (
  SELECT 1 FROM connector_connections
   WHERE id = NEW.connection_id AND workspace_id = NEW.workspace_id
     AND connector_type = 'github' AND status <> 'disabled'
)
BEGIN
  SELECT RAISE(ABORT, 'terminal repository workspace or GitHub connection mismatch');
END;
