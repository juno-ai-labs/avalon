-- Reading routing feedback back out of `activity_suggestions`.
--
-- The table has answered one question since it was created — "what are this
-- work stream's pending suggestions" — which its primary key and the
-- `UNIQUE (activity_id, workstream_id)` dedupe served without help. Contextual
-- routing now reads *resolved* rows before it suggests anything: once per
-- activity to score the event type across the workspace, and once per candidate
-- work stream to find a run of dismissals. Both run on the ingestion path,
-- ahead of an inference call, for every activity that reaches contextual
-- routing, so both have to be an index seek rather than a scan of every
-- suggestion the workspace has ever produced.
--
-- `status` precedes `resolved_at` in both keys because both reads select one
-- status and then range-scan the timestamp; `resolved_at` is in them at all
-- because both reads are windowed, which is what lets a suppressed work stream
-- or event type recover without an acceptance it can no longer earn. Neither
-- index is partial: SQLite would take `WHERE status IN ('accepted','dismissed')`
-- as a partial-index predicate, but `status` is also the first thing both reads
-- filter on, so the full index serves them and stays usable by any later reader
-- of pending rows.
CREATE INDEX activity_suggestions_workspace_feedback_idx
ON activity_suggestions(workspace_id, status, resolved_at);

CREATE INDEX activity_suggestions_workstream_feedback_idx
ON activity_suggestions(workstream_id, status, resolved_at);
