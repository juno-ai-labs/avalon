-- Retire artifacts. The `workstream_create_artifact` tool was the table's only
-- writer, and what it produced was never read back by anything that mattered:
-- the digest mails the run's final message, so an agent that wrote its output
-- into an artifact and left a receipt behind mailed the receipt. Removing the
-- destination is what stops that, rather than teaching each consumer to look in
-- a second place for the same text.
--
-- The R2 objects under `<region>/<workspace>/artifacts/` are NOT removed here.
-- A migration cannot reach the bucket, and dropping the table takes their only
-- pointers with it, so they must be swept by prefix out of band.
DROP TABLE IF EXISTS artifacts;

-- Nothing ever wrote one — the tool inserted into `artifacts` and never into
-- `messages` — so this clears legacy rows from a transcript block that was
-- rendered but never produced. Gaps in `sequence_number` are expected and safe:
-- the column is unique per work stream and read waterlines compare `>=`.
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
