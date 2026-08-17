-- Complete the WorkstreamDO serving projection and permit a non-authoritative
-- regional identity anchor for work streams created after cutover. The anchor
-- exists only because pre-existing regional control tables have foreign keys
-- to workstreams(id); product reads must use the directory projection or the
-- owning Durable Object.

ALTER TABLE workstreams ADD COLUMN do_identity_anchor INTEGER NOT NULL DEFAULT 0
  CHECK (do_identity_anchor IN (0, 1));

DROP TRIGGER workstreams_reject_post_cutover_insert;

CREATE TRIGGER workstreams_reject_post_cutover_insert
BEFORE INSERT ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
       NOT IN ('legacy_open', 'maintenance_draining')
  AND NEW.do_identity_anchor != 1
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

ALTER TABLE workstream_directory_projections ADD COLUMN email_address TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN origin_type TEXT NOT NULL DEFAULT 'ad_hoc'
  CHECK (origin_type IN ('ad_hoc', 'automation'));
ALTER TABLE workstream_directory_projections ADD COLUMN created_by_user_id TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN automation_subscription_id TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN automation_run_id TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN planned_for TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN title_status TEXT NOT NULL DEFAULT 'settled'
  CHECK (title_status IN ('naming', 'automatic', 'settled'));
ALTER TABLE workstream_directory_projections ADD COLUMN latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
  CHECK (latest_attention_ordinal >= 0);
ALTER TABLE workstream_directory_projections ADD COLUMN unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
  CHECK (unread_tracking_start_ordinal >= 0);
ALTER TABLE workstream_directory_projections ADD COLUMN next_wakeup_due_at TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN next_wakeup_prompt TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN next_terminal_action_at TEXT;
ALTER TABLE workstream_directory_projections ADD COLUMN created_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';
ALTER TABLE workstream_directory_projections ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z';

ALTER TABLE workstream_directory_user_projections ADD COLUMN seen_attention_ordinal INTEGER NOT NULL DEFAULT 0
  CHECK (seen_attention_ordinal >= 0);
ALTER TABLE workstream_directory_user_projections ADD COLUMN manual_unread_from_ordinal INTEGER;
ALTER TABLE workstream_directory_user_projections ADD COLUMN manual_unread_generation INTEGER NOT NULL DEFAULT 0
  CHECK (manual_unread_generation >= 0);
ALTER TABLE workstream_directory_user_projections ADD COLUMN latest_mention_attention_ordinal INTEGER NOT NULL DEFAULT 0
  CHECK (latest_mention_attention_ordinal >= 0);

CREATE INDEX workstream_directory_projection_cursor_idx
  ON workstream_directory_projections(
    workspace_id, archived_at, system_kind, last_activity_at DESC, workstream_id
  );

CREATE INDEX workstream_directory_due_work_idx
  ON workstream_directory_projections(
    workspace_id, next_wakeup_due_at, next_terminal_action_at, workstream_id
  );

-- A rebuildable inverted index for connector activity routing. The owning
-- WorkstreamDO emits the complete resource-link set with each common
-- projection; D1 never decides whether a resource is attached or watched.
CREATE TABLE workstream_resource_link_projections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
  relationship_type TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  projected_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, resource_id)
);

CREATE INDEX workstream_resource_link_lookup_idx
  ON workstream_resource_link_projections(
    workspace_id, resource_id, watch_enabled, workstream_id
  );

-- Resolution labels remain workspace-queryable without making the regional
-- copy authoritative for the suggested action itself. This projection powers
-- routing quality gates that aggregate across many WorkstreamDOs.
CREATE TABLE workstream_suggestion_feedback_projections (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('contextual_routing', 'suggested_work')),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'dismissed')),
  resolved_at TEXT NOT NULL,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  projected_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, action_id)
);

CREATE INDEX workstream_suggestion_feedback_workspace_idx
  ON workstream_suggestion_feedback_projections(
    workspace_id, source, status, resolved_at, workstream_id
  );

CREATE TABLE workstream_create_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  creator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_message_id TEXT NOT NULL,
  workstream_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'initialized', 'completed', 'failed')),
  message_id TEXT,
  harness_run_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, creator_user_id, client_message_id),
  UNIQUE (workstream_id)
);
