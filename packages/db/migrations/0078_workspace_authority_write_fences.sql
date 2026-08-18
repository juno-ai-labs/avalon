-- Workspace-wide D1 source closure fence.
--
-- A cutover closes the workspace_authority_gates row first. Every canonical
-- workspace-owned table, including callback/job/run children, then rejects
-- inserts, updates, and deletes in SQLite itself. The three migration-control
-- tables are intentionally excluded because they must record export,
-- comparison, closure, and destination receipts while the source is closed.
--
-- Direct tables use their workspace_id. Tables whose ownership is inherited
-- through a parent resolve that parent in the trigger. New workspace inserts
-- are the sole exception: 0077 creates their writable gate in an AFTER INSERT
-- trigger; subsequent workspace updates/deletes are fenced below.

-- A gate may disappear only as the foreign-key cascade of an already-fenced
-- workspace deletion. This keeps inherited child fences fail-closed while
-- still allowing their DELETE triggers to recognize a parent cascade: by the
-- time SQLite deletes those children, their parent row is no longer visible.
CREATE TRIGGER workspace_authority_gate_delete_requires_workspace_delete
BEFORE DELETE ON workspace_authority_gates
WHEN EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)
BEGIN SELECT RAISE(ABORT, 'workspace_authority_gate_delete_forbidden'); END;

CREATE TRIGGER authority_fence_activities_insert
BEFORE INSERT ON activities
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activities_update
BEFORE UPDATE ON activities
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activities_delete
BEFORE DELETE ON activities
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_event_targets_insert
BEFORE INSERT ON activity_event_targets
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_event_targets_update
BEFORE UPDATE ON activity_event_targets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_event_targets_delete
BEFORE DELETE ON activity_event_targets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_events_insert
BEFORE INSERT ON activity_events
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_events_update
BEFORE UPDATE ON activity_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_events_delete
BEFORE DELETE ON activity_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_suggestions_insert
BEFORE INSERT ON activity_suggestions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_suggestions_update
BEFORE UPDATE ON activity_suggestions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_activity_suggestions_delete
BEFORE DELETE ON activity_suggestions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_agent_inference_payload_logs_insert
BEFORE INSERT ON agent_inference_payload_logs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_agent_inference_payload_logs_update
BEFORE UPDATE ON agent_inference_payload_logs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_agent_inference_payload_logs_delete
BEFORE DELETE ON agent_inference_payload_logs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_artifacts_insert
BEFORE INSERT ON artifacts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_artifacts_update
BEFORE UPDATE ON artifacts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_artifacts_delete
BEFORE DELETE ON artifacts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_attachment_tool_receipts_insert
BEFORE INSERT ON attachment_tool_receipts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_attachment_tool_receipts_update
BEFORE UPDATE ON attachment_tool_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_attachment_tool_receipts_delete
BEFORE DELETE ON attachment_tool_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_audit_events_insert
BEFORE INSERT ON audit_events
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_audit_events_update
BEFORE UPDATE ON audit_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_audit_events_delete
BEFORE DELETE ON audit_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_delivery_targets_insert
BEFORE INSERT ON automation_delivery_targets
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_delivery_targets_update
BEFORE UPDATE ON automation_delivery_targets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_delivery_targets_delete
BEFORE DELETE ON automation_delivery_targets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_email_rate_windows_insert
BEFORE INSERT ON automation_email_rate_windows
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_email_rate_windows_update
BEFORE UPDATE ON automation_email_rate_windows
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_email_rate_windows_delete
BEFORE DELETE ON automation_email_rate_windows
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_email_receipts_insert
BEFORE INSERT ON automation_email_receipts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_email_receipts_update
BEFORE UPDATE ON automation_email_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_email_receipts_delete
BEFORE DELETE ON automation_email_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_runs_insert
BEFORE INSERT ON automation_runs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_runs_update
BEFORE UPDATE ON automation_runs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_runs_delete
BEFORE DELETE ON automation_runs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_subscriptions_insert
BEFORE INSERT ON automation_subscriptions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_subscriptions_update
BEFORE UPDATE ON automation_subscriptions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_subscriptions_delete
BEFORE DELETE ON automation_subscriptions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_templates_insert
BEFORE INSERT ON automation_templates
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_templates_update
BEFORE UPDATE ON automation_templates
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_templates_delete
BEFORE DELETE ON automation_templates
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_connector_connections_insert
BEFORE INSERT ON connector_connections
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_connector_connections_update
BEFORE UPDATE ON connector_connections
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_connector_connections_delete
BEFORE DELETE ON connector_connections
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_connector_oauth_attempts_insert
BEFORE INSERT ON connector_oauth_attempts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_connector_oauth_attempts_update
BEFORE UPDATE ON connector_oauth_attempts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_connector_oauth_attempts_delete
BEFORE DELETE ON connector_oauth_attempts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_desktop_login_tickets_insert
BEFORE INSERT ON desktop_login_tickets
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_desktop_login_tickets_update
BEFORE UPDATE ON desktop_login_tickets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_desktop_login_tickets_delete
BEFORE DELETE ON desktop_login_tickets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_deliveries_insert
BEFORE INSERT ON digest_deliveries
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_deliveries_update
BEFORE UPDATE ON digest_deliveries
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_deliveries_delete
BEFORE DELETE ON digest_deliveries
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_delivery_targets_insert
BEFORE INSERT ON digest_delivery_targets
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_delivery_targets_update
BEFORE UPDATE ON digest_delivery_targets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_delivery_targets_delete
BEFORE DELETE ON digest_delivery_targets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_schedules_insert
BEFORE INSERT ON digest_schedules
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_schedules_update
BEFORE UPDATE ON digest_schedules
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_schedules_delete
BEFORE DELETE ON digest_schedules
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_elicitations_insert
BEFORE INSERT ON elicitations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_elicitations_update
BEFORE UPDATE ON elicitations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_elicitations_delete
BEFORE DELETE ON elicitations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_external_user_identities_insert
BEFORE INSERT ON external_user_identities
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_external_user_identities_update
BEFORE UPDATE ON external_user_identities
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_external_user_identities_delete
BEFORE DELETE ON external_user_identities
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_github_installation_routes_insert
BEFORE INSERT ON github_installation_routes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_github_installation_routes_update
BEFORE UPDATE ON github_installation_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_github_installation_routes_delete
BEFORE DELETE ON github_installation_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_lifecycle_events_insert
BEFORE INSERT ON harness_run_lifecycle_events
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_lifecycle_events_update
BEFORE UPDATE ON harness_run_lifecycle_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_lifecycle_events_delete
BEFORE DELETE ON harness_run_lifecycle_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_memory_contexts_insert
BEFORE INSERT ON harness_run_memory_contexts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_memory_contexts_update
BEFORE UPDATE ON harness_run_memory_contexts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_memory_contexts_delete
BEFORE DELETE ON harness_run_memory_contexts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_scopes_insert
BEFORE INSERT ON harness_run_scopes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_scopes_update
BEFORE UPDATE ON harness_run_scopes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_scopes_delete
BEFORE DELETE ON harness_run_scopes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_runs_insert
BEFORE INSERT ON harness_runs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_runs_update
BEFORE UPDATE ON harness_runs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_runs_delete
BEFORE DELETE ON harness_runs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_block_runs_insert
BEFORE INSERT ON hypersight_block_runs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_block_runs_update
BEFORE UPDATE ON hypersight_block_runs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_block_runs_delete
BEFORE DELETE ON hypersight_block_runs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_configuration_versions_insert
BEFORE INSERT ON hypersight_configuration_versions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_configuration_versions_update
BEFORE UPDATE ON hypersight_configuration_versions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_configuration_versions_delete
BEFORE DELETE ON hypersight_configuration_versions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_user_preferences_insert
BEFORE INSERT ON hypersight_user_preferences
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_user_preferences_update
BEFORE UPDATE ON hypersight_user_preferences
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_hypersight_user_preferences_delete
BEFORE DELETE ON hypersight_user_preferences
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_inference_attempts_insert
BEFORE INSERT ON inference_attempts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_inference_attempts_update
BEFORE UPDATE ON inference_attempts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_inference_attempts_delete
BEFORE DELETE ON inference_attempts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_linear_organization_routes_insert
BEFORE INSERT ON linear_organization_routes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_linear_organization_routes_update
BEFORE UPDATE ON linear_organization_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_linear_organization_routes_delete
BEFORE DELETE ON linear_organization_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_index_outbox_insert
BEFORE INSERT ON memory_index_outbox
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_index_outbox_update
BEFORE UPDATE ON memory_index_outbox
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_index_outbox_delete
BEFORE DELETE ON memory_index_outbox
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_items_insert
BEFORE INSERT ON memory_items
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_items_update
BEFORE UPDATE ON memory_items
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_items_delete
BEFORE DELETE ON memory_items
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_mutations_insert
BEFORE INSERT ON memory_mutations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_mutations_update
BEFORE UPDATE ON memory_mutations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_mutations_delete
BEFORE DELETE ON memory_mutations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_scopes_insert
BEFORE INSERT ON memory_scopes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_scopes_update
BEFORE UPDATE ON memory_scopes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_scopes_delete
BEFORE DELETE ON memory_scopes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_mutations_insert
BEFORE INSERT ON memory_table_mutations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_mutations_update
BEFORE UPDATE ON memory_table_mutations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_mutations_delete
BEFORE DELETE ON memory_table_mutations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_rows_insert
BEFORE INSERT ON memory_table_rows
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_rows_update
BEFORE UPDATE ON memory_table_rows
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_rows_delete
BEFORE DELETE ON memory_table_rows
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_tables_insert
BEFORE INSERT ON memory_tables
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_tables_update
BEFORE UPDATE ON memory_tables
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_tables_delete
BEFORE DELETE ON memory_tables
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_messages_insert
BEFORE INSERT ON messages
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_messages_update
BEFORE UPDATE ON messages
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_messages_delete
BEFORE DELETE ON messages
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_privacy_change_outbox_insert
BEFORE INSERT ON note_privacy_change_outbox
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_privacy_change_outbox_update
BEFORE UPDATE ON note_privacy_change_outbox
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_privacy_change_outbox_delete
BEFORE DELETE ON note_privacy_change_outbox
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_notes_insert
BEFORE INSERT ON notes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_notes_update
BEFORE UPDATE ON notes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_notes_delete
BEFORE DELETE ON notes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_notion_workspace_routes_insert
BEFORE INSERT ON notion_workspace_routes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_notion_workspace_routes_update
BEFORE UPDATE ON notion_workspace_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_notion_workspace_routes_delete
BEFORE DELETE ON notion_workspace_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_oauth_states_insert
BEFORE INSERT ON oauth_states
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_oauth_states_update
BEFORE UPDATE ON oauth_states
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_oauth_states_delete
BEFORE DELETE ON oauth_states
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_batch_events_insert
BEFORE INSERT ON opportunity_batch_events
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_batch_events_update
BEFORE UPDATE ON opportunity_batch_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_batch_events_delete
BEFORE DELETE ON opportunity_batch_events
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_batch_windows_insert
BEFORE INSERT ON opportunity_batch_windows
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_batch_windows_update
BEFORE UPDATE ON opportunity_batch_windows
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_batch_windows_delete
BEFORE DELETE ON opportunity_batch_windows
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_provenance_edges_insert
BEFORE INSERT ON opportunity_provenance_edges
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_provenance_edges_update
BEFORE UPDATE ON opportunity_provenance_edges
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_provenance_edges_delete
BEFORE DELETE ON opportunity_provenance_edges
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_provenance_nodes_insert
BEFORE INSERT ON opportunity_provenance_nodes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_provenance_nodes_update
BEFORE UPDATE ON opportunity_provenance_nodes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_opportunity_provenance_nodes_delete
BEFORE DELETE ON opportunity_provenance_nodes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_platform_workspace_bindings_insert
BEFORE INSERT ON platform_workspace_bindings
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_platform_workspace_bindings_update
BEFORE UPDATE ON platform_workspace_bindings
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_platform_workspace_bindings_delete
BEFORE DELETE ON platform_workspace_bindings
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_realtime_transcription_sessions_insert
BEFORE INSERT ON realtime_transcription_sessions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_realtime_transcription_sessions_update
BEFORE UPDATE ON realtime_transcription_sessions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_realtime_transcription_sessions_delete
BEFORE DELETE ON realtime_transcription_sessions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_realtime_transcription_ticket_receipts_insert
BEFORE INSERT ON realtime_transcription_ticket_receipts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_realtime_transcription_ticket_receipts_update
BEFORE UPDATE ON realtime_transcription_ticket_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_realtime_transcription_ticket_receipts_delete
BEFORE DELETE ON realtime_transcription_ticket_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_regional_onboarding_operations_insert
BEFORE INSERT ON regional_onboarding_operations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_regional_onboarding_operations_update
BEFORE UPDATE ON regional_onboarding_operations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_regional_onboarding_operations_delete
BEFORE DELETE ON regional_onboarding_operations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_repository_publications_insert
BEFORE INSERT ON repository_publications
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_repository_publications_update
BEFORE UPDATE ON repository_publications
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_repository_publications_delete
BEFORE DELETE ON repository_publications
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resource_object_deletion_outbox_insert
BEFORE INSERT ON resource_object_deletion_outbox
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resource_object_deletion_outbox_update
BEFORE UPDATE ON resource_object_deletion_outbox
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resource_object_deletion_outbox_delete
BEFORE DELETE ON resource_object_deletion_outbox
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resource_watches_insert
BEFORE INSERT ON resource_watches
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resource_watches_update
BEFORE UPDATE ON resource_watches
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resource_watches_delete
BEFORE DELETE ON resource_watches
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resources_insert
BEFORE INSERT ON resources
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resources_update
BEFORE UPDATE ON resources
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_resources_delete
BEFORE DELETE ON resources
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sandbox_imported_resources_insert
BEFORE INSERT ON sandbox_imported_resources
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sandbox_imported_resources_update
BEFORE UPDATE ON sandbox_imported_resources
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sandbox_imported_resources_delete
BEFORE DELETE ON sandbox_imported_resources
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sandbox_tasks_insert
BEFORE INSERT ON sandbox_tasks
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sandbox_tasks_update
BEFORE UPDATE ON sandbox_tasks
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sandbox_tasks_delete
BEFORE DELETE ON sandbox_tasks
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_schedules_insert
BEFORE INSERT ON schedules
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_schedules_update
BEFORE UPDATE ON schedules
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_schedules_delete
BEFORE DELETE ON schedules
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sessions_insert
BEFORE INSERT ON sessions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sessions_update
BEFORE UPDATE ON sessions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_sessions_delete
BEFORE DELETE ON sessions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_feedback_insert
BEFORE INSERT ON slack_agent_feedback
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_feedback_update
BEFORE UPDATE ON slack_agent_feedback
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_feedback_delete
BEFORE DELETE ON slack_agent_feedback
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_sessions_insert
BEFORE INSERT ON slack_agent_sessions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_sessions_update
BEFORE UPDATE ON slack_agent_sessions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_sessions_delete
BEFORE DELETE ON slack_agent_sessions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_ingress_jobs_insert
BEFORE INSERT ON slack_ingress_jobs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_ingress_jobs_update
BEFORE UPDATE ON slack_ingress_jobs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_ingress_jobs_delete
BEFORE DELETE ON slack_ingress_jobs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_installation_routes_insert
BEFORE INSERT ON slack_installation_routes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_installation_routes_update
BEFORE UPDATE ON slack_installation_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_installation_routes_delete
BEFORE DELETE ON slack_installation_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_unfurled_links_insert
BEFORE INSERT ON slack_unfurled_links
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_unfurled_links_update
BEFORE UPDATE ON slack_unfurled_links
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_unfurled_links_delete
BEFORE DELETE ON slack_unfurled_links
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_user_links_insert
BEFORE INSERT ON slack_user_links
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_user_links_update
BEFORE UPDATE ON slack_user_links
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_user_links_delete
BEFORE DELETE ON slack_user_links
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_suggested_work_ranking_rounds_insert
BEFORE INSERT ON suggested_work_ranking_rounds
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_suggested_work_ranking_rounds_update
BEFORE UPDATE ON suggested_work_ranking_rounds
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_suggested_work_ranking_rounds_delete
BEFORE DELETE ON suggested_work_ranking_rounds
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_suggested_work_sets_insert
BEFORE INSERT ON suggested_work_sets
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_suggested_work_sets_update
BEFORE UPDATE ON suggested_work_sets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_suggested_work_sets_delete
BEFORE DELETE ON suggested_work_sets
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_telemetry_profile_jobs_insert
BEFORE INSERT ON telemetry_profile_jobs
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_telemetry_profile_jobs_update
BEFORE UPDATE ON telemetry_profile_jobs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_telemetry_profile_jobs_delete
BEFORE DELETE ON telemetry_profile_jobs
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_terminal_publication_grants_insert
BEFORE INSERT ON terminal_publication_grants
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_terminal_publication_grants_update
BEFORE UPDATE ON terminal_publication_grants
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_terminal_publication_grants_delete
BEFORE DELETE ON terminal_publication_grants
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_tool_invocations_insert
BEFORE INSERT ON tool_invocations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_tool_invocations_update
BEFORE UPDATE ON tool_invocations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_tool_invocations_delete
BEFORE DELETE ON tool_invocations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_web_usage_log_insert
BEFORE INSERT ON web_usage_log
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_web_usage_log_update
BEFORE UPDATE ON web_usage_log
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_web_usage_log_delete
BEFORE DELETE ON web_usage_log
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunities_insert
BEFORE INSERT ON work_opportunities
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunities_update
BEFORE UPDATE ON work_opportunities
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunities_delete
BEFORE DELETE ON work_opportunities
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_user_links_insert
BEFORE INSERT ON work_opportunity_user_links
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_user_links_update
BEFORE UPDATE ON work_opportunity_user_links
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_user_links_delete
BEFORE DELETE ON work_opportunity_user_links
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_user_states_insert
BEFORE INSERT ON work_opportunity_user_states
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_user_states_update
BEFORE UPDATE ON work_opportunity_user_states
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_user_states_delete
BEFORE DELETE ON work_opportunity_user_states
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_invitations_insert
BEFORE INSERT ON workspace_invitations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_invitations_update
BEFORE UPDATE ON workspace_invitations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_invitations_delete
BEFORE DELETE ON workspace_invitations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_members_insert
BEFORE INSERT ON workspace_members
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_members_update
BEFORE UPDATE ON workspace_members
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_members_delete
BEFORE DELETE ON workspace_members
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_opportunity_versions_insert
BEFORE INSERT ON workspace_opportunity_versions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_opportunity_versions_update
BEFORE UPDATE ON workspace_opportunity_versions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_opportunity_versions_delete
BEFORE DELETE ON workspace_opportunity_versions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_domains_insert
BEFORE INSERT ON workspace_sandbox_network_domains
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_domains_update
BEFORE UPDATE ON workspace_sandbox_network_domains
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_domains_delete
BEFORE DELETE ON workspace_sandbox_network_domains
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_policies_insert
BEFORE INSERT ON workspace_sandbox_network_policies
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_policies_update
BEFORE UPDATE ON workspace_sandbox_network_policies
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_policies_delete
BEFORE DELETE ON workspace_sandbox_network_policies
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_policy_mutations_insert
BEFORE INSERT ON workspace_sandbox_network_policy_mutations
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_policy_mutations_update
BEFORE UPDATE ON workspace_sandbox_network_policy_mutations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspace_sandbox_network_policy_mutations_delete
BEFORE DELETE ON workspace_sandbox_network_policy_mutations
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_context_compactions_insert
BEFORE INSERT ON workstream_context_compactions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_context_compactions_update
BEFORE UPDATE ON workstream_context_compactions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_context_compactions_delete
BEFORE DELETE ON workstream_context_compactions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_description_refreshes_insert
BEFORE INSERT ON workstream_description_refreshes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_description_refreshes_update
BEFORE UPDATE ON workstream_description_refreshes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_description_refreshes_delete
BEFORE DELETE ON workstream_description_refreshes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_email_receipts_insert
BEFORE INSERT ON workstream_email_receipts
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_email_receipts_update
BEFORE UPDATE ON workstream_email_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_email_receipts_delete
BEFORE DELETE ON workstream_email_receipts
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_email_routes_insert
BEFORE INSERT ON workstream_email_routes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_email_routes_update
BEFORE UPDATE ON workstream_email_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_email_routes_delete
BEFORE DELETE ON workstream_email_routes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_pins_insert
BEFORE INSERT ON workstream_pins
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_pins_update
BEFORE UPDATE ON workstream_pins
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_pins_delete
BEFORE DELETE ON workstream_pins
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_read_states_insert
BEFORE INSERT ON workstream_read_states
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_read_states_update
BEFORE UPDATE ON workstream_read_states
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_read_states_delete
BEFORE DELETE ON workstream_read_states
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_resource_inventory_revisions_insert
BEFORE INSERT ON workstream_resource_inventory_revisions
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_resource_inventory_revisions_update
BEFORE UPDATE ON workstream_resource_inventory_revisions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_resource_inventory_revisions_delete
BEFORE DELETE ON workstream_resource_inventory_revisions
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_sandboxes_insert
BEFORE INSERT ON workstream_sandboxes
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_sandboxes_update
BEFORE UPDATE ON workstream_sandboxes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_sandboxes_delete
BEFORE DELETE ON workstream_sandboxes
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_terminal_repositories_insert
BEFORE INSERT ON workstream_terminal_repositories
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_terminal_repositories_update
BEFORE UPDATE ON workstream_terminal_repositories
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_terminal_repositories_delete
BEFORE DELETE ON workstream_terminal_repositories
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_wakeups_insert
BEFORE INSERT ON workstream_wakeups
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_wakeups_update
BEFORE UPDATE ON workstream_wakeups
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_wakeups_delete
BEFORE DELETE ON workstream_wakeups
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstreams_insert
BEFORE INSERT ON workstreams
WHEN NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstreams_update
BEFORE UPDATE ON workstreams
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = NEW.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstreams_delete
BEFORE DELETE ON workstreams
WHEN OLD.workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_resources_insert
BEFORE INSERT ON automation_resources
WHEN EXISTS (
  SELECT 1
  FROM automation_subscriptions parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.automation_subscription_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_resources_update
BEFORE UPDATE ON automation_resources
WHEN EXISTS (
  SELECT 1
  FROM automation_subscriptions parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.automation_subscription_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM automation_subscriptions parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.automation_subscription_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_resources_delete
BEFORE DELETE ON automation_resources
WHEN EXISTS (
  SELECT 1
  FROM automation_subscriptions parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.automation_subscription_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_template_versions_insert
BEFORE INSERT ON automation_template_versions
WHEN EXISTS (
  SELECT 1
  FROM automation_templates parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.template_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_template_versions_update
BEFORE UPDATE ON automation_template_versions
WHEN EXISTS (
  SELECT 1
  FROM automation_templates parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.template_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM automation_templates parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.template_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_automation_template_versions_delete
BEFORE DELETE ON automation_template_versions
WHEN EXISTS (
  SELECT 1
  FROM automation_templates parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.template_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_schedule_times_insert
BEFORE INSERT ON digest_schedule_times
WHEN EXISTS (
  SELECT 1
  FROM digest_schedules parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.digest_schedule_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_schedule_times_update
BEFORE UPDATE ON digest_schedule_times
WHEN EXISTS (
  SELECT 1
  FROM digest_schedules parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.digest_schedule_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM digest_schedules parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.digest_schedule_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_digest_schedule_times_delete
BEFORE DELETE ON digest_schedule_times
WHEN EXISTS (
  SELECT 1
  FROM digest_schedules parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.digest_schedule_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_plugin_activations_insert
BEFORE INSERT ON harness_run_plugin_activations
WHEN EXISTS (
  SELECT 1
  FROM harness_runs parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.harness_run_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_plugin_activations_update
BEFORE UPDATE ON harness_run_plugin_activations
WHEN EXISTS (
  SELECT 1
  FROM harness_runs parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.harness_run_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM harness_runs parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.harness_run_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_harness_run_plugin_activations_delete
BEFORE DELETE ON harness_run_plugin_activations
WHEN EXISTS (
  SELECT 1
  FROM harness_runs parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.harness_run_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_cells_insert
BEFORE INSERT ON memory_table_cells
WHEN EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = NEW.memory_table_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_cells_update
BEFORE UPDATE ON memory_table_cells
WHEN EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = OLD.memory_table_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = NEW.memory_table_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_cells_delete
BEFORE DELETE ON memory_table_cells
WHEN EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = OLD.memory_table_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_columns_insert
BEFORE INSERT ON memory_table_columns
WHEN EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = NEW.memory_table_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_columns_update
BEFORE UPDATE ON memory_table_columns
WHEN EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = OLD.memory_table_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = NEW.memory_table_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_memory_table_columns_delete
BEFORE DELETE ON memory_table_columns
WHEN EXISTS (
  SELECT 1
  FROM memory_tables parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.memory_table_id = OLD.memory_table_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_message_attachments_insert
BEFORE INSERT ON message_attachments
WHEN EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.message_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_message_attachments_update
BEFORE UPDATE ON message_attachments
WHEN EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.message_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.message_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_message_attachments_delete
BEFORE DELETE ON message_attachments
WHEN EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.message_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_message_mentions_insert
BEFORE INSERT ON message_mentions
WHEN EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.message_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_message_mentions_update
BEFORE UPDATE ON message_mentions
WHEN EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.message_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.message_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_message_mentions_delete
BEFORE DELETE ON message_mentions
WHEN EXISTS (
  SELECT 1
  FROM messages parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.message_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_resource_deletion_outbox_insert
BEFORE INSERT ON note_resource_deletion_outbox
WHEN EXISTS (
  SELECT 1
  FROM resources parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.resource_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_resource_deletion_outbox_update
BEFORE UPDATE ON note_resource_deletion_outbox
WHEN EXISTS (
  SELECT 1
  FROM resources parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.resource_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM resources parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.resource_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_resource_deletion_outbox_delete
BEFORE DELETE ON note_resource_deletion_outbox
WHEN EXISTS (
  SELECT 1
  FROM resources parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.resource_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_transcript_segments_insert
BEFORE INSERT ON note_transcript_segments
WHEN EXISTS (
  SELECT 1
  FROM notes parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.note_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_transcript_segments_update
BEFORE UPDATE ON note_transcript_segments
WHEN EXISTS (
  SELECT 1
  FROM notes parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.note_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM notes parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.note_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_note_transcript_segments_delete
BEFORE DELETE ON note_transcript_segments
WHEN EXISTS (
  SELECT 1
  FROM notes parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.note_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_channel_allowlist_insert
BEFORE INSERT ON slack_agent_channel_allowlist
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_channel_allowlist_update
BEFORE UPDATE ON slack_agent_channel_allowlist
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_channel_allowlist_delete
BEFORE DELETE ON slack_agent_channel_allowlist
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_contexts_insert
BEFORE INSERT ON slack_agent_contexts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_contexts_update
BEFORE UPDATE ON slack_agent_contexts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_contexts_delete
BEFORE DELETE ON slack_agent_contexts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_pending_prompts_insert
BEFORE INSERT ON slack_agent_pending_prompts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_pending_prompts_update
BEFORE UPDATE ON slack_agent_pending_prompts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_pending_prompts_delete
BEFORE DELETE ON slack_agent_pending_prompts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_policies_insert
BEFORE INSERT ON slack_agent_policies
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_policies_update
BEFORE UPDATE ON slack_agent_policies
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_policies_delete
BEFORE DELETE ON slack_agent_policies
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_thread_claims_insert
BEFORE INSERT ON slack_agent_thread_claims
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_thread_claims_update
BEFORE UPDATE ON slack_agent_thread_claims
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_agent_thread_claims_delete
BEFORE DELETE ON slack_agent_thread_claims
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_delivery_preferences_insert
BEFORE INSERT ON slack_delivery_preferences
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_delivery_preferences_update
BEFORE UPDATE ON slack_delivery_preferences
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_delivery_preferences_delete
BEFORE DELETE ON slack_delivery_preferences
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_link_challenges_insert
BEFORE INSERT ON slack_link_challenges
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_link_challenges_update
BEFORE UPDATE ON slack_link_challenges
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_slack_link_challenges_delete
BEFORE DELETE ON slack_link_challenges
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_telemetry_crash_reports_insert
BEFORE INSERT ON telemetry_crash_reports
WHEN NEW.subject_workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM workspaces parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.id
  WHERE parent.id = NEW.subject_workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_telemetry_crash_reports_update
BEFORE UPDATE ON telemetry_crash_reports
WHEN OLD.subject_workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM workspaces parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.id
  WHERE parent.id = OLD.subject_workspace_id
    AND gate.source_state = 'writable'
)
  OR NEW.subject_workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM workspaces parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.id
  WHERE parent.id = NEW.subject_workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_telemetry_crash_reports_delete
BEFORE DELETE ON telemetry_crash_reports
WHEN OLD.subject_workspace_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM workspaces parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.id
  WHERE parent.id = OLD.subject_workspace_id
    AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_tool_invocation_checkpoints_insert
BEFORE INSERT ON tool_invocation_checkpoints
WHEN EXISTS (
  SELECT 1
  FROM tool_invocations parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.tool_invocation_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_tool_invocation_checkpoints_update
BEFORE UPDATE ON tool_invocation_checkpoints
WHEN EXISTS (
  SELECT 1
  FROM tool_invocations parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.tool_invocation_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM tool_invocations parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.tool_invocation_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_tool_invocation_checkpoints_delete
BEFORE DELETE ON tool_invocation_checkpoints
WHEN EXISTS (
  SELECT 1
  FROM tool_invocations parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.tool_invocation_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_webhook_receipts_insert
BEFORE INSERT ON webhook_receipts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_webhook_receipts_update
BEFORE UPDATE ON webhook_receipts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_webhook_receipts_delete
BEFORE DELETE ON webhook_receipts
WHEN EXISTS (
  SELECT 1
  FROM connector_connections parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.connection_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_provenance_roots_insert
BEFORE INSERT ON work_opportunity_provenance_roots
WHEN EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.opportunity_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_provenance_roots_update
BEFORE UPDATE ON work_opportunity_provenance_roots
WHEN EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.opportunity_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.opportunity_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_provenance_roots_delete
BEFORE DELETE ON work_opportunity_provenance_roots
WHEN EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.opportunity_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_snapshots_insert
BEFORE INSERT ON work_opportunity_snapshots
WHEN EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.opportunity_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_snapshots_update
BEFORE UPDATE ON work_opportunity_snapshots
WHEN EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.opportunity_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.opportunity_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_work_opportunity_snapshots_delete
BEFORE DELETE ON work_opportunity_snapshots
WHEN EXISTS (
  SELECT 1
  FROM work_opportunities parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.opportunity_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_participants_insert
BEFORE INSERT ON workstream_participants
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_participants_update
BEFORE UPDATE ON workstream_participants
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.workstream_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_participants_delete
BEFORE DELETE ON workstream_participants
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_plugin_activation_hints_insert
BEFORE INSERT ON workstream_plugin_activation_hints
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_plugin_activation_hints_update
BEFORE UPDATE ON workstream_plugin_activation_hints
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.workstream_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_plugin_activation_hints_delete
BEFORE DELETE ON workstream_plugin_activation_hints
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_resources_insert
BEFORE INSERT ON workstream_resources
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_resources_update
BEFORE UPDATE ON workstream_resources
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.workstream_id
    AND gate.source_state <> 'writable'
)
  OR EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = NEW.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workstream_resources_delete
BEFORE DELETE ON workstream_resources
WHEN EXISTS (
  SELECT 1
  FROM workstreams parent
  JOIN workspace_authority_gates gate ON gate.workspace_id = parent.workspace_id
  WHERE parent.id = OLD.workstream_id
    AND gate.source_state <> 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspaces_update
BEFORE UPDATE ON workspaces
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.id AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;

CREATE TRIGGER authority_fence_workspaces_delete
BEFORE DELETE ON workspaces
WHEN NOT EXISTS (
  SELECT 1 FROM workspace_authority_gates gate
  WHERE gate.workspace_id = OLD.id AND gate.source_state = 'writable'
)
BEGIN SELECT RAISE(ABORT, 'workspace_source_not_writable'); END;
