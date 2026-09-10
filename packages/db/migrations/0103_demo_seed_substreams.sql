PRAGMA foreign_keys = ON;

-- A pack can now open a substream inside a work stream it created, and say
-- things in it. Two facts the receipts could not carry before:
--
--   * `create_substream` is a fifth kind of confirmed action. The kind column
--     is a CHECK, and SQLite cannot widen one in place, so the table is rebuilt
--     rather than altered — the same reason `0102_demo_seed_sidekicks.sql`
--     rebuilt it, and this migration is written against the shape that one
--     leaves behind.
--   * Which conversation an action wrote to. `room` names the work stream, and
--     that was the whole address while every seeded line went to the main
--     conversation. A seeded substream gives a room more than one conversation,
--     so an action now records the child it wrote to by the pack's own name for
--     it (`substream`, NULL for the main conversation) and by the id the
--     creation service minted (`substream_id`, '0' for the main conversation).
--     A later action finds its conversation through the first and writes
--     through the second, the same way it already finds its work stream through
--     `room`.
--
-- Both new columns are NULL for a Sidekick, which is in no room and therefore
-- in no conversation, and the identity CHECK says so alongside the room columns
-- it already governed. Existing rows are all main-conversation room actions or
-- Sidekicks, so the copy decides between the two on `kind` and needs no other
-- per-row decision.
--
-- Nothing references this table, and it references `demo_operations` and
-- `workspaces`, so the copy runs with foreign keys enforced.
CREATE TABLE demo_seed_receipts_new (
  operation_id TEXT NOT NULL REFERENCES demo_operations(operation_id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN ('create_workstream', 'create_substream', 'message', 'upload', 'sidekick')
  ),
  -- The pack's own name for the room, which is how a later action finds the
  -- work stream an earlier one created. Null for an action that is not in a
  -- room.
  room TEXT,
  workstream_id TEXT,
  -- The pack's own name for the substream, on the action that created it and
  -- on every action that wrote to it. NULL means the room's main conversation,
  -- which the pack never names because creating the work stream creates it.
  substream TEXT,
  -- The conversation this action actually wrote to. '0' is the main one. Null
  -- for an action that is not in a room.
  substream_id TEXT,
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
      WHEN 'sidekick' THEN room IS NULL AND workstream_id IS NULL
        AND substream IS NULL AND substream_id IS NULL AND sidekick_id IS NOT NULL
      ELSE room IS NOT NULL AND workstream_id IS NOT NULL
        AND substream_id IS NOT NULL AND sidekick_id IS NULL
    END
  )
);

INSERT INTO demo_seed_receipts_new
  (operation_id, action_id, workspace_id, kind, room, workstream_id, substream, substream_id,
   sidekick_id, sidekick_run_id, turn_id, harness_run_id, run_outcome, elicitation_id,
   resource_id, completed_at)
SELECT operation_id, action_id, workspace_id, kind, room, workstream_id,
       NULL, CASE kind WHEN 'sidekick' THEN NULL ELSE '0' END,
       sidekick_id, sidekick_run_id, turn_id, harness_run_id, run_outcome, elicitation_id,
       resource_id, completed_at
  FROM demo_seed_receipts;

DROP TABLE demo_seed_receipts;
ALTER TABLE demo_seed_receipts_new RENAME TO demo_seed_receipts;

-- Retirement's cascade and a per-workspace audit read by workspace; the
-- barrier reads an operation's receipts by the primary key.
CREATE INDEX demo_seed_receipts_workspace_idx ON demo_seed_receipts(workspace_id);
