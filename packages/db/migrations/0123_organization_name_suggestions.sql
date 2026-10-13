-- Migration-first: the Worker before it never reads this table.
--
-- The organization name suggested at signup, read from the homepage of an
-- email domain (`apps/api/src/services/organization-name-suggestion.ts`). One
-- row per domain, shared by everyone who signs up from it. `outcome` is what
-- the read found, and `name` is set exactly when it is `named`, so an answer
-- that named nothing is reused too. An unreachable homepage is never stored.
-- A row older than thirty days is read again. Written only on Global.
CREATE TABLE organization_name_suggestions (
  domain TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('named', 'unnamed', 'missing', 'not_html')),
  name TEXT,
  fetched_at TEXT NOT NULL,
  CHECK ((outcome = 'named') = (name IS NOT NULL))
) STRICT;
