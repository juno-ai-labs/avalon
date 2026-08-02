-- Migration 0009 widened connector_connections by renaming the original table.
-- D1 correctly propagated that rename into foreign-key declarations on child
-- tables, so those declarations retained the retired table name after the old
-- table was dropped. Rebuild the affected tables and their two dependency
-- branches without renaming a referenced table or losing existing rows.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE _repair_activities AS SELECT * FROM activities;
CREATE TABLE _repair_resources AS SELECT * FROM resources;
CREATE TABLE _repair_automation_runs AS SELECT * FROM automation_runs;
CREATE TABLE _repair_activity_suggestions AS SELECT * FROM activity_suggestions;
CREATE TABLE _repair_workstream_resources AS SELECT * FROM workstream_resources;
CREATE TABLE _repair_resource_watches AS SELECT * FROM resource_watches;
CREATE TABLE _repair_tool_invocations AS SELECT * FROM tool_invocations;
CREATE TABLE _repair_schedules AS SELECT * FROM schedules;
CREATE TABLE _repair_webhook_receipts AS SELECT * FROM webhook_receipts;
CREATE TABLE _repair_web_monitor_snapshots AS SELECT * FROM web_monitor_snapshots;

-- Remove referencing tables before their parents so ON DELETE actions cannot
-- erase rows that are waiting in the repair copies.
DROP TABLE activity_suggestions;
DROP TABLE automation_runs;
DROP TABLE resource_watches;
DROP TABLE workstream_resources;
DROP TABLE tool_invocations;
DROP TABLE schedules;
DROP TABLE webhook_receipts;
DROP TABLE web_monitor_snapshots;
DROP TABLE activities;
DROP TABLE resources;

CREATE TABLE activities (
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

CREATE TABLE resources (
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

CREATE TABLE automation_runs (
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
  created_at TEXT NOT NULL,
  idempotency_key TEXT
);

CREATE TABLE activity_suggestions (
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

CREATE TABLE workstream_resources (
  workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  attached_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  watch_enabled INTEGER NOT NULL DEFAULT 0 CHECK (watch_enabled IN (0, 1)),
  relationship_type TEXT NOT NULL DEFAULT 'attachment',
  attached_at TEXT NOT NULL,
  PRIMARY KEY (workstream_id, resource_id)
);

CREATE TABLE resource_watches (
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

CREATE TABLE tool_invocations (
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

CREATE TABLE schedules (
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

CREATE TABLE webhook_receipts (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
  signature_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  UNIQUE (connection_id, signature_hash)
);

CREATE TABLE web_monitor_snapshots (
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

INSERT INTO activities SELECT * FROM _repair_activities;
INSERT INTO resources SELECT * FROM _repair_resources;
INSERT INTO automation_runs SELECT * FROM _repair_automation_runs;
INSERT INTO activity_suggestions SELECT * FROM _repair_activity_suggestions;
INSERT INTO workstream_resources SELECT * FROM _repair_workstream_resources;
INSERT INTO resource_watches SELECT * FROM _repair_resource_watches;
INSERT INTO tool_invocations SELECT * FROM _repair_tool_invocations;
INSERT INTO schedules SELECT * FROM _repair_schedules;
INSERT INTO webhook_receipts SELECT * FROM _repair_webhook_receipts;
INSERT INTO web_monitor_snapshots SELECT * FROM _repair_web_monitor_snapshots;

DROP TABLE _repair_activities;
DROP TABLE _repair_resources;
DROP TABLE _repair_automation_runs;
DROP TABLE _repair_activity_suggestions;
DROP TABLE _repair_workstream_resources;
DROP TABLE _repair_resource_watches;
DROP TABLE _repair_tool_invocations;
DROP TABLE _repair_schedules;
DROP TABLE _repair_webhook_receipts;
DROP TABLE _repair_web_monitor_snapshots;

CREATE INDEX activities_status_idx ON activities(workspace_id, processing_status, received_at);
CREATE INDEX activities_resource_idx ON activities(workspace_id, provider, provider_resource_id);
CREATE INDEX resources_workspace_idx ON resources(workspace_id, updated_at);
CREATE UNIQUE INDEX resources_connection_provider_identity_idx
  ON resources(workspace_id, connection_id, provider, provider_resource_id)
  WHERE connection_id IS NOT NULL AND provider_resource_id IS NOT NULL;
CREATE UNIQUE INDEX resources_unconnected_provider_identity_idx
  ON resources(workspace_id, provider, provider_resource_id)
  WHERE connection_id IS NULL AND provider_resource_id IS NOT NULL;
CREATE UNIQUE INDEX automation_runs_planned_unique_idx
  ON automation_runs(automation_subscription_id, planned_for)
  WHERE planned_for IS NOT NULL;
CREATE INDEX automation_runs_subscription_idx
  ON automation_runs(automation_subscription_id, created_at DESC);
CREATE UNIQUE INDEX automation_runs_activity_unique_idx
  ON automation_runs(automation_subscription_id, trigger_activity_id)
  WHERE trigger_activity_id IS NOT NULL;
CREATE UNIQUE INDEX automation_runs_manual_idempotency_unique_idx
  ON automation_runs(workspace_id, automation_subscription_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX tool_invocations_run_idx ON tool_invocations(harness_run_id, started_at);
CREATE INDEX tool_invocations_workstream_idx
  ON tool_invocations(workspace_id, workstream_id, started_at DESC);
CREATE INDEX schedules_due_idx ON schedules(workspace_id, enabled, next_run_at);
CREATE INDEX resource_watches_due_idx ON resource_watches(workspace_id, enabled, next_poll_at);

PRAGMA defer_foreign_keys = OFF;
