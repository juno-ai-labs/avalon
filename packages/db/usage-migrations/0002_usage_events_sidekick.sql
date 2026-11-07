-- A Sidekick's cost over time, and one run's (a Sidekick's rows narrowed by
-- substream_id), without scanning every event its Organization logged since:
-- the workspace index reads all of an Organization's rows in the window to
-- find one Sidekick's. Partial, because most events are not a Sidekick's.
CREATE INDEX usage_events_sidekick_occurred
  ON usage_events(sidekick_id, occurred_at)
  WHERE sidekick_id IS NOT NULL;
