-- Migration-first: the Worker before it never reads this table.
--
-- Per-domain cache of the organization name suggested at signup; see
-- `apps/api/src/services/organization-name-suggestion.ts`. Global only.
CREATE TABLE organization_name_suggestions (
  domain TEXT PRIMARY KEY,
  outcome TEXT NOT NULL CHECK (outcome IN ('named', 'unnamed', 'missing', 'not_html', 'too_large', 'refused')),
  name TEXT,
  fetched_at TEXT NOT NULL,
  CHECK ((outcome = 'named') = (name IS NOT NULL))
) STRICT;
