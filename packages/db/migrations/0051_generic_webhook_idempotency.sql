CREATE UNIQUE INDEX generic_webhook_creation_idempotency_idx
  ON connector_connections(
    workspace_id,
    scope,
    COALESCE(owner_user_id, ''),
    json_extract(config_json, '$.creationIdempotencyKey')
  )
  WHERE connector_type = 'generic_webhook'
    AND status != 'disabled'
    AND json_extract(config_json, '$.creationIdempotencyKey') IS NOT NULL;

CREATE INDEX activities_pending_recovery_idx
  ON activities(processing_status, received_at, id)
  WHERE processing_status = 'pending';
