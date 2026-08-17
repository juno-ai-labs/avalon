-- Source-side half of the D1 -> regional Supabase authority handoff. The new
-- Worker understands these rows before any workspace is moved; every existing
-- and newly-created workspace remains writable in D1 until the migration
-- control plane explicitly closes it.

CREATE TABLE workspace_authority_gates (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  authority_mode TEXT NOT NULL DEFAULT 'd1'
    CHECK (authority_mode IN ('d1', 'shadow', 'postgres')),
  source_state TEXT NOT NULL DEFAULT 'writable'
    CHECK (source_state IN ('writable', 'closing', 'closed', 'retired')),
  route_epoch INTEGER NOT NULL DEFAULT 1 CHECK (route_epoch > 0),
  source_closure_cursor TEXT,
  source_closure_hash TEXT,
  destination_receipt_id TEXT,
  shadow_verified_at TEXT,
  closed_at TEXT,
  retired_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((source_closure_cursor IS NULL) = (source_closure_hash IS NULL)),
  CHECK ((source_state IN ('closed', 'retired')) = (closed_at IS NOT NULL)),
  CHECK ((source_state = 'retired') = (retired_at IS NOT NULL)),
  CHECK (authority_mode != 'postgres' OR source_state IN ('closed', 'retired'))
);

INSERT INTO workspace_authority_gates (workspace_id, updated_at)
SELECT id, COALESCE(updated_at, created_at)
FROM workspaces;

CREATE TRIGGER workspaces_initialize_authority_gate
AFTER INSERT ON workspaces
BEGIN
  INSERT INTO workspace_authority_gates (workspace_id, updated_at)
  VALUES (NEW.id, COALESCE(NEW.updated_at, NEW.created_at));
END;

CREATE TABLE workspace_postgres_export_manifests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  route_epoch INTEGER NOT NULL CHECK (route_epoch > 0),
  source_cursor TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64),
  object_count INTEGER NOT NULL CHECK (object_count >= 0),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'imported', 'verified', 'invalid')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (workspace_id, route_epoch, source_cursor)
);

CREATE TABLE workspace_postgres_shadow_comparisons (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  comparison_key TEXT NOT NULL,
  d1_revision TEXT NOT NULL,
  postgres_revision TEXT NOT NULL,
  d1_hash TEXT NOT NULL CHECK (length(d1_hash) = 64),
  postgres_hash TEXT NOT NULL CHECK (length(postgres_hash) = 64),
  state TEXT NOT NULL CHECK (state IN ('matched', 'mismatched', 'unavailable')),
  compared_at TEXT NOT NULL,
  details_json TEXT CHECK (details_json IS NULL OR json_valid(details_json)),
  PRIMARY KEY (workspace_id, comparison_key, d1_revision, postgres_revision)
);

-- These root tables cover every high-volume product mutation. The API command
-- boundary checks the same gate before child-table batches; triggers are the
-- final fail-closed backstop for legacy or incident-time SQL that bypasses that
-- boundary.

CREATE TRIGGER workstreams_authority_insert
BEFORE INSERT ON workstreams
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER workstreams_authority_update
BEFORE UPDATE ON workstreams
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER workstreams_authority_delete
BEFORE DELETE ON workstreams
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER messages_authority_insert
BEFORE INSERT ON messages
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER messages_authority_update
BEFORE UPDATE ON messages
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER messages_authority_delete
BEFORE DELETE ON messages
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER activity_events_authority_insert
BEFORE INSERT ON activity_events
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER activity_events_authority_update
BEFORE UPDATE ON activity_events
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER activity_events_authority_delete
BEFORE DELETE ON activity_events
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER resources_authority_insert
BEFORE INSERT ON resources
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER resources_authority_update
BEFORE UPDATE ON resources
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER resources_authority_delete
BEFORE DELETE ON resources
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER notes_authority_insert
BEFORE INSERT ON notes
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER notes_authority_update
BEFORE UPDATE ON notes
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER notes_authority_delete
BEFORE DELETE ON notes
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER connector_connections_authority_insert
BEFORE INSERT ON connector_connections
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER connector_connections_authority_update
BEFORE UPDATE ON connector_connections
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER connector_connections_authority_delete
BEFORE DELETE ON connector_connections
WHEN EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id AND gate.source_state != 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;
