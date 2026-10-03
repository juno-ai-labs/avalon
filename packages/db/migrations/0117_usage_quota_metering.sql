-- Usage quota metering. See docs/usage-metering.md and the PRD at
-- docs/PRDs/2026-10-03_usage-quota-metering/prd.md.
--
-- Every Organization is on a plan. Existing ones start on Starter (PRD
-- decision 9); an operator moves one to Growth from Ace.
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'
  CHECK (plan IN ('starter', 'growth'));

-- One append-only row per metered call. The primary key is what makes Queue
-- redelivery harmless, and the rows are the per-event history a later Stripe
-- sink or per-person breakdown reads. Kept, not pruned.
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
