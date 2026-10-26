/**
 * WorkspaceDO migration 91: Sidekick parents move into the Organization object.
 *
 * The directory row becomes the definition row. `automation_directory` already
 * held what the rail, the sidebar, search and retirement read about a
 * Sidekick, as a copy of `SidekickDO`'s single `automation` row; it now gains
 * the rest of that row, so there is one row and no copy. Every added column is
 * nullable: a Sidekick whose import has not run keeps the directory row its
 * legacy object last published, and only an import or a hosted write fills
 * them. `docs/PRDs/2026-10-03_sidekick-parent-into-workspace-do/` has the
 * argument; `docs/hosted-conversation-parents.md` owns the mechanism.
 *
 * Every other table leads with `sidekick_id`, and every statement names it: a
 * statement without it reads or writes every Sidekick in the Organization.
 * The child tables are the Sidekick's own rather than `parent_children` and
 * its siblings, because Channel code scans those across every parent and a
 * Sidekick's run is not a Breakout.
 *
 * `sidekick_imports` was the list of Sidekicks that still lived in a legacy
 * object: every row the directory held when this ran. Migration 92 drops it,
 * after the legacy class was deleted.
 */
export const HOSTED_SIDEKICK_SCHEMA_STATEMENTS: readonly string[] = [
  `ALTER TABLE automation_directory ADD COLUMN region TEXT`,
  `ALTER TABLE automation_directory ADD COLUMN paused_by TEXT
     CHECK (paused_by IS NULL OR paused_by IN ('person', 'room_archive'))`,
  `ALTER TABLE automation_directory ADD COLUMN owning_room_archived_at INTEGER
     CHECK (owning_room_archived_at IS NULL OR owning_room_archived_at >= 0)`,
  `ALTER TABLE automation_directory ADD COLUMN current_definition_revision INTEGER
     CHECK (current_definition_revision IS NULL OR current_definition_revision >= 0)`,
  `ALTER TABLE automation_directory ADD COLUMN accepted_definition_revision INTEGER
     CHECK (accepted_definition_revision IS NULL OR accepted_definition_revision > 0)`,
  `ALTER TABLE automation_directory ADD COLUMN connector_bindings_json TEXT
     CHECK (connector_bindings_json IS NULL OR json_valid(connector_bindings_json))`,
  `ALTER TABLE automation_directory ADD COLUMN default_plugin_ids_json TEXT
     CHECK (default_plugin_ids_json IS NULL OR json_valid(default_plugin_ids_json))`,
  `ALTER TABLE automation_directory ADD COLUMN activity_source_plugin_ids_json TEXT
     CHECK (activity_source_plugin_ids_json IS NULL OR json_valid(activity_source_plugin_ids_json))`,
  `ALTER TABLE automation_directory ADD COLUMN evaluator_projection_json TEXT
     CHECK (evaluator_projection_json IS NULL OR json_valid(evaluator_projection_json))`,
  `ALTER TABLE automation_directory ADD COLUMN model_override TEXT`,
  `ALTER TABLE automation_directory ADD COLUMN email_address TEXT COLLATE NOCASE`,
  `ALTER TABLE automation_directory ADD COLUMN effective_after_event_sequence INTEGER`,
  `ALTER TABLE automation_directory ADD COLUMN authority_generation INTEGER
     CHECK (authority_generation IS NULL OR authority_generation > 0)`,
  `ALTER TABLE automation_directory ADD COLUMN stop_generation INTEGER
     CHECK (stop_generation IS NULL OR stop_generation >= 0)`,
  `ALTER TABLE automation_directory ADD COLUMN chat_appearance_json TEXT
     CHECK (chat_appearance_json IS NULL OR json_valid(chat_appearance_json))`,
  `ALTER TABLE automation_directory ADD COLUMN created_at INTEGER`,
  `ALTER TABLE automation_directory ADD COLUMN updated_at INTEGER`,

  `CREATE TABLE sidekick_revisions (
    sidekick_id TEXT NOT NULL,
    definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    definition_hash TEXT NOT NULL,
    evaluator_rules_json TEXT CHECK (evaluator_rules_json IS NULL OR json_valid(evaluator_rules_json)),
    ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
    submitted_by_run_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, definition_revision)
  ) STRICT`,
  `CREATE TABLE sidekick_schedules (
    sidekick_id TEXT NOT NULL,
    schedule_id TEXT NOT NULL,
    definition_revision INTEGER NOT NULL,
    schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('calendar', 'interval')),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    next_due_at INTEGER CHECK (next_due_at IS NULL OR next_due_at >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, schedule_id)
  ) STRICT`,
  `CREATE TABLE sidekick_runs (
    sidekick_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
    definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
    harness_run_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'needs_input', 'completed', 'failed', 'stopped')),
    summary TEXT,
    opening_json TEXT CHECK (opening_json IS NULL OR json_valid(opening_json)),
    seed_json TEXT CHECK (seed_json IS NULL OR json_valid(seed_json)),
    run_as_user_id TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, run_id),
    UNIQUE (sidekick_id, occurrence_key)
  ) STRICT`,
  `CREATE INDEX sidekick_runs_history_idx ON sidekick_runs(sidekick_id, created_at DESC, run_id)`,
  `CREATE TABLE sidekick_email_receipts (
    sidekick_id TEXT NOT NULL,
    resend_email_id TEXT NOT NULL,
    run_id TEXT,
    outcome_code TEXT NOT NULL,
    payload_ref TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, resend_email_id)
  ) STRICT`,
  `CREATE TABLE sidekick_children (
    sidekick_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'child')),
    created_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, substream_id)
  ) STRICT`,
  `CREATE TABLE sidekick_child_projections (
    sidekick_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    payload_hash TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK (json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, substream_id)
  ) STRICT`,
  `CREATE TABLE sidekick_child_receipts (
    sidekick_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (sidekick_id, substream_id, message_id)
  ) STRICT`,
  `CREATE INDEX sidekick_child_receipts_age_idx ON sidekick_child_receipts(received_at)`,

  `CREATE TABLE sidekick_imports (
    sidekick_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('pending', 'imported')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    not_before INTEGER NOT NULL DEFAULT 0 CHECK (not_before >= 0),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 200),
    imported_at INTEGER CHECK (imported_at IS NULL OR imported_at >= 0)
  ) STRICT`,
  `CREATE INDEX sidekick_imports_pending_idx ON sidekick_imports(state, not_before, sidekick_id)`,
  `INSERT INTO sidekick_imports (sidekick_id, state) SELECT automation_id, 'pending' FROM automation_directory`,
];

/**
 * WorkspaceDO migration 132: the scheduled self-review.
 *
 * `runs_since_review` counts run finishes since the last review request or
 * accepted revision, and `reviewed_at` is when the wizard was last asked. Both
 * start empty for every existing Sidekick: a deploy asks nobody to review
 * anything until ten more runs have finished. `sidekick_reviews` is one row
 * per request, so a wake the Queue lost is sent again and history says when
 * the wizard was asked and what it was told. `docs/automation-lifecycle.md`
 * owns the mechanism.
 */
export const SIDEKICK_REVIEW_SCHEMA_STATEMENTS: readonly string[] = [
  `ALTER TABLE automation_directory ADD COLUMN runs_since_review INTEGER NOT NULL DEFAULT 0
     CHECK (runs_since_review >= 0)`,
  `ALTER TABLE automation_directory ADD COLUMN reviewed_at INTEGER
     CHECK (reviewed_at IS NULL OR reviewed_at >= 0)`,
  `CREATE TABLE sidekick_reviews (
    sidekick_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
    coordinator_user_id TEXT NOT NULL,
    notice_json TEXT NOT NULL CHECK (json_valid(notice_json)),
    requested_at INTEGER NOT NULL,
    delivered_at INTEGER CHECK (delivered_at IS NULL OR delivered_at >= 0),
    PRIMARY KEY (sidekick_id, review_id)
  ) STRICT`,
  `CREATE INDEX sidekick_reviews_pending_idx ON sidekick_reviews(sidekick_id, delivered_at, requested_at)`,
];
