PRAGMA foreign_keys = ON;

-- Migration-first: the Worker that reads these columns ships after it, and the
-- Worker before it never names them.
--
-- The pack a demo is made from, stored once and never changed. Until now every
-- operation ran from "the pack in service", compiled into the Worker, and every
-- phase compared the operation's recorded version with it, so a deploy that
-- changed the pack failed every demo still preparing (`demo_pack_changed`).
-- Every new operation now stores the pack it starts with here and runs from
-- that copy, whether it came from the built-in scenario or was passed whole by
-- the Demo MCP.
--
-- A revision is immutable: nothing updates a row. An unnamed revision (no
-- `scenario_id`) is what an operation stores; two operations that start from
-- the same bytes share one row, which is what the partial unique index on the
-- content hash enforces, so storing the same pack again finds the existing row
-- and a refused or repeated request leaves nothing behind. `scenario_id` and
-- `revision` are for the named library the PRD defers to its second phase and
-- are NULL on every row this migration's Worker writes.
CREATE TABLE demo_scenario_revisions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT,
  revision INTEGER CHECK (revision IS NULL OR revision > 0),
  -- The normalized pack as the API parsed it, with the presenter's derived
  -- `expect` in place: what every phase of the operation reads.
  pack_json TEXT NOT NULL,
  -- SHA-256 of `pack_json`, hex.
  content_hash TEXT NOT NULL,
  -- Who stored it, from the Access identity the Demo MCP verified. NULL for a
  -- revision Ace's start request stored, which carries no Access identity.
  saved_by_subject TEXT,
  saved_by_email TEXT,
  created_at TEXT NOT NULL,
  CHECK ((scenario_id IS NULL) = (revision IS NULL))
);

CREATE UNIQUE INDEX demo_scenario_revisions_unnamed_content_idx
  ON demo_scenario_revisions(content_hash) WHERE scenario_id IS NULL;

-- The revision this operation runs from. NULL only on rows written before this
-- migration, which keep comparing their version with the pack in service.
ALTER TABLE demo_operations ADD COLUMN scenario_revision_id TEXT REFERENCES demo_scenario_revisions(id);
-- The key a Demo MCP client chose for this demo. The operation id is derived
-- from it and the requester's Access subject, so this column is for display.
ALTER TABLE demo_operations ADD COLUMN request_key TEXT;
-- Who asked, from the Access identity the Demo MCP verified. NULL for an
-- operation Ace started, whose operator is recorded in the log line instead.
ALTER TABLE demo_operations ADD COLUMN requested_by_subject TEXT;
ALTER TABLE demo_operations ADD COLUMN requested_by_email TEXT;
