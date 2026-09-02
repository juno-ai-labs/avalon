-- The allocator needs workspace identity to derive a candidate, but the
-- serving index does not need to retain it. Keep the shared database to opaque
-- artifact routing identifiers only.
DROP TRIGGER artifact_hostname_routes_identity_immutable;
ALTER TABLE artifact_hostname_routes DROP COLUMN workspace_id;
CREATE TRIGGER artifact_hostname_routes_identity_immutable
BEFORE UPDATE OF hostname_stub, region, artifact_id
ON artifact_hostname_routes
BEGIN
  SELECT RAISE(ABORT, 'artifact hostname identities are immutable');
END;
