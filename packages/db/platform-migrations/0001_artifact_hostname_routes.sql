-- Public artifact hostnames use Rally's four-word stub generator instead of
-- exposing the artifact UUID. This platform database is deliberately shared
-- by the Global and EU Workers and deliberately contains no product content.

CREATE TABLE artifact_hostname_routes (
  hostname_stub TEXT NOT NULL,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  workspace_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (region, hostname_stub),
  UNIQUE (region, artifact_id),
  CHECK (hostname_stub = lower(hostname_stub)),
  CHECK (
    hostname_stub NOT GLOB '*[^a-z-]*'
    AND hostname_stub NOT GLOB '-*'
    AND hostname_stub NOT GLOB '*-'
    AND hostname_stub NOT GLOB '*--*'
    AND length(hostname_stub) - length(replace(hostname_stub, '-', '')) = 3
  )
) STRICT;

-- A public hostname is permanent. Reusing one would let an old link, cookie,
-- or persisted browser partition reach a different artifact.
CREATE TRIGGER artifact_hostname_routes_identity_immutable
BEFORE UPDATE OF hostname_stub, region, workspace_id, artifact_id
ON artifact_hostname_routes
BEGIN
  SELECT RAISE(ABORT, 'artifact hostname identities are immutable');
END;

CREATE TRIGGER artifact_hostname_routes_no_delete
BEFORE DELETE ON artifact_hostname_routes
BEGIN
  SELECT RAISE(ABORT, 'artifact hostnames are permanent tombstones');
END;
