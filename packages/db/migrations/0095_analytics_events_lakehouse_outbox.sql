ALTER TABLE telemetry_accepted_events
  ADD COLUMN analytics_lakehouse_state TEXT
  CHECK (analytics_lakehouse_state IN ('pending', 'queued', 'delivered', 'suppressed'));

ALTER TABLE telemetry_accepted_events
  ADD COLUMN analytics_lakehouse_delivered_at TEXT;

-- Existing accepted Global events are useful for the initial lakehouse and are
-- still inside the telemetry retention boundary. EU events deliberately remain
-- absent: this projection has no EU or cross-region destination.
UPDATE telemetry_accepted_events
SET analytics_lakehouse_state = 'pending'
WHERE route = 'global'
  AND delete_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

CREATE INDEX telemetry_accepted_events_analytics_lakehouse_idx
  ON telemetry_accepted_events(analytics_lakehouse_state, accepted_at)
  WHERE route = 'global' AND analytics_lakehouse_state IN ('pending', 'queued');

CREATE TRIGGER telemetry_accepted_event_analytics_lakehouse_seed
AFTER INSERT ON telemetry_accepted_events
WHEN NEW.route = 'global' AND NEW.analytics_lakehouse_state IS NULL
BEGIN
  UPDATE telemetry_accepted_events
  SET analytics_lakehouse_state = 'pending'
  WHERE event_id = NEW.event_id;
END;
