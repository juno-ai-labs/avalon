/**
 * Workspace-local activity, discovery, and suggested-work product state.
 *
 * Workspace identity lives once in `workspace_identity`; these tables never
 * repeat it. References to users, work streams, messages, connector
 * connections, and Workflows cross authority boundaries and therefore remain
 * stable text identifiers rather than pretending SQLite can enforce a foreign
 * key into another Durable Object or D1 database.
 */
export const WORKSPACE_PRODUCT_SCHEMA_STATEMENTS = [
  `CREATE TABLE workspace_activity_events (
    event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
    subject_type TEXT NOT NULL CHECK (length(subject_type) BETWEEN 1 AND 200),
    subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 200),
    subject_sequence_number INTEGER CHECK (subject_sequence_number IS NULL OR subject_sequence_number >= 0),
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'external')),
    actor_user_id TEXT,
    actor_label TEXT NOT NULL CHECK (length(actor_label) <= 500),
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
    body TEXT NOT NULL CHECK (length(body) <= 65536),
    canonical_url TEXT CHECK (canonical_url IS NULL OR length(canonical_url) <= 2000),
    audience_kind TEXT NOT NULL CHECK (audience_kind IN ('workspace', 'user', 'workstream')),
    audience_user_id TEXT,
    audience_workstream_id TEXT,
    digestible INTEGER NOT NULL CHECK (digestible IN (0, 1)),
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    source_kind TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 120),
    source_id TEXT CHECK (source_id IS NULL OR length(source_id) <= 200),
    dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 1000),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 262144),
    CHECK (
      (audience_kind = 'workspace' AND audience_user_id IS NULL AND audience_workstream_id IS NULL)
      OR (audience_kind = 'user' AND audience_user_id IS NOT NULL AND audience_workstream_id IS NULL)
      OR (audience_kind = 'workstream' AND audience_user_id IS NULL AND audience_workstream_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX workspace_activity_events_cursor_idx
    ON workspace_activity_events(event_sequence)`,
  `CREATE INDEX workspace_activity_events_audience_user_idx
    ON workspace_activity_events(audience_user_id, event_sequence)
    WHERE audience_user_id IS NOT NULL`,
  `CREATE INDEX workspace_activity_events_audience_workstream_idx
    ON workspace_activity_events(audience_workstream_id, event_sequence)
    WHERE audience_workstream_id IS NOT NULL`,
  `CREATE INDEX workspace_activity_events_retention_idx
    ON workspace_activity_events(created_at, event_sequence)`,
  `CREATE TABLE workspace_activity_event_targets (
    event_id TEXT NOT NULL REFERENCES workspace_activity_events(event_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    relation TEXT NOT NULL CHECK (length(relation) BETWEEN 1 AND 120),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (event_id, user_id, relation)
  ) STRICT`,
  `CREATE INDEX workspace_activity_event_targets_user_idx
    ON workspace_activity_event_targets(user_id, created_at DESC, event_id)`,
  `CREATE TABLE opportunity_batch_windows (
    window_id TEXT PRIMARY KEY,
    partition_key TEXT NOT NULL CHECK (length(partition_key) BETWEEN 1 AND 500),
    audience_scope TEXT NOT NULL CHECK (audience_scope IN ('personal', 'workspace')),
    audience_user_id TEXT,
    first_event_at INTEGER NOT NULL CHECK (first_event_at >= 0),
    last_event_at INTEGER NOT NULL CHECK (last_event_at >= first_event_at),
    process_after INTEGER NOT NULL CHECK (process_after >= first_event_at),
    status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 5),
    lease_id TEXT,
    lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= created_at),
    CHECK (
      (audience_scope = 'personal' AND audience_user_id IS NOT NULL)
      OR (audience_scope = 'workspace' AND audience_user_id IS NULL)
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX opportunity_batch_windows_queued_partition_idx
    ON opportunity_batch_windows(partition_key) WHERE status = 'queued'`,
  `CREATE INDEX opportunity_batch_windows_due_idx
    ON opportunity_batch_windows(status, process_after, window_id)`,
  `CREATE TABLE opportunity_batch_events (
    batch_event_id TEXT PRIMARY KEY,
    window_id TEXT NOT NULL REFERENCES opportunity_batch_windows(window_id) ON DELETE CASCADE,
    partition_key TEXT NOT NULL CHECK (length(partition_key) BETWEEN 1 AND 500),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('activity', 'message')),
    source_id TEXT NOT NULL,
    occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
    input_characters INTEGER NOT NULL CHECK (input_characters >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
    error_text TEXT CHECK (error_text IS NULL OR length(error_text) <= 1000),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (partition_key, source_kind, source_id)
  ) STRICT`,
  `CREATE INDEX opportunity_batch_events_window_idx
    ON opportunity_batch_events(window_id, status, occurred_at, batch_event_id)`,
  `CREATE TABLE work_opportunities (
    opportunity_id TEXT PRIMARY KEY,
    audience_scope TEXT NOT NULL CHECK (audience_scope IN ('personal', 'workspace')),
    audience_user_id TEXT,
    display_prompt TEXT NOT NULL CHECK (length(display_prompt) BETWEEN 1 AND 180),
    execution_prompt TEXT NOT NULL CHECK (length(execution_prompt) BETWEEN 1 AND 20000),
    admission_reasoning TEXT NOT NULL CHECK (length(admission_reasoning) BETWEEN 1 AND 20000),
    provider_icon TEXT NOT NULL CHECK (length(provider_icon) BETWEEN 1 AND 80),
    source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 180),
    source_fingerprint TEXT NOT NULL UNIQUE CHECK (length(source_fingerprint) = 64),
    version INTEGER NOT NULL CHECK (version > 0),
    display_prompt_hash TEXT NOT NULL CHECK (length(display_prompt_hash) = 64),
    execution_prompt_hash TEXT NOT NULL CHECK (length(execution_prompt_hash) = 64),
    status TEXT NOT NULL CHECK (status IN ('active', 'starting', 'started', 'superseded', 'expired')),
    created_workstream_id TEXT,
    created_message_id TEXT,
    started_by_user_id TEXT,
    start_idempotency_key TEXT CHECK (start_idempotency_key IS NULL OR length(start_idempotency_key) <= 200),
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    started_at INTEGER CHECK (started_at IS NULL OR started_at >= created_at),
    CHECK (
      (audience_scope = 'personal' AND audience_user_id IS NOT NULL)
      OR (audience_scope = 'workspace' AND audience_user_id IS NULL)
    )
  ) STRICT`,
  `CREATE INDEX work_opportunities_active_idx
    ON work_opportunities(status, expires_at, updated_at DESC, opportunity_id)`,
  `CREATE TABLE opportunity_provenance_nodes (
    node_id TEXT PRIMARY KEY,
    node_kind TEXT NOT NULL CHECK (node_kind IN (
      'activity', 'resource', 'message', 'workstream', 'external_person',
      'identity', 'opportunity', 'provider_url'
    )),
    source_id TEXT,
    provider TEXT,
    provider_tenant_id TEXT,
    canonical_url TEXT CHECK (canonical_url IS NULL OR length(canonical_url) <= 2000),
    label TEXT NOT NULL CHECK (length(label) <= 1000),
    occurred_at INTEGER CHECK (occurred_at IS NULL OR occurred_at >= 0),
    visibility_scope TEXT NOT NULL CHECK (visibility_scope IN ('personal', 'workspace')),
    visibility_user_id TEXT,
    locator_json TEXT NOT NULL CHECK (json_valid(locator_json) AND length(locator_json) <= 65536),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    CHECK (
      (visibility_scope = 'personal' AND visibility_user_id IS NOT NULL)
      OR (visibility_scope = 'workspace' AND visibility_user_id IS NULL)
    )
  ) STRICT`,
  `CREATE UNIQUE INDEX opportunity_provenance_nodes_source_visibility_idx
    ON opportunity_provenance_nodes(
      node_kind, COALESCE(source_id, ''), COALESCE(provider, ''),
      COALESCE(provider_tenant_id, ''), visibility_scope,
      COALESCE(visibility_user_id, '')
    )`,
  `CREATE TABLE opportunity_provenance_edges (
    parent_node_id TEXT NOT NULL REFERENCES opportunity_provenance_nodes(node_id) ON DELETE CASCADE,
    child_node_id TEXT NOT NULL REFERENCES opportunity_provenance_nodes(node_id) ON DELETE CASCADE,
    relationship TEXT NOT NULL CHECK (length(relationship) BETWEEN 1 AND 120),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (parent_node_id, child_node_id, relationship),
    CHECK (parent_node_id != child_node_id)
  ) STRICT`,
  `CREATE TABLE work_opportunity_provenance_roots (
    opportunity_id TEXT NOT NULL REFERENCES work_opportunities(opportunity_id) ON DELETE CASCADE,
    node_id TEXT NOT NULL REFERENCES opportunity_provenance_nodes(node_id) ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (opportunity_id, node_id),
    UNIQUE (opportunity_id, position)
  ) STRICT`,
  `CREATE TABLE work_opportunity_user_links (
    link_id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES work_opportunities(opportunity_id) ON DELETE CASCADE,
    user_id TEXT,
    role TEXT NOT NULL CHECK (length(role) BETWEEN 1 AND 80),
    resolution TEXT NOT NULL CHECK (resolution IN ('verified', 'inferred', 'ambiguous', 'unresolved')),
    reasoning TEXT NOT NULL CHECK (length(reasoning) <= 4000),
    provenance_node_id TEXT REFERENCES opportunity_provenance_nodes(node_id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT`,
  `CREATE UNIQUE INDEX work_opportunity_user_links_identity_idx
    ON work_opportunity_user_links(
      opportunity_id, COALESCE(user_id, ''), role, resolution,
      COALESCE(provenance_node_id, '')
    )`,
  `CREATE INDEX work_opportunity_user_links_target_idx
    ON work_opportunity_user_links(user_id, resolution, opportunity_id)`,
  `CREATE TABLE work_opportunity_user_states (
    opportunity_id TEXT NOT NULL REFERENCES work_opportunities(opportunity_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('impressed', 'dismissed', 'started')),
    impression_count INTEGER NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
    first_impressed_at INTEGER CHECK (first_impressed_at IS NULL OR first_impressed_at >= 0),
    last_impressed_at INTEGER CHECK (last_impressed_at IS NULL OR last_impressed_at >= 0),
    resolved_at INTEGER CHECK (resolved_at IS NULL OR resolved_at >= 0),
    created_workstream_id TEXT,
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (opportunity_id, user_id)
  ) STRICT`,
  `CREATE TABLE suggested_work_sets (
    user_id TEXT PRIMARY KEY,
    candidate_fingerprint TEXT NOT NULL CHECK (length(candidate_fingerprint) <= 64),
    opportunity_ids_json TEXT NOT NULL CHECK (json_valid(opportunity_ids_json) AND length(opportunity_ids_json) <= 4096),
    ranking_reasoning TEXT NOT NULL CHECK (length(ranking_reasoning) <= 20000),
    model TEXT CHECK (model IS NULL OR length(model) <= 200),
    status TEXT NOT NULL CHECK (status IN ('stale', 'ready', 'failed')),
    due_at INTEGER CHECK (due_at IS NULL OR due_at >= 0),
    request_seq INTEGER NOT NULL DEFAULT 0 CHECK (request_seq >= 0),
    lease_id TEXT,
    lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
    last_ranked_at INTEGER CHECK (last_ranked_at IS NULL OR last_ranked_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT`,
  `CREATE INDEX suggested_work_sets_due_idx
    ON suggested_work_sets(due_at, user_id) WHERE due_at IS NOT NULL`,
  `CREATE TABLE suggested_work_ranking_rounds (
    round_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    candidate_ids_json TEXT NOT NULL CHECK (json_valid(candidate_ids_json) AND length(candidate_ids_json) <= 4096),
    selected_ids_json TEXT NOT NULL CHECK (json_valid(selected_ids_json) AND length(selected_ids_json) <= 4096),
    reasoning TEXT NOT NULL CHECK (length(reasoning) <= 20000),
    model TEXT CHECK (model IS NULL OR length(model) <= 200),
    round_number INTEGER NOT NULL CHECK (round_number >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  `CREATE INDEX suggested_work_ranking_rounds_user_idx
    ON suggested_work_ranking_rounds(user_id, created_at DESC, round_id)`,
  `CREATE TABLE work_opportunity_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    opportunity_id TEXT NOT NULL REFERENCES work_opportunities(opportunity_id) ON DELETE CASCADE,
    opportunity_version INTEGER NOT NULL CHECK (opportunity_version > 0),
    selected_by_user_id TEXT NOT NULL,
    display_prompt_hash TEXT NOT NULL CHECK (length(display_prompt_hash) = 64),
    execution_prompt_hash TEXT NOT NULL CHECK (length(execution_prompt_hash) = 64),
    identity_links_json TEXT NOT NULL CHECK (json_valid(identity_links_json) AND length(identity_links_json) <= 262144),
    provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json) AND length(provenance_json) <= 524288),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (opportunity_id, opportunity_version, selected_by_user_id)
  ) STRICT`,
] as const;
