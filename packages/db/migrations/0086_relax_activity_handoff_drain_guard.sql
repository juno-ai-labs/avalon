-- The maintenance drain guard blocked the importing flip while any
-- `activities` row sat in 'pending' or 'processing'. That condition is
-- stricter than the import needs and, because the phase machine is
-- forward-only, it can strand a region in `maintenance_draining` (serving
-- 503s) with no way to satisfy it: the drained consumer refuses the very work
-- the guard waits for. The Global cutover hit exactly this — 862 'processing'
-- rows whose claiming Workflows had been dead for days.
--
-- Dropping the clause is safe by the import's own design: the
-- workspace_connector_events stage carries `processing_status` through,
-- imports unprocessed rows with their claims cleared for post-open recovery,
-- and once the phase leaves draining the writer fences reject any straggling
-- legacy processor anyway — the fences, not this guard, protect the snapshot.
-- The object-deletion outboxes and Slack ingress conditions remain: those
-- represent R2 side effects and handoffs with no post-import recovery path.
--
-- Global's database received this exact trigger by operator surgery on
-- 2026-08-19 to unblock the stranded cutover; replaying it here is a no-op
-- there and brings EU and every future database to the same definition.
DROP TRIGGER IF EXISTS workspace_domain_object_deletion_drain_guard;
CREATE TRIGGER workspace_domain_object_deletion_drain_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN OLD.phase = 'maintenance_draining' AND NEW.phase = 'maintenance_importing'
  AND (
    EXISTS (SELECT 1 FROM note_resource_deletion_outbox)
    OR EXISTS (SELECT 1 FROM resource_object_deletion_outbox)
    OR EXISTS (
      SELECT 1 FROM slack_ingress_jobs
       WHERE status IN ('queued', 'processing')
          OR (status = 'failed' AND payload_json IS NOT NULL AND attempt_count < 20)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace_domain_handoffs_not_drained');
END;
