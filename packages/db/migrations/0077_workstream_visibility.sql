-- Who may read a work stream, in the two words the product has always shown for
-- it. `scope` borrowed `notes`' `personal`/`workspace` vocabulary, and the
-- borrowing stopped fitting the moment a work stream could be started from a
-- private Slack channel: that work stream is private *and* belongs to everyone
-- in the channel, which is what `personal` says the opposite of. The sidebar has
-- rendered the lock as "Private work stream" since the column existed, so this
-- renames the storage to what the product already called it.
--
-- Nullable with no default on purpose. The deploy job applies migrations before
-- it deploys either Worker, so the previous Worker writes into this schema for
-- the length of a deployment — longer if the deploy fails — and it does not know
-- this column. A `DEFAULT 'public'` would therefore be *the value* for every row
-- it inserts in that window, including the digest work streams
-- `createDigestWorkstream` writes as `scope = 'personal'`, each of which is
-- assembled from one person's private activity. See RUNBOOK.md, "The window
-- between a migration and the Worker that needs it". The insert trigger below
-- derives the column from `scope` instead, so an old Worker's row is correct
-- rather than merely defaulted, and `0078` tightens it to `NOT NULL`.
ALTER TABLE workstreams ADD COLUMN visibility TEXT
  CHECK (visibility IS NULL OR visibility IN ('public', 'private'));

UPDATE workstreams
SET visibility = CASE WHEN scope = 'personal' THEN 'private' ELSE 'public' END;

-- `scope` is dead to the application from this migration forward: nothing reads
-- it and nothing writes it. It survives the deployment window only, and these
-- three triggers are what make that window safe in both directions — the
-- previous Worker still decides visibility through `scope`, and the new one
-- decides it through `visibility`, and for those seconds both are live at once
-- in two regions that deploy nine seconds apart. Mirroring one way would leave
-- the other's write invisible: a member closing a work stream on the old Worker
-- while a reader is served by the new one is a private work stream read by the
-- workspace, which is the one failure here that cannot be taken back.
--
-- Each trigger is guarded by whether the other column already agrees, so the
-- write it makes cannot re-fire its counterpart. That terminates regardless of
-- `PRAGMA recursive_triggers`, which is off by default and is not a thing to
-- depend on.
CREATE TRIGGER workstreams_visibility_from_scope_insert
AFTER INSERT ON workstreams
WHEN new.visibility IS NULL
BEGIN
  UPDATE workstreams
     SET visibility = CASE WHEN new.scope = 'personal' THEN 'private' ELSE 'public' END
   WHERE id = new.id;
END;

CREATE TRIGGER workstreams_visibility_from_scope_update
AFTER UPDATE OF scope ON workstreams
WHEN new.visibility IS NOT (CASE WHEN new.scope = 'personal' THEN 'private' ELSE 'public' END)
BEGIN
  UPDATE workstreams
     SET visibility = CASE WHEN new.scope = 'personal' THEN 'private' ELSE 'public' END
   WHERE id = new.id;
END;

CREATE TRIGGER workstreams_scope_from_visibility_update
AFTER UPDATE OF visibility ON workstreams
WHEN new.scope IS NOT (CASE WHEN new.visibility = 'private' THEN 'personal' ELSE 'workspace' END)
BEGIN
  UPDATE workstreams
     SET scope = CASE WHEN new.visibility = 'private' THEN 'personal' ELSE 'workspace' END
   WHERE id = new.id;
END;
