-- A shadow-banned account cannot create an Organization (docs/shadow-ban.md).
-- The time an operator set the ban, or NULL. It can still be added to an
-- Organization as a member or a guest: that is deliberate, and is how the
-- other Organizations of a ring show themselves.
ALTER TABLE users ADD COLUMN shadow_banned_at TEXT;

-- The one guard. Every creator inserts the Organization's row naming who made
-- it, so refusing the row here refuses every way to create one, and any added
-- later. An upsert over an Organization that already exists creates nothing
-- and is left alone.
CREATE TRIGGER workspace_shadow_ban_insert
BEFORE INSERT ON workspaces
WHEN EXISTS (SELECT 1 FROM users WHERE id = NEW.created_by_user_id AND shadow_banned_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'account_shadow_banned'); END;
