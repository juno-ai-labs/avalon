PRAGMA foreign_keys = ON;

-- The Global control-plane binding is the cross-region routing record. The
-- regional workspace row is its local immutable projection so data-plane
-- callers can place child Durable Objects without a Global round trip.
ALTER TABLE platform_workspace_bindings
  ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'
  CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur'));

ALTER TABLE workspaces
  ADD COLUMN placement_affinity TEXT NOT NULL DEFAULT 'wnam'
  CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur'));

-- Existing rows are migration-created fallbacks. New creation writes the
-- request-derived value explicitly. SQLite cannot express a region-dependent
-- DEFAULT, so the repair triggers also cover old test fixtures and intentional
-- background creation that omits the column.
UPDATE platform_workspace_bindings
SET placement_affinity = CASE region WHEN 'eu' THEN 'weur' ELSE 'wnam' END;

UPDATE workspaces
SET placement_affinity = CASE region WHEN 'eu' THEN 'weur' ELSE 'wnam' END;

CREATE TRIGGER IF NOT EXISTS platform_workspace_binding_placement_default
AFTER INSERT ON platform_workspace_bindings
WHEN (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
  OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
BEGIN
  UPDATE platform_workspace_bindings
  SET placement_affinity = CASE NEW.region WHEN 'eu' THEN 'weur' ELSE 'wnam' END
  WHERE platform_user_id = NEW.platform_user_id;
END;

CREATE TRIGGER IF NOT EXISTS workspace_placement_default
AFTER INSERT ON workspaces
WHEN (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
  OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
BEGIN
  UPDATE workspaces
  SET placement_affinity = CASE NEW.region WHEN 'eu' THEN 'weur' ELSE 'wnam' END
  WHERE id = NEW.id;
END;

-- Once a compatible affinity exists, changing it would not move an existing
-- Durable Object and would split future children from their parent.
CREATE TRIGGER IF NOT EXISTS platform_workspace_binding_placement_immutable
BEFORE UPDATE OF placement_affinity ON platform_workspace_bindings
WHEN ((OLD.region = 'global' AND OLD.placement_affinity IN ('wnam', 'enam'))
   OR (OLD.region = 'eu' AND OLD.placement_affinity IN ('weur', 'eeur')))
  AND NEW.placement_affinity <> OLD.placement_affinity
BEGIN
  SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
END;

CREATE TRIGGER IF NOT EXISTS workspace_placement_immutable
BEFORE UPDATE OF placement_affinity ON workspaces
WHEN ((OLD.region = 'global' AND OLD.placement_affinity IN ('wnam', 'enam'))
   OR (OLD.region = 'eu' AND OLD.placement_affinity IN ('weur', 'eeur')))
  AND NEW.placement_affinity <> OLD.placement_affinity
BEGIN
  SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
END;
