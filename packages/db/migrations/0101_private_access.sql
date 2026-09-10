-- Pre-workspace acquisition lives in Global D1. EU retains empty schema until
-- regional workspace invitation grants are integrated; no EU address export.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  acknowledgement_subject TEXT NOT NULL,
  acknowledgement_markdown TEXT NOT NULL,
  acknowledgement_from TEXT NOT NULL,
  acknowledgement_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (acknowledgement_status IN ('pending', 'sending', 'sent', 'failed', 'rejected', 'review_required', 'skipped', 'suppressed')),
  acknowledgement_first_attempt_at TEXT,
  acknowledgement_generation INTEGER NOT NULL DEFAULT 0,
  acknowledged_at TEXT
);

CREATE TABLE download_grants (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('manual', 'access_invitation', 'workspace_invitation')),
  source_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  expires_at TEXT,
  start_bucket INTEGER NOT NULL DEFAULT 0,
  start_count INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE INDEX download_grants_source ON download_grants(source, source_id);

-- Only populated when the operator-selected intake rate guard is finite.
-- Old hourly buckets are discarded on the next guarded request; no raw IPs.
CREATE TABLE access_request_rate_buckets (
  subject_hash TEXT PRIMARY KEY,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE INDEX access_request_rate_buckets_window ON access_request_rate_buckets(bucket);

CREATE INDEX access_requests_created ON access_requests(created_at DESC, id DESC);
CREATE INDEX download_grants_created ON download_grants(created_at DESC, id DESC);
-- One fixed row: authoritative hourly acknowledgement budget across all PoPs.
CREATE TABLE access_email_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL
);
