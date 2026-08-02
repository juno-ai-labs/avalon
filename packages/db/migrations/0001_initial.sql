PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  google_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  joined_at TEXT,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  refresh_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  provider TEXT NOT NULL,
  purpose TEXT NOT NULL,
  code_verifier_encrypted TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  return_uri TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS desktop_login_tickets (
  id TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  invited_by_user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS connector_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('google', 'generic_webhook', 'web_monitor', 'github', 'linear', 'notion')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider_account_id TEXT,
  display_name TEXT NOT NULL,
  encrypted_credentials TEXT,
  credential_iv TEXT,
  credential_key_version INTEGER,
  granted_scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  config_json TEXT NOT NULL DEFAULT '{}',
  last_sync_at TEXT,
  next_poll_at TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  connection_scope TEXT NOT NULL CHECK (connection_scope IN ('personal', 'workspace')),
  connection_owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  resource_type TEXT,
  provider_resource_id TEXT,
  actor_json TEXT NOT NULL DEFAULT '{}',
  subject_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  text_snippet TEXT NOT NULL DEFAULT '',
  payload_ref TEXT,
  visibility_json TEXT NOT NULL DEFAULT '{}',
  entity_keys_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT NOT NULL,
  raw_content_hash TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed')),
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (connection_id, provider_event_id, event_type),
  UNIQUE (connection_id, dedupe_key)
);

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
  resource_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_resource_id TEXT,
  title TEXT NOT NULL,
  mime_type TEXT,
  content_ref TEXT,
  canonical_url TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_hydrated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS resources_provider_identity_idx
  ON resources(workspace_id, provider, provider_resource_id)
  WHERE provider_resource_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS automation_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  sharing_state TEXT NOT NULL CHECK (sharing_state IN ('private', 'workspace')),
  latest_version_number INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_template_versions (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES automation_templates(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  trigger_definitions_json TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  expected_outputs_json TEXT NOT NULL DEFAULT '[]',
  default_behavior_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  UNIQUE (template_id, version_number)
);

CREATE TABLE IF NOT EXISTS automation_subscriptions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES automation_templates(id),
  template_version_id TEXT NOT NULL REFERENCES automation_template_versions(id),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  execution_principal_json TEXT NOT NULL,
  connector_bindings_json TEXT NOT NULL DEFAULT '{}',
  overrides_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'paused', 'error')),
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
);

CREATE TABLE IF NOT EXISTS workstreams (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  origin_type TEXT NOT NULL CHECK (origin_type IN ('ad_hoc', 'automation')),
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  automation_subscription_id TEXT REFERENCES automation_subscriptions(id) ON DELETE SET NULL,
  automation_run_id TEXT,
  planned_for TEXT,
  harness_status TEXT NOT NULL DEFAULT 'idle' CHECK (harness_status IN ('scheduled', 'running', 'needs_input', 'completed', 'failed', 'idle')),
  next_sequence_number INTEGER NOT NULL DEFAULT 1,
  last_activity_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_subscription_id TEXT NOT NULL REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL UNIQUE REFERENCES workstreams(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL,
  trigger_activity_id TEXT REFERENCES activities(id) ON DELETE SET NULL,
  planned_for TEXT,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'needs_input', 'completed', 'failed')),
  result_summary TEXT,
  workflow_instance_id TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_planned_unique_idx
  ON automation_runs(automation_subscription_id, planned_for)
  WHERE planned_for IS NOT NULL;

CREATE TABLE IF NOT EXISTS workstream_participants (
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  participation_reason TEXT NOT NULL CHECK (participation_reason IN ('creator', 'explicit', 'message', 'elicitation', 'action')),
  joined_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (workstream_id, user_id)
);

CREATE TABLE IF NOT EXISTS workstream_resources (
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  attached_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  watch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (watch_enabled IN (0, 1)),
  relationship_type TEXT NOT NULL DEFAULT 'attachment',
  attached_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, resource_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  client_message_id TEXT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL CHECK (author_type IN ('human', 'agent', 'system')),
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'system', 'tool', 'artifact', 'elicitation', 'suggestion')),
  text_content TEXT NOT NULL DEFAULT '',
  structured_content_json TEXT,
  sequence_number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  UNIQUE (workstream_id, sequence_number),
  UNIQUE (workstream_id, client_message_id)
);

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mention_type TEXT NOT NULL CHECK (mention_type IN ('person', 'connector')),
  mentioned_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  connector_type TEXT,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  PRIMARY KEY (message_id, start_offset, end_offset)
);

CREATE TABLE IF NOT EXISTS harness_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  execution_principal_json TEXT NOT NULL,
  workflow_instance_id TEXT,
  parent_harness_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'needs_input', 'completed', 'failed', 'stopped')),
  started_at TEXT,
  completed_at TEXT,
  model TEXT,
  usage_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL,
  output_ref TEXT,
  output_summary TEXT,
  provider_operation_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'started', 'completed', 'failed', 'ambiguous')),
  started_at TEXT,
  completed_at TEXT,
  error_json TEXT,
  UNIQUE (harness_run_id, tool_call_id)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  harness_run_id TEXT REFERENCES harness_runs(id) ON DELETE SET NULL,
  artifact_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_ref TEXT,
  preview_text TEXT,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS elicitations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  harness_run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  response_type TEXT NOT NULL CHECK (response_type IN ('text', 'radio', 'single_select', 'multi_select')),
  options_json TEXT NOT NULL DEFAULT '[]',
  minimum_selections INTEGER NOT NULL DEFAULT 0,
  maximum_selections INTEGER,
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'cancelled')),
  answer_json TEXT,
  answered_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS activity_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason TEXT NOT NULL,
  matched_entities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'dismissed')),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (activity_id, workstream_id)
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_subscription_id TEXT REFERENCES automation_subscriptions(id) ON DELETE CASCADE,
  connector_connection_id TEXT REFERENCES connector_connections(id) ON DELETE CASCADE,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('calendar', 'interval')),
  rrule TEXT,
  interval_seconds INTEGER,
  timezone TEXT NOT NULL,
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (automation_subscription_id IS NOT NULL OR connector_connection_id IS NOT NULL),
  CHECK ((schedule_type = 'calendar' AND rrule IS NOT NULL) OR (schedule_type = 'interval' AND interval_seconds IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS resource_watches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  watch_type TEXT NOT NULL,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  next_poll_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workstream_id, resource_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'workspace', 'system', 'connector')),
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  workstream_id TEXT REFERENCES workstreams(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  signature_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (connection_id, signature_hash)
);

CREATE TABLE IF NOT EXISTS web_monitor_snapshots (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  content_ref TEXT,
  fetched_at TEXT NOT NULL,
  changed_at TEXT,
  UNIQUE (connection_id, content_hash)
);

CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id, status);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS oauth_states_expiry_idx ON oauth_states(expires_at, consumed_at);
CREATE INDEX IF NOT EXISTS connector_connections_poll_idx ON connector_connections(workspace_id, next_poll_at, status);
CREATE INDEX IF NOT EXISTS activities_status_idx ON activities(workspace_id, processing_status, received_at);
CREATE INDEX IF NOT EXISTS activities_resource_idx ON activities(workspace_id, provider, provider_resource_id);
CREATE INDEX IF NOT EXISTS resources_workspace_idx ON resources(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS workstreams_sidebar_idx ON workstreams(workspace_id, harness_status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS messages_page_idx ON messages(workstream_id, sequence_number DESC);
CREATE INDEX IF NOT EXISTS participants_active_idx ON workstream_participants(workstream_id, removed_at);
CREATE INDEX IF NOT EXISTS automation_subscriptions_next_idx ON automation_subscriptions(workspace_id, status, next_run_at);
CREATE INDEX IF NOT EXISTS automation_runs_subscription_idx ON automation_runs(automation_subscription_id, created_at DESC);
CREATE INDEX IF NOT EXISTS harness_runs_workstream_idx ON harness_runs(workstream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_invocations_run_idx ON tool_invocations(harness_run_id, started_at);
CREATE INDEX IF NOT EXISTS tool_invocations_workstream_idx ON tool_invocations(workspace_id, workstream_id, started_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_workstream_idx ON artifacts(workspace_id, workstream_id, created_at DESC);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules(workspace_id, enabled, next_run_at);
CREATE INDEX IF NOT EXISTS resource_watches_due_idx ON resource_watches(workspace_id, enabled, next_poll_at);
CREATE INDEX IF NOT EXISTS audit_events_workspace_idx ON audit_events(workspace_id, created_at DESC);
