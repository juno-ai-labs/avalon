-- Automation subscriptions receive permanent inbound-email identities from the
-- same Global namespace as work streams. Regional rows retain a lifecycle
-- marker so interrupted Global RPC activation can be reconciled safely.
ALTER TABLE automation_subscriptions ADD COLUMN email_address TEXT;
ALTER TABLE automation_subscriptions ADD COLUMN email_route_status TEXT NOT NULL DEFAULT 'reserved'
  CHECK (email_route_status IN ('reserved', 'active', 'disabled'));

CREATE UNIQUE INDEX automation_subscriptions_email_address_unique_idx
  ON automation_subscriptions(email_address COLLATE NOCASE)
  WHERE email_address IS NOT NULL;

CREATE TRIGGER automation_subscriptions_email_address_immutable
BEFORE UPDATE OF email_address ON automation_subscriptions
WHEN OLD.email_address IS NOT NULL
  AND NEW.email_address IS NOT OLD.email_address
BEGIN
  SELECT RAISE(ABORT, 'automation email addresses are immutable');
END;

-- Keep the historical table name for deployment compatibility. local_part is
-- the single account-wide namespace across both regions and both owner kinds.
DROP TRIGGER workstream_email_routes_identity_immutable;
DROP TRIGGER workstream_email_routes_no_delete;
DROP INDEX workstream_email_routes_destination_idx;

ALTER TABLE workstream_email_routes RENAME TO workstream_email_routes_before_automation;

CREATE TABLE workstream_email_routes (
  local_part TEXT PRIMARY KEY COLLATE NOCASE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  workstream_id TEXT,
  automation_subscription_id TEXT,
  status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  CHECK (
    (workstream_id IS NOT NULL AND automation_subscription_id IS NULL)
    OR (workstream_id IS NULL AND automation_subscription_id IS NOT NULL)
  ),
  UNIQUE (region, workspace_id, workstream_id),
  UNIQUE (region, workspace_id, automation_subscription_id)
);

INSERT INTO workstream_email_routes
  (local_part, region, workspace_id, workstream_id, automation_subscription_id,
   status, created_at, updated_at, disabled_at)
SELECT local_part, region, workspace_id, workstream_id, NULL,
       status, created_at, updated_at, disabled_at
FROM workstream_email_routes_before_automation;

DROP TABLE workstream_email_routes_before_automation;

CREATE INDEX workstream_email_routes_destination_idx
  ON workstream_email_routes(
    region, workspace_id, workstream_id, automation_subscription_id, status
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

-- Regional provider-email idempotency. The automation run itself also has a
-- unique provider-derived idempotency key; this receipt provides a reclaimable
-- lease around provider fetch and durable payload creation.
CREATE TABLE automation_email_receipts (
  resend_email_id TEXT NOT NULL,
  automation_subscription_id TEXT NOT NULL
    REFERENCES automation_subscriptions(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  svix_id TEXT NOT NULL,
  payload_ref TEXT,
  workstream_id TEXT REFERENCES workstreams(id) ON DELETE RESTRICT,
  automation_run_id TEXT REFERENCES automation_runs(id) ON DELETE RESTRICT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_json TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  PRIMARY KEY (resend_email_id, automation_subscription_id)
);

CREATE INDEX automation_email_receipts_subscription_idx
  ON automation_email_receipts(automation_subscription_id, received_at DESC);

CREATE INDEX automation_email_receipts_lease_idx
  ON automation_email_receipts(processed_at, lease_expires_at)
  WHERE processed_at IS NULL;

-- A leaked alias must not become an unbounded inference-spend capability.
-- The regional Worker atomically claims one slot before creating any run.
CREATE TABLE automation_email_rate_windows (
  automation_subscription_id TEXT NOT NULL
    REFERENCES automation_subscriptions(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  window_started_at TEXT NOT NULL,
  accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
  PRIMARY KEY (automation_subscription_id, window_started_at)
);

CREATE INDEX automation_email_rate_windows_workspace_idx
  ON automation_email_rate_windows(workspace_id, window_started_at DESC);
