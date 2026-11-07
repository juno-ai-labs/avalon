PRAGMA foreign_keys = ON;

-- The demo pack is rewritten around Canvases and Sidekicks
-- (docs/PRDs/2026-11-06_canvases-and-sidekicks), so a confirmed action now
-- addresses a Canvas or a Sidekick rather than a room and its substream:
--
--   * The kinds are the new pack's six: `create_canvas`, `canvas_message`,
--     `canvas_artifact`, `upload`, `sidekick` and `sidekick_message`. The kind
--     column is a CHECK, and SQLite cannot change one in place, so the table is
--     rebuilt, as 0102 and 0103 rebuilt it.
--   * A Canvas action records the pack's name for its Canvas (`canvas`) and the
--     Canvas it got (`canvas_id`); a Sidekick action the pack's name for its
--     Sidekick (`sidekick`) and the Sidekick (`sidekick_id`). A later action
--     finds its destination through the name and writes through the id, the
--     way a room action found its work stream through `room`. A Sidekick whose
--     run wrote a Canvas records that Canvas's id on its own receipt.
--
-- Rows of the retired kinds are not copied. They are receipts of Thread,
-- Channel and Breakout seeding: nothing reads a receipt after its operation is
-- Ready, the conversations they name are retired with the Organization's
-- Threads, and an operation still preparing under the old pack cannot resume
-- under the new one — it fails at its next step and the operator starts a new
-- demo. Nothing references this table, and it references `demo_operations`
-- and `workspaces`, so the rebuild runs with foreign keys enforced.
CREATE TABLE demo_seed_receipts_new (
  operation_id TEXT NOT NULL REFERENCES demo_operations(operation_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('create_canvas', 'canvas_message', 'canvas_artifact', 'upload', 'sidekick', 'sidekick_message')
  ),
  -- The pack's own name for the Canvas, and the Canvas it got.
  canvas TEXT,
  canvas_id TEXT,
  -- The pack's own name for the Sidekick, the Sidekick, and the seeded run.
  sidekick TEXT,
  sidekick_id TEXT,
  sidekick_run_id TEXT,
  -- The person's turn this action wrote.
  turn_id TEXT,
  -- The run the turn started, or the run a publish is attributed to.
  harness_run_id TEXT,
  run_outcome TEXT CHECK (run_outcome IN ('completed', 'needs_input')),
  -- The real elicitation an `ask` turn opened.
  elicitation_id TEXT,
  -- The document an upload attached or a publish wrote.
  resource_id TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, action_id),
  CHECK (
    CASE kind
      WHEN 'sidekick' THEN canvas IS NULL AND sidekick IS NOT NULL AND sidekick_id IS NOT NULL
      WHEN 'sidekick_message' THEN canvas IS NULL AND canvas_id IS NULL
        AND sidekick IS NOT NULL AND sidekick_id IS NOT NULL AND turn_id IS NOT NULL
      ELSE canvas IS NOT NULL AND canvas_id IS NOT NULL AND sidekick IS NULL AND sidekick_id IS NULL
    END
  )
);

DROP TABLE demo_seed_receipts;
ALTER TABLE demo_seed_receipts_new RENAME TO demo_seed_receipts;

-- Retirement's cascade and a per-workspace audit read by workspace; the
-- barrier reads an operation's receipts by the primary key.
CREATE INDEX demo_seed_receipts_workspace_idx ON demo_seed_receipts(workspace_id);
