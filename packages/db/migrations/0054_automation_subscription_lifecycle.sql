-- An automation's lifecycle is a different axis from its run status. `status`
-- says whether it is a draft, running, paused, or errored; `lifecycle_state`
-- says whether it is still present at all. One enum column carries both the
-- draft the user dismissed and the automation the user deleted, so neither
-- needs a nullable flag of its own, and `updated_at` records when the
-- transition happened.
--
-- Nothing that starts an automation reads this column alone: the workspace
-- scheduler, activity matching, and inbound email each require
-- status = 'active' AND lifecycle_state = 'visible', so a hidden automation can
-- never run. Rows are kept rather than deleted because automation runs, work
-- streams, memory scopes, and the permanent email tombstone all reference them.
ALTER TABLE automation_subscriptions ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'visible'
  CHECK (lifecycle_state IN ('visible', 'archived', 'deleted'));

CREATE INDEX IF NOT EXISTS automation_subscriptions_lifecycle_idx
  ON automation_subscriptions(workspace_id, lifecycle_state);
