-- Global holds one fact about an address: that it is taken, permanently.
--
-- `status` was a second copy of a decision every delivery already re-derives
-- regionally from the owner's own row — `archived_at IS NULL` for a work
-- stream, `status = 'active' AND lifecycle_state = 'visible'` for an
-- automation. The inbound resolver filtered on the Global copy as well, so a
-- route could only be trusted while two records agreed.
--
-- Keeping them agreed is what the lifecycle RPCs existed for, and it is what
-- made a transient failure durable: a pause or resume whose Global transition
-- failed left the regional marker knowingly stale, and an automation's inbound
-- mail was refused until a list or detail read happened to reconcile it. There
-- is nothing to reconcile once the address is the only thing recorded here.
--
-- Rebuild rather than `DROP COLUMN`: `status` is inside a CHECK constraint and
-- carried by the destination index, both of which SQLite refuses to drop a
-- column out of. The steps mirror 0022, which last rebuilt this table.

DROP TRIGGER workstream_email_routes_identity_immutable;
DROP TRIGGER workstream_email_routes_no_delete;
DROP INDEX workstream_email_routes_destination_idx;

ALTER TABLE workstream_email_routes RENAME TO workstream_email_routes_before_status_drop;

CREATE TABLE workstream_email_routes (
  local_part TEXT PRIMARY KEY COLLATE NOCASE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  workstream_id TEXT,
  automation_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (workstream_id IS NOT NULL AND automation_subscription_id IS NULL)
    OR (workstream_id IS NULL AND automation_subscription_id IS NOT NULL)
  ),
  UNIQUE (region, workspace_id, workstream_id),
  UNIQUE (region, workspace_id, automation_subscription_id)
);

-- Every row carries over, disabled ones included. A disabled route is still a
-- claimed address, and this table exists to stop that address being handed to
-- anybody else.
INSERT INTO workstream_email_routes
  (local_part, region, workspace_id, workstream_id, automation_subscription_id,
   created_at, updated_at)
SELECT local_part, region, workspace_id, workstream_id, automation_subscription_id,
       created_at, updated_at
FROM workstream_email_routes_before_status_drop;

DROP TABLE workstream_email_routes_before_status_drop;

CREATE INDEX workstream_email_routes_destination_idx
  ON workstream_email_routes(
    region, workspace_id, workstream_id, automation_subscription_id
  );

CREATE TRIGGER workstream_email_routes_identity_immutable
BEFORE UPDATE OF local_part, region, workspace_id, workstream_id, automation_subscription_id
ON workstream_email_routes
WHEN NEW.local_part IS NOT OLD.local_part
  OR NEW.region IS NOT OLD.region
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.workstream_id IS NOT OLD.workstream_id
  OR NEW.automation_subscription_id IS NOT OLD.automation_subscription_id
BEGIN
  SELECT RAISE(ABORT, 'email route identities are immutable');
END;

CREATE TRIGGER workstream_email_routes_no_delete
BEFORE DELETE ON workstream_email_routes
BEGIN
  SELECT RAISE(ABORT, 'email routes are permanent tombstones');
END;
