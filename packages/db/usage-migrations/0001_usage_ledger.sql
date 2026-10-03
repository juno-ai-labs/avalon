-- The usage ledger, in its own D1 database (USAGE_DB) so that reaching the
-- database size limit can only break metering, never the regional database
-- that holds workspaces, members and sessions. See docs/usage-metering.md.
--
-- One append-only row per metered call. The primary key is what makes Queue
-- redelivery harmless. Rows stay here for the retention window
-- (USAGE_EVENTS_D1_RETENTION_DAYS) and in the usage lakehouse in R2 for good;
-- the lakehouse is the per-event history a Stripe replay or breakdown reads.
CREATE TABLE usage_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
  organization_pays INTEGER NOT NULL CHECK (organization_pays IN (0, 1)),
  model TEXT,
  user_id TEXT,
  workstream_id TEXT,
  substream_id TEXT,
  sidekick_id TEXT,
  received_at TEXT NOT NULL
);
CREATE INDEX usage_events_workspace_occurred ON usage_events(workspace_id, occurred_at);

-- Totals per quota week and monthly period. A week that crosses a period
-- boundary has two rows. Overage is never stored: the read derives it from
-- these sums, so arrival order and plan changes cannot skew it.
-- `quota_microusd` is the plan's weekly quota when the row was created; a plan
-- change rewrites it on the current week's rows.
CREATE TABLE usage_rollups (
  workspace_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  period_start TEXT NOT NULL,
  quota_microusd INTEGER NOT NULL,
  organization_microusd INTEGER NOT NULL DEFAULT 0,
  rally_microusd INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, week_start, period_start)
);

-- Serves the scheduled prune of rows past the D1 retention window. Every row
-- is also in the usage lakehouse in R2, which keeps them.
CREATE INDEX usage_events_occurred ON usage_events(occurred_at);
