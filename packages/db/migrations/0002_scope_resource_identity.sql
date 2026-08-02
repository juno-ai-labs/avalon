DROP INDEX IF EXISTS resources_provider_identity_idx;

CREATE UNIQUE INDEX IF NOT EXISTS resources_connection_provider_identity_idx
  ON resources(workspace_id, connection_id, provider, provider_resource_id)
  WHERE connection_id IS NOT NULL AND provider_resource_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS resources_unconnected_provider_identity_idx
  ON resources(workspace_id, provider, provider_resource_id)
  WHERE connection_id IS NULL AND provider_resource_id IS NOT NULL;
