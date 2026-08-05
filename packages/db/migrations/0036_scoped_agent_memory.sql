-- Durable, host-authorized agent memory. D1 is canonical; Vectorize is an
-- eventually-consistent retrieval projection maintained through the outbox.

CREATE TABLE memory_scopes (
  memory_scope_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('workstream', 'automation', 'user', 'workspace')),
  owner_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind, owner_id),
  CHECK (kind <> 'workspace' OR owner_id = workspace_id)
);

CREATE TRIGGER memory_scopes_validate_workspace_owner
BEFORE INSERT ON memory_scopes
FOR EACH ROW
WHEN NEW.kind = 'workspace' AND NOT EXISTS (
  SELECT 1 FROM workspaces
   WHERE id = NEW.workspace_id AND id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_workspace_owner_invalid');
END;

CREATE TRIGGER memory_scopes_validate_user_owner
BEFORE INSERT ON memory_scopes
FOR EACH ROW
WHEN NEW.kind = 'user' AND NOT EXISTS (
  SELECT 1 FROM workspace_members
   WHERE workspace_id = NEW.workspace_id AND user_id = NEW.owner_id
     AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_user_owner_invalid');
END;

CREATE TRIGGER memory_scopes_validate_workstream_owner
BEFORE INSERT ON memory_scopes
FOR EACH ROW
WHEN NEW.kind = 'workstream' AND NOT EXISTS (
  SELECT 1 FROM workstreams
   WHERE id = NEW.owner_id AND workspace_id = NEW.workspace_id
     AND origin_type = 'ad_hoc' AND automation_subscription_id IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_workstream_owner_invalid');
END;

CREATE TRIGGER memory_scopes_validate_automation_owner
BEFORE INSERT ON memory_scopes
FOR EACH ROW
WHEN NEW.kind = 'automation' AND NOT EXISTS (
  SELECT 1 FROM automation_subscriptions
   WHERE id = NEW.owner_id AND workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_automation_owner_invalid');
END;

CREATE TRIGGER memory_scopes_are_immutable
BEFORE UPDATE ON memory_scopes
BEGIN
  SELECT RAISE(ABORT, 'memory_scope_immutable');
END;

CREATE TRIGGER memory_scopes_remove_deleted_user
AFTER DELETE ON users
BEGIN
  DELETE FROM memory_scopes WHERE kind = 'user' AND owner_id = OLD.id;
END;

CREATE TRIGGER memory_scopes_remove_deleted_workstream
AFTER DELETE ON workstreams
BEGIN
  DELETE FROM memory_scopes WHERE kind = 'workstream' AND owner_id = OLD.id;
END;

CREATE TRIGGER memory_scopes_remove_deleted_automation
AFTER DELETE ON automation_subscriptions
BEGIN
  DELETE FROM memory_scopes WHERE kind = 'automation' AND owner_id = OLD.id;
END;

CREATE TABLE memory_items (
  memory_item_id TEXT PRIMARY KEY,
  memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  expires_at TEXT,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
  last_accessed_at TEXT,
  invalidated_at TEXT,
  invalidated_by_principal_json TEXT CHECK (
    invalidated_by_principal_json IS NULL OR json_valid(invalidated_by_principal_json)
  ),
  invalidation_reason TEXT,
  last_mutation_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (invalidated_at IS NULL AND invalidated_by_principal_json IS NULL AND invalidation_reason IS NULL)
    OR
    (invalidated_at IS NOT NULL AND invalidated_by_principal_json IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
);

CREATE TRIGGER memory_items_validate_scope
BEFORE INSERT ON memory_items
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memory_scopes
   WHERE memory_scope_id = NEW.memory_scope_id
     AND workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_item_scope_mismatch');
END;

CREATE TRIGGER memory_item_scope_is_immutable
BEFORE UPDATE OF memory_scope_id, workspace_id ON memory_items
BEGIN
  SELECT RAISE(ABORT, 'memory_item_scope_immutable');
END;

CREATE INDEX memory_items_scope_active_idx
  ON memory_items(memory_scope_id, invalidated_at, expires_at, updated_at DESC);
CREATE INDEX memory_items_workspace_idx
  ON memory_items(workspace_id, updated_at DESC);

CREATE VIRTUAL TABLE memory_items_fts USING fts5(
  text,
  content = 'memory_items',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER memory_items_fts_insert
AFTER INSERT ON memory_items
BEGIN
  INSERT INTO memory_items_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;

CREATE TRIGGER memory_items_fts_delete
AFTER DELETE ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
END;

CREATE TRIGGER memory_items_fts_update
AFTER UPDATE OF text ON memory_items
BEGIN
  INSERT INTO memory_items_fts(memory_items_fts, rowid, text)
  VALUES ('delete', OLD.rowid, OLD.text);
  INSERT INTO memory_items_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
END;

CREATE TABLE memory_mutations (
  memory_mutation_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  memory_item_id TEXT NOT NULL REFERENCES memory_items(memory_item_id) ON DELETE CASCADE,
  memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('add', 'update', 'invalidate')),
  prior_revision INTEGER CHECK (prior_revision IS NULL OR prior_revision > 0),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
  actor_principal_json TEXT NOT NULL CHECK (json_valid(actor_principal_json)),
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  rationale TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  UNIQUE (harness_run_id, receipt_id),
  CHECK (
    (operation = 'add' AND prior_revision IS NULL AND resulting_revision = 1)
    OR
    (operation IN ('update', 'invalidate') AND prior_revision IS NOT NULL
      AND resulting_revision = prior_revision + 1)
  )
);

CREATE TRIGGER memory_mutations_validate_item
BEFORE INSERT ON memory_mutations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memory_items
   WHERE memory_item_id = NEW.memory_item_id
     AND memory_scope_id = NEW.memory_scope_id
     AND workspace_id = NEW.workspace_id
     AND revision = NEW.resulting_revision
     AND last_mutation_id = NEW.memory_mutation_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_mutation_item_mismatch');
END;

CREATE TRIGGER memory_mutations_are_immutable
BEFORE UPDATE ON memory_mutations
BEGIN
  SELECT RAISE(ABORT, 'memory_mutation_immutable');
END;

CREATE INDEX memory_mutations_item_idx
  ON memory_mutations(memory_item_id, resulting_revision DESC);
CREATE INDEX memory_mutations_run_idx
  ON memory_mutations(harness_run_id, created_at);

CREATE TABLE memory_index_outbox (
  outbox_id TEXT PRIMARY KEY,
  memory_item_id TEXT NOT NULL REFERENCES memory_items(memory_item_id) ON DELETE CASCADE,
  memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (memory_item_id, revision, operation)
);

CREATE TRIGGER memory_index_outbox_validate_item
BEFORE INSERT ON memory_index_outbox
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memory_items
   WHERE memory_item_id = NEW.memory_item_id
     AND memory_scope_id = NEW.memory_scope_id
     AND workspace_id = NEW.workspace_id
     AND revision = NEW.revision
)
BEGIN
  SELECT RAISE(ABORT, 'memory_index_outbox_item_mismatch');
END;

CREATE INDEX memory_index_outbox_ready_idx
  ON memory_index_outbox(status, available_at, lease_expires_at, created_at);

CREATE TABLE harness_run_memory_contexts (
  harness_run_id TEXT PRIMARY KEY REFERENCES harness_runs(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  memory_scope_ids_json TEXT NOT NULL CHECK (json_valid(memory_scope_ids_json)),
  query_text TEXT NOT NULL,
  retrieval_mode TEXT NOT NULL CHECK (retrieval_mode IN ('hybrid', 'fts_only', 'vector_only', 'none')),
  results_json TEXT NOT NULL CHECK (json_valid(results_json)),
  memory_context_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (harness_run_id, attempt_id)
);

CREATE TRIGGER harness_run_memory_contexts_are_immutable
BEFORE UPDATE ON harness_run_memory_contexts
BEGIN
  SELECT RAISE(ABORT, 'harness_run_memory_context_immutable');
END;

ALTER TABLE harness_run_scopes ADD COLUMN memory_context_hash TEXT;
