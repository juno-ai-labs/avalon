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

-- Control-plane cursor only: the member identities stay authoritative in D1,
-- while each member's digest configuration is read and repaired in the owning
-- WorkspaceDO. This prevents an impossible cross-database NOT EXISTS join and
-- bounds every fleet sweep without copying digest product state back to D1.
CREATE TABLE digest_reconciliation_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  after_workspace_id TEXT NOT NULL DEFAULT '',
  after_user_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);

INSERT INTO digest_reconciliation_control (id, after_workspace_id, after_user_id, updated_at)
VALUES (1, '', '', datetime('now'));

-- Opaque provider-to-workspace lookup used before a webhook or callback can
-- address a WorkspaceDO. Credentials, cursor, configuration and display data
-- never live here.
CREATE TABLE connector_ingress_routes (
  connection_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  connector_type TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  provider_account_id TEXT,
  provider_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  updated_at TEXT NOT NULL
);

CREATE INDEX connector_ingress_routes_provider_idx
  ON connector_ingress_routes(connector_type, provider_account_id, status, workspace_id);
CREATE INDEX connector_ingress_routes_user_idx
  ON connector_ingress_routes(connector_type, provider_user_id, status, workspace_id);

INSERT INTO connector_ingress_routes (
  connection_id, workspace_id, region, connector_type, scope,
  provider_account_id, provider_user_id, status, updated_at
)
SELECT connection.id, connection.workspace_id, workspace.region,
       connection.connector_type, connection.scope, connection.provider_account_id,
       COALESCE(
         CAST(json_extract(connection.config_json, '$.providerUserId') AS TEXT),
         CAST(json_extract(connection.config_json, '$.githubUserId') AS TEXT)
       ),
       CASE WHEN connection.status = 'disabled' THEN 'disabled' ELSE 'active' END,
       connection.updated_at
  FROM connector_connections connection
  JOIN workspaces workspace ON workspace.id = connection.workspace_id;

CREATE TRIGGER connector_ingress_routes_after_insert
AFTER INSERT ON connector_connections
BEGIN
  INSERT INTO connector_ingress_routes (
    connection_id, workspace_id, region, connector_type, scope,
    provider_account_id, provider_user_id, status, updated_at
  )
  SELECT NEW.id, NEW.workspace_id, workspace.region, NEW.connector_type, NEW.scope,
         NEW.provider_account_id,
         COALESCE(
           CAST(json_extract(NEW.config_json, '$.providerUserId') AS TEXT),
           CAST(json_extract(NEW.config_json, '$.githubUserId') AS TEXT)
         ),
         CASE WHEN NEW.status = 'disabled' THEN 'disabled' ELSE 'active' END,
         NEW.updated_at
    FROM workspaces workspace WHERE workspace.id = NEW.workspace_id
  ON CONFLICT(connection_id) DO UPDATE SET
    workspace_id = excluded.workspace_id, region = excluded.region,
    connector_type = excluded.connector_type, scope = excluded.scope,
    provider_account_id = excluded.provider_account_id,
    provider_user_id = excluded.provider_user_id,
    status = excluded.status, updated_at = excluded.updated_at;
END;

CREATE TRIGGER connector_ingress_routes_after_update
AFTER UPDATE OF workspace_id, connector_type, scope, provider_account_id, config_json, status, updated_at
ON connector_connections
BEGIN
  INSERT INTO connector_ingress_routes (
    connection_id, workspace_id, region, connector_type, scope,
    provider_account_id, provider_user_id, status, updated_at
  )
  SELECT NEW.id, NEW.workspace_id, workspace.region, NEW.connector_type, NEW.scope,
         NEW.provider_account_id,
         COALESCE(
           CAST(json_extract(NEW.config_json, '$.providerUserId') AS TEXT),
           CAST(json_extract(NEW.config_json, '$.githubUserId') AS TEXT)
         ),
         CASE WHEN NEW.status = 'disabled' THEN 'disabled' ELSE 'active' END,
         NEW.updated_at
    FROM workspaces workspace WHERE workspace.id = NEW.workspace_id
  ON CONFLICT(connection_id) DO UPDATE SET
    workspace_id = excluded.workspace_id, region = excluded.region,
    connector_type = excluded.connector_type, scope = excluded.scope,
    provider_account_id = excluded.provider_account_id,
    provider_user_id = excluded.provider_user_id,
    status = excluded.status, updated_at = excluded.updated_at;
END;

CREATE TRIGGER workspace_domain_object_deletion_drain_guard
BEFORE UPDATE OF phase ON workstream_authority_control
WHEN OLD.phase = 'maintenance_draining' AND NEW.phase = 'maintenance_importing'
  AND (
    EXISTS (SELECT 1 FROM note_resource_deletion_outbox)
    OR EXISTS (SELECT 1 FROM resource_object_deletion_outbox)
    OR EXISTS (
      SELECT 1 FROM activities WHERE processing_status IN ('pending', 'processing')
    )
    OR EXISTS (
      SELECT 1 FROM slack_ingress_jobs
       WHERE status IN ('queued', 'processing')
          OR (status = 'failed' AND payload_json IS NOT NULL AND attempt_count < 20)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace_domain_handoffs_not_drained');
END;

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

-- Every moved workspace table is read-only in D1 as soon as import begins.
-- Rows can be deleted only during the verified maintenance scrub. This is the
-- final authority fence for callers that accidentally bypass the runtime
-- WorkspaceDO database adapter after the one-way cutover.
CREATE TRIGGER activities_reject_workspace_do_insert BEFORE INSERT ON activities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER activities_reject_workspace_do_update BEFORE UPDATE ON activities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER activities_reject_workspace_do_delete BEFORE DELETE ON activities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER connector_connections_reject_workspace_do_insert BEFORE INSERT ON connector_connections
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER connector_connections_reject_workspace_do_update BEFORE UPDATE ON connector_connections
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER connector_connections_reject_workspace_do_delete BEFORE DELETE ON connector_connections
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER webhook_receipts_reject_workspace_do_insert BEFORE INSERT ON webhook_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER webhook_receipts_reject_workspace_do_update BEFORE UPDATE ON webhook_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER webhook_receipts_reject_workspace_do_delete BEFORE DELETE ON webhook_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER connector_oauth_attempts_reject_workspace_do_insert BEFORE INSERT ON connector_oauth_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER connector_oauth_attempts_reject_workspace_do_update BEFORE UPDATE ON connector_oauth_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER connector_oauth_attempts_reject_workspace_do_delete BEFORE DELETE ON connector_oauth_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER external_user_identities_reject_workspace_do_insert BEFORE INSERT ON external_user_identities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER external_user_identities_reject_workspace_do_update BEFORE UPDATE ON external_user_identities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER external_user_identities_reject_workspace_do_delete BEFORE DELETE ON external_user_identities
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER workspace_sandbox_network_policies_reject_workspace_do_insert BEFORE INSERT ON workspace_sandbox_network_policies
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workspace_sandbox_network_policies_reject_workspace_do_update BEFORE UPDATE ON workspace_sandbox_network_policies
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workspace_sandbox_network_policies_reject_workspace_do_delete BEFORE DELETE ON workspace_sandbox_network_policies
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER workspace_sandbox_network_domains_reject_workspace_do_insert BEFORE INSERT ON workspace_sandbox_network_domains
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workspace_sandbox_network_domains_reject_workspace_do_update BEFORE UPDATE ON workspace_sandbox_network_domains
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workspace_sandbox_network_domains_reject_workspace_do_delete BEFORE DELETE ON workspace_sandbox_network_domains
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER workspace_sandbox_network_policy_mutations_reject_workspace_do_insert BEFORE INSERT ON workspace_sandbox_network_policy_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workspace_sandbox_network_policy_mutations_reject_workspace_do_update BEFORE UPDATE ON workspace_sandbox_network_policy_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workspace_sandbox_network_policy_mutations_reject_workspace_do_delete BEFORE DELETE ON workspace_sandbox_network_policy_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_policies_reject_workspace_do_insert BEFORE INSERT ON slack_agent_policies
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_policies_reject_workspace_do_update BEFORE UPDATE ON slack_agent_policies
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_policies_reject_workspace_do_delete BEFORE DELETE ON slack_agent_policies
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_channel_allowlist_reject_workspace_do_insert BEFORE INSERT ON slack_agent_channel_allowlist
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_channel_allowlist_reject_workspace_do_update BEFORE UPDATE ON slack_agent_channel_allowlist
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_channel_allowlist_reject_workspace_do_delete BEFORE DELETE ON slack_agent_channel_allowlist
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_delivery_preferences_reject_workspace_do_insert BEFORE INSERT ON slack_delivery_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_delivery_preferences_reject_workspace_do_update BEFORE UPDATE ON slack_delivery_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_delivery_preferences_reject_workspace_do_delete BEFORE DELETE ON slack_delivery_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_user_links_reject_workspace_do_insert BEFORE INSERT ON slack_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_user_links_reject_workspace_do_update BEFORE UPDATE ON slack_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_user_links_reject_workspace_do_delete BEFORE DELETE ON slack_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_contexts_reject_workspace_do_insert BEFORE INSERT ON slack_agent_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_contexts_reject_workspace_do_update BEFORE UPDATE ON slack_agent_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_contexts_reject_workspace_do_delete BEFORE DELETE ON slack_agent_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_feedback_reject_workspace_do_insert BEFORE INSERT ON slack_agent_feedback
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_feedback_reject_workspace_do_update BEFORE UPDATE ON slack_agent_feedback
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_feedback_reject_workspace_do_delete BEFORE DELETE ON slack_agent_feedback
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_sessions_reject_workspace_do_insert BEFORE INSERT ON slack_agent_sessions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_sessions_reject_workspace_do_update BEFORE UPDATE ON slack_agent_sessions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_sessions_reject_workspace_do_delete BEFORE DELETE ON slack_agent_sessions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_thread_claims_reject_workspace_do_insert BEFORE INSERT ON slack_agent_thread_claims
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_thread_claims_reject_workspace_do_update BEFORE UPDATE ON slack_agent_thread_claims
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_thread_claims_reject_workspace_do_delete BEFORE DELETE ON slack_agent_thread_claims
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_ingress_jobs_reject_workspace_do_insert BEFORE INSERT ON slack_ingress_jobs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_ingress_jobs_reject_workspace_do_update BEFORE UPDATE ON slack_ingress_jobs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_ingress_jobs_reject_workspace_do_delete BEFORE DELETE ON slack_ingress_jobs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_link_challenges_reject_workspace_do_insert BEFORE INSERT ON slack_link_challenges
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_link_challenges_reject_workspace_do_update BEFORE UPDATE ON slack_link_challenges
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_link_challenges_reject_workspace_do_delete BEFORE DELETE ON slack_link_challenges
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_agent_pending_prompts_reject_workspace_do_insert BEFORE INSERT ON slack_agent_pending_prompts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_pending_prompts_reject_workspace_do_update BEFORE UPDATE ON slack_agent_pending_prompts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_agent_pending_prompts_reject_workspace_do_delete BEFORE DELETE ON slack_agent_pending_prompts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER slack_unfurled_links_reject_workspace_do_insert BEFORE INSERT ON slack_unfurled_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_unfurled_links_reject_workspace_do_update BEFORE UPDATE ON slack_unfurled_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER slack_unfurled_links_reject_workspace_do_delete BEFORE DELETE ON slack_unfurled_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_templates_reject_workspace_do_insert BEFORE INSERT ON automation_templates
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_templates_reject_workspace_do_update BEFORE UPDATE ON automation_templates
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_templates_reject_workspace_do_delete BEFORE DELETE ON automation_templates
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_template_versions_reject_workspace_do_insert BEFORE INSERT ON automation_template_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_template_versions_reject_workspace_do_update BEFORE UPDATE ON automation_template_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_template_versions_reject_workspace_do_delete BEFORE DELETE ON automation_template_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_subscriptions_reject_workspace_do_insert BEFORE INSERT ON automation_subscriptions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_subscriptions_reject_workspace_do_update BEFORE UPDATE ON automation_subscriptions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_subscriptions_reject_workspace_do_delete BEFORE DELETE ON automation_subscriptions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_runs_reject_workspace_do_insert BEFORE INSERT ON automation_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_runs_reject_workspace_do_update BEFORE UPDATE ON automation_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_runs_reject_workspace_do_delete BEFORE DELETE ON automation_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_delivery_targets_reject_workspace_do_insert BEFORE INSERT ON automation_delivery_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_delivery_targets_reject_workspace_do_update BEFORE UPDATE ON automation_delivery_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_delivery_targets_reject_workspace_do_delete BEFORE DELETE ON automation_delivery_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_email_receipts_reject_workspace_do_insert BEFORE INSERT ON automation_email_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_email_receipts_reject_workspace_do_update BEFORE UPDATE ON automation_email_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_email_receipts_reject_workspace_do_delete BEFORE DELETE ON automation_email_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_email_rate_windows_reject_workspace_do_insert BEFORE INSERT ON automation_email_rate_windows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_email_rate_windows_reject_workspace_do_update BEFORE UPDATE ON automation_email_rate_windows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_email_rate_windows_reject_workspace_do_delete BEFORE DELETE ON automation_email_rate_windows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER automation_resources_reject_workspace_do_insert BEFORE INSERT ON automation_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_resources_reject_workspace_do_update BEFORE UPDATE ON automation_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER automation_resources_reject_workspace_do_delete BEFORE DELETE ON automation_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER digest_schedules_reject_workspace_do_insert BEFORE INSERT ON digest_schedules
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_schedules_reject_workspace_do_update BEFORE UPDATE ON digest_schedules
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_schedules_reject_workspace_do_delete BEFORE DELETE ON digest_schedules
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER digest_schedule_times_reject_workspace_do_insert BEFORE INSERT ON digest_schedule_times
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_schedule_times_reject_workspace_do_update BEFORE UPDATE ON digest_schedule_times
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_schedule_times_reject_workspace_do_delete BEFORE DELETE ON digest_schedule_times
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER digest_delivery_targets_reject_workspace_do_insert BEFORE INSERT ON digest_delivery_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_delivery_targets_reject_workspace_do_update BEFORE UPDATE ON digest_delivery_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_delivery_targets_reject_workspace_do_delete BEFORE DELETE ON digest_delivery_targets
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER digest_deliveries_reject_workspace_do_insert BEFORE INSERT ON digest_deliveries
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_deliveries_reject_workspace_do_update BEFORE UPDATE ON digest_deliveries
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER digest_deliveries_reject_workspace_do_delete BEFORE DELETE ON digest_deliveries
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER schedules_reject_workspace_do_insert BEFORE INSERT ON schedules
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER schedules_reject_workspace_do_update BEFORE UPDATE ON schedules
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER schedules_reject_workspace_do_delete BEFORE DELETE ON schedules
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER resources_reject_workspace_do_insert BEFORE INSERT ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER resources_reject_workspace_do_update BEFORE UPDATE ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER resources_reject_workspace_do_delete BEFORE DELETE ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER resource_watches_reject_workspace_do_insert BEFORE INSERT ON resource_watches
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER resource_watches_reject_workspace_do_update BEFORE UPDATE ON resource_watches
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER resource_watches_reject_workspace_do_delete BEFORE DELETE ON resource_watches
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER notes_reject_workspace_do_insert BEFORE INSERT ON notes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER notes_reject_workspace_do_update BEFORE UPDATE ON notes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER notes_reject_workspace_do_delete BEFORE DELETE ON notes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER note_transcript_segments_reject_workspace_do_insert BEFORE INSERT ON note_transcript_segments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER note_transcript_segments_reject_workspace_do_update BEFORE UPDATE ON note_transcript_segments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER note_transcript_segments_reject_workspace_do_delete BEFORE DELETE ON note_transcript_segments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER note_privacy_change_outbox_reject_workspace_do_insert BEFORE INSERT ON note_privacy_change_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER note_privacy_change_outbox_reject_workspace_do_update BEFORE UPDATE ON note_privacy_change_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER note_privacy_change_outbox_reject_workspace_do_delete BEFORE DELETE ON note_privacy_change_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER note_resource_deletion_outbox_reject_workspace_do_insert BEFORE INSERT ON note_resource_deletion_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER note_resource_deletion_outbox_reject_workspace_do_update BEFORE UPDATE ON note_resource_deletion_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER note_resource_deletion_outbox_reject_workspace_do_delete BEFORE DELETE ON note_resource_deletion_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER resource_object_deletion_outbox_reject_workspace_do_insert BEFORE INSERT ON resource_object_deletion_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER resource_object_deletion_outbox_reject_workspace_do_update BEFORE UPDATE ON resource_object_deletion_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER resource_object_deletion_outbox_reject_workspace_do_delete BEFORE DELETE ON resource_object_deletion_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_scopes_reject_workspace_do_insert BEFORE INSERT ON memory_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_scopes_reject_workspace_do_update BEFORE UPDATE ON memory_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_scopes_reject_workspace_do_delete BEFORE DELETE ON memory_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_items_reject_workspace_do_insert BEFORE INSERT ON memory_items
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_items_reject_workspace_do_update BEFORE UPDATE ON memory_items
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_items_reject_workspace_do_delete BEFORE DELETE ON memory_items
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_mutations_reject_workspace_do_insert BEFORE INSERT ON memory_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_mutations_reject_workspace_do_update BEFORE UPDATE ON memory_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_mutations_reject_workspace_do_delete BEFORE DELETE ON memory_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_index_outbox_reject_workspace_do_insert BEFORE INSERT ON memory_index_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_index_outbox_reject_workspace_do_update BEFORE UPDATE ON memory_index_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_index_outbox_reject_workspace_do_delete BEFORE DELETE ON memory_index_outbox
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_tables_reject_workspace_do_insert BEFORE INSERT ON memory_tables
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_tables_reject_workspace_do_update BEFORE UPDATE ON memory_tables
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_tables_reject_workspace_do_delete BEFORE DELETE ON memory_tables
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_table_columns_reject_workspace_do_insert BEFORE INSERT ON memory_table_columns
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_columns_reject_workspace_do_update BEFORE UPDATE ON memory_table_columns
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_columns_reject_workspace_do_delete BEFORE DELETE ON memory_table_columns
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_table_rows_reject_workspace_do_insert BEFORE INSERT ON memory_table_rows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_rows_reject_workspace_do_update BEFORE UPDATE ON memory_table_rows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_rows_reject_workspace_do_delete BEFORE DELETE ON memory_table_rows
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_table_cells_reject_workspace_do_insert BEFORE INSERT ON memory_table_cells
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_cells_reject_workspace_do_update BEFORE UPDATE ON memory_table_cells
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_cells_reject_workspace_do_delete BEFORE DELETE ON memory_table_cells
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER memory_table_mutations_reject_workspace_do_insert BEFORE INSERT ON memory_table_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_mutations_reject_workspace_do_update BEFORE UPDATE ON memory_table_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER memory_table_mutations_reject_workspace_do_delete BEFORE DELETE ON memory_table_mutations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER workstream_notification_intents_reject_workspace_do_insert BEFORE INSERT ON workstream_notification_intents
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workstream_notification_intents_reject_workspace_do_update BEFORE UPDATE ON workstream_notification_intents
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workstream_notification_intents_reject_workspace_do_delete BEFORE DELETE ON workstream_notification_intents
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

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

-- Inbound-email processing receipts and dictation admission state follow the
-- same authority move: WorkspaceDO owns the rows once the route opens, the
-- maintenance campaign imports and scrubs the legacy copies, and these fences
-- keep any later writer from resurrecting a second store.
CREATE TRIGGER workstream_email_receipts_reject_workspace_do_insert BEFORE INSERT ON workstream_email_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workstream_email_receipts_reject_workspace_do_update BEFORE UPDATE ON workstream_email_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER workstream_email_receipts_reject_workspace_do_delete BEFORE DELETE ON workstream_email_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER realtime_transcription_sessions_reject_workspace_do_insert BEFORE INSERT ON realtime_transcription_sessions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER realtime_transcription_sessions_reject_workspace_do_update BEFORE UPDATE ON realtime_transcription_sessions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER realtime_transcription_sessions_reject_workspace_do_delete BEFORE DELETE ON realtime_transcription_sessions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

CREATE TRIGGER realtime_transcription_ticket_receipts_reject_workspace_do_insert BEFORE INSERT ON realtime_transcription_ticket_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER realtime_transcription_ticket_receipts_reject_workspace_do_update BEFORE UPDATE ON realtime_transcription_ticket_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
CREATE TRIGGER realtime_transcription_ticket_receipts_reject_workspace_do_delete BEFORE DELETE ON realtime_transcription_ticket_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;
