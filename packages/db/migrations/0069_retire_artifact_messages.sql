-- Retire artifacts, first half. The `workstream_create_artifact` tool was the
-- `artifacts` table's only writer, and what it produced was never read back by
-- anything that mattered: the digest mails the run's final message, so an agent
-- that wrote its output into an artifact and left a receipt behind mailed the
-- receipt. Removing the destination is what stops that, rather than teaching
-- each consumer to look in a second place for the same text.
--
-- **`DROP TABLE artifacts` is deliberately not here.** The deploy job applies
-- both regions' migrations before it deploys either Worker, so for the length
-- of a deployment the *previous* Worker is running against the new schema — and
-- that Worker calls `loadArtifacts` on every `GET /workstreams/:id/context`.
-- Dropping the table in the same release as the code removal would fail every
-- context request in both regions until the new Worker went live, and
-- indefinitely if the deploy failed after the migration step, because a failed
-- deployment leaves migrations applied. The table is therefore retained here
-- and dropped in a later release, once no deployed Worker reads it. See
-- "The window between a migration and the Worker that needs it" in the runbook.
--
-- What is safe now is the `messages` half: nothing has ever written an
-- `'artifact'` row — the tool inserted into `artifacts` and never into
-- `messages` — so neither the delete nor the triggers can collide with a Worker
-- of either generation.

-- Clears legacy rows from a transcript block that was rendered but never
-- produced. Gaps in `sequence_number` are expected and safe: the column is
-- unique per work stream rather than contiguous, and read waterlines compare
-- with `>=`.
DELETE FROM messages
WHERE message_type = 'artifact';

-- Deployed `messages` tables carry a historical CHECK admitting 'artifact'.
-- Reject it explicitly rather than rebuilding the largest table in the schema
-- and every foreign key rooted at it, which is what 0038 did for the same
-- reason when the Web Monitor connector was retired.
CREATE TRIGGER IF NOT EXISTS messages_artifact_type_removed_insert
BEFORE INSERT ON messages
FOR EACH ROW
WHEN NEW.message_type = 'artifact'
BEGIN
  SELECT RAISE(ABORT, 'artifact messages have been removed');
END;

CREATE TRIGGER IF NOT EXISTS messages_artifact_type_removed_update
BEFORE UPDATE OF message_type ON messages
FOR EACH ROW
WHEN NEW.message_type = 'artifact'
BEGIN
  SELECT RAISE(ABORT, 'artifact messages have been removed');
END;
