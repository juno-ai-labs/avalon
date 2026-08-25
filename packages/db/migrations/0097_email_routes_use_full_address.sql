-- An email route is the whole address, not its local part. The local-part-only
-- key made a domain rename rewrite every historical route at read time, and it
-- also made two future custom domains unable to use the same local part for
-- different owners.
--
-- Existing addresses crossed from automation.with-avalon.com to
-- automation.rallywith.ai in commit c983257a. The commit could not mint a
-- Rally address before 2026-08-25T03:28:06Z. Production had no route claims
-- between the last pre-cutover row and the first deployment known to carry the
-- new domain, so the commit time is an unambiguous backfill boundary there.
-- The boundary is exclusive: a row stamped at that exact instant belongs to
-- the Rally side. The production deploy completed at 04:14:09Z; an audit found
-- zero claims between merge and deploy, with the surrounding claims at
-- 2026-08-24T22:25:01.928Z and 2026-08-25T15:00:02.996Z.
-- A regional owner's stored full address remains the product authority; the
-- Worker verifies this inferred value whenever that owner is reconciled and
-- may replace it exactly once while address_source = 'migration'.

DROP TRIGGER workstream_email_routes_identity_immutable;
DROP TRIGGER workstream_email_routes_no_delete;
DROP INDEX workstream_email_routes_destination_idx;

ALTER TABLE workstream_email_routes RENAME TO workstream_email_routes_before_full_address;

CREATE TABLE workstream_email_routes (
  email_address TEXT PRIMARY KEY COLLATE NOCASE,
  address_source TEXT NOT NULL CHECK (address_source IN ('migration', 'allocator', 'owner')),
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  workstream_id TEXT,
  automation_subscription_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (email_address = lower(email_address)),
  CHECK (length(email_address) <= 254 AND instr(email_address, '@') > 1),
  CHECK (
    (workstream_id IS NOT NULL AND automation_subscription_id IS NULL)
    OR (workstream_id IS NULL AND automation_subscription_id IS NOT NULL)
  ),
  UNIQUE (region, workspace_id, workstream_id),
  UNIQUE (region, workspace_id, automation_subscription_id)
);

INSERT INTO workstream_email_routes
  (email_address, address_source, region, workspace_id, workstream_id,
   automation_subscription_id, created_at, updated_at)
SELECT lower(local_part) || '@' || CASE
         WHEN created_at < '2026-08-25T03:28:06.000Z'
           THEN 'automation.with-avalon.com'
         ELSE 'automation.rallywith.ai'
       END,
       'migration', region, workspace_id, workstream_id,
       automation_subscription_id, created_at, updated_at
FROM workstream_email_routes_before_full_address;

DROP TABLE workstream_email_routes_before_full_address;

CREATE INDEX workstream_email_routes_destination_idx
  ON workstream_email_routes(
    region, workspace_id, workstream_id, automation_subscription_id
  );

-- The owner may verify or correct a migration-inferred address exactly once.
-- Allocator- and owner-sourced claims, and every destination identity, are
-- immutable permanent tombstones.
CREATE TRIGGER workstream_email_routes_identity_immutable
BEFORE UPDATE OF email_address, address_source, region, workspace_id, workstream_id, automation_subscription_id
ON workstream_email_routes
WHEN NEW.region IS NOT OLD.region
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.workstream_id IS NOT OLD.workstream_id
  OR NEW.automation_subscription_id IS NOT OLD.automation_subscription_id
  OR (
    (NEW.email_address IS NOT OLD.email_address OR NEW.address_source IS NOT OLD.address_source)
    AND NOT (OLD.address_source = 'migration' AND NEW.address_source = 'owner')
  )
BEGIN
  SELECT RAISE(ABORT, 'email route identities are immutable');
END;

CREATE TRIGGER workstream_email_routes_no_delete
BEFORE DELETE ON workstream_email_routes
BEGIN
  SELECT RAISE(ABORT, 'email routes are permanent tombstones');
END;
