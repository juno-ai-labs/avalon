-- Regional, maintenance-window cutover from D1 work-stream product authority
-- to the existing one-object-per-work-stream SQLite Durable Objects.
--
-- This is deliberately a control ledger, not a second product store. Existing
-- workstream rows become fenced identity anchors after cutover. WorkspaceDO
-- owns the workspace directory and WorkstreamDO owns each product record.

CREATE TABLE workstream_authority_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL CHECK (phase IN (
    'legacy_open',
    'maintenance_draining',
    'maintenance_importing',
    'maintenance_verified',
    'durable_object_open',
    'quarantined'
  )),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  required_serving_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (required_serving_contract_version > 0),
  serving_contract_version INTEGER NOT NULL DEFAULT 0
    CHECK (serving_contract_version >= 0),
  requested_by TEXT,
  reason TEXT,
  started_at TEXT,
  verified_at TEXT,
  opened_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (phase = 'legacy_open' AND generation = 0)
    OR generation > 0
  )
);

INSERT INTO workstream_authority_control (
  id, phase, generation, requested_by, reason, started_at, verified_at,
  opened_at, updated_at
)
VALUES (1, 'legacy_open', 0, NULL, NULL, NULL, NULL, NULL, datetime('now'));

CREATE TABLE workstream_authority_routes (
  workspace_id TEXT NOT NULL,
  workstream_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation > 0),
  object_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'importing', 'verified', 'active', 'quarantined'
  )),
  stage_index INTEGER NOT NULL DEFAULT 0 CHECK (stage_index >= 0),
  source_cursor INTEGER NOT NULL DEFAULT 0 CHECK (source_cursor >= 0),
  source_fence_sequence INTEGER NOT NULL CHECK (source_fence_sequence >= 0),
  source_hash TEXT,
  target_hash TEXT,
  row_counts_json TEXT CHECK (row_counts_json IS NULL OR json_valid(row_counts_json)),
  imported_at TEXT,
  verified_at TEXT,
  activated_at TEXT,
  last_error_code TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workstream_id) REFERENCES workstreams(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, object_name),
  UNIQUE (workstream_id, generation)
);

CREATE INDEX workstream_authority_routes_state_idx
  ON workstream_authority_routes(generation, state, workstream_id);

CREATE TABLE workstream_authority_commands (
  command_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK (generation > 0),
  command TEXT NOT NULL CHECK (command IN (
    'begin_maintenance', 'begin_import', 'verify', 'open', 'quarantine'
  )),
  request_hash TEXT NOT NULL,
  result_hash TEXT,
  result_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX workstream_authority_commands_generation_idx
  ON workstream_authority_commands(generation, created_at);

CREATE TRIGGER workstream_authority_phase_transition_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase != OLD.phase AND NOT (
  (OLD.phase = 'legacy_open' AND NEW.phase = 'maintenance_draining')
  OR (OLD.phase = 'maintenance_draining' AND NEW.phase = 'maintenance_importing')
  OR (OLD.phase = 'maintenance_importing' AND NEW.phase IN ('maintenance_verified', 'quarantined'))
  OR (OLD.phase = 'maintenance_verified' AND NEW.phase IN ('durable_object_open', 'quarantined'))
  OR (OLD.phase = 'durable_object_open' AND NEW.phase = 'quarantined')
  OR (OLD.phase = 'quarantined' AND NEW.phase = 'maintenance_draining' AND NEW.generation > OLD.generation)
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_invalid_phase_transition');
END;

CREATE TRIGGER workstream_authority_drain_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN OLD.phase = 'maintenance_draining' AND NEW.phase = 'maintenance_importing'
  AND EXISTS (
    SELECT 1 FROM harness_runs
     WHERE status IN ('scheduled', 'running')
       AND terminalized_at IS NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_runs_not_drained');
END;

CREATE TRIGGER workstream_authority_begin_import
AFTER UPDATE OF phase ON workstream_authority_control
WHEN OLD.phase = 'maintenance_draining' AND NEW.phase = 'maintenance_importing'
BEGIN
  INSERT INTO workstream_authority_routes (
    workspace_id, workstream_id, generation, object_name, state, stage_index,
    source_cursor, source_fence_sequence, updated_at
  )
  SELECT w.workspace_id, w.id, NEW.generation,
         ws.region || ':' || w.workspace_id || ':' || w.id,
         'pending', 0, 0, w.next_sequence_number - 1, NEW.updated_at
    FROM workstreams w JOIN workspaces ws ON ws.id = w.workspace_id
  ON CONFLICT(workstream_id) DO UPDATE SET
    generation = excluded.generation,
    object_name = excluded.object_name,
    state = 'pending', stage_index = 0, source_cursor = 0,
    source_fence_sequence = excluded.source_fence_sequence,
    source_hash = NULL, target_hash = NULL, row_counts_json = NULL,
    imported_at = NULL, verified_at = NULL, activated_at = NULL,
    last_error_code = NULL, updated_at = excluded.updated_at;
END;

CREATE TRIGGER workstream_authority_verified_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase = 'maintenance_verified' AND (
  OLD.phase != 'maintenance_importing'
  OR EXISTS (
    SELECT 1 FROM workstream_authority_routes
     WHERE generation = NEW.generation AND state != 'verified'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_routes_not_verified');
END;

CREATE TRIGGER workstream_authority_open_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase = 'durable_object_open' AND (
  OLD.phase != 'maintenance_verified'
  OR NEW.serving_contract_version < NEW.required_serving_contract_version
  OR EXISTS (
    SELECT 1 FROM workstream_authority_routes
     WHERE generation = NEW.generation AND state != 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_not_ready_to_open');
END;

-- Once import starts, the source snapshot is immutable. After the region opens,
-- the same fences prevent a silent second authority. Draining remains writable
-- only so already-admitted runs can settle before the guarded import transition.
-- Workspace and Workstream Durable Objects hold all serving rows and never
-- mutate these legacy D1 rows.
CREATE TRIGGER workstreams_reject_post_cutover_insert
BEFORE INSERT ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstreams_reject_post_cutover_update
BEFORE UPDATE ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstreams_reject_post_cutover_delete
BEFORE DELETE ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

-- Per-viewer pin order moves with the sidebar into WorkspaceDO. The migration
-- reads these rows during the maintenance window, then this fence prevents D1
-- from becoming a second writable preference store.
CREATE TRIGGER workstream_pins_reject_do_authority_insert
BEFORE INSERT ON workstream_pins
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

CREATE TRIGGER workstream_pins_reject_do_authority_update
BEFORE UPDATE ON workstream_pins
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

CREATE TRIGGER workstream_pins_reject_do_authority_delete
BEFORE DELETE ON workstream_pins
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

-- Every legacy product table is fenced as a group during import, verification,
-- open, and quarantine. Tables intentionally absent here remain regional/
-- workspace control data (routing, schedules, connector delivery, audit, or
-- telemetry).
CREATE TRIGGER activity_suggestions_reject_do_authority_insert
BEFORE INSERT ON activity_suggestions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER activity_suggestions_reject_do_authority_update
BEFORE UPDATE ON activity_suggestions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER activity_suggestions_reject_do_authority_delete
BEFORE DELETE ON activity_suggestions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER artifacts_reject_do_authority_insert
BEFORE INSERT ON artifacts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER artifacts_reject_do_authority_update
BEFORE UPDATE ON artifacts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER artifacts_reject_do_authority_delete
BEFORE DELETE ON artifacts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER elicitations_reject_do_authority_insert
BEFORE INSERT ON elicitations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER elicitations_reject_do_authority_update
BEFORE UPDATE ON elicitations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER elicitations_reject_do_authority_delete
BEFORE DELETE ON elicitations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_lifecycle_events_reject_do_authority_insert
BEFORE INSERT ON harness_run_lifecycle_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_lifecycle_events_reject_do_authority_update
BEFORE UPDATE ON harness_run_lifecycle_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_lifecycle_events_reject_do_authority_delete
BEFORE DELETE ON harness_run_lifecycle_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_memory_contexts_reject_do_authority_insert
BEFORE INSERT ON harness_run_memory_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_memory_contexts_reject_do_authority_update
BEFORE UPDATE ON harness_run_memory_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_memory_contexts_reject_do_authority_delete
BEFORE DELETE ON harness_run_memory_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_plugin_activations_reject_do_authority_insert
BEFORE INSERT ON harness_run_plugin_activations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_plugin_activations_reject_do_authority_update
BEFORE UPDATE ON harness_run_plugin_activations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_plugin_activations_reject_do_authority_delete
BEFORE DELETE ON harness_run_plugin_activations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_scopes_reject_do_authority_insert
BEFORE INSERT ON harness_run_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_scopes_reject_do_authority_update
BEFORE UPDATE ON harness_run_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_run_scopes_reject_do_authority_delete
BEFORE DELETE ON harness_run_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_runs_reject_do_authority_insert
BEFORE INSERT ON harness_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_runs_reject_do_authority_update
BEFORE UPDATE ON harness_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER harness_runs_reject_do_authority_delete
BEFORE DELETE ON harness_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_block_runs_reject_do_authority_insert
BEFORE INSERT ON block_dashboard_block_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_block_runs_reject_do_authority_update
BEFORE UPDATE ON block_dashboard_block_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_block_runs_reject_do_authority_delete
BEFORE DELETE ON block_dashboard_block_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_configuration_versions_reject_do_authority_insert
BEFORE INSERT ON block_dashboard_configuration_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_configuration_versions_reject_do_authority_update
BEFORE UPDATE ON block_dashboard_configuration_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_configuration_versions_reject_do_authority_delete
BEFORE DELETE ON block_dashboard_configuration_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_user_preferences_reject_do_authority_insert
BEFORE INSERT ON block_dashboard_user_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_user_preferences_reject_do_authority_update
BEFORE UPDATE ON block_dashboard_user_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER block_dashboard_user_preferences_reject_do_authority_delete
BEFORE DELETE ON block_dashboard_user_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER inference_attempts_reject_do_authority_insert
BEFORE INSERT ON inference_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER inference_attempts_reject_do_authority_update
BEFORE UPDATE ON inference_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER inference_attempts_reject_do_authority_delete
BEFORE DELETE ON inference_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER message_attachments_reject_do_authority_insert
BEFORE INSERT ON message_attachments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER message_attachments_reject_do_authority_update
BEFORE UPDATE ON message_attachments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER message_attachments_reject_do_authority_delete
BEFORE DELETE ON message_attachments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER message_mentions_reject_do_authority_insert
BEFORE INSERT ON message_mentions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER message_mentions_reject_do_authority_update
BEFORE UPDATE ON message_mentions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER message_mentions_reject_do_authority_delete
BEFORE DELETE ON message_mentions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER messages_reject_do_authority_insert
BEFORE INSERT ON messages
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER messages_reject_do_authority_update
BEFORE UPDATE ON messages
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER messages_reject_do_authority_delete
BEFORE DELETE ON messages
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER repository_publications_reject_do_authority_insert
BEFORE INSERT ON repository_publications
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER repository_publications_reject_do_authority_update
BEFORE UPDATE ON repository_publications
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER repository_publications_reject_do_authority_delete
BEFORE DELETE ON repository_publications
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER sandbox_imported_resources_reject_do_authority_insert
BEFORE INSERT ON sandbox_imported_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER sandbox_imported_resources_reject_do_authority_update
BEFORE UPDATE ON sandbox_imported_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER sandbox_imported_resources_reject_do_authority_delete
BEFORE DELETE ON sandbox_imported_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER sandbox_tasks_reject_do_authority_insert
BEFORE INSERT ON sandbox_tasks
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER sandbox_tasks_reject_do_authority_update
BEFORE UPDATE ON sandbox_tasks
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER sandbox_tasks_reject_do_authority_delete
BEFORE DELETE ON sandbox_tasks
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER terminal_publication_grants_reject_do_authority_insert
BEFORE INSERT ON terminal_publication_grants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER terminal_publication_grants_reject_do_authority_update
BEFORE UPDATE ON terminal_publication_grants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER terminal_publication_grants_reject_do_authority_delete
BEFORE DELETE ON terminal_publication_grants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER tool_invocation_checkpoints_reject_do_authority_insert
BEFORE INSERT ON tool_invocation_checkpoints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER tool_invocation_checkpoints_reject_do_authority_update
BEFORE UPDATE ON tool_invocation_checkpoints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER tool_invocation_checkpoints_reject_do_authority_delete
BEFORE DELETE ON tool_invocation_checkpoints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER tool_invocations_reject_do_authority_insert
BEFORE INSERT ON tool_invocations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER tool_invocations_reject_do_authority_update
BEFORE UPDATE ON tool_invocations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER tool_invocations_reject_do_authority_delete
BEFORE DELETE ON tool_invocations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_context_compactions_reject_do_authority_insert
BEFORE INSERT ON workstream_context_compactions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_context_compactions_reject_do_authority_update
BEFORE UPDATE ON workstream_context_compactions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_context_compactions_reject_do_authority_delete
BEFORE DELETE ON workstream_context_compactions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_description_refreshes_reject_do_authority_insert
BEFORE INSERT ON workstream_description_refreshes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_description_refreshes_reject_do_authority_update
BEFORE UPDATE ON workstream_description_refreshes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_description_refreshes_reject_do_authority_delete
BEFORE DELETE ON workstream_description_refreshes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_participants_reject_do_authority_insert
BEFORE INSERT ON workstream_participants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_participants_reject_do_authority_update
BEFORE UPDATE ON workstream_participants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_participants_reject_do_authority_delete
BEFORE DELETE ON workstream_participants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_plugin_activation_hints_reject_do_authority_insert
BEFORE INSERT ON workstream_plugin_activation_hints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_plugin_activation_hints_reject_do_authority_update
BEFORE UPDATE ON workstream_plugin_activation_hints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_plugin_activation_hints_reject_do_authority_delete
BEFORE DELETE ON workstream_plugin_activation_hints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_read_states_reject_do_authority_insert
BEFORE INSERT ON workstream_read_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_read_states_reject_do_authority_update
BEFORE UPDATE ON workstream_read_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_read_states_reject_do_authority_delete
BEFORE DELETE ON workstream_read_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_resource_inventory_revisions_reject_do_authority_insert
BEFORE INSERT ON workstream_resource_inventory_revisions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_resource_inventory_revisions_reject_do_authority_update
BEFORE UPDATE ON workstream_resource_inventory_revisions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_resource_inventory_revisions_reject_do_authority_delete
BEFORE DELETE ON workstream_resource_inventory_revisions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_resources_reject_do_authority_insert
BEFORE INSERT ON workstream_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_resources_reject_do_authority_update
BEFORE UPDATE ON workstream_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_resources_reject_do_authority_delete
BEFORE DELETE ON workstream_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_sandboxes_reject_do_authority_insert
BEFORE INSERT ON workstream_sandboxes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_sandboxes_reject_do_authority_update
BEFORE UPDATE ON workstream_sandboxes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_sandboxes_reject_do_authority_delete
BEFORE DELETE ON workstream_sandboxes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_terminal_repositories_reject_do_authority_insert
BEFORE INSERT ON workstream_terminal_repositories
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_terminal_repositories_reject_do_authority_update
BEFORE UPDATE ON workstream_terminal_repositories
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_terminal_repositories_reject_do_authority_delete
BEFORE DELETE ON workstream_terminal_repositories
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_wakeups_reject_do_authority_insert
BEFORE INSERT ON workstream_wakeups
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_wakeups_reject_do_authority_update
BEFORE UPDATE ON workstream_wakeups
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

CREATE TRIGGER workstream_wakeups_reject_do_authority_delete
BEFORE DELETE ON workstream_wakeups
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;
