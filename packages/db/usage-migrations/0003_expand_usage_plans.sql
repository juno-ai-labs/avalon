-- Allow the four-plan catalog and future catalog additions. Like workspaces.plan,
-- plan IDs are validated by PlanIdSchema instead of a second SQL enum.
-- Preserve the existing change history; no usage rollup or receipt is repriced.
CREATE TABLE usage_plan_changes_next (
  workspace_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  plan TEXT NOT NULL,
  previous_plan TEXT NOT NULL,
  PRIMARY KEY (workspace_id, effective_at)
);
INSERT INTO usage_plan_changes_next SELECT workspace_id, effective_at, plan, previous_plan FROM usage_plan_changes;
DROP TABLE usage_plan_changes;
ALTER TABLE usage_plan_changes_next RENAME TO usage_plan_changes;
