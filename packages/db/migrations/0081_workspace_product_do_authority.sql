-- Maintenance-window move of the first-party activity log and suggested-work
-- product graph into each workspace's SQLite Durable Object. D1 retains this
-- ledger and frozen source rows only until the controller verifies the target.
-- Deletes (and the one opportunity-redaction update) are allowed only in
-- maintenance_verified so activation can atomically scrub D1 before opening;
-- inserts and ordinary updates remain fenced throughout.

CREATE TABLE workspace_product_authority_routes (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK (generation > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'importing', 'verified', 'active', 'quarantined')),
  stage_index INTEGER NOT NULL DEFAULT 0 CHECK (stage_index >= 0),
  source_cursor INTEGER NOT NULL DEFAULT 0 CHECK (source_cursor >= 0),
  row_counts_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(row_counts_json)),
  last_error_code TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX workspace_product_authority_routes_state_idx
  ON workspace_product_authority_routes(generation, state, workspace_id);

CREATE TRIGGER workspace_product_authority_begin_import
AFTER UPDATE OF phase ON workstream_authority_control
WHEN OLD.phase = 'maintenance_draining' AND NEW.phase = 'maintenance_importing'
BEGIN
  INSERT INTO workspace_product_authority_routes (
    workspace_id, generation, state, stage_index, source_cursor,
    row_counts_json, last_error_code, updated_at
  )
  SELECT id, NEW.generation, 'pending', 0, 0, '{}', NULL, NEW.updated_at FROM workspaces WHERE 1
  ON CONFLICT(workspace_id) DO UPDATE SET
    generation = excluded.generation, state = 'pending', stage_index = 0,
    source_cursor = 0, row_counts_json = '{}', last_error_code = NULL,
    updated_at = excluded.updated_at;
END;

DROP TRIGGER workstream_authority_verified_guard;
CREATE TRIGGER workstream_authority_verified_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase = 'maintenance_verified' AND (
  OLD.phase != 'maintenance_importing'
  OR EXISTS (
    SELECT 1 FROM workstream_authority_routes
     WHERE generation = NEW.generation AND state != 'verified'
  )
  OR EXISTS (
    SELECT 1 FROM workspace_product_authority_routes
     WHERE generation = NEW.generation AND state != 'verified'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_routes_not_verified');
END;

DROP TRIGGER workstream_authority_open_guard;
CREATE TRIGGER workstream_authority_open_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN NEW.phase = 'durable_object_open' AND (
  OLD.phase != 'maintenance_verified'
  OR NEW.serving_contract_version < NEW.required_serving_contract_version
  OR EXISTS (
    SELECT 1 FROM workstream_authority_routes
     WHERE generation = NEW.generation AND state != 'active'
  )
  OR EXISTS (
    SELECT 1 FROM workspace_product_authority_routes
     WHERE generation = NEW.generation AND state != 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'workstream_authority_not_ready_to_open');
END;

CREATE TRIGGER activity_events_reject_do_authority_insert BEFORE INSERT ON activity_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER activity_events_reject_do_authority_update BEFORE UPDATE ON activity_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER activity_events_reject_do_authority_delete BEFORE DELETE ON activity_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER activity_event_targets_reject_do_authority_insert BEFORE INSERT ON activity_event_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER activity_event_targets_reject_do_authority_update BEFORE UPDATE ON activity_event_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER activity_event_targets_reject_do_authority_delete BEFORE DELETE ON activity_event_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

-- These tables are one authority group: admission windows, the opportunity
-- graph, per-user resolutions, ranking state, and immutable start snapshots.
CREATE TRIGGER opportunity_batch_windows_reject_do_authority_insert BEFORE INSERT ON opportunity_batch_windows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_batch_windows_reject_do_authority_update BEFORE UPDATE ON opportunity_batch_windows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_batch_windows_reject_do_authority_delete BEFORE DELETE ON opportunity_batch_windows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER opportunity_batch_events_reject_do_authority_insert BEFORE INSERT ON opportunity_batch_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_batch_events_reject_do_authority_update BEFORE UPDATE ON opportunity_batch_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_batch_events_reject_do_authority_delete BEFORE DELETE ON opportunity_batch_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER work_opportunities_reject_do_authority_insert BEFORE INSERT ON work_opportunities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunities_reject_do_authority_update BEFORE UPDATE ON work_opportunities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunities_reject_do_authority_delete BEFORE DELETE ON work_opportunities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER opportunity_provenance_nodes_reject_do_authority_insert BEFORE INSERT ON opportunity_provenance_nodes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_provenance_nodes_reject_do_authority_update BEFORE UPDATE ON opportunity_provenance_nodes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_provenance_nodes_reject_do_authority_delete BEFORE DELETE ON opportunity_provenance_nodes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER opportunity_provenance_edges_reject_do_authority_insert BEFORE INSERT ON opportunity_provenance_edges
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_provenance_edges_reject_do_authority_update BEFORE UPDATE ON opportunity_provenance_edges
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER opportunity_provenance_edges_reject_do_authority_delete BEFORE DELETE ON opportunity_provenance_edges
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER work_opportunity_provenance_roots_reject_do_authority_insert BEFORE INSERT ON work_opportunity_provenance_roots
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_provenance_roots_reject_do_authority_update BEFORE UPDATE ON work_opportunity_provenance_roots
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_provenance_roots_reject_do_authority_delete BEFORE DELETE ON work_opportunity_provenance_roots
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER work_opportunity_user_links_reject_do_authority_insert BEFORE INSERT ON work_opportunity_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_user_links_reject_do_authority_update BEFORE UPDATE ON work_opportunity_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_user_links_reject_do_authority_delete BEFORE DELETE ON work_opportunity_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER work_opportunity_user_states_reject_do_authority_insert BEFORE INSERT ON work_opportunity_user_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_user_states_reject_do_authority_update BEFORE UPDATE ON work_opportunity_user_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_user_states_reject_do_authority_delete BEFORE DELETE ON work_opportunity_user_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER suggested_work_sets_reject_do_authority_insert BEFORE INSERT ON suggested_work_sets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER suggested_work_sets_reject_do_authority_update BEFORE UPDATE ON suggested_work_sets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER suggested_work_sets_reject_do_authority_delete BEFORE DELETE ON suggested_work_sets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER suggested_work_ranking_rounds_reject_do_authority_insert BEFORE INSERT ON suggested_work_ranking_rounds
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER suggested_work_ranking_rounds_reject_do_authority_update BEFORE UPDATE ON suggested_work_ranking_rounds
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER suggested_work_ranking_rounds_reject_do_authority_delete BEFORE DELETE ON suggested_work_ranking_rounds
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER work_opportunity_snapshots_reject_do_authority_insert BEFORE INSERT ON work_opportunity_snapshots
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_snapshots_reject_do_authority_update BEFORE UPDATE ON work_opportunity_snapshots
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER work_opportunity_snapshots_reject_do_authority_delete BEFORE DELETE ON work_opportunity_snapshots
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
