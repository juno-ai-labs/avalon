-- One Linear identity has one active Avalon connection per ownership boundary.
-- Personal and workspace connections for the same Linear organization may
-- coexist, and each Avalon member may own a separate personal authorization.
--
-- Deploy preflight: these indexes intentionally fail if historical duplicate
-- rows exist. Resolve those rows explicitly instead of disabling an arbitrary
-- credential during migration.
CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_linear_workspace_active_account_uq
ON connector_connections(workspace_id, provider_account_id)
WHERE connector_type = 'linear'
  AND scope = 'workspace'
  AND status <> 'disabled'
  AND provider_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS connector_connections_linear_personal_active_account_uq
ON connector_connections(workspace_id, owner_user_id, provider_account_id)
WHERE connector_type = 'linear'
  AND scope = 'personal'
  AND status <> 'disabled'
  AND owner_user_id IS NOT NULL
  AND provider_account_id IS NOT NULL;
