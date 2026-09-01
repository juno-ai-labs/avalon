PRAGMA foreign_keys = ON;

-- A closed workspace is retained for operator reversal, but every normal
-- authority read fences it. NULL keeps all existing workspaces active.
ALTER TABLE workspaces ADD COLUMN abandoned_at TEXT;

-- The route registry used to be one current destination per account. It now
-- retains one independently reconcilable route per regional membership.
DROP TRIGGER platform_workspace_binding_placement_default;
DROP TRIGGER platform_workspace_binding_placement_immutable;
DROP INDEX platform_workspace_bindings_destination_idx;

ALTER TABLE platform_workspace_bindings
  RENAME TO platform_workspace_bindings_before_multiple_workspaces;

CREATE TABLE platform_workspace_bindings (
  platform_user_id TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'inactive')),
  operation_id TEXT NOT NULL UNIQUE,
  pending_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  placement_affinity TEXT NOT NULL DEFAULT 'wnam'
    CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
  PRIMARY KEY (platform_user_id, region, workspace_id)
);

INSERT INTO platform_workspace_bindings
  (platform_user_id, region, workspace_id, status, operation_id,
   pending_expires_at, created_at, updated_at, placement_affinity)
SELECT platform_user_id, region, workspace_id, status, operation_id,
       pending_expires_at, created_at, updated_at, placement_affinity
FROM platform_workspace_bindings_before_multiple_workspaces;

DROP TABLE platform_workspace_bindings_before_multiple_workspaces;

CREATE INDEX platform_workspace_bindings_destination_idx
  ON platform_workspace_bindings(region, workspace_id, status);
CREATE UNIQUE INDEX platform_workspace_bindings_one_pending_idx
  ON platform_workspace_bindings(platform_user_id)
  WHERE status = 'pending';

CREATE TRIGGER platform_workspace_binding_placement_default
AFTER INSERT ON platform_workspace_bindings
WHEN (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
  OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
BEGIN
  UPDATE platform_workspace_bindings
  SET placement_affinity = CASE NEW.region WHEN 'eu' THEN 'weur' ELSE 'wnam' END
  WHERE platform_user_id = NEW.platform_user_id
    AND region = NEW.region
    AND workspace_id = NEW.workspace_id;
END;

CREATE TRIGGER platform_workspace_binding_placement_immutable
BEFORE UPDATE OF placement_affinity ON platform_workspace_bindings
WHEN ((OLD.region = 'global' AND OLD.placement_affinity IN ('wnam', 'enam'))
   OR (OLD.region = 'eu' AND OLD.placement_affinity IN ('weur', 'eeur')))
  AND NEW.placement_affinity <> OLD.placement_affinity
BEGIN
  SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
END;

-- The client operation id is both the telemetry correlation id and the durable
-- replay key. This journal chooses the destination before a regional write, so
-- a lost response can resume the same membership instead of allocating one
-- more workspace after the first route has become active.
CREATE TABLE platform_workspace_operations (
  operation_id TEXT PRIMARY KEY,
  platform_user_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'accept')),
  request_fingerprint TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  placement_affinity TEXT NOT NULL
    CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
  invitation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (action = 'create' AND invitation_id IS NULL)
    OR (action = 'accept' AND invitation_id IS NOT NULL)
  )
);

CREATE INDEX platform_workspace_operations_identity_idx
  ON platform_workspace_operations(platform_user_id, created_at DESC);
