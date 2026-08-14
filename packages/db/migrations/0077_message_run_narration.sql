-- A run's transcript rows are its turns: what it said on the way to each set of
-- tool calls, and the answer it ended on. Only the last of those is the run's
-- answer, and several places have to tell the difference — the classifier that
-- decides whether a message is addressed to the agent reads the last ten things
-- said, naming counts what the work stream has said, a description is written
-- from a window of it, and every surface that delivers "the answer" outward
-- reads one row. Without a mark on the row, one talkative run reads as ten
-- things said and crowds every one of those windows out.
--
-- Nullable would have been the cheaper column, but every existing row genuinely
-- is a turn somebody said rather than narration, so the default is the truth
-- for the whole table rather than a placeholder standing in for it.
ALTER TABLE messages ADD COLUMN harness_narration INTEGER NOT NULL DEFAULT 0;

-- The windows above all read recent text rows for one work stream and now
-- filter on this column; without it they scan the work stream's whole history.
CREATE INDEX messages_workstream_narration_idx
  ON messages (workstream_id, harness_narration, sequence_number);
