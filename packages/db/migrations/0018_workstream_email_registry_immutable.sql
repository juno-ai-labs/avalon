-- A friendly address is a permanent Global reservation. Status may change,
-- but its identity can never be reassigned or deleted, even after a work stream
-- is archived or its regional row is removed.
CREATE TRIGGER workstream_email_routes_identity_immutable
BEFORE UPDATE OF local_part, region, workspace_id, workstream_id ON workstream_email_routes
WHEN NEW.local_part IS NOT OLD.local_part
  OR NEW.region IS NOT OLD.region
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.workstream_id IS NOT OLD.workstream_id
BEGIN
  SELECT RAISE(ABORT, 'work stream email route identities are immutable');
END;

CREATE TRIGGER workstream_email_routes_no_delete
BEFORE DELETE ON workstream_email_routes
BEGIN
  SELECT RAISE(ABORT, 'work stream email routes are permanent tombstones');
END;
