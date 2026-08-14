-- Agent inference capture stops being a workspace preference and becomes an
-- unconditional compliance record, and the preference the toggle used to hold is
-- replaced by a different question: may Avalon use this workspace's work streams,
-- anonymized and generalized, to improve the platform.
--
-- The two are not the same decision, so this migration does not rename or
-- backfill `workspaces.log_agent_inference` into the new column. That flag said
-- "capture my payloads so support can debug them"; a workspace that set it never
-- agreed to have anything derived from them, and reading consent into an
-- unrelated opt-in is exactly the mistake this ledger exists to make impossible.
-- The new column starts at 0 for everyone, including workspaces that had capture
-- turned on.
--
-- `log_agent_inference` is left in place rather than dropped. The deploy job
-- applies both regions' migrations before it deploys either Worker, so for the
-- length of a deployment the previous Worker — which still selects the column in
-- `getWorkspace` and gates capture on it — meets this schema. Dropping it here
-- would be a `no such column` on every workspace read in that window, and for
-- hours rather than seconds if the deploy failed, because a failed deploy leaves
-- the migrations applied. See `runbook.md`, "The window between a migration and
-- the Worker that needs it", and `0070` for the same two-phase drop. The second
-- phase is a later migration, once a Worker that ignores the column is live in
-- both regions.
--
-- Consent is stored as periods rather than as a change log of on/off events
-- because of what it is read for: selecting the captured payloads a workspace has
-- allowed us to learn from. That question is "was sharing on when this row was
-- written", which a half-open interval answers with a join and a change log
-- answers only by replaying every event before it in order. A period whose
-- `ended_at` is NULL is open, and the partial unique index below is what keeps the
-- periods disjoint — without it a double enable leaves two open rows and every
-- interval join silently doubles its result set.
ALTER TABLE workspaces
ADD COLUMN share_workstreams_for_improvement INTEGER NOT NULL DEFAULT 0
CHECK (share_workstreams_for_improvement IN (0, 1));

CREATE TABLE workspace_improvement_sharing_periods (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  ended_at TEXT CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- The admin who made each call, kept for the audit the consent record is: who
  -- agreed, and who withdrew. Nulled rather than cascaded on account deletion,
  -- because losing the name must never lose the window it authorized.
  started_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  ended_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX idx_workspace_improvement_sharing_open
ON workspace_improvement_sharing_periods(workspace_id)
WHERE ended_at IS NULL;

CREATE INDEX idx_workspace_improvement_sharing_periods_window
ON workspace_improvement_sharing_periods(workspace_id, started_at);
