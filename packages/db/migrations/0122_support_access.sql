-- Migration-first: the Worker before it never reads either addition, and every
-- session it writes leaves the new column NULL, which means an ordinary login.
--
-- An Organization can let Rally staff (members of the support Organization the
-- API names in `support-access.ts`) act as its people for a bounded time. The
-- grant is one row per Organization: granting again moves its expiry, revoking
-- deletes it. See `docs/impersonation.md`.
CREATE TABLE support_access_grants (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  granted_by_user_id TEXT NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > granted_at)
) STRICT;

-- A support session is an ordinary session of the represented person, so every
-- existing check (membership, incarnation, revocation, socket admission) applies
-- to it unchanged. These columns name the staff member actually acting and the
-- staff membership that admitted them, which is what ties the session to a live
-- grant and to that membership: a staff member removed and invited back holds a
-- new incarnation, so an old support session does not come back with them.
ALTER TABLE sessions ADD COLUMN impersonator_user_id TEXT REFERENCES users(id);
ALTER TABLE sessions ADD COLUMN impersonator_incarnation TEXT;

CREATE INDEX sessions_impersonated_workspace_idx
  ON sessions(workspace_id) WHERE impersonator_user_id IS NOT NULL AND revoked_at IS NULL;
