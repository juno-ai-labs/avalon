-- A work stream can now schedule itself a one-shot prompt wake-up: the agent
-- names a future instant and the prompt it wants delivered, and the workspace
-- scheduler starts a run with that prompt when the instant arrives.
--
-- This is deliberately not a row in `schedules`. That table carries recurring
-- timing for an automation subscription or a connector poll and holds no
-- payload; a wake-up is one-shot, belongs to a work stream, and carries the
-- prompt text that becomes the run's trigger. The workspace scheduler unions
-- both tables when it computes its next alarm.
CREATE TABLE IF NOT EXISTS workstream_wakeups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  -- The run that asked for the wake-up. Kept for provenance only: the principal
  -- below is re-validated at fire time, so a deleted run cannot resurrect
  -- authority the workspace has since revoked.
  created_by_harness_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
  execution_principal_json TEXT NOT NULL,
  prompt TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fired', 'cancelled')),
  -- Derived from the creating tool receipt, so a replayed tool call resolves to
  -- the wake-up the first attempt already created instead of scheduling a
  -- second one.
  idempotency_key TEXT NOT NULL,
  fired_at TEXT,
  cancelled_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workstream_id, idempotency_key),
  CHECK ((status = 'fired') = (fired_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- The scheduler's due scan is by workspace; the tool's list and cap are by work
-- stream. Both read only pending rows.
CREATE INDEX IF NOT EXISTS workstream_wakeups_due_idx
  ON workstream_wakeups(workspace_id, status, due_at);
CREATE INDEX IF NOT EXISTS workstream_wakeups_workstream_idx
  ON workstream_wakeups(workstream_id, status, due_at);
