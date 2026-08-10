-- Post-organization onboarding checklist.
--
-- The step catalog itself is code (apps/api/src/services/onboarding-checklist-catalog.ts)
-- so steps can be added, reworded, or reordered without a migration. Only the
-- per-member outcome of a step lives here, keyed by an opaque step id, and a
-- step stays resolved once it is resolved even if the catalog later changes the
-- signal that produced it.
CREATE TABLE onboarding_step_progress (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('completed', 'skipped')),
  source TEXT NOT NULL CHECK (source IN ('signal', 'manual')),
  resolved_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id, step_id)
);

CREATE INDEX onboarding_step_progress_member_idx
  ON onboarding_step_progress(workspace_id, user_id, state);

-- Checklist-level state: which step the member is currently being guided
-- through (so the spotlight follows them across windows and devices) and
-- whether they dismissed the checklist. Dismissal records the catalog version
-- it applied to, so a later catalog revision surfaces the checklist again
-- instead of staying hidden forever.
CREATE TABLE onboarding_checklist_state (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_step_id TEXT,
  dismissed_version TEXT,
  dismissed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
