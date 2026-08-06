-- Structured, spreadsheet-like durable memory. Tables inherit the same
-- host-authorized scopes as prose memory, while rows remain queryable without
-- placing the whole collection in model context.

ALTER TABLE automation_template_versions
  ADD COLUMN memory_tables_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(memory_tables_json));

CREATE TABLE memory_tables (
  memory_table_id TEXT PRIMARY KEY,
  memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL,
  usage_instructions TEXT NOT NULL,
  key_column_ids_json TEXT NOT NULL CHECK (json_valid(key_column_ids_json)),
  schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision > 0),
  data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
  last_mutation_id TEXT,
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  invalidated_at TEXT,
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (memory_scope_id, name COLLATE NOCASE),
  CHECK (
    (invalidated_at IS NULL AND invalidation_reason IS NULL)
    OR (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
);

CREATE TRIGGER memory_tables_validate_scope
BEFORE INSERT ON memory_tables
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memory_scopes
   WHERE memory_scope_id = NEW.memory_scope_id
     AND workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_table_scope_mismatch');
END;

CREATE TRIGGER memory_table_scope_is_immutable
BEFORE UPDATE OF memory_scope_id, workspace_id ON memory_tables
BEGIN
  SELECT RAISE(ABORT, 'memory_table_scope_immutable');
END;

CREATE INDEX memory_tables_scope_active_idx
  ON memory_tables(memory_scope_id, invalidated_at, name COLLATE NOCASE);

CREATE TABLE memory_table_columns (
  memory_table_column_id TEXT PRIMARY KEY,
  memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (
    value_type IN ('string', 'url', 'number', 'integer', 'boolean', 'datetime', 'date')
  ),
  is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
  is_searchable INTEGER NOT NULL DEFAULT 0 CHECK (is_searchable IN (0, 1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  created_at TEXT NOT NULL,
  UNIQUE (memory_table_id, name COLLATE NOCASE),
  UNIQUE (memory_table_id, position)
);

CREATE INDEX memory_table_columns_table_idx
  ON memory_table_columns(memory_table_id, position);

CREATE TABLE memory_table_rows (
  memory_table_row_id TEXT PRIMARY KEY,
  memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
  memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  natural_key_hash TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK (json_valid(data_json)),
  searchable_text TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
  created_by_mutation_id TEXT NOT NULL,
  last_mutation_id TEXT NOT NULL,
  invalidated_at TEXT,
  invalidated_by_principal_json TEXT CHECK (
    invalidated_by_principal_json IS NULL OR json_valid(invalidated_by_principal_json)
  ),
  invalidation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (memory_table_id, natural_key_hash),
  CHECK (
    (invalidated_at IS NULL AND invalidated_by_principal_json IS NULL AND invalidation_reason IS NULL)
    OR
    (invalidated_at IS NOT NULL AND invalidated_by_principal_json IS NOT NULL AND invalidation_reason IS NOT NULL)
  )
);

CREATE TRIGGER memory_table_rows_validate_parent
BEFORE INSERT ON memory_table_rows
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memory_tables
   WHERE memory_table_id = NEW.memory_table_id
     AND memory_scope_id = NEW.memory_scope_id
     AND workspace_id = NEW.workspace_id
     AND invalidated_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'memory_table_row_parent_mismatch');
END;

CREATE TRIGGER memory_table_row_parent_is_immutable
BEFORE UPDATE OF memory_table_id, memory_scope_id, workspace_id, natural_key_hash
ON memory_table_rows
BEGIN
  SELECT RAISE(ABORT, 'memory_table_row_identity_immutable');
END;

CREATE INDEX memory_table_rows_active_idx
  ON memory_table_rows(memory_table_id, invalidated_at, updated_at DESC, memory_table_row_id);
CREATE INDEX memory_table_rows_created_by_idx
  ON memory_table_rows(memory_table_id, created_by_mutation_id);

CREATE VIRTUAL TABLE memory_table_rows_fts USING fts5(
  searchable_text,
  content = 'memory_table_rows',
  content_rowid = 'rowid',
  tokenize = 'unicode61'
);

CREATE TRIGGER memory_table_rows_fts_insert
AFTER INSERT ON memory_table_rows
BEGIN
  INSERT INTO memory_table_rows_fts(rowid, searchable_text)
  VALUES (NEW.rowid, NEW.searchable_text);
END;

CREATE TRIGGER memory_table_rows_fts_delete
AFTER DELETE ON memory_table_rows
BEGIN
  INSERT INTO memory_table_rows_fts(memory_table_rows_fts, rowid, searchable_text)
  VALUES ('delete', OLD.rowid, OLD.searchable_text);
END;

CREATE TRIGGER memory_table_rows_fts_update
AFTER UPDATE OF searchable_text ON memory_table_rows
BEGIN
  INSERT INTO memory_table_rows_fts(memory_table_rows_fts, rowid, searchable_text)
  VALUES ('delete', OLD.rowid, OLD.searchable_text);
  INSERT INTO memory_table_rows_fts(rowid, searchable_text)
  VALUES (NEW.rowid, NEW.searchable_text);
END;

-- Canonical row values remain JSON. This typed projection makes dynamic
-- column predicates and ordering indexable without creating physical tables
-- or accepting raw SQL from an agent.
CREATE TABLE memory_table_cells (
  memory_table_row_id TEXT NOT NULL REFERENCES memory_table_rows(memory_table_row_id) ON DELETE CASCADE,
  memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
  memory_table_column_id TEXT NOT NULL REFERENCES memory_table_columns(memory_table_column_id) ON DELETE CASCADE,
  value_type TEXT NOT NULL CHECK (
    value_type IN ('string', 'url', 'number', 'integer', 'boolean', 'datetime', 'date')
  ),
  string_value TEXT,
  number_value REAL,
  boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
  temporal_value TEXT,
  PRIMARY KEY (memory_table_row_id, memory_table_column_id),
  CHECK (
    (value_type IN ('string', 'url') AND string_value IS NOT NULL
      AND number_value IS NULL AND boolean_value IS NULL AND temporal_value IS NULL)
    OR
    (value_type IN ('number', 'integer') AND number_value IS NOT NULL
      AND string_value IS NULL AND boolean_value IS NULL AND temporal_value IS NULL)
    OR
    (value_type = 'boolean' AND boolean_value IS NOT NULL
      AND string_value IS NULL AND number_value IS NULL AND temporal_value IS NULL)
    OR
    (value_type IN ('datetime', 'date') AND temporal_value IS NOT NULL
      AND string_value IS NULL AND number_value IS NULL AND boolean_value IS NULL)
  )
);

CREATE TRIGGER memory_table_cells_validate_parent
BEFORE INSERT ON memory_table_cells
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
    FROM memory_table_rows row_value
    JOIN memory_table_columns column_value
      ON column_value.memory_table_id = row_value.memory_table_id
   WHERE row_value.memory_table_row_id = NEW.memory_table_row_id
     AND row_value.memory_table_id = NEW.memory_table_id
     AND column_value.memory_table_column_id = NEW.memory_table_column_id
     AND column_value.value_type = NEW.value_type
)
BEGIN
  SELECT RAISE(ABORT, 'memory_table_cell_parent_mismatch');
END;

CREATE INDEX memory_table_cells_string_idx
  ON memory_table_cells(memory_table_id, memory_table_column_id, string_value COLLATE NOCASE, memory_table_row_id);
CREATE INDEX memory_table_cells_number_idx
  ON memory_table_cells(memory_table_id, memory_table_column_id, number_value, memory_table_row_id);
CREATE INDEX memory_table_cells_boolean_idx
  ON memory_table_cells(memory_table_id, memory_table_column_id, boolean_value, memory_table_row_id);
CREATE INDEX memory_table_cells_temporal_idx
  ON memory_table_cells(memory_table_id, memory_table_column_id, temporal_value, memory_table_row_id);

CREATE TABLE memory_table_mutations (
  memory_table_mutation_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
  memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'insert_rows', 'update_rows', 'invalidate_rows')),
  actor_principal_json TEXT NOT NULL CHECK (json_valid(actor_principal_json)),
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  rationale TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL,
  UNIQUE (harness_run_id, receipt_id)
);

CREATE TRIGGER memory_table_mutations_validate_parent
BEFORE INSERT ON memory_table_mutations
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM memory_tables
   WHERE memory_table_id = NEW.memory_table_id
     AND memory_scope_id = NEW.memory_scope_id
     AND workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory_table_mutation_parent_mismatch');
END;

CREATE TRIGGER memory_table_mutations_are_immutable
BEFORE UPDATE ON memory_table_mutations
BEGIN
  SELECT RAISE(ABORT, 'memory_table_mutation_immutable');
END;

CREATE TRIGGER memory_table_mutations_validate_changed_rows
BEFORE INSERT ON memory_table_mutations
FOR EACH ROW
WHEN NEW.operation IN ('update_rows', 'invalidate_rows') AND EXISTS (
  SELECT 1
    FROM json_each(NEW.mutation_json, '$.rowIds') requested
   WHERE NOT EXISTS (
     SELECT 1 FROM memory_table_rows row
      WHERE row.memory_table_row_id = requested.value
        AND row.memory_table_id = NEW.memory_table_id
        AND row.last_mutation_id = NEW.memory_table_mutation_id
   )
)
BEGIN
  SELECT RAISE(ABORT, 'memory_table_row_revision_conflict');
END;

CREATE INDEX memory_table_mutations_table_idx
  ON memory_table_mutations(memory_table_id, created_at DESC);
