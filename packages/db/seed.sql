-- Development-only seed. Production startup never executes this file.
INSERT OR IGNORE INTO users
  (id, google_subject, email, name, avatar_url, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000001', 'dev-adam', 'adam@avalon.local', 'Adam', NULL, '2026-07-31T18:00:00.000Z', '2026-07-31T18:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000003', 'dev-samantha', 'samantha@avalon.local', 'Samantha Lee', NULL, '2026-07-31T18:00:00.000Z', '2026-07-31T18:00:00.000Z');

INSERT OR IGNORE INTO workspaces
  (id, name, slug, region, created_by_user_id, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000002', 'Avalon Studio', 'avalon-studio', 'global', '00000000-0000-7000-8000-000000000001', '2026-07-31T18:00:00.000Z', '2026-07-31T18:00:00.000Z');

INSERT OR IGNORE INTO workspace_members
  (workspace_id, user_id, role, status, joined_at)
VALUES
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'owner', 'active', '2026-07-31T18:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003', 'member', 'active', '2026-07-31T18:00:00.000Z');

INSERT OR IGNORE INTO connector_connections
  (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
   display_name, granted_scopes_json, status, cursor_json, config_json,
   created_at, updated_at, model_plugin_id)
VALUES
  ('00000000-0000-7000-8000-000000000061', '00000000-0000-7000-8000-000000000002',
   'generic_webhook', 'workspace', NULL, 'seed-incident-webhook', 'Incident updates fixture',
   '[]', 'healthy', '{}', '{"eventTypes":["incident.updated"]}',
   '2026-07-31T18:01:00.000Z', '2026-07-31T18:01:00.000Z', 'plugin_webhook');

INSERT OR IGNORE INTO automation_templates
  (id, workspace_id, owner_user_id, name, description, sharing_state, latest_version_number, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000010', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'Weekly changelog', 'Prepare a concise changelog from completed work every Friday.', 'workspace', 1, '2026-07-31T18:02:00.000Z', '2026-07-31T18:02:00.000Z'),
  ('00000000-0000-7000-8000-000000000014', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'Former-client monitor', 'Watch a public page for meaningful changes.', 'private', 1, '2026-07-31T18:03:00.000Z', '2026-07-31T18:03:00.000Z');

INSERT OR IGNORE INTO automation_template_versions
  (id, template_id, version_number, instructions, trigger_definitions_json, required_capabilities_json, expected_outputs_json, default_behavior_json, created_by_user_id, created_at)
VALUES
  ('00000000-0000-7000-8000-000000000011', '00000000-0000-7000-8000-000000000010', 1, 'Review work completed this week and prepare a readable changelog.', '[{"type":"calendar","rrule":"FREQ=WEEKLY;BYDAY=FR","timezone":"America/Los_Angeles","summary":"Every Friday at 2:00 PM"}]', '[]', '["changelog"]', '{}', '00000000-0000-7000-8000-000000000001', '2026-07-31T18:02:00.000Z'),
  ('00000000-0000-7000-8000-000000000015', '00000000-0000-7000-8000-000000000014', 1, 'Fetch the configured page and report only meaningful changes.', '[{"type":"interval","intervalSeconds":86400,"summary":"Every 24 hours"}]', '["web.read"]', '["change summary"]', '{}', '00000000-0000-7000-8000-000000000001', '2026-07-31T18:03:00.000Z');

INSERT OR IGNORE INTO automation_subscriptions
  (id, workspace_id, template_id, template_version_id, scope, owner_user_id, execution_principal_json, connector_bindings_json, overrides_json, status, last_run_at, next_run_at, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000012', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000010', '00000000-0000-7000-8000-000000000011', 'workspace', NULL, '{"type":"workspace","workspaceId":"00000000-0000-7000-8000-000000000002"}', '{}', '{}', 'active', NULL, '2026-08-07T21:00:00.000Z', '2026-07-31T18:02:00.000Z', '2026-07-31T18:02:00.000Z'),
  ('00000000-0000-7000-8000-000000000016', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000014', '00000000-0000-7000-8000-000000000015', 'personal', '00000000-0000-7000-8000-000000000001', '{"type":"user","userId":"00000000-0000-7000-8000-000000000001"}', '{}', '{}', 'paused', NULL, NULL, '2026-07-31T18:03:00.000Z', '2026-07-31T18:03:00.000Z');

INSERT OR IGNORE INTO schedules
  (id, workspace_id, automation_subscription_id, schedule_type, rrule, timezone, next_run_at, enabled, version, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000013', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000012', 'calendar', 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0', 'America/Los_Angeles', '2026-08-07T21:00:00.000Z', 1, 1, '2026-07-31T18:02:00.000Z', '2026-07-31T18:02:00.000Z');

INSERT OR IGNORE INTO workstreams
  (id, workspace_id, title, objective, description_source, origin_type, created_by_user_id, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000020', '00000000-0000-7000-8000-000000000002', 'Prepare the Acme client follow-up', 'Turn the client call into a clear follow-up with owners and next steps.', 'authored', 'ad_hoc', '00000000-0000-7000-8000-000000000001', 'needs_input', 4, '2026-07-31T19:45:00.000Z', '2026-07-31T19:30:00.000Z', '2026-07-31T19:45:00.000Z'),
  ('00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000002', 'Investigate ENG-142', 'Find the cause of intermittent invoice retry failures.', 'authored', 'ad_hoc', '00000000-0000-7000-8000-000000000001', 'running', 3, '2026-07-31T19:40:00.000Z', '2026-07-31T19:20:00.000Z', '2026-07-31T19:40:00.000Z');

INSERT OR IGNORE INTO workstream_participants
  (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
VALUES
  ('00000000-0000-7000-8000-000000000020', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', 'creator', '2026-07-31T19:30:00.000Z'),
  ('00000000-0000-7000-8000-000000000020', '00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000001', 'explicit', '2026-07-31T19:30:00.000Z'),
  ('00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000001', 'creator', '2026-07-31T19:20:00.000Z');

INSERT OR IGNORE INTO resources
  (id, workspace_id, connection_id, resource_type, provider, provider_resource_id, title,
   mime_type, canonical_url, metadata_json, last_hydrated_at, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000041', '00000000-0000-7000-8000-000000000002', NULL, 'text', 'fixture', 'eng-142-status', 'ENG-142 incident status',
   'text/plain', NULL, '{}', '2026-07-31T19:39:00.000Z', '2026-07-31T19:15:00.000Z', '2026-07-31T19:39:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  canonical_url = excluded.canonical_url,
  updated_at = excluded.updated_at;

INSERT OR IGNORE INTO workstream_resources
  (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
VALUES
  ('00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000041', '00000000-0000-7000-8000-000000000001', 0, 'reference', '2026-07-31T19:20:00.000Z');

INSERT OR IGNORE INTO harness_runs
  (id, workspace_id, workstream_id, origin, execution_principal_json, status, started_at, model, usage_json, created_at)
VALUES
  ('00000000-0000-7000-8000-000000000051', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', 'message',
   '{"type":"user","userId":"00000000-0000-7000-8000-000000000001"}', 'running', '2026-07-31T19:34:58.000Z', 'seed-model', '{}', '2026-07-31T19:34:58.000Z');

INSERT OR IGNORE INTO tool_invocations
  (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name, connection_id,
   input_hash, input_json, output_summary, status, started_at, completed_at)
VALUES
  ('00000000-0000-7000-8000-000000000052', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000051', 'seed-tool-1', 'Search invoice error events', NULL,
   'seed-search-invoice-errors', '{"query":"invoice retry failures"}', 'Found 18 related events across three deploys.', 'completed', '2026-07-31T19:35:00.000Z', '2026-07-31T19:35:42.000Z'),
  ('00000000-0000-7000-8000-000000000053', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000051', 'seed-tool-2', 'Inspect retry policy', NULL,
   'seed-inspect-retry-policy', '{"ticket":"ENG-142"}', 'The third retry overlaps the downstream timeout window.', 'completed', '2026-07-31T19:36:00.000Z', '2026-07-31T19:37:18.000Z'),
  ('00000000-0000-7000-8000-000000000054', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000051', 'seed-tool-3', 'Reproduce invoice failure', NULL,
   'seed-reproduce-invoice-failure', '{"fixture":"safe"}', NULL, 'started', '2026-07-31T19:38:00.000Z', NULL);

INSERT OR IGNORE INTO messages
  (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id, message_type, text_content, sequence_number, created_at)
VALUES
  ('00000000-0000-7000-8000-000000000030', 'seed-acme-1', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000020', 'human', '00000000-0000-7000-8000-000000000001', 'text', 'Prepare the follow-up from today’s Acme call. Capture every promised action and flag anything that still needs an owner.', 1, '2026-07-31T19:30:00.000Z'),
  ('00000000-0000-7000-8000-000000000031', NULL, '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000020', 'agent', NULL, 'text', 'I found three follow-ups. Two have clear owners; the rollout date still needs a decision.', 2, '2026-07-31T19:42:00.000Z'),
  ('00000000-0000-7000-8000-000000000032', 'seed-eng-1', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', 'human', '00000000-0000-7000-8000-000000000001', 'text', 'Investigate ENG-142 and summarize the evidence before proposing a fix.', 1, '2026-07-31T19:20:00.000Z'),
  ('00000000-0000-7000-8000-000000000033', NULL, '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', 'system', NULL, 'system', 'Reviewing the latest failure events and attached ticket context.', 2, '2026-07-31T19:40:00.000Z');

INSERT OR IGNORE INTO messages
  (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id, message_type,
   text_content, structured_content_json, sequence_number, created_at)
VALUES
  ('00000000-0000-7000-8000-000000000042', NULL, '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', 'agent', NULL, 'tool', '',
   '{"invocation":{"id":"00000000-0000-7000-8000-000000000052","harnessRunId":"00000000-0000-7000-8000-000000000051","toolCallId":"seed-tool-1","toolName":"Search invoice error events","connectionId":null,"status":"completed","inputSummary":"Search recent invoice retry failures","outputSummary":"Found 18 related events across three deploys.","startedAt":"2026-07-31T19:35:00.000Z","completedAt":"2026-07-31T19:35:42.000Z","error":null}}', 3, '2026-07-31T19:35:42.000Z'),
  ('00000000-0000-7000-8000-000000000043', NULL, '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', 'agent', NULL, 'tool', '',
   '{"invocation":{"id":"00000000-0000-7000-8000-000000000053","harnessRunId":"00000000-0000-7000-8000-000000000051","toolCallId":"seed-tool-2","toolName":"Inspect retry policy","connectionId":null,"status":"completed","inputSummary":"Compare retry settings with failure timestamps","outputSummary":"The third retry overlaps the downstream timeout window.","startedAt":"2026-07-31T19:36:00.000Z","completedAt":"2026-07-31T19:37:18.000Z","error":null}}', 4, '2026-07-31T19:37:18.000Z'),
  ('00000000-0000-7000-8000-000000000044', NULL, '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000021', 'agent', NULL, 'tool', '',
   '{"invocation":{"id":"00000000-0000-7000-8000-000000000054","harnessRunId":"00000000-0000-7000-8000-000000000051","toolCallId":"seed-tool-3","toolName":"Reproduce invoice failure","connectionId":null,"status":"started","inputSummary":"Run the bounded reproduction against a safe fixture","outputSummary":null,"startedAt":"2026-07-31T19:38:00.000Z","completedAt":null,"error":null}}', 5, '2026-07-31T19:38:00.000Z');

UPDATE workstreams
SET next_sequence_number = MAX(next_sequence_number, 6)
WHERE id = '00000000-0000-7000-8000-000000000021';
