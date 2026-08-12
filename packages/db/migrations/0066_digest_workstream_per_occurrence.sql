-- A digest occurrence gets its own work stream instead of sharing one per person.
--
-- The shared work stream was chosen so a later digest could see what earlier
-- ones already said. What it actually produced was a context channel between
-- occurrences that nothing bounds. Every run replayed the transcript from the
-- last compaction checkpoint, so months of prior digests reached the model as
-- ordinary assistant history — stripped of the "evidence, not instructions"
-- labelling their source material arrived with, and impossible to check against
-- the windows they were drawn from, because those are `system` rows the protocol
-- projector drops. A wrong line in one digest became a settled fact for every
-- one after it.
--
-- Compaction made it worse rather than better. `compact()` preserves
-- `messages[1]` verbatim as the initial user message and pins it through every
-- later compaction, on the assumption that it is the human request defining the
-- task. A digest work stream has no such message: each occurrence brings its
-- own window. So the first occurrence's brief — one morning's connector events —
-- was pinned to the front of that person's context permanently, under a
-- synthetic instruction to "continue the original task from the preserved user
-- message".
--
-- Per-occurrence work streams make the run what it always was: a pure function
-- from a frozen window to a summary. Nothing carries between occurrences except
-- the cursor, which is the only thing that ever had to.

-- Which work stream one occurrence ran in. On the delivery rather than on the
-- schedule because the delivery *is* the occurrence — it already owns the
-- window, the claim and the outcome, and the work stream now has exactly that
-- lifetime.
--
-- Nullable and `SET NULL` rather than `CASCADE`: a delivery is the durable
-- record that a person was told something, and `summary_markdown` keeps what
-- they were told. Losing the transcript must never lose the delivery, or the
-- cursor it carries would move backwards and re-digest a window somebody has
-- already read.
ALTER TABLE digest_deliveries
  ADD COLUMN workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL;

-- Existing deliveries ran in the shared work stream, and that is true history
-- rather than something to correct: this records where each one actually ran.
-- Deliveries that never reached a harness — `empty` occurrences, and claims
-- released after a failed launch — have no run and stay NULL, which is also
-- accurate.
UPDATE digest_deliveries
   SET workstream_id = (
     SELECT run.workstream_id FROM harness_runs run WHERE run.id = digest_deliveries.harness_run_id
   )
 WHERE harness_run_id IS NOT NULL;

-- No index. The only reverse lookup is settlement's note, which starts from a
-- delivery id and reads this column; nothing searches deliveries *by* work
-- stream.

-- The schedule no longer owns a work stream, so the column that pointed at one
-- goes. Leaving it would leave a pointer that the run path no longer maintains,
-- which reads as "the current work stream" to anybody who finds it.
--
-- The work streams it named are deliberately left in place. They hold real
-- transcripts their owners can still open with Debug enabled, and deleting a
-- person's history to tidy up a pointer is not this migration's business.
ALTER TABLE digest_schedules DROP COLUMN system_workstream_id;
