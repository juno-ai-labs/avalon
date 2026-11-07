/**
 * WorkspaceDO migration 72: Channel and Space parents move into the
 * Organization object.
 *
 * Two halves. The directory tables WorkspaceDO already held take the product's
 * names, because they are no longer a projection of another object's rows but
 * the Organization's own. And every table a `WorkstreamDO` held for one parent
 * arrives here with `parent_id` as its leading key, so one parent is one slice
 * of these rows. `docs/hosted-conversation-parents.md` has the table map.
 *
 * The seeded `parent_imports` rows were the list of parents that still lived in
 * a legacy object: every Channel and Space the directory knew when this ran.
 * Migration 75 drops the ledger once every import had run.
 *
 * Every `parent_*` table with a `parent_id` column is one parent's state, and
 * retiring a Thread or Channel (`WorkspaceDO.deleteRetiredThreadParent`)
 * sweeps that parent's rows from each table `HOSTED_PARENT_STATE_TABLES`
 * names. A Canvas keys its invitation and grant rows here by its own id, so a
 * Thread's sweep never reaches them. A new `parent_*` table joins that list,
 * or a retired Thread leaves its rows in it.
 */
export const HOSTED_PARENT_SCHEMA_STATEMENTS: readonly string[] = [
  `ALTER TABLE workspace_workstream_directory RENAME TO channels`,
  `ALTER TABLE workspace_workstream_viewers RENAME TO channel_viewers`,
  `ALTER TABLE workspace_breakout_directory RENAME TO breakouts`,
  `ALTER TABLE workspace_breakout_viewers RENAME TO breakout_viewers`,
  `ALTER TABLE workspace_space_directory RENAME TO spaces`,
  `ALTER TABLE workspace_space_viewers RENAME TO space_viewers`,

  `CREATE TABLE parent_imports (
    parent_id TEXT PRIMARY KEY,
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'space')),
    state TEXT NOT NULL CHECK (state IN ('pending', 'imported')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    not_before INTEGER NOT NULL DEFAULT 0 CHECK (not_before >= 0),
    last_error_code TEXT CHECK (last_error_code IS NULL OR length(last_error_code) <= 200),
    source_rows INTEGER CHECK (source_rows IS NULL OR source_rows >= 0),
    imported_at INTEGER CHECK (imported_at IS NULL OR imported_at >= 0)
  ) STRICT`,
  `CREATE INDEX parent_imports_pending_idx ON parent_imports(state, not_before, parent_id)`,
  `INSERT INTO parent_imports (parent_id, parent_kind, state)
     SELECT workstream_id, 'workstream', 'pending' FROM channels`,
  `INSERT OR IGNORE INTO parent_imports (parent_id, parent_kind, state)
     SELECT space_id, 'space', 'pending' FROM spaces`,

  `CREATE TABLE parent_metadata (
    parent_id TEXT PRIMARY KEY,
    parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'space')),
    workspace_id TEXT NOT NULL,
    region TEXT NOT NULL,
    authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
    revision INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    preview TEXT NOT NULL,
    email_address TEXT,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    exact_state TEXT NOT NULL CHECK (exact_state IN (
      'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
      'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
      'idle', 'archived', 'deleting', 'restoring'
    )),
    created_by_user_id TEXT,
    title_status TEXT NOT NULL DEFAULT 'settled'
      CHECK (title_status IN ('naming', 'automatic', 'settled')),
    system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),
    last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
    latest_attention_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (latest_attention_ordinal >= 0),
    unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0 CHECK (unread_tracking_start_ordinal >= 0),
    next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
    next_wakeup_prompt TEXT,
    next_terminal_action_at INTEGER CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
    source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),
    source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,

  `CREATE TABLE parent_children (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('main', 'child')),
    created_by_user_id TEXT,
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('reserved', 'ready', 'failed')),
    title TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
    lifecycle_version INTEGER NOT NULL DEFAULT 0,
    lifecycle_delivered_version INTEGER NOT NULL DEFAULT 0,
    lifecycle_not_before INTEGER NOT NULL DEFAULT 0,
    audience TEXT NOT NULL DEFAULT 'restricted' CHECK (audience IN ('restricted', 'inherits_workstream')),
    PRIMARY KEY (parent_id, substream_id)
  ) STRICT`,
  `CREATE INDEX parent_children_lifecycle_idx
    ON parent_children(lifecycle_not_before, parent_id, substream_id)
    WHERE lifecycle_version > lifecycle_delivered_version`,

  `CREATE TABLE parent_child_projections (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    payload_hash TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK (json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, substream_id)
  ) STRICT`,
  `CREATE TABLE parent_child_viewer_projections (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    payload_hash TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK (json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, substream_id, user_id)
  ) STRICT`,
  `CREATE INDEX parent_child_viewer_projections_user_idx
    ON parent_child_viewer_projections(parent_id, user_id, substream_id)`,
  `CREATE TABLE parent_child_receipts (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, substream_id, message_id)
  ) STRICT`,
  `CREATE INDEX parent_child_receipts_age_idx ON parent_child_receipts(received_at)`,
  `CREATE TABLE parent_projection_keys (
    parent_id TEXT NOT NULL,
    projection_key TEXT NOT NULL,
    next_version INTEGER NOT NULL CHECK (next_version > 0),
    last_payload_hash TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, projection_key)
  ) STRICT`,
  `CREATE TABLE parent_state_clock (
    parent_id TEXT PRIMARY KEY,
    next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
    last_event_time INTEGER NOT NULL CHECK (last_event_time >= 0)
  ) STRICT`,
  `CREATE TABLE parent_state_changes (
    parent_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 180),
    waterline INTEGER NOT NULL CHECK (waterline > 0),
    event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 180),
    payload_hash TEXT NOT NULL,
    state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(state_json) <= 262144),
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    PRIMARY KEY (parent_id, sequence),
    UNIQUE (parent_id, state_key, waterline)
  ) STRICT`,
  `CREATE INDEX parent_state_changes_latest_idx
    ON parent_state_changes(parent_id, state_key, waterline DESC)`,
  // Only work that leaves the object: a notification to deliver, a mention to
  // snapshot, a revoked Channel grant's Sidekick revocation, and whatever the
  // legacy object still had pending at import. A row that cannot be read is
  // kept as `failed` with its code, for an operator, rather than retried.
  `CREATE TABLE parent_outbox (
    parent_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    partition_key TEXT NOT NULL,
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
    effect_kind TEXT NOT NULL CHECK (effect_kind IN (
      'directory_common', 'directory_user', 'activity_event',
      'mention_notification', 'participant_notification', 'scope_grant_directory'
    )),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000),
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'failed')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_error_code TEXT,
    PRIMARY KEY (parent_id, message_id)
  ) STRICT`,
  `CREATE INDEX parent_outbox_delivery_idx
    ON parent_outbox(state, not_before, created_at, message_id)`,

  `CREATE TABLE parent_breakout_preparations (
    parent_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
    completed_parts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_parts_json)),
    prepared_context_json TEXT CHECK (prepared_context_json IS NULL OR json_valid(prepared_context_json)),
    status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'confirming', 'ready', 'failed')),
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    prepared_conversation_hash TEXT CHECK (prepared_conversation_hash IS NULL OR (
      length(prepared_conversation_hash) = 24 AND substr(prepared_conversation_hash, 1, 8) = 'fnv1a64:'
    )),
    PRIMARY KEY (parent_id, operation_id),
    UNIQUE (parent_id, substream_id),
    FOREIGN KEY (parent_id, substream_id) REFERENCES parent_children(parent_id, substream_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE parent_breakout_members (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    version INTEGER NOT NULL CHECK (version > 0),
    added_by_user_id TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    removed_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, substream_id, user_id),
    FOREIGN KEY (parent_id, substream_id) REFERENCES parent_children(parent_id, substream_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE INDEX parent_breakout_members_user_idx
    ON parent_breakout_members(parent_id, user_id, active, substream_id)`,
  `CREATE TABLE parent_breakout_member_effects (
    parent_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    membership_version INTEGER NOT NULL CHECK (membership_version > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'delivered')),
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, operation_id)
  ) STRICT`,
  `CREATE INDEX parent_breakout_member_effects_due_idx
    ON parent_breakout_member_effects(state, not_before, created_at, parent_id, operation_id)`,

  `CREATE TABLE parent_grant_revision (
    parent_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT`,
  `CREATE TABLE parent_grants (
    parent_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('workstream', 'conversation')),
    substream_id TEXT NOT NULL,
    grant_json TEXT NOT NULL CHECK (json_valid(grant_json)),
    source_kind TEXT NOT NULL DEFAULT 'direct' CHECK (source_kind IN ('direct', 'space')),
    source_id TEXT NOT NULL DEFAULT '',
    CHECK ((scope_kind = 'workstream' AND substream_id = '') OR
      (scope_kind = 'conversation' AND substream_id <> '')),
    PRIMARY KEY (parent_id, user_id, scope_kind, substream_id)
  ) STRICT`,
  `CREATE INDEX parent_grants_scope_idx ON parent_grants(parent_id, scope_kind, substream_id, user_id)`,
  `CREATE TABLE parent_grant_operations (
    parent_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, operation_id)
  ) STRICT`,
  `CREATE TABLE parent_grant_imports (
    parent_id TEXT NOT NULL,
    scope_kind TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    PRIMARY KEY (parent_id, scope_kind, substream_id)
  ) STRICT`,
  `CREATE TABLE parent_participant_targets (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    transfer_id TEXT NOT NULL,
    PRIMARY KEY (parent_id, substream_id)
  ) STRICT`,
  `CREATE TABLE parent_participant_migrations (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    transfer_id TEXT NOT NULL,
    incarnations_json TEXT CHECK (incarnations_json IS NULL OR json_valid(incarnations_json)),
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'complete')),
    PRIMARY KEY (parent_id, substream_id)
  ) STRICT`,
  `CREATE TRIGGER parent_breakout_members_freeze_insert BEFORE INSERT ON parent_breakout_members
    WHEN EXISTS(SELECT 1 FROM parent_participant_migrations
      WHERE parent_id = NEW.parent_id AND substream_id = NEW.substream_id AND substream_id <> '0')
    BEGIN SELECT RAISE(ABORT, 'participant_authority_transferred'); END`,
  `CREATE TRIGGER parent_breakout_members_freeze_update BEFORE UPDATE ON parent_breakout_members
    WHEN EXISTS(SELECT 1 FROM parent_participant_migrations
      WHERE substream_id <> '0' AND (
        (parent_id = OLD.parent_id AND substream_id = OLD.substream_id)
        OR (parent_id = NEW.parent_id AND substream_id = NEW.substream_id)))
    BEGIN SELECT RAISE(ABORT, 'participant_authority_transferred'); END`,
  `CREATE TRIGGER parent_breakout_members_freeze_delete BEFORE DELETE ON parent_breakout_members
    WHEN EXISTS(SELECT 1 FROM parent_participant_migrations
      WHERE parent_id = OLD.parent_id AND substream_id = OLD.substream_id AND substream_id <> '0')
    BEGIN SELECT RAISE(ABORT, 'participant_authority_transferred'); END`,
  `CREATE TABLE parent_participant_deliveries (
    parent_id TEXT NOT NULL,
    substream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    acknowledged_revision INTEGER,
    PRIMARY KEY (parent_id, substream_id, user_id)
  ) STRICT`,

  `CREATE TABLE parent_invitation_operations (
    parent_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    invitation_ids_json TEXT NOT NULL CHECK (json_valid(invitation_ids_json)),
    PRIMARY KEY (parent_id, operation_id)
  ) STRICT`,
  `CREATE TABLE parent_invitations (
    parent_id TEXT NOT NULL,
    id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    actor_incarnation TEXT NOT NULL,
    summary_json TEXT NOT NULL CHECK (json_valid(summary_json)),
    token_hash TEXT NOT NULL UNIQUE,
    delivery_encrypted TEXT NOT NULL,
    grant_operations_json TEXT NOT NULL CHECK (json_valid(grant_operations_json)),
    delivered_at INTEGER,
    accepted_incarnation TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, id),
    FOREIGN KEY (parent_id, operation_id) REFERENCES parent_invitation_operations(parent_id, operation_id)
  ) STRICT`,
  `CREATE TABLE parent_connector_admissions (
    parent_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    PRIMARY KEY (parent_id, event_id)
  ) STRICT`,
  `CREATE TABLE parent_sidekicks (
    parent_id TEXT NOT NULL,
    sidekick_id TEXT NOT NULL,
    attached_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, sidekick_id)
  ) STRICT`,

  `CREATE TABLE parent_direct_audience (
    parent_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE parent_space_sources (
    parent_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    participants_json TEXT NOT NULL CHECK (json_valid(participants_json)),
    space_revision INTEGER NOT NULL CHECK (space_revision > 0),
    membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
    operation_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, space_id)
  ) STRICT`,
  `CREATE TABLE parent_space_readers (
    parent_id TEXT NOT NULL,
    space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (parent_id, space_id, user_id),
    FOREIGN KEY (parent_id, space_id) REFERENCES parent_space_sources(parent_id, space_id) ON DELETE CASCADE
  ) STRICT`,
  `CREATE TABLE parent_access_operations (
    parent_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, operation_id)
  ) STRICT`,

  // Post-commit work a directory batch owes: written in the batch's own
  // transaction, run straight after the commit, taken by the alarm if that run
  // did not finish. A row that does not parse is kept as `failed` with its
  // code rather than retried.
  `CREATE TABLE workspace_directory_followups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    followup_json TEXT NOT NULL CHECK (json_valid(followup_json)),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'failed')),
    last_error_code TEXT
  ) STRICT`,
  `CREATE INDEX workspace_directory_followups_due_idx ON workspace_directory_followups(state, not_before)`,

  // Each person's workspace relationship as this object last heard it: from a
  // relationship change event (sequence > 0, in D1's order), or from a D1 read
  // or write a request just made (sequence kept), which replaces the row only
  // when it is provably newer. Access checks read it instead of D1; the events
  // keep it current. `relationship_json` is null for someone with no
  // relationship; `removed_incarnation` names the one a removal event ended,
  // so a later read of that same relationship cannot bring it back.
  `CREATE TABLE workspace_member_status (
    user_id TEXT PRIMARY KEY,
    relationship_json TEXT CHECK (relationship_json IS NULL OR json_valid(relationship_json)),
    removed_incarnation TEXT CHECK (removed_incarnation IS NULL OR relationship_json IS NULL),
    active INTEGER NOT NULL CHECK (active IN (0, 1)),
    sequence INTEGER NOT NULL CHECK (sequence >= 0),
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * Every live `parent_*` table keyed by `parent_id`, in definition order: what
 * `WorkspaceDO.deleteRetiredThreadParent` sweeps for a retired Thread or
 * Channel. The closed, code-owned allowlist its dynamic table names come from
 * (docs/durable-object-sqlite.md); it is intersected with the schema, so a
 * table phase C drops first is skipped rather than failed on. Tables earlier
 * migrations dropped (`parent_imports`, and the four `parent_*_access` and
 * Space-source tables migration 94 dropped) are not listed.
 */
export const HOSTED_PARENT_STATE_TABLES: readonly string[] = [
  "parent_metadata",
  "parent_children",
  "parent_child_projections",
  "parent_child_viewer_projections",
  "parent_child_receipts",
  "parent_projection_keys",
  "parent_state_clock",
  "parent_state_changes",
  "parent_outbox",
  "parent_breakout_preparations",
  "parent_breakout_members",
  "parent_breakout_member_effects",
  "parent_grant_revision",
  "parent_grants",
  "parent_grant_operations",
  "parent_grant_imports",
  "parent_participant_targets",
  "parent_participant_migrations",
  "parent_participant_deliveries",
  "parent_invitation_operations",
  "parent_invitations",
  "parent_connector_admissions",
  "parent_sidekicks",
];
