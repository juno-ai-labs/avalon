PRAGMA foreign_keys = ON;

-- A demo's pack can now seed a Sidekick, which belongs to no room.
--
-- Every earlier seed action wrote into a work stream, so the receipts table
-- required one: `room` — the pack's own name for it — and the `workstream_id`
-- a later action in the same room resolves through. A Sidekick has neither. It
-- is created by `createAutomation`, it owns its own authoring conversation, and
-- nothing in the pack refers back to it the way a message refers back to its
-- room. So both columns become nullable, `sidekick_id` is added beside them,
-- and a CHECK keeps each kind's identity complete: a room action still names a
-- room and a work stream, a sidekick action still names a Sidekick.
--
-- `sidekick_run_id` is the one run a seeded Sidekick has already made — the
-- briefing that gives a demo something to look at before its schedule first
-- fires. Null when the pack seeded no run. It is a Sidekick run id, not a
-- harness run id: `harness_run_id` stays what it has always been, the run the
-- action's own turn started inside a room.
--
-- SQLite cannot widen the `kind` CHECK in place, so this is a rebuild. Nothing
-- references this table, and it references `demo_operations` and `workspaces`,
-- so the copy runs with foreign keys enforced.
CREATE TABLE demo_seed_receipts_new (
  operation_id TEXT NOT NULL REFERENCES demo_operations(operation_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('create_workstream', 'message', 'upload', 'sidekick')),
  -- The pack's own name for the room, which is how a later action finds the
  -- work stream an earlier one created. Null for an action that is not in a
  -- room.
  room TEXT,
  workstream_id TEXT,
  -- The Sidekick this action published, and the seeded run it already made.
  sidekick_id TEXT,
  sidekick_run_id TEXT,
  -- The human turn this action wrote, for a create or a message.
  turn_id TEXT,
  -- The run the turn started and how it settled, when it started one.
  harness_run_id TEXT,
  run_outcome TEXT CHECK (run_outcome IN ('completed', 'needs_input')),
  -- The real elicitation an `ask` turn opened.
  elicitation_id TEXT,
  -- The resource an upload created and attached.
  resource_id TEXT,
  completed_at TEXT NOT NULL,
  PRIMARY KEY (operation_id, action_id),
  CHECK (
    CASE kind
      WHEN 'sidekick' THEN room IS NULL AND workstream_id IS NULL AND sidekick_id IS NOT NULL
      ELSE room IS NOT NULL AND workstream_id IS NOT NULL AND sidekick_id IS NULL
    END
  )
);

INSERT INTO demo_seed_receipts_new
  (operation_id, action_id, workspace_id, kind, room, workstream_id, sidekick_id, sidekick_run_id,
   turn_id, harness_run_id, run_outcome, elicitation_id, resource_id, completed_at)
SELECT operation_id, action_id, workspace_id, kind, room, workstream_id, NULL, NULL,
       turn_id, harness_run_id, run_outcome, elicitation_id, resource_id, completed_at
  FROM demo_seed_receipts;

DROP TABLE demo_seed_receipts;
ALTER TABLE demo_seed_receipts_new RENAME TO demo_seed_receipts;

-- Retirement's cascade and a per-workspace audit read by workspace; the
-- barrier reads an operation's receipts by the primary key.
CREATE INDEX demo_seed_receipts_workspace_idx ON demo_seed_receipts(workspace_id);
