-- Connector credentials retain their opaque connection:<uuid> authorization
-- identity. This separate, workspace-local identifier is the stable name that
-- can safely be shown to a model (for example plugin_web_monitor).
ALTER TABLE connector_connections ADD COLUMN model_plugin_id TEXT;

-- Backfill active prototype connections deterministically. The oldest active
-- connection of a provider receives the clean base name, with numeric suffixes
-- only when multiple credentials of that provider are simultaneously active.
UPDATE connector_connections AS connection
SET model_plugin_id =
  'plugin_' ||
  CASE connection.connector_type
    WHEN 'generic_webhook' THEN 'webhook'
    ELSE connection.connector_type
  END ||
  CASE
    WHEN (
      SELECT COUNT(*)
      FROM connector_connections AS prior
      WHERE prior.workspace_id = connection.workspace_id
        AND prior.connector_type = connection.connector_type
        AND prior.status <> 'disabled'
        AND (
          prior.created_at < connection.created_at
          OR (prior.created_at = connection.created_at AND prior.id <= connection.id)
        )
    ) = 1 THEN ''
    ELSE '_' || CAST((
      SELECT COUNT(*)
      FROM connector_connections AS prior
      WHERE prior.workspace_id = connection.workspace_id
        AND prior.connector_type = connection.connector_type
        AND prior.status <> 'disabled'
        AND (
          prior.created_at < connection.created_at
          OR (prior.created_at = connection.created_at AND prior.id <= connection.id)
        )
    ) AS TEXT)
  END
WHERE connection.status <> 'disabled';

-- Disabled credentials do not reserve a model-facing name. This makes a
-- remove -> add cycle reclaim plugin_<provider> without random/hash suffixes.
CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
  ON connector_connections(workspace_id, model_plugin_id)
  WHERE status <> 'disabled' AND model_plugin_id IS NOT NULL;
