-- Migration-first: the Worker before it never reads this table.
--
-- The organization name suggested at signup, read from the homepage of an
-- email domain (`apps/api/src/services/organization-name-suggestion.ts`). One
-- row per domain, shared by everyone who signs up from it. `name` is NULL when
-- the homepage answered but named nothing usable, so that answer is reused
-- too. A row older than thirty days is fetched again. Written only on Global.
CREATE TABLE organization_name_suggestions (
  domain TEXT PRIMARY KEY,
  name TEXT,
  fetched_at TEXT NOT NULL
) STRICT;
