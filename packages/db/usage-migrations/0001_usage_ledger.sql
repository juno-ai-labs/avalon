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
-- is also in the usage lakehouse in R2, which keeps them. Keyed on receipt,
-- not occurrence: dedupe needs a row for as long as its message can be
-- redelivered, and that is measured from when the ledger received it.
CREATE INDEX usage_events_received ON usage_events(received_at);

-- Every plan change, with the plan it replaced. A rollup row's quota is the
-- plan in force at the end of its week, read from here inside the same insert
-- that creates the row, so a late event priced into a past week gets that
-- week's plan, and a plan change racing the consumer cannot be lost: D1 runs
-- one transaction at a time, so either the change lands first and the insert
-- reads it, or the insert lands first and the change rewrites the row.
CREATE TABLE usage_plan_changes (
  workspace_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan IN ('starter', 'growth')),
  previous_plan TEXT NOT NULL CHECK (previous_plan IN ('starter', 'growth')),
  PRIMARY KEY (workspace_id, effective_at)
);
