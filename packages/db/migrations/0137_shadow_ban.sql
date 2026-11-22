-- A shadow-banned account keeps the Organizations it already has and gains no
-- new one (docs/shadow-ban.md). The time an operator set the ban, or NULL.
ALTER TABLE users ADD COLUMN shadow_banned_at TEXT;

-- The one guard. Creating an Organization, being added to one, accepting an
-- invitation and being shared a Canvas as a guest each write a membership row,
-- so refusing the row here refuses all of them, and any writer added later.
-- A row that already exists is left to the update guard below, so an upsert
-- over an existing relationship is judged by what it changes.
CREATE TRIGGER workspace_member_shadow_ban_insert
BEFORE INSERT ON workspace_members
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND shadow_banned_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM workspace_members
                   WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'account_shadow_banned'); END;

-- A guest made a member, or a suspended relationship made active again, is
-- joining too. Every other change to an existing relationship stays allowed.
CREATE TRIGGER workspace_member_shadow_ban_update
BEFORE UPDATE OF access_class, status ON workspace_members
WHEN ((OLD.access_class = 'guest' AND NEW.access_class = 'member')
   OR (OLD.status <> 'active' AND NEW.status = 'active'))
  AND EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND shadow_banned_at IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'account_shadow_banned'); END;
