-- Who wrote the description a work stream is carrying. A person naming their own
-- work is evidence of intent that an automatic rewrite has to overcome; a
-- description derived at creation from the opening message, a suggested-work
-- prompt, or an automation is not, and is the case the refresh loop below exists
-- to correct. Without this column both look identical by the time the loop reads
-- them.
--
-- `derived` is the default because it is what creation produces unless a person
-- typed the description themselves. The backfill promotes the rows that can
-- still be shown to have been authored: an ad-hoc work stream whose description
-- is not simply its opening message.
--
-- This runs once and cannot be re-run, so it excludes the two shapes where
-- "differs from the opening message" is not evidence of a person:
--
--   * an attachment-only work stream, whose description is the literal fallback
--     `Review the attached files` against an empty opening message;
--   * a Slack mention longer than 4,000 characters, whose description is the
--     opening message truncated to that length rather than a different text.
--
-- Both would otherwise be promoted, and a wrongly promoted row tells the
-- refresh loop to protect a description nobody wrote.
ALTER TABLE workstreams ADD COLUMN description_source TEXT NOT NULL DEFAULT 'derived'
  CHECK (description_source IN ('authored', 'derived'));

UPDATE workstreams
SET description_source = 'authored'
WHERE origin_type = 'ad_hoc'
  AND created_from_opportunity_id IS NULL
  AND trim(objective) <> ''
  AND trim(objective) <> 'Review the attached files'
  AND trim(objective) <> COALESCE((
    SELECT trim(m.text_content)
      FROM messages m
     WHERE m.workstream_id = workstreams.id AND m.sequence_number = 1
  ), '')
  AND trim(objective) <> COALESCE((
    SELECT trim(substr(m.text_content, 1, 4000))
      FROM messages m
     WHERE m.workstream_id = workstreams.id AND m.sequence_number = 1
  ), '');

-- A work stream's description (`workstreams.objective`) is written once, when the
-- work stream is created, and then never again unless a person edits it. It is
-- derived from the opening message, from a suggested-work prompt, or from a
-- title-like fragment, so it is often a poor description of the work on day one
-- and a wrong one by the second week: the work stream keeps its name while its
-- reason for existing moves.
--
-- This table is the state behind the loop that re-reads a work stream's recent
-- transcript and rewrites the description when it has genuinely veered. One row
-- per work stream, holding the last evaluation rather than a history: the
-- description in force lives on `workstreams`, and what is needed here is the
-- throttle clock, the decision that produced the current wording, and enough
-- provenance to explain an automatic rewrite to whoever notices it.
CREATE TABLE IF NOT EXISTS workstream_description_refreshes (
  workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- When the last evaluation started, not when it finished. Provenance only:
  -- the gate is `rest_until` below.
  evaluated_at TEXT NOT NULL,
  -- The earliest instant a further evaluation may run, and the single-writer
  -- claim. Writing it forward when an evaluation *starts* is what stops two
  -- runs terminalizing at once from both reaching the model, and what stops a
  -- model that is failing from being retried by every run behind it.
  --
  -- It carries the backoff as well as the throttle, because the rest a work
  -- stream has earned depends on its history rather than on a constant: each
  -- consecutive `kept` doubles it, a rewrite returns it to the floor, and a
  -- person editing the description themselves buys a full rest. Storing the
  -- resolved instant rather than the inputs keeps the admission test one
  -- comparison and keeps the policy in one place in the service.
  rest_until TEXT NOT NULL,
  -- How many evaluations in a row have confirmed the description. The doubling
  -- above reads this; a rewrite resets it.
  consecutive_keeps INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_keeps >= 0),
  -- The highest message sequence the last evaluation read. The next evaluation
  -- measures what is new against it, so a quiet work stream is never
  -- re-evaluated on a transcript it has already seen.
  evaluated_through_sequence INTEGER NOT NULL CHECK (evaluated_through_sequence >= 0),
  window_message_count INTEGER NOT NULL DEFAULT 0 CHECK (window_message_count >= 0),
  -- `pending` is the claim; the rest are outcomes. `kept` is the common one and
  -- is deliberately recorded: knowing the loop looked and left the description
  -- alone is what separates a description that still fits from one nothing has
  -- examined. `rejected` is a proposal the guards refused, `failed` an
  -- evaluation that never produced one, and `authored` a person settling the
  -- description themselves — which is not a `kept`, because the loop did not
  -- look and this row is the only place that distinction is recorded.
  decision TEXT NOT NULL
    CHECK (decision IN ('pending', 'kept', 'rewritten', 'rejected', 'failed', 'authored')),
  rejection_code TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model TEXT,
  previous_description TEXT,
  description TEXT,
  reasoning TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- A refusal without its reason is an unexplained description; the code is
  -- what makes a run of them diagnosable.
  CHECK ((decision IN ('rejected', 'failed')) = (rejection_code IS NOT NULL)),
  CHECK (decision <> 'rewritten' OR description IS NOT NULL)
);

-- Answers "which work streams has the loop touched lately, and what did it do"
-- for one workspace, which is the only way this table is read outside its own
-- work stream.
CREATE INDEX IF NOT EXISTS workstream_description_refreshes_workspace_idx
  ON workstream_description_refreshes(workspace_id, evaluated_at DESC);
