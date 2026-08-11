-- Who owns a work stream's title, and whether Avalon may still change it.
--
-- 'naming'    the naming agent is choosing the first title; the stored one is
--             the first line of the objective, and clients render a skeleton
--             rather than showing a placeholder as though it were a name.
-- 'automatic' Avalon named it. The transcript is still short, so one later
--             pass may replace the name once the work has taken shape.
-- 'settled'   final. A person named it, the caller supplied it, or the second
--             pass has already run. Avalon never renames a settled title.
--
-- Existing rows are settled: their titles are what their workspaces have been
-- reading, and a rename of history is not this column's job.
ALTER TABLE workstreams
  ADD COLUMN title_status TEXT NOT NULL DEFAULT 'settled'
  CHECK (title_status IN ('naming', 'automatic', 'settled'));
