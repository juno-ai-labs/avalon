-- Retire the Web Monitor connector from databases that applied migrations
-- before it was removed from Avalon's connector registry and API contracts.
-- Provider resources are removed first because deleting their connection would
-- otherwise retain them with a NULL connection through ON DELETE SET NULL.
DELETE FROM resources
WHERE provider = 'web_monitor';

DELETE FROM connector_connections
WHERE connector_type = 'web_monitor';

DROP TABLE IF EXISTS web_monitor_snapshots;

-- Older deployed connector_connections tables still have a historical CHECK
-- constraint that admits web_monitor. Reject it explicitly without rebuilding
-- every foreign-key branch rooted at connector_connections.
CREATE TRIGGER IF NOT EXISTS connector_connections_web_monitor_removed_insert
BEFORE INSERT ON connector_connections
FOR EACH ROW
WHEN NEW.connector_type = 'web_monitor'
BEGIN
  SELECT RAISE(ABORT, 'web_monitor connector has been removed');
END;

CREATE TRIGGER IF NOT EXISTS connector_connections_web_monitor_removed_update
BEFORE UPDATE OF connector_type ON connector_connections
FOR EACH ROW
WHEN NEW.connector_type = 'web_monitor'
BEGIN
  SELECT RAISE(ABORT, 'web_monitor connector has been removed');
END;
