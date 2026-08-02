-- Regional work streams keep a durable copy of the route lifecycle so a
-- failed Global RPC activation can be retried without guessing. Existing
-- addressed work streams predate this marker and already own active routes.
ALTER TABLE workstreams ADD COLUMN email_route_status TEXT NOT NULL DEFAULT 'reserved'
  CHECK (email_route_status IN ('reserved', 'active', 'disabled'));

UPDATE workstreams
SET email_route_status = 'active'
WHERE email_address IS NOT NULL;

-- Reservations are permanent tombstones, but they are not routable until the
-- owning regional work-stream transaction has committed and explicitly
-- activates them. SQLite cannot widen a CHECK constraint in place, so rebuild
-- the small Global registry while preserving every issued identity.
DROP TRIGGER workstream_email_routes_identity_immutable;
DROP TRIGGER workstream_email_routes_no_delete;
DROP INDEX workstream_email_routes_destination_idx;

ALTER TABLE workstream_email_routes RENAME TO workstream_email_routes_before_lifecycle;

CREATE TABLE workstream_email_routes (
  local_part TEXT PRIMARY KEY COLLATE NOCASE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (region, workspace_id, workstream_id)
);

INSERT INTO workstream_email_routes
  (local_part, region, workspace_id, workstream_id, status, created_at, updated_at, disabled_at)
SELECT local_part, region, workspace_id, workstream_id, status, created_at, updated_at, disabled_at
FROM workstream_email_routes_before_lifecycle;

DROP TABLE workstream_email_routes_before_lifecycle;

CREATE INDEX workstream_email_routes_destination_idx
  ON workstream_email_routes(region, workspace_id, workstream_id, status);

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
