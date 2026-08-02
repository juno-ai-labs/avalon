-- A resource attachment and a scheduled resource watch are separate actions.
-- Reconcile legacy presentation flags to the scheduler-visible canonical row.
UPDATE workstream_resources AS wr
SET watch_enabled = CASE
  WHEN EXISTS (
    SELECT 1
      FROM resource_watches rw
     WHERE rw.workstream_id = wr.workstream_id
       AND rw.resource_id = wr.resource_id
       AND rw.enabled = 1
       AND rw.next_poll_at IS NOT NULL
  ) THEN 1
  ELSE 0
END;
