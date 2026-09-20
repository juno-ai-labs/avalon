-- Worker-first: WorkspaceDO has been the only workspace product authority
-- since the one-time migration 0083 cutover. The retained per-workspace import
-- ledger is not a live route, and keeping it after the import made operator
-- tooling and people mistake historical rows for current authority.
--
-- Keep the regional generation/serving fence and the live per-workstream route
-- gate. Only remove the completed workspace import ledger from those guards.
DROP TRIGGER IF EXISTS workstream_authority_verified_guard;
CREATE TRIGGER workstream_authority_verified_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase = 'maintenance_verified' AND (
  OLD.phase != 'maintenance_importing'
  OR EXISTS (
    SELECT 1 FROM workstream_authority_routes
     WHERE generation = NEW.generation AND state != 'verified'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_routes_not_verified');
END;

DROP TRIGGER IF EXISTS workstream_authority_open_guard;
CREATE TRIGGER workstream_authority_open_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase = 'durable_object_open' AND (
  OLD.phase != 'maintenance_verified'
  OR NEW.serving_contract_version < NEW.required_serving_contract_version
  OR EXISTS (
    SELECT 1 FROM workstream_authority_routes
     WHERE generation = NEW.generation AND state != 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_not_ready_to_open');
END;

DROP TABLE workspace_product_authority_routes;
