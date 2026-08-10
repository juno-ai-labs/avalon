-- Archiving a draft automation hides it from the sidebar without deleting the
-- subscription, its template version, or its memory scope. Only draft
-- subscriptions can be archived, so this column never hides an automation that
-- schedules, activities, or inbound email can still start: every one of those
-- paths already requires status = 'active'.
ALTER TABLE automation_subscriptions ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS automation_subscriptions_visible_idx
  ON automation_subscriptions(workspace_id, archived_at);
