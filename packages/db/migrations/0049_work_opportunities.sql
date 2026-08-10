PRAGMA foreign_keys = ON;

ALTER TABLE activities ADD COLUMN external_people_json TEXT NOT NULL DEFAULT '[]';

-- Activity and in-product mentions are debounced into visibility-compatible
-- windows before any opportunity model work is attempted.
CREATE TABLE opportunity_batch_windows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  partition_key TEXT NOT NULL,
  audience_scope TEXT NOT NULL CHECK (audience_scope IN ('personal', 'workspace')),
  audience_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  first_event_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  process_after TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed')),
  lease_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (audience_scope = 'personal' AND audience_user_id IS NOT NULL)
    OR (audience_scope = 'workspace' AND audience_user_id IS NULL)
  )
);

CREATE UNIQUE INDEX opportunity_batch_windows_queued_partition_idx
  ON opportunity_batch_windows(workspace_id, partition_key)
  WHERE status = 'queued';
CREATE INDEX opportunity_batch_windows_due_idx
  ON opportunity_batch_windows(status, process_after);

CREATE TABLE opportunity_batch_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  window_id TEXT NOT NULL REFERENCES opportunity_batch_windows(id) ON DELETE CASCADE,
  partition_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('activity', 'message')),
  source_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  input_characters INTEGER NOT NULL DEFAULT 0 CHECK (input_characters >= 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  error_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, partition_key, source_kind, source_id)
);

CREATE INDEX opportunity_batch_events_window_idx
  ON opportunity_batch_events(window_id, status, occurred_at, id);

-- Verified mappings are reusable. Semantic resolutions are deliberately kept
-- source/opportunity-local in work_opportunity_user_links below.
CREATE TABLE external_user_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  handle TEXT,
  email TEXT COLLATE NOCASE,
  display_name TEXT,
  verification_source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, provider_tenant_id, provider_user_id)
);

CREATE INDEX external_user_identities_alias_idx
  ON external_user_identities(workspace_id, provider, provider_tenant_id, handle, email);

CREATE TABLE work_opportunities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  audience_scope TEXT NOT NULL CHECK (audience_scope IN ('personal', 'workspace')),
  audience_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  display_prompt TEXT NOT NULL CHECK (length(display_prompt) BETWEEN 1 AND 180),
  execution_prompt TEXT NOT NULL CHECK (length(execution_prompt) BETWEEN 1 AND 20000),
  admission_reasoning TEXT NOT NULL CHECK (length(admission_reasoning) BETWEEN 1 AND 20000),
  provider_icon TEXT NOT NULL DEFAULT 'plug',
  source_label TEXT NOT NULL DEFAULT 'Connected activity',
  source_fingerprint TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  display_prompt_hash TEXT NOT NULL,
  execution_prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'starting', 'started', 'superseded', 'expired')),
  created_workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
  created_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  started_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  start_idempotency_key TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  CHECK (
    (audience_scope = 'personal' AND audience_user_id IS NOT NULL)
    OR (audience_scope = 'workspace' AND audience_user_id IS NULL)
  ),
  UNIQUE (workspace_id, source_fingerprint)
);

CREATE INDEX work_opportunities_active_idx
  ON work_opportunities(workspace_id, status, expires_at, updated_at DESC);

CREATE TABLE opportunity_provenance_nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  node_kind TEXT NOT NULL CHECK (node_kind IN (
    'activity', 'resource', 'message', 'workstream', 'external_person',
    'identity', 'opportunity', 'provider_url'
  )),
  source_id TEXT,
  provider TEXT,
  provider_tenant_id TEXT,
  canonical_url TEXT,
  label TEXT NOT NULL,
  occurred_at TEXT,
  visibility_scope TEXT NOT NULL CHECK (visibility_scope IN ('personal', 'workspace')),
  visibility_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  locator_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX opportunity_provenance_nodes_source_visibility_idx
  ON opportunity_provenance_nodes(
    workspace_id,
    node_kind,
    COALESCE(source_id, ''),
    COALESCE(provider, ''),
    COALESCE(provider_tenant_id, ''),
    visibility_scope,
    COALESCE(visibility_user_id, '')
  );

CREATE TABLE opportunity_provenance_edges (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_node_id TEXT NOT NULL REFERENCES opportunity_provenance_nodes(id) ON DELETE CASCADE,
  child_node_id TEXT NOT NULL REFERENCES opportunity_provenance_nodes(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (parent_node_id, child_node_id, relationship),
  CHECK (parent_node_id != child_node_id)
);

CREATE TABLE work_opportunity_provenance_roots (
  opportunity_id TEXT NOT NULL REFERENCES work_opportunities(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES opportunity_provenance_nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (opportunity_id, node_id)
);

CREATE TABLE work_opportunity_user_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES work_opportunities(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('verified', 'inferred', 'ambiguous', 'unresolved')),
  reasoning TEXT NOT NULL DEFAULT '',
  provenance_node_id TEXT REFERENCES opportunity_provenance_nodes(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (opportunity_id, user_id, role, resolution)
);

CREATE INDEX work_opportunity_user_links_target_idx
  ON work_opportunity_user_links(workspace_id, user_id, resolution, opportunity_id);

CREATE TABLE work_opportunity_user_states (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  opportunity_id TEXT NOT NULL REFERENCES work_opportunities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('impressed', 'dismissed', 'started')),
  impression_count INTEGER NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
  first_impressed_at TEXT,
  last_impressed_at TEXT,
  resolved_at TEXT,
  created_workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (opportunity_id, user_id)
);

CREATE TABLE suggested_work_sets (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_version INTEGER NOT NULL DEFAULT 0,
  candidate_fingerprint TEXT NOT NULL,
  opportunity_ids_json TEXT NOT NULL DEFAULT '[]',
  ranking_reasoning TEXT NOT NULL DEFAULT '',
  model TEXT,
  status TEXT NOT NULL DEFAULT 'stale' CHECK (status IN ('stale', 'ranking', 'ready', 'failed')),
  lease_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE suggested_work_ranking_rounds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_ids_json TEXT NOT NULL,
  selected_ids_json TEXT NOT NULL,
  reasoning TEXT NOT NULL,
  model TEXT,
  round_number INTEGER NOT NULL CHECK (round_number >= 0),
  created_at TEXT NOT NULL
);

CREATE TABLE work_opportunity_snapshots (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES work_opportunities(id) ON DELETE CASCADE,
  opportunity_version INTEGER NOT NULL,
  selected_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_prompt_hash TEXT NOT NULL,
  execution_prompt_hash TEXT NOT NULL,
  identity_links_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (opportunity_id, opportunity_version, selected_by_user_id)
);

CREATE TABLE workspace_opportunity_versions (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at TEXT NOT NULL
);

ALTER TABLE workstreams ADD COLUMN created_from_opportunity_id TEXT REFERENCES work_opportunities(id) ON DELETE SET NULL;
ALTER TABLE workstreams ADD COLUMN opportunity_version INTEGER;
ALTER TABLE workstreams ADD COLUMN opportunity_display_prompt_hash TEXT;
ALTER TABLE workstreams ADD COLUMN opportunity_execution_prompt_hash TEXT;

CREATE UNIQUE INDEX workstreams_created_from_opportunity_idx
  ON workstreams(created_from_opportunity_id)
  WHERE created_from_opportunity_id IS NOT NULL;
