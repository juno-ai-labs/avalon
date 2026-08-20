-- The verified maintenance scrub deletes a workspace's relational rows from D1
-- after WorkspaceDO has been imported and verified. D1 enforces foreign keys,
-- so deleting a workspace-owned parent (`activities`, `resources`, `notes`,
-- `connector_connections`) cascades into work-stream-owned children such as
-- `activity_suggestions` and `workstream_resources`. Those children carry the
-- 0079 fences, which were written before 0083 established that the scrub is a
-- legitimate deletion and so admit no phase beyond draining. The cascade
-- therefore aborted the scrub with `workspace_do_authoritative` and quarantined
-- the campaign at activation, after every route had already imported and
-- verified.
--
-- These triggers now admit `maintenance_verified`, matching the workspace
-- fences in 0083 exactly. Nothing else changes: inserts and updates stay
-- refused from the moment import begins, and deletes remain refused once the
-- region is open, so D1 still cannot become a second writable authority.


DROP TRIGGER activity_suggestions_reject_do_authority_delete;
CREATE TRIGGER activity_suggestions_reject_do_authority_delete
BEFORE DELETE ON activity_suggestions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER artifacts_reject_do_authority_delete;
CREATE TRIGGER artifacts_reject_do_authority_delete
BEFORE DELETE ON artifacts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER attachment_tool_receipts_reject_do_authority_delete;
CREATE TRIGGER attachment_tool_receipts_reject_do_authority_delete
BEFORE DELETE ON attachment_tool_receipts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER block_dashboard_block_runs_reject_do_authority_delete;
CREATE TRIGGER block_dashboard_block_runs_reject_do_authority_delete
BEFORE DELETE ON block_dashboard_block_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER block_dashboard_configuration_versions_reject_do_authority_delete;
CREATE TRIGGER block_dashboard_configuration_versions_reject_do_authority_delete
BEFORE DELETE ON block_dashboard_configuration_versions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER block_dashboard_user_preferences_reject_do_authority_delete;
CREATE TRIGGER block_dashboard_user_preferences_reject_do_authority_delete
BEFORE DELETE ON block_dashboard_user_preferences
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER elicitations_reject_do_authority_delete;
CREATE TRIGGER elicitations_reject_do_authority_delete
BEFORE DELETE ON elicitations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER harness_run_lifecycle_events_reject_do_authority_delete;
CREATE TRIGGER harness_run_lifecycle_events_reject_do_authority_delete
BEFORE DELETE ON harness_run_lifecycle_events
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER harness_run_memory_contexts_reject_do_authority_delete;
CREATE TRIGGER harness_run_memory_contexts_reject_do_authority_delete
BEFORE DELETE ON harness_run_memory_contexts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER harness_run_plugin_activations_reject_do_authority_delete;
CREATE TRIGGER harness_run_plugin_activations_reject_do_authority_delete
BEFORE DELETE ON harness_run_plugin_activations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER harness_run_scopes_reject_do_authority_delete;
CREATE TRIGGER harness_run_scopes_reject_do_authority_delete
BEFORE DELETE ON harness_run_scopes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER harness_runs_reject_do_authority_delete;
CREATE TRIGGER harness_runs_reject_do_authority_delete
BEFORE DELETE ON harness_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER inference_attempts_reject_do_authority_delete;
CREATE TRIGGER inference_attempts_reject_do_authority_delete
BEFORE DELETE ON inference_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER message_attachments_reject_do_authority_delete;
CREATE TRIGGER message_attachments_reject_do_authority_delete
BEFORE DELETE ON message_attachments
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER message_mentions_reject_do_authority_delete;
CREATE TRIGGER message_mentions_reject_do_authority_delete
BEFORE DELETE ON message_mentions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER messages_reject_do_authority_delete;
CREATE TRIGGER messages_reject_do_authority_delete
BEFORE DELETE ON messages
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER repository_publications_reject_do_authority_delete;
CREATE TRIGGER repository_publications_reject_do_authority_delete
BEFORE DELETE ON repository_publications
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER sandbox_imported_resources_reject_do_authority_delete;
CREATE TRIGGER sandbox_imported_resources_reject_do_authority_delete
BEFORE DELETE ON sandbox_imported_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER sandbox_tasks_reject_do_authority_delete;
CREATE TRIGGER sandbox_tasks_reject_do_authority_delete
BEFORE DELETE ON sandbox_tasks
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER terminal_publication_grants_reject_do_authority_delete;
CREATE TRIGGER terminal_publication_grants_reject_do_authority_delete
BEFORE DELETE ON terminal_publication_grants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER tool_invocation_checkpoints_reject_do_authority_delete;
CREATE TRIGGER tool_invocation_checkpoints_reject_do_authority_delete
BEFORE DELETE ON tool_invocation_checkpoints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER tool_invocations_reject_do_authority_delete;
CREATE TRIGGER tool_invocations_reject_do_authority_delete
BEFORE DELETE ON tool_invocations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_context_compactions_reject_do_authority_delete;
CREATE TRIGGER workstream_context_compactions_reject_do_authority_delete
BEFORE DELETE ON workstream_context_compactions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_description_refreshes_reject_do_authority_delete;
CREATE TRIGGER workstream_description_refreshes_reject_do_authority_delete
BEFORE DELETE ON workstream_description_refreshes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_participants_reject_do_authority_delete;
CREATE TRIGGER workstream_participants_reject_do_authority_delete
BEFORE DELETE ON workstream_participants
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_pins_reject_do_authority_delete;
CREATE TRIGGER workstream_pins_reject_do_authority_delete
BEFORE DELETE ON workstream_pins
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_plugin_activation_hints_reject_do_authority_delete;
CREATE TRIGGER workstream_plugin_activation_hints_reject_do_authority_delete
BEFORE DELETE ON workstream_plugin_activation_hints
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_read_states_reject_do_authority_delete;
CREATE TRIGGER workstream_read_states_reject_do_authority_delete
BEFORE DELETE ON workstream_read_states
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_resource_inventory_revisions_reject_do_authority_delete;
CREATE TRIGGER workstream_resource_inventory_revisions_reject_do_authority_delete
BEFORE DELETE ON workstream_resource_inventory_revisions
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_resources_reject_do_authority_delete;
CREATE TRIGGER workstream_resources_reject_do_authority_delete
BEFORE DELETE ON workstream_resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_sandboxes_reject_do_authority_delete;
CREATE TRIGGER workstream_sandboxes_reject_do_authority_delete
BEFORE DELETE ON workstream_sandboxes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_terminal_repositories_reject_do_authority_delete;
CREATE TRIGGER workstream_terminal_repositories_reject_do_authority_delete
BEFORE DELETE ON workstream_terminal_repositories
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstream_wakeups_reject_do_authority_delete;
CREATE TRIGGER workstream_wakeups_reject_do_authority_delete
BEFORE DELETE ON workstream_wakeups
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;

DROP TRIGGER workstreams_reject_post_cutover_delete;
CREATE TRIGGER workstreams_reject_post_cutover_delete
BEFORE DELETE ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1)
  NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workspace_do_authoritative');
END;
