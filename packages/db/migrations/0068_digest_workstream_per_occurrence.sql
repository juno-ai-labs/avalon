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
-- An earlier compaction design made that worse: it preserved the first user
-- message verbatim through every later compaction, which in a digest work stream
-- meant the first occurrence's brief pinned to the front of that person's
-- context forever. That was removed in 084c54a, before this landed, so it is
-- history rather than a reason — compaction now carries nothing forward
-- verbatim. The replayed transcript above is the whole of the case.
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

-- No index on it. The only reverse lookup is settlement's note, which starts
-- from a delivery id and reads this column; nothing searches deliveries *by*
-- work stream.

-- The ordinary sidebar list gets a recency index of its own, because digest work
-- streams now grow a population inside `workstreams` that it never wants to see.
--
-- `workstreams_sidebar_recency_idx` is keyed `(workspace_id, last_activity_at
-- DESC)`, so the list seeks to the workspace and then walks in recency order,
-- testing `system_kind` row by row. That was free when a workspace held one
-- digest work stream per person. With one per occurrence and nothing reaping
-- them, every ordinary listing — which is every listing outside Debug enabled,
-- so very nearly all of them — has to step over each digest row newer than the
-- last row it returns, a scan that grows with digest history for a result set
-- that does not.
--
-- A partial index is usable only when the query's WHERE implies its predicate,
-- which is why this mirrors the listing clause exactly. There is deliberately no
-- matching index for the `system_kind IS NOT NULL` side: a listing that asks for
-- machinery does not filter on it — it asks for everything and pages — so it has
-- no predicate that could reach such an index, and it keeps using the general
-- one above. That index stays for the same reason, so an unarchived row sits in
-- it and, when it is ordinary, in this one too: two index writes per
-- `last_activity_at` update rather than one.
CREATE INDEX workstreams_sidebar_recency_ordinary_idx
  ON workstreams(workspace_id, last_activity_at DESC)
  WHERE archived_at IS NULL AND system_kind IS NULL;

-- `digest_schedules.system_workstream_id` is deliberately NOT dropped here.
--
-- The deploy job applies both regions' migrations before it deploys either
-- Worker, so between this migration and the Worker that stops naming the column
-- the *previous* Worker is still running — and it reads that column in
-- `fireDigestSchedule`, writes it in `reconcileDigestDefaults`, and selects it
-- when the settings screen loads a digest. Dropping it in the same change turns
-- all three into `no such column` for the length of a deployment, which the
-- runbook measures in seconds when it goes well and in hours when it does not,
-- because a failed deploy leaves the migrations applied. Digest firing would
-- throw, the reconciler's whole batch would abort, and digest settings would
-- 500. See RUNBOOK.md, "The window between a migration and the Worker that
-- needs it".
--
-- So this is the backward-compatible half: the new column arrives and is
-- populated, and the old column keeps working for whatever is still reading it.
-- Once this Worker is deployed everywhere, a later migration drops the column
-- on its own — by then nothing reads it, and the drop is the whole change
-- rather than a hazard buried in one.
--
-- The work streams it names are a separate question and are left alone
-- permanently. They hold real transcripts their owners can still open with
-- Debug enabled, and deleting somebody's history to tidy up a pointer is not
-- this migration's business.
