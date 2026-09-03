const WORKSPACE_FENCED_TABLES = [
  "connector_connections",
  "webhook_receipts",
  "connector_oauth_attempts",
  "external_user_identities",
  "workspace_sandbox_network_policies",
  "workspace_sandbox_network_domains",
  "workspace_sandbox_network_policy_mutations",
  "slack_user_links",
  "slack_agent_feedback",
  "slack_agent_sessions",
  "slack_ingress_jobs",
  "slack_unfurled_links",
  "automation_templates",
  "automation_subscriptions",
  "automation_runs",
  "automation_delivery_targets",
  "automation_email_receipts",
  "automation_email_rate_windows",
  "digest_schedules",
  "digest_delivery_targets",
  "digest_deliveries",
  "schedules",
  "resources",
  "resource_watches",
  "resource_object_deletion_outbox",
  "notes",
  "note_privacy_change_outbox",
  "memory_scopes",
  "memory_items",
  "memory_mutations",
  "memory_index_outbox",
  "memory_tables",
  "memory_table_rows",
  "memory_table_mutations",
  "workstream_notification_intents",
  "external_delivery_attempts",
  "workstream_email_receipts",
  "realtime_transcription_ticket_receipts",
  "realtime_transcription_sessions",
] as const;

/**
 * The two triggers that hold one table's rows to this object's workspace.
 *
 * Exported because a table rebuild drops its triggers with it: SQLite takes a
 * table's triggers when the table goes, and a rebuild that restored only the
 * indexes would leave the upgraded object without the guard that stops another
 * workspace's row from reaching it. A migration recreates them from here rather
 * than from a copy, so the fence a rebuilt table gets is the fence every other
 * table has.
 */
export function workspaceIdentityFencesFor(table: string): string[] {
  return [
    `CREATE TRIGGER ${table}_workspace_identity_insert
      BEFORE INSERT ON ${table}
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER ${table}_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON ${table}
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ];
}

function workspaceIdentityFences(): string[] {
  return WORKSPACE_FENCED_TABLES.flatMap((table) => workspaceIdentityFencesFor(table));
}

/**
 * Where Avalon's Slack status reaction sits, and which one it is.
 *
 * Separate from the frozen `CREATE TABLE` below because these arrived after the
 * D1 cutover: WorkspaceDO applies them as a schema migration, and the test
 * fixture that stands in for an object database applies them to the snapshot it
 * builds. One definition, so the two cannot drift.
 */
export const SLACK_REACTION_COLUMN_STATEMENTS = [
  `ALTER TABLE slack_agent_sessions ADD COLUMN reaction_channel_id TEXT`,
  `ALTER TABLE slack_agent_sessions ADD COLUMN reaction_message_ts TEXT`,
  `ALTER TABLE slack_agent_sessions ADD COLUMN reaction_current TEXT`,
  `ALTER TABLE slack_agent_sessions ADD COLUMN reaction_cursor INTEGER NOT NULL DEFAULT 0`,
] as const;

/**
 * Workspace-scoped product authorities that do not belong to one work stream.
 *
 * `workspace_id` remains on imported rows during this maintenance-window
 * cutover so existing repositories and audit payloads retain their shape. The
 * RPC identity fence and per-table triggers require it to equal the singleton
 * `workspace_identity`; it is never a routing key inside the object.
 * Cross-object identifiers (users, connector connections, work streams, runs)
 * are opaque text and deliberately have no pretend foreign key.
 */
export const WORKSPACE_DOMAIN_SCHEMA_STATEMENTS = [
  `CREATE TABLE connector_connections (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connector_type TEXT NOT NULL CHECK (connector_type IN ('google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    owner_user_id TEXT,
    provider_account_id TEXT,
    display_name TEXT NOT NULL,
    encrypted_credentials TEXT,
    credential_iv TEXT,
    credential_key_version INTEGER,
    credential_refresh_lease_id TEXT,
    credential_refresh_lease_expires_at TEXT,
    granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
    status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
    cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
    config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
    last_sync_at TEXT,
    next_poll_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    model_plugin_id TEXT NOT NULL,
    CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
  ) STRICT`,
  `CREATE INDEX connector_connections_poll_idx
    ON connector_connections(status, next_poll_at, id)`,
  `CREATE INDEX connector_connections_provider_account_idx
    ON connector_connections(connector_type, provider_account_id, status)`,
  `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
    ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
  `CREATE TABLE webhook_receipts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    signature_hash TEXT NOT NULL,
    received_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (connection_id, signature_hash)
  ) STRICT`,
  `CREATE INDEX webhook_receipts_expiry_idx ON webhook_receipts(expires_at, id)`,
  `CREATE TABLE connector_oauth_attempts (
    id TEXT PRIMARY KEY,
    region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
    provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'granola', 'linear', 'notion', 'slack')),
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
    connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
    error_code TEXT,
    expires_at TEXT NOT NULL,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    telemetry_operation_id TEXT
  ) STRICT`,
  `CREATE INDEX connector_oauth_attempts_expiry_idx
    ON connector_oauth_attempts(status, expires_at, id)`,
  `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
    ON connector_oauth_attempts(telemetry_operation_id)
    WHERE telemetry_operation_id IS NOT NULL`,
  `CREATE TABLE external_user_identities (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
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
  ) STRICT`,
  `CREATE INDEX external_user_identities_user_idx
    ON external_user_identities(user_id, updated_at DESC)`,

  `CREATE TABLE workspace_sandbox_network_policies (
    workspace_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('trusted_only', 'full_internet')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    verification_state TEXT NOT NULL CHECK (verification_state IN ('pending', 'verified', 'failed')),
    baseline_manifest_version TEXT NOT NULL,
    effective_domains_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(effective_domains_json)),
    last_verified_at TEXT,
    failure_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX workspace_sandbox_network_policies_verification_idx
    ON workspace_sandbox_network_policies(verification_state, updated_at)`,
  `CREATE TABLE workspace_sandbox_network_domains (
    workspace_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, domain)
  ) STRICT`,
  `CREATE TABLE workspace_sandbox_network_policy_mutations (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 1),
    resulting_revision INTEGER CHECK (resulting_revision IS NULL OR resulting_revision >= 1),
    proposed_mode TEXT NOT NULL CHECK (proposed_mode IN ('trusted_only', 'full_internet')),
    proposed_domains_json TEXT NOT NULL CHECK (json_valid(proposed_domains_json)),
    effective_domains_json TEXT NOT NULL CHECK (json_valid(effective_domains_json)),
    affected_sandboxes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(affected_sandboxes_json)),
    state TEXT NOT NULL CHECK (state IN ('preview', 'pending', 'verified', 'failed', 'conflict')),
    failure_code TEXT,
    requested_by_user_id TEXT NOT NULL,
    confirmed_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (workspace_id, id)
  ) STRICT`,
  `CREATE INDEX workspace_sandbox_network_policy_mutations_state_idx
    ON workspace_sandbox_network_policy_mutations(state, created_at, id)`,

  `CREATE TABLE automation_templates (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    sharing_state TEXT NOT NULL CHECK (sharing_state IN ('private', 'workspace')),
    latest_version_number INTEGER NOT NULL DEFAULT 1 CHECK (latest_version_number >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT`,
  `CREATE INDEX automation_templates_catalog_idx
    ON automation_templates(sharing_state, archived_at, name COLLATE NOCASE, id)`,
  `CREATE TABLE automation_template_versions (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES automation_templates(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL CHECK (version_number >= 1),
    instructions TEXT NOT NULL,
    trigger_definitions_json TEXT NOT NULL CHECK (json_valid(trigger_definitions_json)),
    required_capabilities_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(required_capabilities_json)),
    expected_outputs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(expected_outputs_json)),
    default_behavior_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(default_behavior_json)),
    created_by_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    overview TEXT NOT NULL DEFAULT '',
    recommended_plugins_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_plugins_json)),
    memory_tables_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(memory_tables_json)),
    UNIQUE (template_id, version_number)
  ) STRICT`,

  `CREATE TABLE slack_agent_policies (
    connection_id TEXT PRIMARY KEY REFERENCES connector_connections(id) ON DELETE CASCADE,
    allow_unlinked_workspace_tasks INTEGER NOT NULL DEFAULT 1 CHECK (allow_unlinked_workspace_tasks IN (0, 1)),
    public_channel_mode TEXT NOT NULL DEFAULT 'all_invited' CHECK (public_channel_mode IN ('all_invited', 'allowlist', 'disabled')),
    private_channel_mode TEXT NOT NULL DEFAULT 'disabled' CHECK (private_channel_mode IN ('allowlist', 'disabled')),
    allow_direct_messages INTEGER NOT NULL DEFAULT 1 CHECK (allow_direct_messages IN (0, 1)),
    allow_commands INTEGER NOT NULL DEFAULT 1 CHECK (allow_commands IN (0, 1)),
    allow_shortcuts INTEGER NOT NULL DEFAULT 1 CHECK (allow_shortcuts IN (0, 1)),
    updated_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE slack_agent_channel_allowlist (
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL,
    channel_type TEXT NOT NULL CHECK (channel_type IN ('public', 'private')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_by_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, slack_channel_id)
  ) STRICT`,
  `CREATE TABLE slack_delivery_preferences (
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    notify_needs_input INTEGER NOT NULL DEFAULT 1 CHECK (notify_needs_input IN (0, 1)),
    notify_automation_completed INTEGER NOT NULL DEFAULT 1 CHECK (notify_automation_completed IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, user_id)
  ) STRICT`,
  `CREATE TABLE slack_user_links (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    slack_team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (connection_id, slack_user_id),
    UNIQUE (workspace_id, connection_id, user_id)
  ) STRICT`,
  `CREATE INDEX slack_user_links_user_idx ON slack_user_links(user_id, status)`,
  `CREATE TABLE slack_agent_contexts (
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    slack_user_id TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, slack_user_id)
  ) STRICT`,
  `CREATE TABLE slack_agent_feedback (
    id TEXT PRIMARY KEY,
    ingress_job_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    rating TEXT NOT NULL CHECK (rating IN ('helpful', 'needs_improvement')),
    comment TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE slack_agent_sessions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    linked_user_id TEXT,
    execution_scope TEXT NOT NULL CHECK (execution_scope IN ('user', 'workspace')),
    slack_team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    slack_channel_id TEXT NOT NULL,
    slack_thread_ts TEXT NOT NULL,
    slack_stream_ts TEXT,
    last_delivery_key TEXT,
    opening_client_message_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    invocation_kind TEXT NOT NULL CHECK (invocation_kind IN ('app_mention', 'direct_message', 'slash_command', 'shortcut')),
    channel_type TEXT NOT NULL CHECK (channel_type IN ('public', 'private', 'im', 'unknown')),
    assigned_user_id TEXT,
    assigned_at TEXT,
    assignment_method TEXT CHECK (assignment_method IS NULL OR assignment_method IN ('verified_email', 'explicit_link')),
    claimed_by_slack_user_id TEXT,
    claimed_at TEXT,
    context_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(context_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (connection_id, slack_channel_id, slack_thread_ts),
    UNIQUE (workstream_id),
    CHECK ((execution_scope = 'user' AND linked_user_id IS NOT NULL) OR execution_scope = 'workspace')
  ) STRICT`,
  `CREATE INDEX slack_agent_sessions_workstream_idx ON slack_agent_sessions(workstream_id)`,
  `CREATE TABLE slack_agent_thread_claims (
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL,
    slack_thread_ts TEXT NOT NULL,
    lease_id TEXT NOT NULL,
    lease_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, slack_channel_id, slack_thread_ts)
  ) STRICT`,
  `CREATE TABLE slack_ingress_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    team_id TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('event', 'interaction', 'command')),
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_id TEXT,
    lease_expires_at TEXT,
    error_code TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  ) STRICT`,
  `CREATE INDEX slack_ingress_jobs_team_idx ON slack_ingress_jobs(team_id, received_at)`,
  `CREATE TABLE slack_link_challenges (
    token_hash TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    slack_team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    consumed_by_user_id TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE slack_agent_pending_prompts (
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL,
    slack_thread_ts TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 40000),
    denial_reason TEXT NOT NULL CHECK (denial_reason IN ('connection', 'channel_resolution', 'policy')),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (connection_id, slack_channel_id, slack_thread_ts, slack_user_id)
  ) STRICT`,
  `CREATE TABLE slack_unfurled_links (
    connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
    slack_channel_id TEXT NOT NULL,
    slack_message_ts TEXT NOT NULL,
    url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2000),
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    rendered_status TEXT NOT NULL,
    rendered_anonymous INTEGER NOT NULL DEFAULT 0 CHECK (rendered_anonymous IN (0, 1)),
    audience_checked_at TEXT NOT NULL,
    shared_at TEXT NOT NULL,
    refreshed_at TEXT NOT NULL,
    rendered_hash TEXT,
    PRIMARY KEY (connection_id, slack_channel_id, slack_message_ts, url)
  ) STRICT`,

  `CREATE TABLE automation_subscriptions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    template_id TEXT NOT NULL,
    template_version_id TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
    owner_user_id TEXT,
    execution_principal_json TEXT NOT NULL CHECK (json_valid(execution_principal_json)),
    connector_bindings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(connector_bindings_json)),
    overrides_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(overrides_json)),
    status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'error')),
    last_run_at TEXT,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    email_address TEXT,
    email_route_status TEXT NOT NULL DEFAULT 'reserved' CHECK (email_route_status IN ('reserved', 'active', 'disabled')),
    default_plugins_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(default_plugins_json)),
    activity_trigger_bindings_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(activity_trigger_bindings_json)),
    lifecycle_state TEXT NOT NULL DEFAULT 'visible' CHECK (lifecycle_state IN ('visible', 'archived', 'deleted')),
    model_override TEXT,
    draft_conversation_json TEXT CHECK (draft_conversation_json IS NULL OR json_valid(draft_conversation_json)),
    CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
  ) STRICT`,
  `CREATE INDEX automation_subscriptions_next_idx
    ON automation_subscriptions(status, next_run_at, id)`,
  `CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
    workstream_id TEXT NOT NULL UNIQUE,
    trigger_type TEXT NOT NULL,
    trigger_activity_id TEXT,
    planned_for TEXT,
    started_at TEXT,
    completed_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'needs_input', 'completed', 'failed')),
    result_summary TEXT,
    workflow_instance_id TEXT,
    created_at TEXT NOT NULL,
    idempotency_key TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX automation_runs_planned_unique_idx
    ON automation_runs(automation_subscription_id, planned_for) WHERE planned_for IS NOT NULL`,
  `CREATE INDEX automation_runs_subscription_idx
    ON automation_runs(automation_subscription_id, created_at DESC)`,
  `CREATE TABLE automation_delivery_targets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK (target_type IN ('slack_agent_dm', 'email')),
    connection_id TEXT,
    user_id TEXT NOT NULL,
    slack_team_id TEXT,
    slack_user_id TEXT,
    email_address TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_input', 'disabled')),
    last_delivered_at TEXT,
    last_delivered_workstream_id TEXT,
    last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (automation_subscription_id, target_type),
    CHECK ((target_type = 'slack_agent_dm' AND connection_id IS NOT NULL AND slack_team_id IS NOT NULL
      AND slack_user_id IS NOT NULL AND email_address IS NULL)
      OR (target_type = 'email' AND connection_id IS NULL AND slack_team_id IS NULL
      AND slack_user_id IS NULL AND email_address IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX automation_delivery_targets_connection_idx
    ON automation_delivery_targets(connection_id, status)`,
  `CREATE TABLE automation_email_receipts (
    resend_email_id TEXT NOT NULL,
    automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE RESTRICT,
    workspace_id TEXT NOT NULL,
    svix_id TEXT NOT NULL,
    payload_ref TEXT,
    workstream_id TEXT,
    automation_run_id TEXT REFERENCES automation_runs(id) ON DELETE RESTRICT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    lease_token TEXT,
    lease_expires_at TEXT,
    PRIMARY KEY (resend_email_id, automation_subscription_id)
  ) STRICT`,
  `CREATE INDEX automation_email_receipts_lease_idx
    ON automation_email_receipts(processed_at, lease_expires_at, received_at)`,
  `CREATE TABLE automation_email_rate_windows (
    automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE RESTRICT,
    workspace_id TEXT NOT NULL,
    window_started_at TEXT NOT NULL,
    accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
    PRIMARY KEY (automation_subscription_id, window_started_at)
  ) STRICT`,
  `CREATE TABLE automation_resources (
    automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL,
    attached_by_user_id TEXT,
    relationship_type TEXT NOT NULL DEFAULT 'context',
    attached_at TEXT NOT NULL,
    PRIMARY KEY (automation_subscription_id, resource_id)
  ) STRICT`,
  `CREATE INDEX automation_resources_resource_idx ON automation_resources(resource_id)`,

  `CREATE TABLE digest_schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    day_mask INTEGER NOT NULL CHECK (day_mask BETWEEN 0 AND 127),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    execution_principal_json TEXT NOT NULL CHECK (json_valid(execution_principal_json)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workspace_id, user_id)
  ) STRICT`,
  `CREATE TABLE digest_schedule_times (
    digest_schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
    minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
    PRIMARY KEY (digest_schedule_id, minute_of_day)
  ) STRICT`,
  `CREATE TABLE digest_delivery_targets (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    digest_schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    target_type TEXT NOT NULL,
    connection_id TEXT,
    provider_tenant_id TEXT,
    provider_user_id TEXT,
    email_address TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_input', 'disabled')),
    last_delivered_at TEXT,
    last_delivered_delivery_id TEXT,
    last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (digest_schedule_id, target_type),
    CHECK ((target_type = 'email' AND connection_id IS NULL AND provider_tenant_id IS NULL
      AND provider_user_id IS NULL AND email_address IS NOT NULL)
      OR (target_type <> 'email' AND connection_id IS NOT NULL AND provider_tenant_id IS NOT NULL
      AND provider_user_id IS NOT NULL AND email_address IS NULL))
  ) STRICT`,
  `CREATE INDEX digest_delivery_targets_connection_idx
    ON digest_delivery_targets(connection_id, status)`,
  `CREATE TABLE digest_deliveries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    digest_schedule_id TEXT NOT NULL REFERENCES digest_schedules(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    planned_for TEXT NOT NULL,
    cursor_from INTEGER,
    cursor_through INTEGER NOT NULL CHECK (cursor_through >= 0),
    event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
    highlight_count INTEGER NOT NULL DEFAULT 0 CHECK (highlight_count >= 0),
    harness_run_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'delivered', 'empty', 'failed')),
    summary_markdown TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    workstream_id TEXT,
    UNIQUE (digest_schedule_id, planned_for)
  ) STRICT`,
  `CREATE INDEX digest_deliveries_cursor_idx
    ON digest_deliveries(digest_schedule_id, cursor_through DESC)`,

  `CREATE TABLE schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    automation_subscription_id TEXT REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
    connector_connection_id TEXT,
    digest_schedule_id TEXT REFERENCES digest_schedules(id) ON DELETE CASCADE,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('calendar', 'interval')),
    rrule TEXT,
    interval_seconds INTEGER,
    timezone TEXT NOT NULL,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((automation_subscription_id IS NOT NULL) + (connector_connection_id IS NOT NULL)
      + (digest_schedule_id IS NOT NULL) = 1),
    CHECK ((schedule_type = 'calendar' AND rrule IS NOT NULL)
      OR (schedule_type = 'interval' AND interval_seconds IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at, id)`,
  `CREATE INDEX schedules_digest_idx ON schedules(digest_schedule_id) WHERE digest_schedule_id IS NOT NULL`,

  `CREATE TABLE resources (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    connection_id TEXT,
    resource_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_resource_id TEXT,
    title TEXT NOT NULL,
    mime_type TEXT,
    content_ref TEXT,
    canonical_url TEXT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    last_hydrated_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    uploaded_by_user_id TEXT,
    attachment_status TEXT NOT NULL DEFAULT 'attached' CHECK (attachment_status IN ('draft', 'attached')),
    model_content_ref TEXT,
    model_mime_type TEXT,
    model_content_sha256 TEXT,
    model_metadata_json TEXT CHECK (model_metadata_json IS NULL OR json_valid(model_metadata_json)),
    content_sha256 TEXT,
    model_content_status TEXT CHECK (model_content_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
    model_content_extractor_version TEXT,
    model_content_character_count INTEGER CHECK (model_content_character_count IS NULL OR model_content_character_count >= 0),
    model_content_extracted_at TEXT,
    model_content_error_code TEXT,
    model_content_claimed_at TEXT,
    model_content_claim_id TEXT
  ) STRICT`,
  `CREATE UNIQUE INDEX resources_connection_provider_identity_idx
    ON resources(workspace_id, connection_id, provider, provider_resource_id)
    WHERE connection_id IS NOT NULL AND provider_resource_id IS NOT NULL`,
  `CREATE UNIQUE INDEX resources_unconnected_provider_identity_idx
    ON resources(workspace_id, provider, provider_resource_id)
    WHERE connection_id IS NULL AND provider_resource_id IS NOT NULL`,
  `CREATE INDEX resources_workspace_idx ON resources(updated_at DESC, id DESC)`,
  `CREATE TABLE resource_watches (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    connection_id TEXT NOT NULL,
    watch_type TEXT NOT NULL,
    cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
    next_poll_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (workstream_id, resource_id)
  ) STRICT`,
  `CREATE INDEX resource_watches_due_idx ON resource_watches(enabled, next_poll_at, id)`,
  `CREATE TABLE resource_object_deletion_outbox (
    object_ref TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    object_kind TEXT NOT NULL CHECK (object_kind IN ('original', 'derivative', 'receipt')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX resource_object_deletion_outbox_created_idx
    ON resource_object_deletion_outbox(created_at, object_ref)`,
  `CREATE TRIGGER resources_track_model_content_after_update
    AFTER UPDATE OF model_content_ref ON resources BEGIN
      DELETE FROM resource_object_deletion_outbox
       WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.model_content_ref;
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
        SELECT OLD.model_content_ref, OLD.workspace_id, OLD.id, 'derivative', datetime('now'), datetime('now')
         WHERE OLD.model_content_ref IS NOT NULL AND OLD.model_content_ref IS NOT NEW.model_content_ref;
    END`,
  `CREATE TRIGGER resources_track_original_after_update
    AFTER UPDATE OF content_ref ON resources
    WHEN OLD.content_ref IS NOT NEW.content_ref AND OLD.content_ref IS NOT NULL BEGIN
      DELETE FROM resource_object_deletion_outbox
       WHERE workspace_id = NEW.workspace_id AND object_ref = NEW.content_ref;
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
        VALUES (OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now'));
    END`,
  `CREATE TRIGGER resources_enqueue_objects_before_delete
    BEFORE DELETE ON resources BEGIN
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
        SELECT OLD.content_ref, OLD.workspace_id, OLD.id, 'original', datetime('now'), datetime('now')
         WHERE OLD.content_ref IS NOT NULL;
      INSERT OR IGNORE INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
        SELECT OLD.model_content_ref, OLD.workspace_id, OLD.id, 'derivative', datetime('now'), datetime('now')
         WHERE OLD.model_content_ref IS NOT NULL;
    END`,

  `CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id) ON DELETE CASCADE,
    scope TEXT NOT NULL DEFAULT 'personal' CHECK (scope IN ('personal', 'workspace')),
    title TEXT NOT NULL,
    recording_status TEXT NOT NULL DEFAULT 'idle' CHECK (recording_status IN ('idle', 'recording', 'complete')),
    manual_notes_markdown TEXT NOT NULL DEFAULT '',
    live_notes_markdown TEXT NOT NULL DEFAULT '',
    notes_through_sequence INTEGER NOT NULL DEFAULT 0 CHECK (notes_through_sequence >= 0),
    next_segment_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_segment_sequence >= 1),
    recorded_ms INTEGER NOT NULL DEFAULT 0 CHECK (recorded_ms >= 0),
    started_at TEXT,
    ended_at TEXT,
    generated_at TEXT,
    privacy_changed_by_user_id TEXT,
    last_activity_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  ) STRICT`,
  `CREATE INDEX notes_sidebar_idx ON notes(archived_at, last_activity_at DESC, id DESC)`,
  `CREATE INDEX notes_owner_idx ON notes(owner_user_id, archived_at, last_activity_at DESC)`,
  `CREATE TABLE note_transcript_segments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    client_segment_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL CHECK (sequence_number >= 1),
    start_offset_ms INTEGER NOT NULL CHECK (start_offset_ms >= 0),
    end_offset_ms INTEGER NOT NULL CHECK (end_offset_ms >= start_offset_ms),
    captured_at TEXT NOT NULL,
    speaker_label TEXT,
    text_content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(note_id, client_segment_id),
    UNIQUE(note_id, sequence_number)
  ) STRICT`,
  `CREATE INDEX note_transcript_segments_note_sequence_idx
    ON note_transcript_segments(note_id, sequence_number)`,
  `CREATE TABLE note_privacy_change_outbox (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    note_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    note_title TEXT NOT NULL,
    actor_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    processed_at TEXT
  ) STRICT`,
  `CREATE INDEX note_privacy_change_outbox_pending_idx
    ON note_privacy_change_outbox(processed_at, created_at, id)`,
  `CREATE TABLE note_resource_deletion_outbox (
    resource_id TEXT PRIMARY KEY,
    content_ref TEXT,
    model_content_ref TEXT,
    created_at TEXT NOT NULL
  ) STRICT`,

  `CREATE TABLE memory_scopes (
    memory_scope_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('workstream', 'automation', 'user', 'workspace')),
    owner_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (workspace_id, kind, owner_id),
    CHECK (kind <> 'workspace' OR owner_id = workspace_id)
  ) STRICT`,
  `CREATE TRIGGER memory_scopes_are_immutable BEFORE UPDATE ON memory_scopes
    BEGIN SELECT RAISE(ABORT, 'memory_scope_immutable'); END`,
  `CREATE TABLE memory_items (
    memory_item_id TEXT PRIMARY KEY,
    memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    text TEXT NOT NULL CHECK (length(trim(text)) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    expires_at TEXT,
    provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
    access_count INTEGER NOT NULL DEFAULT 0 CHECK (access_count >= 0),
    last_accessed_at TEXT,
    invalidated_at TEXT,
    invalidated_by_principal_json TEXT CHECK (invalidated_by_principal_json IS NULL OR json_valid(invalidated_by_principal_json)),
    invalidation_reason TEXT,
    last_mutation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK ((invalidated_at IS NULL AND invalidated_by_principal_json IS NULL AND invalidation_reason IS NULL)
      OR (invalidated_at IS NOT NULL AND invalidated_by_principal_json IS NOT NULL AND invalidation_reason IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX memory_items_scope_active_idx
    ON memory_items(memory_scope_id, invalidated_at, expires_at, updated_at DESC)`,
  `CREATE INDEX memory_items_workspace_idx ON memory_items(workspace_id, updated_at DESC)`,
  `CREATE VIRTUAL TABLE memory_items_fts USING fts5(
    text, content = 'memory_items', content_rowid = 'rowid', tokenize = 'unicode61'
  )`,
  `CREATE TRIGGER memory_items_fts_insert AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_items_fts(rowid, text) VALUES (NEW.rowid, NEW.text); END`,
  `CREATE TRIGGER memory_items_fts_delete AFTER DELETE ON memory_items BEGIN
    INSERT INTO memory_items_fts(memory_items_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text); END`,
  `CREATE TRIGGER memory_items_fts_update AFTER UPDATE OF text ON memory_items BEGIN
    INSERT INTO memory_items_fts(memory_items_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text);
    INSERT INTO memory_items_fts(rowid, text) VALUES (NEW.rowid, NEW.text); END`,
  `CREATE TABLE memory_mutations (
    memory_mutation_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL,
    memory_item_id TEXT NOT NULL REFERENCES memory_items(memory_item_id) ON DELETE CASCADE,
    memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('add', 'update', 'invalidate')),
    prior_revision INTEGER CHECK (prior_revision IS NULL OR prior_revision > 0),
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision > 0),
    actor_principal_json TEXT NOT NULL CHECK (json_valid(actor_principal_json)),
    harness_run_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    rationale TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    UNIQUE (harness_run_id, receipt_id),
    CHECK ((operation = 'add' AND prior_revision IS NULL AND resulting_revision = 1)
      OR (operation IN ('update', 'invalidate') AND prior_revision IS NOT NULL
      AND resulting_revision = prior_revision + 1))
  ) STRICT`,
  `CREATE INDEX memory_mutations_item_idx ON memory_mutations(memory_item_id, resulting_revision DESC)`,
  `CREATE INDEX memory_mutations_run_idx ON memory_mutations(harness_run_id, created_at)`,
  `CREATE TABLE memory_index_outbox (
    outbox_id TEXT PRIMARY KEY,
    memory_item_id TEXT NOT NULL REFERENCES memory_items(memory_item_id) ON DELETE CASCADE,
    memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    lease_token TEXT,
    lease_expires_at TEXT,
    last_error TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (memory_item_id, revision, operation)
  ) STRICT`,
  `CREATE INDEX memory_index_outbox_ready_idx
    ON memory_index_outbox(status, available_at, lease_expires_at, created_at)`,

  `CREATE TABLE memory_tables (
    memory_table_id TEXT PRIMARY KEY,
    memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL,
    usage_instructions TEXT NOT NULL,
    key_column_ids_json TEXT NOT NULL CHECK (json_valid(key_column_ids_json)),
    schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision > 0),
    data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
    last_mutation_id TEXT,
    provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
    invalidated_at TEXT,
    invalidation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (memory_scope_id, name COLLATE NOCASE),
    CHECK ((invalidated_at IS NULL AND invalidation_reason IS NULL)
      OR (invalidated_at IS NOT NULL AND invalidation_reason IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX memory_tables_scope_active_idx
    ON memory_tables(memory_scope_id, invalidated_at, name COLLATE NOCASE)`,
  `CREATE TABLE memory_table_columns (
    memory_table_column_id TEXT PRIMARY KEY,
    memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'url', 'number', 'integer', 'boolean', 'datetime', 'date')),
    is_required INTEGER NOT NULL DEFAULT 0 CHECK (is_required IN (0, 1)),
    is_searchable INTEGER NOT NULL DEFAULT 0 CHECK (is_searchable IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (memory_table_id, name COLLATE NOCASE),
    UNIQUE (memory_table_id, position)
  ) STRICT`,
  `CREATE INDEX memory_table_columns_table_idx ON memory_table_columns(memory_table_id, position)`,
  `CREATE TABLE memory_table_rows (
    memory_table_row_id TEXT PRIMARY KEY,
    memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
    memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    natural_key_hash TEXT NOT NULL,
    data_json TEXT NOT NULL CHECK (json_valid(data_json)),
    searchable_text TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    provenance_json TEXT NOT NULL CHECK (json_valid(provenance_json)),
    created_by_mutation_id TEXT NOT NULL,
    last_mutation_id TEXT NOT NULL,
    invalidated_at TEXT,
    invalidated_by_principal_json TEXT CHECK (invalidated_by_principal_json IS NULL OR json_valid(invalidated_by_principal_json)),
    invalidation_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (memory_table_id, natural_key_hash),
    CHECK ((invalidated_at IS NULL AND invalidated_by_principal_json IS NULL AND invalidation_reason IS NULL)
      OR (invalidated_at IS NOT NULL AND invalidated_by_principal_json IS NOT NULL AND invalidation_reason IS NOT NULL))
  ) STRICT`,
  `CREATE INDEX memory_table_rows_active_idx
    ON memory_table_rows(memory_table_id, invalidated_at, updated_at DESC, memory_table_row_id)`,
  `CREATE INDEX memory_table_rows_created_by_idx
    ON memory_table_rows(memory_table_id, created_by_mutation_id)`,
  `CREATE VIRTUAL TABLE memory_table_rows_fts USING fts5(
    searchable_text, content = 'memory_table_rows', content_rowid = 'rowid', tokenize = 'unicode61'
  )`,
  `CREATE TRIGGER memory_table_rows_fts_insert AFTER INSERT ON memory_table_rows BEGIN
    INSERT INTO memory_table_rows_fts(rowid, searchable_text) VALUES (NEW.rowid, NEW.searchable_text); END`,
  `CREATE TRIGGER memory_table_rows_fts_delete AFTER DELETE ON memory_table_rows BEGIN
    INSERT INTO memory_table_rows_fts(memory_table_rows_fts, rowid, searchable_text)
      VALUES ('delete', OLD.rowid, OLD.searchable_text); END`,
  `CREATE TRIGGER memory_table_rows_fts_update AFTER UPDATE OF searchable_text ON memory_table_rows BEGIN
    INSERT INTO memory_table_rows_fts(memory_table_rows_fts, rowid, searchable_text)
      VALUES ('delete', OLD.rowid, OLD.searchable_text);
    INSERT INTO memory_table_rows_fts(rowid, searchable_text) VALUES (NEW.rowid, NEW.searchable_text); END`,
  `CREATE TABLE memory_table_cells (
    memory_table_row_id TEXT NOT NULL REFERENCES memory_table_rows(memory_table_row_id) ON DELETE CASCADE,
    memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
    memory_table_column_id TEXT NOT NULL REFERENCES memory_table_columns(memory_table_column_id) ON DELETE CASCADE,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'url', 'number', 'integer', 'boolean', 'datetime', 'date')),
    string_value TEXT,
    number_value REAL,
    boolean_value INTEGER CHECK (boolean_value IS NULL OR boolean_value IN (0, 1)),
    temporal_value TEXT,
    PRIMARY KEY (memory_table_row_id, memory_table_column_id),
    CHECK ((value_type IN ('string', 'url') AND string_value IS NOT NULL AND number_value IS NULL
      AND boolean_value IS NULL AND temporal_value IS NULL)
      OR (value_type IN ('number', 'integer') AND number_value IS NOT NULL AND string_value IS NULL
      AND boolean_value IS NULL AND temporal_value IS NULL)
      OR (value_type = 'boolean' AND boolean_value IS NOT NULL AND string_value IS NULL
      AND number_value IS NULL AND temporal_value IS NULL)
      OR (value_type IN ('datetime', 'date') AND temporal_value IS NOT NULL AND string_value IS NULL
      AND number_value IS NULL AND boolean_value IS NULL))
  ) STRICT`,
  `CREATE INDEX memory_table_cells_string_idx
    ON memory_table_cells(memory_table_id, memory_table_column_id, string_value COLLATE NOCASE, memory_table_row_id)`,
  `CREATE INDEX memory_table_cells_number_idx
    ON memory_table_cells(memory_table_id, memory_table_column_id, number_value, memory_table_row_id)`,
  `CREATE INDEX memory_table_cells_boolean_idx
    ON memory_table_cells(memory_table_id, memory_table_column_id, boolean_value, memory_table_row_id)`,
  `CREATE INDEX memory_table_cells_temporal_idx
    ON memory_table_cells(memory_table_id, memory_table_column_id, temporal_value, memory_table_row_id)`,
  `CREATE TABLE memory_table_mutations (
    memory_table_mutation_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL,
    memory_table_id TEXT NOT NULL REFERENCES memory_tables(memory_table_id) ON DELETE CASCADE,
    memory_scope_id TEXT NOT NULL REFERENCES memory_scopes(memory_scope_id) ON DELETE CASCADE,
    workspace_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('create', 'insert_rows', 'update_rows', 'invalidate_rows')),
    actor_principal_json TEXT NOT NULL CHECK (json_valid(actor_principal_json)),
    harness_run_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    rationale TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    mutation_json TEXT NOT NULL CHECK (json_valid(mutation_json)),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at TEXT NOT NULL,
    UNIQUE (harness_run_id, receipt_id)
  ) STRICT`,
  `CREATE INDEX memory_table_mutations_table_idx
    ON memory_table_mutations(memory_table_id, created_at DESC)`,

  `CREATE TABLE workstream_notification_intents (
    intent_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    recipient_user_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL,
    source_generation INTEGER NOT NULL CHECK (source_generation > 0),
    source_version INTEGER NOT NULL CHECK (source_version > 0),
    required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
    notification_kind TEXT NOT NULL CHECK (notification_kind = 'mention'),
    payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'delivered', 'skipped', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    lease_id TEXT,
    lease_expires_at TEXT,
    last_error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT,
    UNIQUE (source_message_id, recipient_user_id, notification_kind)
  ) STRICT`,
  `CREATE INDEX workstream_notification_intents_delivery_idx
    ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
  `CREATE INDEX workstream_notification_intents_terminal_idx
    ON workstream_notification_intents(workstream_id, state, created_at)`,
  `CREATE TABLE external_delivery_attempts (
    delivery_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('automation', 'digest', 'mention', 'note_privacy')),
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    destination_type TEXT NOT NULL CHECK (destination_type IN ('email', 'slack_agent_dm', 'workstream')),
    destination_snapshot_json TEXT NOT NULL CHECK (json_valid(destination_snapshot_json)),
    payload_ref TEXT,
    payload_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'delivered', 'failed', 'skipped')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    available_at TEXT NOT NULL,
    lease_id TEXT,
    lease_expires_at TEXT,
    provider_receipt_id TEXT,
    last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    delivered_at TEXT
  ) STRICT`,
  `CREATE INDEX external_delivery_attempts_due_idx
    ON external_delivery_attempts(state, available_at, lease_expires_at, delivery_id)`,
  // Inbound-email processing idempotency and its exclusive processing lease.
  // One received email may intentionally name more than one work stream, so the
  // work-stream identifier is part of the key. Keyed and shaped exactly like the
  // imported D1 rows; timestamps remain ISO strings for repository compatibility.
  `CREATE TABLE workstream_email_receipts (
    resend_email_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    svix_id TEXT NOT NULL,
    payload_ref TEXT,
    received_at TEXT NOT NULL,
    processed_at TEXT,
    error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
    lease_token TEXT,
    lease_expires_at TEXT,
    PRIMARY KEY (resend_email_id, workstream_id)
  ) STRICT`,
  `CREATE INDEX workstream_email_receipts_workstream_idx
    ON workstream_email_receipts(workstream_id, received_at DESC)`,
  `CREATE INDEX workstream_email_receipts_lease_idx
    ON workstream_email_receipts(lease_expires_at)
    WHERE processed_at IS NULL`,
  // Dictation socket admission: one-time ticket consumption plus the short
  // concurrency leases the per-user/per-workspace session caps are counted
  // over. Serialized here so two simultaneous upgrades cannot both pass the
  // cap check. Epochs are Unix SECONDS — the signed ticket's external JWT
  // contract — and the one place this object departs from its unix-ms rule,
  // so the column names carry the unit; the import maps the D1 names over.
  `CREATE TABLE realtime_transcription_ticket_receipts (
    ticket_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    consumed_at_s INTEGER NOT NULL,
    expires_at_s INTEGER NOT NULL CHECK (expires_at_s > consumed_at_s)
  ) STRICT`,
  `CREATE INDEX realtime_transcription_ticket_receipts_expiry_idx
    ON realtime_transcription_ticket_receipts(expires_at_s)`,
  `CREATE TABLE realtime_transcription_sessions (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    started_at_s INTEGER NOT NULL,
    expires_at_s INTEGER NOT NULL CHECK (expires_at_s > started_at_s)
  ) STRICT`,
  `CREATE INDEX realtime_transcription_sessions_user_idx
    ON realtime_transcription_sessions(workspace_id, user_id, expires_at_s)`,
  `CREATE INDEX realtime_transcription_sessions_workspace_idx
    ON realtime_transcription_sessions(workspace_id, expires_at_s)`,
  ...workspaceIdentityFences(),
] as const;
