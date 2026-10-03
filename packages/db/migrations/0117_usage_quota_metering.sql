-- Usage quota metering. See docs/usage-metering.md and the PRD at
-- docs/PRDs/2026-10-03_usage-quota-metering/prd.md.
--
-- Every Organization is on a plan. Existing ones start on Starter (PRD
-- decision 9); an operator moves one to Growth from Ace.
ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'
  CHECK (plan IN ('starter', 'growth'));

-- The usage ledger itself lives in its own database, USAGE_DB, so a full
-- ledger can only break metering. See packages/db/usage-migrations/.
