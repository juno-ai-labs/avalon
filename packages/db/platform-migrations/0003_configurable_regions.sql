-- Deployment identifiers are configuration, not a fixed geographical enum.
-- Hold dependent rows before rebuilding so cascading foreign keys preserve data.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE "_region_copy_artifact_hostname_routes" AS SELECT * FROM "artifact_hostname_routes";

DROP TRIGGER "artifact_hostname_routes_no_delete";

DROP TRIGGER "artifact_hostname_routes_identity_immutable";

DELETE FROM "artifact_hostname_routes";

DROP TABLE "artifact_hostname_routes";

CREATE TABLE artifact_hostname_routes (
  hostname_stub TEXT NOT NULL,
  region TEXT NOT NULL,
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

INSERT INTO "artifact_hostname_routes" SELECT * FROM "_region_copy_artifact_hostname_routes";

DROP TABLE "_region_copy_artifact_hostname_routes";

CREATE TRIGGER artifact_hostname_routes_no_delete
BEFORE DELETE ON artifact_hostname_routes
BEGIN
  SELECT RAISE(ABORT, 'artifact hostnames are permanent tombstones');
END;

CREATE TRIGGER artifact_hostname_routes_identity_immutable
BEFORE UPDATE OF hostname_stub, region, artifact_id
ON artifact_hostname_routes
BEGIN
  SELECT RAISE(ABORT, 'artifact hostname identities are immutable');
END;

PRAGMA defer_foreign_keys = OFF;
