-- Reading routing feedback back out of `activity_suggestions`.
--
-- Two things are needed before a resolution can be read back as evidence: a way
-- to tell which producer's card it was, and an index that makes the read a seek.
--
-- **Who wrote the card.** `activity_suggestions` looks like contextual routing's
-- table and is not. `createActivitySuggestion` has two callers — contextual
-- routing in the activity consumer, and `routeExistingDecision` on the
-- suggested-work batching path — and both produce a card that is
-- indistinguishable in the transcript and resolved by the same endpoint. Without
-- this column, "four dismissals of this event type" silently means "four
-- dismissals across two different producers", so cards the suggested-work
-- admission agent published would decide whether contextual routing's classifier
-- gets to speak. The two disagree about what a dismissal even measures: the
-- batching path routes with `confidence: 1` after a deliberate decision over a
-- whole window, where contextual routing is guessing per event.
--
-- Existing rows become `unknown` rather than being attributed to either
-- producer, and no feedback read counts them. Guessing would be free and wrong
-- in the one direction that matters, since the gates it feeds only ever withhold.
-- The cost is that the feedback starts from nothing on deploy, which is where it
-- starts in a new workspace anyway.
ALTER TABLE activity_suggestions
ADD COLUMN source TEXT NOT NULL DEFAULT 'unknown'
  CHECK (source IN ('contextual_routing', 'suggested_work', 'unknown'));

-- **Indexes.** The table has answered one question since it was created — "what
-- are this work stream's pending suggestions" — which its primary key and the
-- `UNIQUE (activity_id, workstream_id)` dedupe served without help. Contextual
-- routing now reads *resolved* rows before it suggests anything: once per
-- activity to score the event type across the workspace, and once per candidate
-- work stream to find a run of dismissals. Both run on the ingestion path, ahead
-- of an inference call, for every activity that reaches contextual routing, so
-- both have to be an index seek rather than a scan of every suggestion the
-- workspace has ever produced.
--
-- `source` sits directly after the scope column because every feedback read
-- filters it to exactly one producer, and `status` follows because both reads
-- select one status and then range-scan `resolved_at`. `resolved_at` is in the
-- keys at all because both reads are windowed, which is what lets a suppressed
-- work stream or event type recover without an acceptance it can no longer earn.
CREATE INDEX activity_suggestions_workspace_feedback_idx
ON activity_suggestions(workspace_id, source, status, resolved_at);

CREATE INDEX activity_suggestions_workstream_feedback_idx
ON activity_suggestions(workstream_id, source, status, resolved_at);
