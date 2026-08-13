-- Regional control-plane state for the Daytona-backed Terminal plugin. Every
-- tenant-owned key and claim starts with workspace_id; provider identifiers are
-- reconciliation facts, never authorization.

CREATE TABLE workspace_sandbox_network_policies (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('trusted_only', 'full_internet')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  verification_state TEXT NOT NULL CHECK (verification_state IN ('pending', 'verified', 'failed')),
  baseline_manifest_version TEXT NOT NULL,
  effective_domains_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(effective_domains_json)),
  last_verified_at TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_sandbox_network_domains (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, domain)
);

CREATE TABLE workspace_sandbox_network_policy_mutations (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  expected_revision INTEGER NOT NULL,
  resulting_revision INTEGER,
  proposed_mode TEXT NOT NULL CHECK (proposed_mode IN ('trusted_only', 'full_internet')),
  proposed_domains_json TEXT NOT NULL CHECK (json_valid(proposed_domains_json)),
  effective_domains_json TEXT NOT NULL CHECK (json_valid(effective_domains_json)),
  affected_sandboxes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_sandboxes_json)),
  state TEXT NOT NULL CHECK (state IN ('preview', 'pending', 'verified', 'failed', 'conflict')),
  failure_code TEXT,
  requested_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  confirmed_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE workstream_sandboxes (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN (
    'absent', 'starting', 'running', 'stopping', 'stopped', 'archiving',
    'archived', 'restoring', 'expiring', 'expired', 'failed'
  )),
  stable_name TEXT NOT NULL,
  provider_sandbox_id TEXT,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  authority_fingerprint TEXT NOT NULL,
  applied_network_revision INTEGER NOT NULL CHECK (applied_network_revision >= 1),
  version INTEGER NOT NULL CHECK (version >= 1),
  operation_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
  operation_lease_expires_at TEXT,
  lifecycle_claim_id TEXT,
  lifecycle_claim_expires_at TEXT,
  last_activity_at TEXT NOT NULL,
  warm_stop_due_at TEXT,
  archive_due_at TEXT,
  expire_due_at TEXT,
  final_diff_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, workstream_id),
  UNIQUE (workspace_id, stable_name),
  UNIQUE (workspace_id, provider_sandbox_id)
);

CREATE TABLE sandbox_tasks (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,
  sandbox_generation INTEGER NOT NULL CHECK (sandbox_generation >= 1),
  provider_task_name TEXT NOT NULL,
  provider_task_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'submitting', 'running', 'completed', 'failed', 'timed_out', 'cancelled')),
  command_sha256 TEXT NOT NULL,
  command_deadline_at TEXT NOT NULL,
  exit_code INTEGER,
  termination_reason TEXT CHECK (termination_reason IS NULL OR termination_reason IN (
    'exited', 'timed_out', 'cancelled', 'output_limit_exceeded'
  )),
  stdout_head TEXT NOT NULL DEFAULT '',
  stdout_tail TEXT NOT NULL DEFAULT '',
  stderr_head TEXT NOT NULL DEFAULT '',
  stderr_tail TEXT NOT NULL DEFAULT '',
  stdout_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stdout_bytes >= 0),
  stderr_bytes INTEGER NOT NULL DEFAULT 0 CHECK (stderr_bytes >= 0),
  output_resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
  continuation_emitted_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, tool_invocation_id),
  UNIQUE (workspace_id, provider_task_name)
);

CREATE TABLE sandbox_imported_resources (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  sandbox_generation INTEGER NOT NULL CHECK (sandbox_generation >= 1),
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  destination_path TEXT NOT NULL,
  source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('planned', 'completed')),
  imported_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, workstream_id, sandbox_generation, resource_id, destination_path),
  FOREIGN KEY (workspace_id, workstream_id)
    REFERENCES workstream_sandboxes(workspace_id, workstream_id) ON DELETE CASCADE
);

CREATE TABLE terminal_publication_grants (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  principal_key TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_by_invocation_id TEXT REFERENCES tool_invocations(id) ON DELETE SET NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, harness_run_id, source_message_id, repository_full_name)
);

CREATE TABLE workstream_terminal_repositories (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE RESTRICT,
  repository_id INTEGER NOT NULL CHECK (repository_id > 0),
  repository_full_name TEXT NOT NULL CHECK (
    repository_full_name GLOB '*/*' AND repository_full_name NOT GLOB '*/*/*'
  ),
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL CHECK (length(base_sha) = 40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
  head_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('selected', 'revoked')),
  bootstrapped_sandbox_generation INTEGER CHECK (
    bootstrapped_sandbox_generation IS NULL OR bootstrapped_sandbox_generation >= 1
  ),
  read_token_expires_at TEXT,
  selected_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, workstream_id),
  UNIQUE (workspace_id, workstream_id, repository_full_name, head_ref)
);

CREATE TABLE repository_publications (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  tool_invocation_id TEXT NOT NULL REFERENCES tool_invocations(id) ON DELETE CASCADE,
  grant_id TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  head_ref TEXT NOT NULL,
  expected_old_sha TEXT,
  requested_commit_sha TEXT NOT NULL,
  published_sha TEXT,
  state TEXT NOT NULL CHECK (state IN ('planned', 'validating', 'publishing', 'completed', 'failed', 'ambiguous')),
  pull_request_number INTEGER,
  pull_request_url TEXT,
  pull_request_state TEXT CHECK (pull_request_state IS NULL OR pull_request_state IN ('open', 'closed', 'merged')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, grant_id) REFERENCES terminal_publication_grants(workspace_id, id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, tool_invocation_id)
);

CREATE INDEX idx_workspace_sandbox_network_policies_verification
  ON workspace_sandbox_network_policies(workspace_id, verification_state, updated_at);
CREATE INDEX idx_workspace_sandbox_network_domains_domain
  ON workspace_sandbox_network_domains(workspace_id, domain);
CREATE INDEX idx_workspace_sandbox_network_policy_mutations_state
  ON workspace_sandbox_network_policy_mutations(workspace_id, state, created_at);
CREATE INDEX idx_workstream_sandboxes_lifecycle
  ON workstream_sandboxes(workspace_id, warm_stop_due_at, archive_due_at, expire_due_at, state);
CREATE INDEX idx_sandbox_tasks_state
  ON sandbox_tasks(workspace_id, state, command_deadline_at);
CREATE INDEX idx_sandbox_imported_resources_resource
  ON sandbox_imported_resources(workspace_id, resource_id, workstream_id);
CREATE INDEX idx_terminal_publication_grants_expiry
  ON terminal_publication_grants(workspace_id, expires_at, consumed_at);
CREATE INDEX idx_workstream_terminal_repositories_connection
  ON workstream_terminal_repositories(workspace_id, connection_id, state);
CREATE INDEX idx_repository_publications_target
  ON repository_publications(workspace_id, repository_full_name, base_ref, head_ref, state);

CREATE TRIGGER workstream_sandboxes_workspace_guard_insert
BEFORE INSERT ON workstream_sandboxes
WHEN NOT EXISTS (
  SELECT 1 FROM workstreams
   WHERE id = NEW.workstream_id AND workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'terminal workstream workspace mismatch');
END;

CREATE TRIGGER workstream_sandboxes_workspace_guard_update
BEFORE UPDATE OF workspace_id, workstream_id ON workstream_sandboxes
WHEN NOT EXISTS (
  SELECT 1 FROM workstreams
   WHERE id = NEW.workstream_id AND workspace_id = NEW.workspace_id
)
BEGIN
  SELECT RAISE(ABORT, 'terminal workstream workspace mismatch');
END;

CREATE TRIGGER workstream_terminal_repositories_workspace_guard_insert
BEFORE INSERT ON workstream_terminal_repositories
WHEN NOT EXISTS (
  SELECT 1 FROM workstreams
   WHERE id = NEW.workstream_id AND workspace_id = NEW.workspace_id
) OR NOT EXISTS (
  SELECT 1 FROM connector_connections
   WHERE id = NEW.connection_id AND workspace_id = NEW.workspace_id
     AND connector_type = 'github' AND status = 'healthy'
)
BEGIN
  SELECT RAISE(ABORT, 'terminal repository workspace or GitHub connection mismatch');
END;
