ALTER TABLE resources ADD COLUMN content_sha256 TEXT;
ALTER TABLE resources ADD COLUMN model_content_status TEXT
  CHECK (model_content_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported'));
ALTER TABLE resources ADD COLUMN model_content_extractor_version TEXT;
ALTER TABLE resources ADD COLUMN model_content_character_count INTEGER
  CHECK (model_content_character_count IS NULL OR model_content_character_count >= 0);
ALTER TABLE resources ADD COLUMN model_content_extracted_at TEXT;
ALTER TABLE resources ADD COLUMN model_content_error_code TEXT;
ALTER TABLE resources ADD COLUMN model_index_ref TEXT;

ALTER TABLE workstream_context_compactions
  ADD COLUMN checkpoint_template_version INTEGER NOT NULL DEFAULT 1
  CHECK (checkpoint_template_version >= 1);

-- Every current or superseded model object is registered here. The row is
-- derived state: deleting the resource deletes this catalog after the trigger
-- below has copied its object references into the durable cleanup outbox.
CREATE TABLE resource_model_objects (
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  object_ref TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('derivative', 'index')),
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('active', 'superseded')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (resource_id, object_ref)
);

CREATE INDEX idx_resource_model_objects_lifecycle
  ON resource_model_objects(resource_id, lifecycle_status, created_at);

CREATE TABLE resource_object_deletion_outbox (
  object_ref TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  object_kind TEXT NOT NULL CHECK (object_kind IN ('original', 'derivative', 'index', 'receipt')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_resource_object_deletion_outbox_created
  ON resource_object_deletion_outbox(created_at, object_ref);

-- This trigger applies to every resource owner. Relationship detachment never
-- fires it; only deleting the resource's lifecycle row schedules object cleanup.
CREATE TRIGGER resources_enqueue_objects_before_delete
BEFORE DELETE ON resources
BEGIN
  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.content_ref, OLD.id, 'original', datetime('now'), datetime('now')
    WHERE OLD.content_ref IS NOT NULL;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.model_content_ref, OLD.id, 'derivative', datetime('now'), datetime('now')
    WHERE OLD.model_content_ref IS NOT NULL;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, resource_id, object_kind, created_at, updated_at)
    SELECT OLD.model_index_ref, OLD.id, 'index', datetime('now'), datetime('now')
    WHERE OLD.model_index_ref IS NOT NULL;

  INSERT OR IGNORE INTO resource_object_deletion_outbox
    (object_ref, resource_id, object_kind, created_at, updated_at)
    SELECT object_ref, OLD.id, object_kind, datetime('now'), datetime('now')
    FROM resource_model_objects WHERE resource_id = OLD.id;
END;
