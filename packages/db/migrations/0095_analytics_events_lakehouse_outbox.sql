ALTER TABLE telemetry_accepted_events
  ADD COLUMN analytics_lakehouse_state TEXT
  CHECK (analytics_lakehouse_state IN ('pending', 'queued', 'delivered', 'suppressed', 'rejected'));

ALTER TABLE telemetry_accepted_events
  ADD COLUMN analytics_lakehouse_delivered_at TEXT;

CREATE INDEX telemetry_accepted_events_analytics_lakehouse_idx
  ON telemetry_accepted_events(accepted_at DESC)
  WHERE route = 'global' AND analytics_lakehouse_state IN ('pending', 'queued');

CREATE TRIGGER telemetry_accepted_events_analytics_lakehouse_seed
AFTER INSERT ON telemetry_accepted_events
WHEN NEW.route = 'global' AND NEW.analytics_lakehouse_state IS NULL
BEGIN
  UPDATE telemetry_accepted_events
  SET analytics_lakehouse_state = 'pending'
  WHERE event_id = NEW.event_id;
END;
