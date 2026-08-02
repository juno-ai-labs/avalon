ALTER TABLE workstreams ADD COLUMN email_address TEXT;

CREATE UNIQUE INDEX workstreams_email_address_unique_idx
  ON workstreams(email_address COLLATE NOCASE)
  WHERE email_address IS NOT NULL;

CREATE TRIGGER workstreams_email_address_immutable
BEFORE UPDATE OF email_address ON workstreams
WHEN OLD.email_address IS NOT NULL
  AND NEW.email_address IS NOT OLD.email_address
BEGIN
  SELECT RAISE(ABORT, 'work stream email addresses are immutable');
END;

-- The Global data plane is authoritative for this route table. Regional
-- databases have the same schema so local development and disaster recovery
-- can exercise the complete flow without a second public ingress.
CREATE TABLE workstream_email_routes (
  local_part TEXT PRIMARY KEY COLLATE NOCASE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  UNIQUE (region, workspace_id, workstream_id)
);

CREATE INDEX workstream_email_routes_destination_idx
  ON workstream_email_routes(region, workspace_id, workstream_id, status);

-- Global ingress idempotency. The raw email body is deliberately absent: EU
-- email content is fetched and stored only inside the EU data plane.
CREATE TABLE resend_webhook_receipts (
  svix_id TEXT PRIMARY KEY,
  resend_email_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  routed_at TEXT,
  error_json TEXT
);

CREATE INDEX resend_webhook_receipts_email_idx
  ON resend_webhook_receipts(resend_email_id, received_at DESC);

-- Regional processing idempotency. One received email may intentionally name
-- more than one work stream, so the work-stream identifier is part of the key.
CREATE TABLE workstream_email_receipts (
  resend_email_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  svix_id TEXT NOT NULL,
  payload_ref TEXT,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error_json TEXT,
  PRIMARY KEY (resend_email_id, workstream_id)
);

CREATE INDEX workstream_email_receipts_workstream_idx
  ON workstream_email_receipts(workstream_id, received_at DESC);
