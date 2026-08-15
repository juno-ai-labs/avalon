-- Persist the closed telemetry contract chosen when an OAuth attempt is admitted
-- so its terminal outcome never has to infer dimensions from provider state.
ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_event_version INTEGER NOT NULL DEFAULT 1
  CHECK (telemetry_event_version IN (1, 2));
ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_scope TEXT
  CHECK (telemetry_scope IN ('personal', 'workspace'));
ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_capability_count INTEGER
  CHECK (telemetry_capability_count >= 0);
ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_reconnect INTEGER NOT NULL DEFAULT 0
  CHECK (telemetry_reconnect IN (0, 1));
