-- Independent telemetry storage. Identity IDs are references, not cross-database foreign keys.
CREATE TABLE "telemetry_accepted_events" (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  route TEXT NOT NULL,
  routing_basis TEXT NOT NULL CHECK (
    routing_basis IN ('explicit_binding', 'explicit_selection', 'ip_geolocation', 'geolocation_fallback')
  ),
  analytics_subject_id TEXT NOT NULL,
  workspace_analytics_id TEXT,
  subject_user_id TEXT,
  accepted_at TEXT NOT NULL,
  normalized_timestamp TEXT NOT NULL,
  delete_at TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (
    delivery_state IN ('pending', 'delivering', 'delivered', 'retrying', 'suppressed', 'terminal', 'expired')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT,
  delivered_at TEXT,
  terminal_code TEXT, analytics_lakehouse_state TEXT
  CHECK (analytics_lakehouse_state IN ('pending', 'queued', 'delivered', 'suppressed', 'rejected')), analytics_lakehouse_delivered_at TEXT
);

CREATE TABLE "telemetry_delivery_receipts" (
  event_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  route TEXT NOT NULL,
  result_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);

CREATE TABLE telemetry_replay_audit (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK (reason_code IN ('destination_recovery', 'incident_response')),
  result_code TEXT NOT NULL CHECK (
    result_code IN ('requeued', 'denied', 'not_found', 'wrong_region', 'expired', 'suppressed', 'invalid_state')
  ),
  original_delete_at TEXT,
  created_at TEXT NOT NULL,
  delete_at TEXT NOT NULL
);

CREATE INDEX telemetry_accepted_events_analytics_lakehouse_idx
  ON telemetry_accepted_events(accepted_at DESC)
  WHERE analytics_lakehouse_state IN ('pending', 'queued');

CREATE INDEX telemetry_accepted_events_delivery_idx
  ON telemetry_accepted_events(delivery_state, next_attempt_at, accepted_at);

CREATE INDEX telemetry_accepted_events_expiry_idx ON telemetry_accepted_events(delete_at);

CREATE INDEX telemetry_accepted_events_subject_idx
  ON telemetry_accepted_events(subject_user_id, delete_at) WHERE subject_user_id IS NOT NULL;

CREATE INDEX telemetry_delivery_receipts_expiry_idx ON telemetry_delivery_receipts(delete_at);

CREATE INDEX telemetry_replay_audit_expiry_idx ON telemetry_replay_audit(delete_at);

CREATE TRIGGER telemetry_accepted_event_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_accepted_events
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_accepted_events_analytics_lakehouse_seed
AFTER INSERT ON telemetry_accepted_events
WHEN NEW.analytics_lakehouse_state IS NULL
BEGIN
  UPDATE telemetry_accepted_events
  SET analytics_lakehouse_state = 'pending'
  WHERE event_id = NEW.event_id;
END;

CREATE TRIGGER telemetry_delivery_receipt_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_delivery_receipts
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;

CREATE TRIGGER telemetry_replay_audit_deadline_immutable
BEFORE UPDATE OF delete_at ON telemetry_replay_audit
WHEN NEW.delete_at <> OLD.delete_at
BEGIN
  SELECT RAISE(ABORT, 'telemetry_deadline_immutable');
END;
