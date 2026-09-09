-- Pre-workspace acquisition lives in Global D1. EU retains empty schema until
-- regional workspace invitation grants are integrated; no EU address export.
CREATE TABLE access_requests (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  acknowledgement_subject TEXT NOT NULL,
  acknowledgement_markdown TEXT NOT NULL,
  acknowledgement_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (acknowledgement_status IN ('pending', 'sent', 'failed', 'skipped')),
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
  revoked_at TEXT
);
CREATE INDEX download_grants_source ON download_grants(source, source_id);
