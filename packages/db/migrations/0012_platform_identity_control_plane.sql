PRAGMA foreign_keys = ON;

-- Google identity is established once by the Global control plane. Regional
-- users keep a stable, immutable link to that platform identity while their
-- workspace membership and content remain in the regional database.
ALTER TABLE users ADD COLUMN platform_user_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS users_platform_user_id_idx
  ON users(platform_user_id)
  WHERE platform_user_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS users_platform_identity_immutable
BEFORE UPDATE OF platform_user_id ON users
WHEN OLD.platform_user_id IS NOT NULL
  AND (NEW.platform_user_id IS NULL OR NEW.platform_user_id <> OLD.platform_user_id)
BEGIN
  SELECT RAISE(ABORT, 'platform_user_id_immutable');
END;

-- This table is authoritative only in the Global database. It deliberately
-- has no workspace foreign key because an EU workspace ID is opaque to the
-- Global D1 database. Pending rows serialize cross-region membership creation.
-- pending_expires_at is diagnostic only: an unknown RPC outcome is never
-- reclaimed on elapsed time because its regional action may still commit.
CREATE TABLE IF NOT EXISTS platform_workspace_bindings (
  platform_user_id TEXT PRIMARY KEY,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
  operation_id TEXT NOT NULL UNIQUE,
  pending_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_workspace_bindings_destination_idx
  ON platform_workspace_bindings(region, workspace_id, status);

-- Regional actions are idempotent at the durable data boundary. We do not
-- persist returned session material here; a retry issues a fresh regional
-- session after re-verifying the already-created membership.
CREATE TABLE IF NOT EXISTS regional_onboarding_operations (
  operation_id TEXT PRIMARY KEY,
  platform_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('activate', 'accept', 'create')),
  workspace_id TEXT NOT NULL,
  invitation_id TEXT,
  completed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS regional_onboarding_operations_identity_idx
  ON regional_onboarding_operations(platform_user_id, completed_at DESC);

CREATE INDEX IF NOT EXISTS workspace_invitations_pending_email_idx
  ON workspace_invitations(email, created_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
