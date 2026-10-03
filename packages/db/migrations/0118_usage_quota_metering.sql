-- Usage quota metering. See docs/usage-metering.md and the PRD at
-- docs/PRDs/2026-10-03_usage-quota-metering/prd.md.
--
-- Every Organization is on a plan. Existing ones start on Starter (PRD
-- decision 9); an operator moves one to Growth from Ace. No CHECK: the set of
-- plans is a moving product decision, SQLite cannot alter a CHECK, and
-- PlanIdSchema parses the value on every read.
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter';

-- The usage ledger itself lives in its own database, USAGE_DB, so a full
-- ledger can only break metering. See packages/db/usage-migrations/.
