-- X connections are shared workspace infrastructure. Retire historical
-- personal installations before the workspace-only runtime guard is enabled.
-- Keep the disabled rows for audit/history, but remove credentials and polling
-- state so they cannot continue to operate or appear eligible for execution.
UPDATE connector_connections
SET status = 'disabled',
    encrypted_credentials = NULL,
    credential_iv = NULL,
    credential_refresh_lease_id = NULL,
    credential_refresh_lease_expires_at = NULL,
    next_poll_at = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE connector_type = 'x'
  AND scope = 'personal';

DROP INDEX IF EXISTS connector_connections_x_personal_active_user_uq;

-- Older connector_connections tables have a general scope CHECK that still
-- admits personal X rows. Enforce the provider-specific invariant without a
-- destructive table rebuild across all connector foreign-key branches.
CREATE TRIGGER IF NOT EXISTS connector_connections_x_workspace_only_insert
BEFORE INSERT ON connector_connections
FOR EACH ROW
WHEN NEW.connector_type = 'x'
  AND (NEW.scope <> 'workspace' OR NEW.owner_user_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'X connections must use workspace scope');
END;

CREATE TRIGGER IF NOT EXISTS connector_connections_x_workspace_only_update
BEFORE UPDATE ON connector_connections
FOR EACH ROW
WHEN NEW.connector_type = 'x'
  AND NEW.scope = 'personal'
  AND (
    OLD.connector_type <> 'x'
    OR OLD.scope <> 'personal'
    OR NEW.status <> 'disabled'
  )
BEGIN
  SELECT RAISE(ABORT, 'X connections must use workspace scope');
END;
