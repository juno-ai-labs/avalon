-- Guest is an ordinary user's relationship to one workspace. A guest has no
-- administrative role. Rebuild the unreferenced membership table to make that
-- distinction an enforced invariant rather than a convention in middleware.
CREATE TABLE _guest_members_copy AS SELECT * FROM workspace_members;
DROP TABLE workspace_members;
CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  joined_at TEXT,
  last_seen_at TEXT,
  access_class TEXT NOT NULL DEFAULT 'member' CHECK (access_class IN ('member', 'guest')),
  incarnation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  CHECK ((access_class = 'member' AND role IS NOT NULL) OR (access_class = 'guest' AND role IS NULL)),
  PRIMARY KEY (workspace_id, user_id)
) STRICT;
INSERT INTO workspace_members (workspace_id,user_id,role,status,joined_at,last_seen_at)
SELECT workspace_id,user_id,role,status,joined_at,last_seen_at FROM _guest_members_copy;
DROP TABLE _guest_members_copy;
CREATE INDEX workspace_members_user_idx ON workspace_members(user_id, status);
CREATE INDEX workspace_members_last_seen_idx ON workspace_members(workspace_id, last_seen_at);

-- No foreign keys: a removal must leave its delivery intent after the user or
-- workspace is deleted. The control-plane dispatcher acknowledges by sequence.
CREATE TABLE workspace_relationship_deliveries (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('upsert', 'removed')),
  access_class TEXT NOT NULL CHECK (access_class IN ('member', 'guest')),
  role TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  dispatched_at TEXT,
  processed_at TEXT,
  UNIQUE(workspace_id, user_id, incarnation, revision)
) STRICT;
CREATE INDEX workspace_relationship_deliveries_pending_idx
ON workspace_relationship_deliveries(sequence) WHERE dispatched_at IS NULL;

CREATE TRIGGER workspace_member_incarnation_immutable
BEFORE UPDATE OF incarnation,workspace_id,user_id ON workspace_members
WHEN NEW.incarnation <> OLD.incarnation OR NEW.workspace_id <> OLD.workspace_id OR NEW.user_id <> OLD.user_id
BEGIN SELECT RAISE(ABORT, 'workspace_member_identity_immutable'); END;

CREATE TRIGGER workspace_member_revision_monotone
BEFORE UPDATE OF revision ON workspace_members WHEN NEW.revision < OLD.revision
BEGIN SELECT RAISE(ABORT, 'workspace_member_revision_regressed'); END;

-- Legacy membership writers participate in durable publication too. Activity
-- touches do not change admission or produce an intent.
CREATE TRIGGER workspace_member_admission_revision
AFTER UPDATE OF role,status,access_class ON workspace_members
WHEN NEW.revision = OLD.revision AND
  (NEW.role IS NOT OLD.role OR NEW.status <> OLD.status OR NEW.access_class <> OLD.access_class)
BEGIN
  UPDATE workspace_members SET revision = revision + 1
  WHERE workspace_id = NEW.workspace_id AND user_id = NEW.user_id;
END;

CREATE TRIGGER workspace_member_delivery_insert AFTER INSERT ON workspace_members
BEGIN
  INSERT INTO workspace_relationship_deliveries
    (workspace_id,user_id,incarnation,revision,change_kind,access_class,role,status)
  VALUES (NEW.workspace_id,NEW.user_id,NEW.incarnation,NEW.revision,'upsert',NEW.access_class,NEW.role,NEW.status);
END;

CREATE TRIGGER workspace_member_delivery_update AFTER UPDATE OF revision ON workspace_members
WHEN NEW.revision > OLD.revision
BEGIN
  INSERT INTO workspace_relationship_deliveries
    (workspace_id,user_id,incarnation,revision,change_kind,access_class,role,status)
  VALUES (NEW.workspace_id,NEW.user_id,NEW.incarnation,NEW.revision,'upsert',NEW.access_class,NEW.role,NEW.status);
END;

CREATE TRIGGER workspace_member_delivery_delete AFTER DELETE ON workspace_members
BEGIN
  INSERT INTO workspace_relationship_deliveries
    (workspace_id,user_id,incarnation,revision,change_kind,access_class,role,status)
  VALUES (OLD.workspace_id,OLD.user_id,OLD.incarnation,OLD.revision+1,'removed',OLD.access_class,OLD.role,OLD.status);
END;
