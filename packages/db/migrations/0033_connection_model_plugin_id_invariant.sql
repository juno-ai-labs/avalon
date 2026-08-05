-- The API contract requires every connection, including disabled historical
-- rows, to expose a syntactically valid model-facing plugin id. Disabled rows
-- do not participate in the active uniqueness index, so reusing a provider's
-- clean base id remains safe when a connection is added again.
UPDATE connector_connections
SET model_plugin_id = 'plugin_' ||
  CASE connector_type
    WHEN 'generic_webhook' THEN 'webhook'
    WHEN 'web_monitor' THEN 'web_monitor'
    WHEN 'github' THEN 'github'
    WHEN 'linear' THEN 'linear'
    WHEN 'notion' THEN 'notion'
    ELSE 'google'
  END
WHERE model_plugin_id IS NULL;

CREATE TRIGGER connector_connections_model_plugin_id_required_insert
BEFORE INSERT ON connector_connections
FOR EACH ROW
WHEN NEW.model_plugin_id IS NULL
  OR length(NEW.model_plugin_id) < 8
  OR length(NEW.model_plugin_id) > 70
  OR NEW.model_plugin_id NOT GLOB 'plugin_[a-z]*'
  OR substr(NEW.model_plugin_id, 8) GLOB '*[^a-z0-9_]*'
BEGIN
  SELECT RAISE(ABORT, 'connector_connections.model_plugin_id must match the API contract');
END;

CREATE TRIGGER connector_connections_model_plugin_id_required_update
BEFORE UPDATE OF model_plugin_id ON connector_connections
FOR EACH ROW
WHEN NEW.model_plugin_id IS NULL
  OR length(NEW.model_plugin_id) < 8
  OR length(NEW.model_plugin_id) > 70
  OR NEW.model_plugin_id NOT GLOB 'plugin_[a-z]*'
  OR substr(NEW.model_plugin_id, 8) GLOB '*[^a-z0-9_]*'
BEGIN
  SELECT RAISE(ABORT, 'connector_connections.model_plugin_id must match the API contract');
END;
