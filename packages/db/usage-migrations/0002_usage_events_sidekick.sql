-- A Sidekick's (or one run's) cost over a window without scanning its
-- Organization's events. Partial: most events are not a Sidekick's.
CREATE INDEX usage_events_sidekick_occurred
  ON usage_events(sidekick_id, occurred_at)
  WHERE sidekick_id IS NOT NULL;
