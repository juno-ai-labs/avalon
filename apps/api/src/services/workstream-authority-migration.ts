import type { Env } from "../env";
import { durableObjectNamespaceForRegion } from "../lib/durable-object-namespace";
import {
  WORKSTREAM_AUTHORITY_IMPORT_BUNDLE_STAGE_LIMIT,
  WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX,
  WORKSTREAM_AUTHORITY_IMPORT_PAGE_SIZE,
  WORKSTREAM_AUTHORITY_IMPORT_STAGES,
  workstreamImportHash,
  type WorkstreamAuthorityImportStage,
} from "../durable-objects/workstream-authority-import";
import { workstreamRoomName } from "../durable-objects/workstream-room";
import {
  WORKSTREAM_DO_SERVING_CONTRACT_VERSION,
  type WorkstreamAuthorityControl,
} from "./workstream-authority";

type SourceRow = Record<string, unknown> & { source_rowid: number };
type ImportRow = Record<string, string | number | null>;

interface RouteRow {
  workspace_id: string;
  workstream_id: string;
  generation: number;
  state: "pending" | "importing" | "verified" | "active" | "quarantined";
  stage_index: number;
  source_cursor: number;
  source_fence_sequence: number;
  source_hash: string | null;
  row_counts_json: string | null;
}

const NEVER_EXPIRES_MS = 253_402_300_799_000;

function text(row: SourceRow, key: string, fallback = ""): string {
  const value = row[key];
  return typeof value === "string" ? value : fallback;
}

function nullableText(row: SourceRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function integer(row: SourceRow, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.trunc(Number(value));
  }
  return fallback;
}

function nullableInteger(row: SourceRow, key: string): number | null {
  const value = row[key];
  if (value == null) return null;
  return integer(row, key);
}

function epoch(row: SourceRow, key: string, fallback = 0): number {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function nullableEpoch(row: SourceRow, key: string): number | null {
  return row[key] == null ? null : epoch(row, key);
}

function json(row: SourceRow, key: string, fallback: string): string {
  const value = row[key];
  if (typeof value !== "string") return fallback;
  try {
    JSON.parse(value);
    return value;
  } catch {
    return fallback;
  }
}

function exactState(row: SourceRow): string {
  if (nullableText(row, "archived_at")) return "archived";
  switch (text(row, "harness_status")) {
    case "scheduled": return "scheduled";
    case "running": return "running";
    case "needs_input": return "needs_input";
    case "failed": return "failed";
    case "completed": return "completed";
    default: return "idle";
  }
}

function runStatus(value: string): string {
  switch (value) {
    case "scheduled": return "admitted";
    case "running": return "running";
    case "needs_input": return "needs_input";
    case "completed": return "completed";
    case "stopped": return "cancelled";
    default: return "failed";
  }
}

function toolStatus(value: string): string {
  switch (value) {
    case "pending": return "admitted";
    case "started": return "executing";
    case "completed": return "completed";
    case "ambiguous": return "ambiguous";
    default: return "failed";
  }
}

function toolMode(row: SourceRow): "read" | "write" {
  const plan = json(row, "execution_plan_json", "{}");
  try {
    const mode = (JSON.parse(plan) as { mode?: unknown }).mode;
    return mode === "read" ? "read" : "write";
  } catch {
    return "write";
  }
}

function transcriptToolStatus(value: string): "pending" | "completed" | "failed" | "ambiguous" {
  if (value === "completed") return "completed";
  if (value === "failed") return "failed";
  if (value === "ambiguous") return "ambiguous";
  return "pending";
}

export function workstreamAuthoritySourceQuery(stage: WorkstreamAuthorityImportStage): string {
  switch (stage) {
    case "workstream":
      return `SELECT rowid AS source_rowid, * FROM workstreams
               WHERE workspace_id = ?1 AND id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "participants":
      return `SELECT rowid AS source_rowid, * FROM workstream_participants
               WHERE workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "runs":
      return `SELECT r.rowid AS source_rowid, r.*, trigger.sequence_number AS trigger_sequence
                FROM harness_runs r LEFT JOIN messages trigger ON trigger.id = r.trigger_message_id
               WHERE r.workspace_id = ?1 AND r.workstream_id = ?2 AND r.rowid > ?3
               ORDER BY r.rowid LIMIT ?4`;
    case "run_scopes":
      return `SELECT rowid AS source_rowid, * FROM harness_run_scopes
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "run_memory_contexts":
      return `SELECT rowid AS source_rowid, * FROM harness_run_memory_contexts
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "run_plugin_activations":
      return `SELECT a.rowid AS source_rowid, a.* FROM harness_run_plugin_activations a
                JOIN harness_runs r ON r.id = a.harness_run_id
               WHERE r.workspace_id = ?1 AND r.workstream_id = ?2 AND a.rowid > ?3
               ORDER BY a.rowid LIMIT ?4`;
    case "run_lifecycle_events":
      return `SELECT rowid AS source_rowid, * FROM harness_run_lifecycle_events
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "inference_attempts":
      return `SELECT rowid AS source_rowid, * FROM inference_attempts
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "hypersight_configuration_versions":
      return `SELECT rowid AS source_rowid, * FROM hypersight_configuration_versions
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "hypersight_block_runs":
      return `SELECT rowid AS source_rowid, * FROM hypersight_block_runs
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "hypersight_user_preferences":
      return `SELECT rowid AS source_rowid, * FROM hypersight_user_preferences
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "parts":
      return `SELECT m.rowid AS source_rowid, m.*, r.attempt_number AS run_attempt_number,
                     tool.tool_name AS transcript_tool_name,
                     tool.status AS transcript_tool_status,
                     tool.execution_plan_json AS transcript_tool_execution_plan_json
                FROM messages m
                LEFT JOIN harness_runs r ON r.id = m.harness_run_id
                LEFT JOIN tool_invocations tool ON tool.id = m.id
               WHERE m.workspace_id = ?1 AND m.workstream_id = ?2 AND m.rowid > ?3
               ORDER BY m.rowid LIMIT ?4`;
    case "part_attachments":
      return `SELECT a.rowid AS source_rowid, a.* FROM message_attachments a
                JOIN messages m ON m.id = a.message_id
               WHERE m.workspace_id = ?1 AND m.workstream_id = ?2 AND a.rowid > ?3
               ORDER BY a.rowid LIMIT ?4`;
    case "part_mentions":
      return `SELECT mm.rowid AS source_rowid, mm.*, m.sequence_number AS attention_ordinal,
                     (SELECT COUNT(*) FROM message_mentions prior
                       WHERE prior.message_id = mm.message_id AND prior.rowid <= mm.rowid) - 1 AS mention_index
                FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
               WHERE m.workspace_id = ?1 AND m.workstream_id = ?2 AND mm.rowid > ?3
               ORDER BY mm.rowid LIMIT ?4`;
    case "member_attention":
      return `SELECT rs.rowid AS source_rowid, rs.*,
                     w.unread_tracking_start_sequence_number,
                     w.latest_attention_sequence_number,
                     COALESCE((SELECT MAX(m.sequence_number)
                       FROM message_mentions mm JOIN messages m ON m.id = mm.message_id
                      WHERE m.workstream_id = rs.workstream_id AND mm.mentioned_user_id = rs.user_id), 0)
                       AS latest_mention_sequence
                FROM workstream_read_states rs JOIN workstreams w ON w.id = rs.workstream_id
               WHERE rs.workspace_id = ?1 AND rs.workstream_id = ?2 AND rs.rowid > ?3
               ORDER BY rs.rowid LIMIT ?4`;
    case "tool_effects":
      return `SELECT t.rowid AS source_rowid, t.*, r.attempt_number AS run_attempt_number,
                     (SELECT COUNT(*) FROM tool_invocations prior
                       WHERE prior.harness_run_id = t.harness_run_id AND prior.rowid <= t.rowid) - 1 AS tool_position,
                     EXISTS (SELECT 1 FROM messages message WHERE message.id = t.id)
                       AS has_transcript_part
                FROM tool_invocations t JOIN harness_runs r ON r.id = t.harness_run_id
               WHERE t.workspace_id = ?1 AND t.workstream_id = ?2 AND t.rowid > ?3
               ORDER BY t.rowid LIMIT ?4`;
    case "tool_effect_checkpoints":
      return `SELECT c.rowid AS source_rowid, c.* FROM tool_invocation_checkpoints c
                JOIN tool_invocations t ON t.id = c.tool_invocation_id
               WHERE t.workspace_id = ?1 AND t.workstream_id = ?2 AND c.rowid > ?3
               ORDER BY c.rowid LIMIT ?4`;
    case "attachment_tool_receipts":
      return `SELECT receipt.rowid AS source_rowid, receipt.*
                FROM attachment_tool_receipts receipt
                JOIN tool_invocations invocation ON invocation.id = receipt.tool_invocation_id
               WHERE invocation.workspace_id = ?1 AND invocation.workstream_id = ?2
                 AND receipt.rowid > ?3 ORDER BY receipt.rowid LIMIT ?4`;
    case "elicitation_requests":
      return `SELECT rowid AS source_rowid, * FROM elicitations
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "workstream_resource_links":
      return `SELECT wr.rowid AS source_rowid, wr.*, r.connection_id, r.resource_type, r.provider,
                     r.provider_resource_id, r.title AS resource_title, r.mime_type, r.content_ref,
                     r.canonical_url, r.metadata_json, r.updated_at AS resource_updated_at
                FROM workstream_resources wr JOIN resources r ON r.id = wr.resource_id
               WHERE wr.workstream_id = ?2 AND wr.rowid > ?3 ORDER BY wr.rowid LIMIT ?4`;
    case "resource_inventory_revision":
      return `SELECT rowid AS source_rowid, * FROM workstream_resource_inventory_revisions
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "legacy_artifacts":
      return `SELECT rowid AS source_rowid, * FROM artifacts
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "compaction_checkpoints":
      return `SELECT rowid AS source_rowid, * FROM workstream_context_compactions
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "plugin_activation_hints":
      return `SELECT rowid AS source_rowid, * FROM workstream_plugin_activation_hints
               WHERE workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "suggested_actions":
      return `SELECT suggestion.rowid AS source_rowid, suggestion.*,
                     activity.title AS activity_title,
                     activity.summary AS activity_summary
                FROM activity_suggestions suggestion
                JOIN activities activity ON activity.id = suggestion.activity_id
               WHERE suggestion.workspace_id = ?1 AND suggestion.workstream_id = ?2
                 AND suggestion.rowid > ?3
               ORDER BY suggestion.rowid LIMIT ?4`;
    case "workstream_wakeups":
      return `SELECT rowid AS source_rowid, * FROM workstream_wakeups
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "description_refresh_state":
      return `SELECT rowid AS source_rowid, * FROM workstream_description_refreshes
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "terminal_workspace":
      return `SELECT rowid AS source_rowid, * FROM workstream_sandboxes
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "terminal_tasks":
      return `SELECT rowid AS source_rowid, * FROM sandbox_tasks
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "terminal_imported_resources":
      return `SELECT rowid AS source_rowid, * FROM sandbox_imported_resources
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "terminal_publication_grants":
      return `SELECT rowid AS source_rowid, * FROM terminal_publication_grants
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "terminal_repository":
      return `SELECT rowid AS source_rowid, * FROM workstream_terminal_repositories
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
    case "repository_publications":
      return `SELECT rowid AS source_rowid, * FROM repository_publications
               WHERE workspace_id = ?1 AND workstream_id = ?2 AND rowid > ?3 ORDER BY rowid LIMIT ?4`;
  }
}

export function normalizeWorkstreamAuthoritySourceRow(
  stage: WorkstreamAuthorityImportStage,
  row: SourceRow,
  region: "global" | "eu",
): ImportRow {
  const createdAt = epoch(row, "created_at");
  const updatedAt = epoch(row, "updated_at", createdAt);
  switch (stage) {
    case "workstream": {
      const state = exactState(row);
      return {
        workstream_key: text(row, "id"), parent_workspace_key: text(row, "workspace_id"), region,
        title: text(row, "title"), description: text(row, "objective"), scope: text(row, "scope", "workspace"),
        exact_state: state, state_reason_code: "imported_from_d1",
        next_sequence_number: integer(row, "next_sequence_number", 1),
        next_attention_ordinal: integer(row, "latest_attention_sequence_number") + 1,
        unread_tracking_start_ordinal: integer(row, "unread_tracking_start_sequence_number"),
        created_at: createdAt, last_people_activity_at: epoch(row, "last_activity_at", createdAt),
        state_changed_at: updatedAt, completed_at: state === "completed" ? updatedAt : null,
        origin_type: text(row, "origin_type", "ad_hoc"),
        created_by_user_id: nullableText(row, "created_by_user_id"),
        automation_subscription_id: nullableText(row, "automation_subscription_id"),
        automation_run_id: nullableText(row, "automation_run_id"), planned_for: nullableEpoch(row, "planned_for"),
        email_address: nullableText(row, "email_address"), email_route_status: text(row, "email_route_status", "pending"),
        created_from_opportunity_id: nullableText(row, "created_from_opportunity_id"),
        opportunity_version: nullableInteger(row, "opportunity_version"),
        opportunity_display_prompt_hash: nullableText(row, "opportunity_display_prompt_hash"),
        opportunity_execution_prompt_hash: nullableText(row, "opportunity_execution_prompt_hash"),
        description_source: text(row, "description_source", "derived"), system_kind: nullableText(row, "system_kind"),
        title_status: text(row, "title_status", "settled"), model_override: nullableText(row, "model_override"),
        archived_at: nullableEpoch(row, "archived_at"),
        updated_at: updatedAt,
      };
    }
    case "participants": {
      const removedAt = nullableEpoch(row, "removed_at");
      return { user_id: text(row, "user_id"), participation_reason: text(row, "participation_reason"),
        added_by_user_id: nullableText(row, "added_by_user_id"), status: removedAt === null ? "active" : "removed",
        participant_epoch: removedAt === null ? 0 : 1, added_at: epoch(row, "joined_at"), removed_at: removedAt,
        updated_at: removedAt ?? epoch(row, "joined_at") };
    }
    case "runs": {
      const status = runStatus(text(row, "status"));
      const startedAt = nullableEpoch(row, "started_at") ?? createdAt;
      const completedAt = nullableEpoch(row, "completed_at");
      return { run_id: text(row, "id"), substream_id: "0", workflow_instance_id: nullableText(row, "workflow_instance_id"),
        status, budget: "{}", attempt_epoch: integer(row, "attempt_number"), model_iteration: 0,
        next_action_cursor: "", input_fence_seq: integer(row, "trigger_sequence"), revision: 0,
        started_at: startedAt, active_elapsed_ms: 0, idle_elapsed_ms: 0, step_count: 0, subrequest_count: 0,
        retry_count: integer(row, "attempt_number"), tool_count: 0, input_tokens: 0, output_tokens: 0,
        cost_micros: 0, output_bytes: 0, terminal_reason: status === "cancelled" ? "cancelled" : null,
        origin: text(row, "origin"), execution_principal_json: json(row, "execution_principal_json", "{}"),
        parent_run_id: nullableText(row, "parent_harness_run_id"), parent_tool_call_id: nullableText(row, "parent_tool_call_id"),
        chain_root_run_id: nullableText(row, "chain_root_harness_run_id"), chain_depth: integer(row, "chain_depth"),
        model: nullableText(row, "model"), usage_json: nullableText(row, "usage_json"), error_json: nullableText(row, "error_json"),
        legacy_attempt_id: nullableText(row, "attempt_id"), lease_owner: nullableText(row, "lease_owner"),
        lease_expires_at: nullableEpoch(row, "lease_expires_at"), heartbeat_at: nullableEpoch(row, "heartbeat_at"),
        cancellation_requested_at: nullableEpoch(row, "cancellation_requested_at"),
        cancellation_reason: nullableText(row, "cancellation_reason"), final_part_id: nullableText(row, "final_message_id"),
        terminalized_at: nullableEpoch(row, "terminalized_at"), delegated_task_hash: nullableText(row, "delegated_task_hash"),
        inherited_scope_hash: nullableText(row, "inherited_scope_hash"), child_result_json: nullableText(row, "child_result_json"),
        child_result_hash: nullableText(row, "child_result_hash"), trigger_part_id: nullableText(row, "trigger_message_id"),
        completed_at: completedAt, created_at: createdAt, updated_at: completedAt ?? epoch(row, "heartbeat_at", startedAt) };
    }
    case "run_scopes": return { run_id: text(row, "harness_run_id"), attempt_id: text(row, "attempt_id"),
      execution_principal_json: json(row, "execution_principal_json", "{}"),
      eligible_connection_ids_json: json(row, "eligible_connection_ids_json", "[]"),
      eligible_capabilities_json: json(row, "eligible_capabilities_json", "[]"),
      eligible_connection_capabilities_json: json(row, "eligible_connection_capabilities_json", "{}"),
      trigger_policy_json: json(row, "trigger_policy_json", "{}"), routing_policy_version: text(row, "routing_policy_version"),
      prompt_version: text(row, "prompt_version"), tool_surface_hash: text(row, "tool_surface_hash"),
      limits_json: json(row, "limits_json", "{}"), scope_hash: text(row, "scope_hash"),
      memory_context_hash: nullableText(row, "memory_context_hash"), created_at: createdAt };
    case "run_memory_contexts": return { run_id: text(row, "harness_run_id"), attempt_id: text(row, "attempt_id"),
      memory_scope_ids_json: json(row, "memory_scope_ids_json", "[]"), query_text: text(row, "query_text"),
      retrieval_mode: text(row, "retrieval_mode"), results_json: json(row, "results_json", "[]"),
      memory_context_hash: text(row, "memory_context_hash"), created_at: createdAt };
    case "run_plugin_activations": return { run_id: text(row, "harness_run_id"), attempt_id: text(row, "attempt_id"),
      plugin_id: text(row, "plugin_id"), tool_surface_hash: text(row, "tool_surface_hash"),
      authorized_at: epoch(row, "authorized_at"), activated_at: epoch(row, "activated_at") };
    case "run_lifecycle_events": return { event_id: text(row, "id"), run_id: text(row, "harness_run_id"),
      attempt_id: text(row, "attempt_id"), event_key: text(row, "event_key"), event_type: text(row, "event_type"),
      status: nullableText(row, "status"), member_safe_payload_json: json(row, "member_safe_payload_json", "{}"),
      created_at: createdAt };
    case "inference_attempts": return { inference_attempt_id: text(row, "id"), run_id: text(row, "harness_run_id"),
      attempt_id: text(row, "attempt_id"), turn_id: text(row, "turn_id"), endpoint_attempt: integer(row, "endpoint_attempt", 1),
      fallback_attempt: integer(row, "fallback_attempt"), provider: text(row, "provider"), model: text(row, "model"),
      credential_source_hash: nullableText(row, "credential_source_hash"), workspace_identity_hash: text(row, "workspace_identity_hash"),
      routing_decision_json: json(row, "routing_decision_json", "{}"), outcome: text(row, "outcome"),
      failure_classification: nullableText(row, "failure_classification"), latency_ms: nullableInteger(row, "latency_ms"),
      ttft_ms: nullableInteger(row, "ttft_ms"), input_tokens: nullableInteger(row, "input_tokens"),
      output_tokens: nullableInteger(row, "output_tokens"), reasoning_tokens: nullableInteger(row, "reasoning_tokens"),
      cached_tokens: nullableInteger(row, "cached_tokens"), cost_micros: nullableInteger(row, "cost_microusd"),
      response_bytes: nullableInteger(row, "response_bytes"), started_at: epoch(row, "started_at"),
      completed_at: epoch(row, "completed_at"), created_at: createdAt };
    case "hypersight_configuration_versions": return { configuration_version_id: text(row, "id"),
      version_number: integer(row, "version_number", 1), blocks_json: json(row, "blocks_json", "[]"),
      created_by_user_id: text(row, "created_by_user_id"), created_at: createdAt };
    case "hypersight_block_runs": return { block_run_id: text(row, "id"),
      configuration_version_id: text(row, "configuration_version_id"), block_id: text(row, "block_id"),
      prompt: text(row, "prompt"), trigger_sequence: integer(row, "trigger_sequence"), run_id: text(row, "harness_run_id"),
      status: text(row, "status"), markdown: nullableText(row, "markdown"), error_json: nullableText(row, "error_json"),
      created_at: createdAt, started_at: nullableEpoch(row, "started_at"), completed_at: nullableEpoch(row, "completed_at") };
    case "hypersight_user_preferences": return { user_id: text(row, "user_id"), visible: integer(row, "visible"),
      updated_at: updatedAt };
    case "parts": {
      const author = text(row, "author_type");
      const messageType = text(row, "message_type", "text");
      const modelVisible = messageType === "text" || messageType === "elicitation";
      const transcriptToolRow = messageType === "tool"
        ? { ...row, execution_plan_json: row.transcript_tool_execution_plan_json }
        : row;
      return { id: text(row, "id"), substream_id: "0", sequence_number: integer(row, "sequence_number"),
        attention_ordinal: messageType === "tool" ? null : integer(row, "sequence_number"),
        role: author === "human" ? "user" : author === "agent" ? "assistant" : "system",
        kind: messageType === "tool" ? "tool_call" : "text",
        author_type: nullableText(row, "external_actor_json") ? "external" : author === "human" ? "member" : author === "agent" ? "agent" : "system",
        author_user_id: nullableText(row, "author_user_id"), external_actor_json: nullableText(row, "external_actor_json"),
        content: text(row, "text_content"), client_message_id: nullableText(row, "client_message_id"),
        effect_intent_id: messageType === "tool" ? text(row, "id") : null,
        tool_name: messageType === "tool" ? nullableText(row, "transcript_tool_name") : null,
        tool_mode: messageType === "tool" ? toolMode(transcriptToolRow) : null,
        tool_status: messageType === "tool"
          ? transcriptToolStatus(text(row, "transcript_tool_status"))
          : null,
        produced_by_run_id: nullableText(row, "harness_run_id"), attempt_epoch: nullableInteger(row, "run_attempt_number"),
        visibility: modelVisible ? "both" : "people", pinned: 0, message_type: messageType,
        structured_content_json: nullableText(row, "structured_content_json"), edited_at: nullableEpoch(row, "edited_at"),
        created_at: createdAt, updated_at: nullableEpoch(row, "edited_at") ?? createdAt };
    }
    case "part_attachments": return { part_id: text(row, "message_id"), resource_id: text(row, "resource_id"),
      position: integer(row, "position"), attachment_json: JSON.stringify({ attachedAt: nullableText(row, "attached_at") }) };
    case "part_mentions": return { part_id: text(row, "message_id"), mention_index: integer(row, "mention_index"),
      mention_kind: text(row, "mention_type"), target_user_id: nullableText(row, "mentioned_user_id"),
      connector_type: nullableText(row, "connector_type"), start_offset: integer(row, "start_offset"),
      end_offset: integer(row, "end_offset"), attention_ordinal: integer(row, "attention_ordinal") };
    case "member_attention": return { user_id: text(row, "user_id"),
      unread_tracking_start_ordinal: integer(row, "unread_tracking_start_sequence_number"),
      seen_attention_ordinal: integer(row, "read_through_sequence_number"),
      manual_unread_from_ordinal: nullableInteger(row, "manual_unread_from_sequence_number"),
      latest_mention_attention_ordinal: integer(row, "latest_mention_sequence"), last_seen_at: updatedAt,
      version: integer(row, "manual_unread_generation"), updated_at: updatedAt };
    case "tool_effects": return { effect_intent_id: text(row, "id"), run_id: text(row, "harness_run_id"),
      attempt_epoch: integer(row, "run_attempt_number"), tool_position: integer(row, "tool_position"),
      occurrence_key: `legacy:${text(row, "id")}`, tool_name: text(row, "tool_name"), mode: toolMode(row),
      request_hash: text(row, "input_hash"), authority_revision: nullableText(row, "execution_plan_hash") ?? "d1-maintenance-import",
      status: toolStatus(text(row, "status")),
      result_part_id: integer(row, "has_transcript_part") === 1 ? text(row, "id") : null,
      provider_operation_id: nullableText(row, "provider_operation_id"),
      started_at: nullableEpoch(row, "started_at"), settled_at: nullableEpoch(row, "completed_at"),
      result_hash: workstreamImportHash({ outputRef: row.output_ref, outputSummary: row.output_summary, status: row.status }),
      tool_call_id: text(row, "tool_call_id"), connection_id: nullableText(row, "connection_id"),
      input_json: json(row, "input_json", "{}"), output_ref: nullableText(row, "output_ref"),
      output_summary: nullableText(row, "output_summary"), error_json: nullableText(row, "error_json"),
      execution_plan_hash: nullableText(row, "execution_plan_hash"), execution_plan_json: nullableText(row, "execution_plan_json"),
      provider_idempotency_key: nullableText(row, "provider_idempotency_key"), checkpoint_index: integer(row, "checkpoint_index") };
    case "tool_effect_checkpoints": return { checkpoint_id: text(row, "id"), effect_intent_id: text(row, "tool_invocation_id"),
      run_id: text(row, "harness_run_id"), attempt_id: text(row, "attempt_id"), checkpoint_index: integer(row, "checkpoint_index"),
      phase: text(row, "phase"), member_safe_payload_json: json(row, "member_safe_payload_json", "{}"), created_at: createdAt };
    case "attachment_tool_receipts": return {
      workspace_id: text(row, "workspace_id"), resource_id: text(row, "resource_id"),
      tool_invocation_id: text(row, "tool_invocation_id"),
      derivative_sha256: text(row, "derivative_sha256"), created_at: createdAt,
    };
    case "elicitation_requests": return { elicitation_id: text(row, "id"), run_id: text(row, "harness_run_id"),
      prompt: text(row, "prompt"), response_type: text(row, "response_type"), options_json: json(row, "options_json", "[]"),
      minimum_selections: integer(row, "minimum_selections"), maximum_selections: nullableInteger(row, "maximum_selections"),
      target_user_id: nullableText(row, "target_user_id"), status: text(row, "status") === "open" ? "pending" : text(row, "status"),
      answer_json: nullableText(row, "answer_json"), answered_by_user_id: nullableText(row, "answered_by_user_id"),
      external_actor_json: nullableText(row, "answered_by_external_actor_json"), created_at: createdAt,
      answered_at: nullableEpoch(row, "answered_at") };
    case "workstream_resource_links": return { resource_id: text(row, "resource_id"),
      attached_by_user_id: nullableText(row, "attached_by_user_id"), watch_enabled: integer(row, "watch_enabled"),
      relationship_type: text(row, "relationship_type"), resource_json: JSON.stringify({
        id: text(row, "resource_id"), type: text(row, "resource_type"), provider: text(row, "provider"),
        connectionId: nullableText(row, "connection_id"),
        providerResourceId: nullableText(row, "provider_resource_id"), title: text(row, "resource_title"),
        mimeType: nullableText(row, "mime_type"), contentRef: nullableText(row, "content_ref"),
        canonicalUrl: nullableText(row, "canonical_url"), metadata: JSON.parse(json(row, "metadata_json", "{}")),
      }), attached_at: epoch(row, "attached_at"), updated_at: epoch(row, "resource_updated_at", epoch(row, "attached_at")) };
    case "resource_inventory_revision": return { id: 1, revision: integer(row, "revision"), updated_at: updatedAt };
    case "legacy_artifacts": return { artifact_id: text(row, "id"), run_id: nullableText(row, "harness_run_id"),
      artifact_type: text(row, "artifact_type"), title: text(row, "title"), content_ref: nullableText(row, "content_ref"),
      preview_text: nullableText(row, "preview_text"), status: text(row, "status"), metadata_json: json(row, "metadata_json", "{}"),
      created_at: createdAt, updated_at: updatedAt };
    case "compaction_checkpoints": return { projection_key: `legacy:${text(row, "execution_principal_key")}:${text(row, "resource_visibility_fingerprint")}:v${integer(row, "checkpoint_template_version")}`,
      execution_principal_key: text(row, "execution_principal_key"), resource_visibility_fingerprint: text(row, "resource_visibility_fingerprint"),
      checkpoint_template_version: integer(row, "checkpoint_template_version", 1), run_id: text(row, "harness_run_id"),
      compacted_through_sequence: integer(row, "compacted_through_sequence"), messages_json: json(row, "messages_json", "[]"),
      summary: text(row, "summary"), model: text(row, "model"), context_tokens_before_compaction: integer(row, "context_tokens_before_compaction"),
      context_window_tokens: integer(row, "context_window_tokens", 1), input_tokens: integer(row, "input_tokens"),
      output_tokens: integer(row, "output_tokens"), cost_micros: integer(row, "cost_microusd"), created_at: createdAt, updated_at: updatedAt };
    case "plugin_activation_hints": return { plugin_id: text(row, "plugin_id"), activated_at: epoch(row, "activated_at"),
      last_authorized_at: epoch(row, "last_authorized_at") };
    case "suggested_actions": {
      const created = createdAt;
      const status = text(row, "status");
      return { action_id: text(row, "id"), version: 1, source_activity_id: text(row, "activity_id"),
        delivery_id: `legacy:${text(row, "id")}`, audience_kind: "workstream", audience_user_id: null,
        provenance_ref: `activity:${text(row, "activity_id")}`, authorization_selector_hash: "legacy-d1",
        source_revisions_json: "[]", source_authorization_epoch: 0,
        display_title: text(row, "activity_title", "Suggested activity"),
        display_body: text(row, "activity_summary", text(row, "reason")),
        status, created_at: created, expires_at: NEVER_EXPIRES_MS,
        resolved_at: nullableEpoch(row, "resolved_at"), retracted_at: null,
        resolved_by_user_id: nullableText(row, "resolved_by_user_id"), resolution_client_id: null,
        share_intent_json: JSON.stringify({ confidence: row.confidence, matchedEntities: JSON.parse(json(row, "matched_entities_json", "[]")), source: row.source }),
        authored_part_id: null, feedback_message_id: null };
    }
    case "workstream_wakeups": return { wakeup_id: text(row, "id"), created_by_run_id: nullableText(row, "created_by_harness_run_id"),
      execution_principal_json: json(row, "execution_principal_json", "{}"), prompt: text(row, "prompt"), due_at: epoch(row, "due_at"),
      status: text(row, "status"), idempotency_key: text(row, "idempotency_key"), fired_at: nullableEpoch(row, "fired_at"),
      cancelled_at: nullableEpoch(row, "cancelled_at"), version: integer(row, "version", 1), created_at: createdAt, updated_at: updatedAt };
    case "description_refresh_state": return { id: 1, evaluated_at: nullableEpoch(row, "evaluated_at"),
      rest_until: epoch(row, "rest_until"), consecutive_keeps: integer(row, "consecutive_keeps"),
      evaluated_through_sequence: integer(row, "evaluated_through_sequence"), window_message_count: integer(row, "window_message_count"),
      decision: nullableText(row, "decision"), rejection_code: nullableText(row, "rejection_code"),
      confidence: typeof row.confidence === "number" ? row.confidence : null, model: nullableText(row, "model"),
      previous_description: nullableText(row, "previous_description"), description: nullableText(row, "description"),
      reasoning: nullableText(row, "reasoning"), version: integer(row, "version", 1), created_at: createdAt, updated_at: updatedAt };
    case "terminal_workspace": {
      const lifecycle = text(row, "state", "absent");
      return { id: 1, provider: "daytona", sandbox_id: lifecycle === "absent" ? null : nullableText(row, "provider_sandbox_id"),
        lifecycle_state: lifecycle, authority_epoch: integer(row, "version"), last_command_at: nullableEpoch(row, "last_activity_at"),
        idle_expires_at: nullableEpoch(row, "warm_stop_due_at"), created_at: createdAt, updated_at: updatedAt,
        generation: integer(row, "generation"), stable_name: nullableText(row, "stable_name"),
        applied_network_revision: integer(row, "applied_network_revision"), version: integer(row, "version"),
        lifecycle_json: JSON.stringify({ sourceState: row.state, providerSandboxId: row.provider_sandbox_id,
          authorityFingerprint: row.authority_fingerprint,
          operationRunId: row.operation_run_id, operationLeaseExpiresAt: row.operation_lease_expires_at,
          lifecycleClaimId: row.lifecycle_claim_id, lifecycleClaimExpiresAt: row.lifecycle_claim_expires_at,
          archiveDueAt: row.archive_due_at, expireDueAt: row.expire_due_at,
          finalDiffResourceId: row.final_diff_resource_id, failureCode: row.failure_code }) };
    }
    case "terminal_tasks": return { task_id: text(row, "id"), run_id: text(row, "harness_run_id"),
      effect_intent_id: text(row, "tool_invocation_id"), sandbox_generation: integer(row, "sandbox_generation", 1),
      provider_task_name: text(row, "provider_task_name"), provider_task_id: nullableText(row, "provider_task_id"), state: text(row, "state"),
      command_sha256: text(row, "command_sha256"), command_deadline_at: epoch(row, "command_deadline_at"), exit_code: nullableInteger(row, "exit_code"),
      termination_reason: nullableText(row, "termination_reason"), stdout_head: text(row, "stdout_head"), stdout_tail: text(row, "stdout_tail"),
      stderr_head: text(row, "stderr_head"), stderr_tail: text(row, "stderr_tail"), stdout_bytes: integer(row, "stdout_bytes"),
      stderr_bytes: integer(row, "stderr_bytes"), output_resource_id: nullableText(row, "output_resource_id"),
      continuation_emitted_at: nullableEpoch(row, "continuation_emitted_at"), started_at: nullableEpoch(row, "started_at"),
      completed_at: nullableEpoch(row, "completed_at"), created_at: createdAt, updated_at: updatedAt };
    case "terminal_imported_resources": return { sandbox_generation: integer(row, "sandbox_generation", 1),
      resource_id: text(row, "resource_id"), destination_path: text(row, "destination_path"), source_sha256: text(row, "source_sha256"),
      size_bytes: integer(row, "size_bytes"), state: text(row, "state"), imported_at: nullableEpoch(row, "imported_at"), updated_at: updatedAt };
    case "terminal_publication_grants": return { grant_id: text(row, "id"), run_id: text(row, "harness_run_id"),
      source_part_id: text(row, "source_message_id"), principal_key: text(row, "principal_key"),
      repository_full_name: text(row, "repository_full_name"), base_ref: text(row, "base_ref"), head_ref: text(row, "head_ref"),
      expires_at: epoch(row, "expires_at"), consumed_by_effect_intent_id: nullableText(row, "consumed_by_invocation_id"),
      consumed_at: nullableEpoch(row, "consumed_at"), created_at: createdAt };
    case "terminal_repository": return { id: 1, connection_id: text(row, "connection_id"), repository_id: integer(row, "repository_id"),
      repository_full_name: text(row, "repository_full_name"), base_ref: text(row, "base_ref"), base_sha: text(row, "base_sha"),
      head_ref: text(row, "head_ref"), state: text(row, "state"),
      bootstrapped_sandbox_generation: nullableInteger(row, "bootstrapped_sandbox_generation"),
      read_token_expires_at: nullableEpoch(row, "read_token_expires_at"), selected_by_user_id: text(row, "selected_by_user_id"),
      remote_access: text(row, "remote_access", "full_access"), created_at: createdAt, updated_at: updatedAt };
    case "repository_publications": return { publication_id: text(row, "id"), effect_intent_id: text(row, "tool_invocation_id"),
      grant_id: text(row, "grant_id"), repository_full_name: text(row, "repository_full_name"), base_ref: text(row, "base_ref"),
      head_ref: text(row, "head_ref"), expected_old_sha: nullableText(row, "expected_old_sha"),
      requested_commit_sha: text(row, "requested_commit_sha"), published_sha: nullableText(row, "published_sha"), state: text(row, "state"),
      pull_request_number: nullableInteger(row, "pull_request_number"), pull_request_url: nullableText(row, "pull_request_url"),
      pull_request_state: nullableText(row, "pull_request_state"), title: text(row, "title"), body: text(row, "body"),
      failure_code: nullableText(row, "failure_code"), created_at: createdAt, updated_at: updatedAt,
      completed_at: nullableEpoch(row, "completed_at") };
  }
}

function parseCounts(value: string | null): Partial<Record<WorkstreamAuthorityImportStage, number>> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, count]) =>
      typeof count === "number" && Number.isInteger(count) && count >= 0 ? [[key, count]] : []));
  } catch {
    return {};
  }
}

async function postImport(
  env: Env,
  route: RouteRow,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rooms = durableObjectNamespaceForRegion(env.WORKSTREAM_ROOMS, env.AVALON_REGION, env.APP_ENV);
  const id = rooms.idFromName(workstreamRoomName(env.AVALON_REGION, route.workspace_id, route.workstream_id));
  const response = await rooms.get(id).fetch("https://workstream-room/internal/authority-import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "workstream_import_request_failed");
  return result;
}

async function nextRoutes(
  env: Env,
  state: RouteRow["state"],
  limit: number,
): Promise<RouteRow[]> {
  const result = await env.DB.prepare(
    `SELECT workspace_id, workstream_id, generation, state, stage_index, source_cursor,
            source_fence_sequence, source_hash, row_counts_json
       FROM workstream_authority_routes
      WHERE generation = (SELECT generation FROM workstream_authority_control WHERE id = 1)
        AND state = ?
      ORDER BY updated_at, workstream_id LIMIT ?`,
  ).bind(state, limit).all<RouteRow>();
  return result.results ?? [];
}

async function beginRoute(env: Env, route: RouteRow): Promise<void> {
  const campaignId = `${WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX}:${route.generation}`;
  const sourceHash = workstreamImportHash({
    region: env.AVALON_REGION,
    workspaceId: route.workspace_id,
    workstreamId: route.workstream_id,
    generation: route.generation,
    sourceFence: route.source_fence_sequence,
  });
  await postImport(env, route, {
    operation: "begin", campaignId, generation: route.generation,
    workspaceId: route.workspace_id, workstreamId: route.workstream_id,
    sourceFence: route.source_fence_sequence, sourceHash,
  });
  await env.DB.prepare(
    `UPDATE workstream_authority_routes
        SET state = 'importing', stage_index = 0, source_cursor = 0,
            source_hash = NULL, row_counts_json = '{}', last_error_code = NULL, updated_at = ?
      WHERE workstream_id = ? AND generation = ? AND state = 'pending'`,
  ).bind(new Date().toISOString(), route.workstream_id, route.generation).run();
}

async function seedDirectoryProjections(env: Env, route: RouteRow): Promise<void> {
  const root = await env.DB.prepare(
    `SELECT rowid AS source_rowid, * FROM workstreams WHERE workspace_id = ? AND id = ?`,
  ).bind(route.workspace_id, route.workstream_id).first<SourceRow>();
  if (!root) throw new Error("workstream_import_projection_root_missing");
  const state = exactState(root);
  const wakeup = await env.DB.prepare(
    `SELECT due_at, prompt FROM workstream_wakeups
      WHERE workspace_id = ? AND workstream_id = ? AND status = 'pending'
      ORDER BY due_at, id LIMIT 1`,
  ).bind(route.workspace_id, route.workstream_id).first<{ due_at: string; prompt: string }>();
  const terminal = await env.DB.prepare(
    `SELECT CASE
              WHEN state IN ('stopping', 'archiving', 'expiring')
                THEN lifecycle_claim_expires_at
              WHEN expire_due_at IS NOT NULL AND (
                (state = 'running' AND (warm_stop_due_at IS NULL OR expire_due_at <= warm_stop_due_at))
                OR (state = 'stopped' AND (archive_due_at IS NULL OR expire_due_at <= archive_due_at))
                OR state = 'archived'
              ) THEN expire_due_at
              WHEN state = 'running' THEN warm_stop_due_at
              WHEN state = 'stopped' THEN archive_due_at
              ELSE expire_due_at
            END AS due_at
       FROM workstream_sandboxes
      WHERE workspace_id = ? AND workstream_id = ? AND provider_sandbox_id IS NOT NULL`,
  ).bind(route.workspace_id, route.workstream_id).first<{ due_at: string | null }>();
  const common = {
    title: text(root, "title"),
    description: text(root, "objective"),
    preview: "",
    scope: text(root, "scope", "workspace"),
    state,
    systemKind: nullableText(root, "system_kind"),
    lastActivityAt: text(root, "last_activity_at"),
    completedAt: state === "completed" ? text(root, "updated_at") : null,
    archivedAt: nullableText(root, "archived_at"),
    emailAddress: nullableText(root, "email_address"),
    originType: text(root, "origin_type", "ad_hoc"),
    createdByUserId: nullableText(root, "created_by_user_id"),
    automationSubscriptionId: nullableText(root, "automation_subscription_id"),
    automationRunId: nullableText(root, "automation_run_id"),
    plannedFor: nullableText(root, "planned_for"),
    titleStatus: text(root, "title_status", "settled"),
    latestAttentionOrdinal: integer(root, "latest_attention_sequence_number"),
    unreadTrackingStartOrdinal: integer(root, "unread_tracking_start_sequence_number"),
    nextWakeupDueAt: wakeup?.due_at ?? null,
    nextWakeupPrompt: wakeup?.prompt ?? null,
    nextTerminalActionAt: terminal?.due_at ?? null,
    createdAt: text(root, "created_at"),
    updatedAt: text(root, "updated_at"),
  };
  await env.DB.prepare(
    `INSERT INTO workstream_directory_projections
       (workspace_id, workstream_id, generation, version, title, description, preview,
        scope, state, system_kind, last_activity_at, completed_at, archived_at,
        email_address, origin_type, created_by_user_id, automation_subscription_id,
        automation_run_id, planned_for, title_status, latest_attention_ordinal,
        unread_tracking_start_ordinal, next_wakeup_due_at, next_wakeup_prompt,
        next_terminal_action_at, created_at, updated_at, payload_hash, projected_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(workstream_id) DO UPDATE SET
       workspace_id = excluded.workspace_id, generation = excluded.generation,
       version = excluded.version, title = excluded.title, description = excluded.description,
       preview = excluded.preview, scope = excluded.scope, state = excluded.state,
       system_kind = excluded.system_kind, last_activity_at = excluded.last_activity_at,
       completed_at = excluded.completed_at, archived_at = excluded.archived_at,
       email_address = excluded.email_address, origin_type = excluded.origin_type,
       created_by_user_id = excluded.created_by_user_id,
       automation_subscription_id = excluded.automation_subscription_id,
       automation_run_id = excluded.automation_run_id, planned_for = excluded.planned_for,
       title_status = excluded.title_status,
       latest_attention_ordinal = excluded.latest_attention_ordinal,
       unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
       next_wakeup_due_at = excluded.next_wakeup_due_at,
       next_wakeup_prompt = excluded.next_wakeup_prompt,
       next_terminal_action_at = excluded.next_terminal_action_at,
       created_at = excluded.created_at, updated_at = excluded.updated_at,
       payload_hash = excluded.payload_hash, projected_at = excluded.projected_at
     WHERE excluded.generation > workstream_directory_projections.generation
        OR (excluded.generation = workstream_directory_projections.generation
            AND excluded.version >= workstream_directory_projections.version)`,
  ).bind(
    route.workspace_id,
    route.workstream_id,
    route.generation,
    common.title,
    common.description,
    common.preview,
    common.scope,
    common.state,
    common.systemKind,
    common.lastActivityAt,
    common.completedAt,
    common.archivedAt,
    common.emailAddress,
    common.originType,
    common.createdByUserId,
    common.automationSubscriptionId,
    common.automationRunId,
    common.plannedFor,
    common.titleStatus,
    common.latestAttentionOrdinal,
    common.unreadTrackingStartOrdinal,
    common.nextWakeupDueAt,
    common.nextWakeupPrompt,
    common.nextTerminalActionAt,
    common.createdAt,
    common.updatedAt,
    workstreamImportHash(common),
    new Date().toISOString(),
  ).run();

  const projectedAt = new Date().toISOString();
  await env.DB.prepare(
    `DELETE FROM workstream_resource_link_projections WHERE workstream_id = ?`,
  ).bind(route.workstream_id).run();
  await env.DB.prepare(
    `INSERT INTO workstream_resource_link_projections
       (workspace_id, workstream_id, resource_id, watch_enabled,
        relationship_type, generation, version, projected_at)
     SELECT ?, wr.workstream_id, wr.resource_id, wr.watch_enabled,
            wr.relationship_type, ?, 0, ?
       FROM workstream_resources wr
      WHERE wr.workstream_id = ?`,
  ).bind(
    route.workspace_id,
    route.generation,
    projectedAt,
    route.workstream_id,
  ).run();
  await env.DB.prepare(
    `INSERT INTO workstream_suggestion_feedback_projections
       (workspace_id, workstream_id, action_id, activity_id, source, status,
        resolved_at, resolved_by_user_id, generation, version, projected_at)
     SELECT suggestion.workspace_id, suggestion.workstream_id, suggestion.id,
            suggestion.activity_id, suggestion.source, suggestion.status,
            suggestion.resolved_at, suggestion.resolved_by_user_id, ?, 1, ?
       FROM activity_suggestions suggestion
      WHERE suggestion.workspace_id = ? AND suggestion.workstream_id = ?
        AND suggestion.source IN ('contextual_routing', 'suggested_work')
        AND suggestion.status IN ('accepted', 'dismissed')
        AND suggestion.resolved_at IS NOT NULL
     ON CONFLICT(workstream_id, action_id) DO UPDATE SET
       activity_id = excluded.activity_id, source = excluded.source,
       status = excluded.status, resolved_at = excluded.resolved_at,
       resolved_by_user_id = excluded.resolved_by_user_id,
       generation = excluded.generation, version = excluded.version,
       projected_at = excluded.projected_at`,
  ).bind(
    route.generation,
    projectedAt,
    route.workspace_id,
    route.workstream_id,
  ).run();

  const viewers = await env.DB.prepare(
    `WITH interested(user_id) AS (
       SELECT user_id FROM workstream_participants
        WHERE workstream_id = ?2
       UNION
       SELECT user_id FROM workstream_read_states
        WHERE workspace_id = ?1 AND workstream_id = ?2
       UNION
       SELECT mm.mentioned_user_id FROM message_mentions mm
        JOIN messages m ON m.id = mm.message_id
        WHERE m.workspace_id = ?1 AND m.workstream_id = ?2
          AND mm.mentioned_user_id IS NOT NULL
     )
     SELECT interested.user_id,
            EXISTS (
              SELECT 1 FROM workstream_participants participant
               WHERE participant.workstream_id = ?2
                 AND participant.user_id = interested.user_id
                 AND participant.removed_at IS NULL
            ) AS is_participant,
            COALESCE((
              SELECT COUNT(*) FROM messages message
               WHERE message.workspace_id = ?1 AND message.workstream_id = ?2
                 AND message.message_type != 'tool'
                 AND message.sequence_number >= CASE
                   WHEN rs.manual_unread_from_sequence_number IS NOT NULL
                     THEN rs.manual_unread_from_sequence_number
                   ELSE MAX(
                     w.unread_tracking_start_sequence_number,
                     COALESCE(rs.read_through_sequence_number, 0)
                   ) + 1
                 END
            ), 0) AS unread_count,
            EXISTS (
              SELECT 1 FROM message_mentions mention
               JOIN messages mentioned_message ON mentioned_message.id = mention.message_id
              WHERE mentioned_message.workspace_id = ?1
                AND mentioned_message.workstream_id = ?2
                AND mention.mentioned_user_id = interested.user_id
                AND mentioned_message.sequence_number > COALESCE(rs.read_through_sequence_number, 0)
            ) AS you_are_mentioned,
            COALESCE(rs.read_through_sequence_number, w.unread_tracking_start_sequence_number)
              AS seen_attention_ordinal,
            rs.manual_unread_from_sequence_number AS manual_unread_from_ordinal,
            COALESCE(rs.manual_unread_generation, 0) AS manual_unread_generation,
            COALESCE((
              SELECT MAX(mentioned_message.sequence_number)
                FROM message_mentions mention
                JOIN messages mentioned_message ON mentioned_message.id = mention.message_id
               WHERE mentioned_message.workspace_id = ?1
                 AND mentioned_message.workstream_id = ?2
                 AND mention.mentioned_user_id = interested.user_id
            ), 0) AS latest_mention_attention_ordinal
       FROM interested
       JOIN workstreams w ON w.id = ?2 AND w.workspace_id = ?1
       LEFT JOIN workstream_read_states rs
         ON rs.workstream_id = w.id AND rs.user_id = interested.user_id`,
  ).bind(route.workspace_id, route.workstream_id).all<{
    user_id: string;
    is_participant: number;
    unread_count: number;
    you_are_mentioned: number;
    seen_attention_ordinal: number;
    manual_unread_from_ordinal: number | null;
    manual_unread_generation: number;
    latest_mention_attention_ordinal: number;
  }>();
  const viewerStatements = (viewers.results ?? []).map((viewer) => {
    const projection = {
      isParticipant: Number(viewer.is_participant) > 0,
      unreadCount: Number(viewer.unread_count),
      youAreMentioned: Number(viewer.you_are_mentioned) > 0,
      listable: common.scope === "workspace" || Number(viewer.is_participant) > 0,
      seenAttentionOrdinal: Number(viewer.seen_attention_ordinal),
      manualUnreadFromOrdinal: viewer.manual_unread_from_ordinal,
      manualUnreadGeneration: Number(viewer.manual_unread_generation),
      latestMentionAttentionOrdinal: Number(viewer.latest_mention_attention_ordinal),
    };
    return env.DB.prepare(
      `INSERT INTO workstream_directory_user_projections
       (workspace_id, workstream_id, user_id, generation, version, is_participant,
          unread_count, you_are_mentioned, listable, payload_hash, projected_at,
          seen_attention_ordinal, manual_unread_from_ordinal,
          manual_unread_generation, latest_mention_attention_ordinal)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workstream_id, user_id) DO UPDATE SET
         workspace_id = excluded.workspace_id, generation = excluded.generation,
         version = excluded.version, is_participant = excluded.is_participant,
         unread_count = excluded.unread_count, you_are_mentioned = excluded.you_are_mentioned,
         listable = excluded.listable, payload_hash = excluded.payload_hash,
         seen_attention_ordinal = excluded.seen_attention_ordinal,
         manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
         manual_unread_generation = excluded.manual_unread_generation,
         latest_mention_attention_ordinal = excluded.latest_mention_attention_ordinal,
         projected_at = excluded.projected_at
       WHERE excluded.generation > workstream_directory_user_projections.generation
          OR (excluded.generation = workstream_directory_user_projections.generation
              AND excluded.version >= workstream_directory_user_projections.version)`,
    ).bind(
      route.workspace_id,
      route.workstream_id,
      viewer.user_id,
      route.generation,
      projection.isParticipant ? 1 : 0,
      projection.unreadCount,
      projection.youAreMentioned ? 1 : 0,
      projection.listable ? 1 : 0,
      workstreamImportHash(projection),
      new Date().toISOString(),
      projection.seenAttentionOrdinal,
      projection.manualUnreadFromOrdinal,
      projection.manualUnreadGeneration,
      projection.latestMentionAttentionOrdinal,
    );
  });
  for (let start = 0; start < viewerStatements.length; start += 80) {
    await env.DB.batch(viewerStatements.slice(start, start + 80));
  }
}

async function importRoutePage(env: Env, route: RouteRow): Promise<void> {
  const stage = WORKSTREAM_AUTHORITY_IMPORT_STAGES[route.stage_index];
  const campaignId = `${WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX}:${route.generation}`;
  if (!stage) {
    if (!route.source_hash) throw new Error("workstream_import_page_chain_missing");
    const result = await postImport(env, route, {
      operation: "verify", campaignId, generation: route.generation,
      expectedPageHash: route.source_hash, expectedCounts: parseCounts(route.row_counts_json),
    });
    const targetHash = typeof result.resultHash === "string" ? result.resultHash : null;
    if (!targetHash) throw new Error("workstream_import_verification_hash_missing");
    await seedDirectoryProjections(env, route);
    await env.DB.prepare(
      `UPDATE workstream_authority_routes
          SET state = 'verified', target_hash = ?, imported_at = ?, verified_at = ?,
              last_error_code = NULL, updated_at = ?
        WHERE workstream_id = ? AND generation = ? AND state = 'importing'`,
    ).bind(targetHash, new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
      route.workstream_id, route.generation).run();
    return;
  }
  const candidateStages = WORKSTREAM_AUTHORITY_IMPORT_STAGES.slice(
    route.stage_index,
    route.stage_index + WORKSTREAM_AUTHORITY_IMPORT_BUNDLE_STAGE_LIMIT,
  );
  const sourcePages = await env.DB.batch<SourceRow>(candidateStages.map((candidate, offset) =>
    env.DB.prepare(workstreamAuthoritySourceQuery(candidate)).bind(
      route.workspace_id,
      route.workstream_id,
      offset === 0 ? route.source_cursor : 0,
      WORKSTREAM_AUTHORITY_IMPORT_PAGE_SIZE + 1,
    )));
  const counts = parseCounts(route.row_counts_json);
  const pages: Array<Record<string, unknown>> = [];
  let rowBudget = WORKSTREAM_AUTHORITY_IMPORT_PAGE_SIZE;
  let nextStageIndex = route.stage_index;
  let nextSourceCursor = route.source_cursor;

  for (const [offset, candidate] of candidateStages.entries()) {
    if (rowBudget === 0) break;
    const available = (sourcePages[offset]?.results ?? []) as SourceRow[];
    const currentSourceCursor = offset === 0 ? route.source_cursor : 0;
    const sourceRows = available.slice(0, rowBudget);
    const stageComplete = available.length <= sourceRows.length;
    const rows = sourceRows.map((row) =>
      normalizeWorkstreamAuthoritySourceRow(candidate, row, env.AVALON_REGION));
    const pageSourceCursor = sourceRows.at(-1)?.source_rowid ?? currentSourceCursor;
    const priorCursor = currentSourceCursor === 0 ? null : String(currentSourceCursor);
    const cursor = stageComplete ? `end:${pageSourceCursor}` : String(pageSourceCursor);
    const request = {
      campaignId,
      generation: route.generation,
      stage: candidate,
      priorCursor,
      cursor,
      rows,
      stageComplete,
    };
    pages.push({
      operation: "page",
      commandId: `${campaignId}:${route.workstream_id}:${candidate}:${currentSourceCursor}:${cursor}`,
      requestHash: workstreamImportHash(request),
      ...request,
    });
    counts[candidate] = (counts[candidate] ?? 0) + rows.length;
    rowBudget -= rows.length;
    if (stageComplete) {
      nextStageIndex += 1;
      nextSourceCursor = 0;
    } else {
      nextSourceCursor = pageSourceCursor;
      break;
    }
  }

  const imported = await postImport(env, route, {
    operation: "batch",
    campaignId,
    generation: route.generation,
    pages,
  });
  const resultHash = typeof imported.resultHash === "string" ? imported.resultHash : null;
  if (!resultHash) throw new Error("workstream_import_page_result_hash_missing");
  await env.DB.prepare(
    `UPDATE workstream_authority_routes
        SET stage_index = ?, source_cursor = ?, source_hash = ?, row_counts_json = ?,
            last_error_code = NULL, updated_at = ?
      WHERE workstream_id = ? AND generation = ? AND state = 'importing'
        AND stage_index = ? AND source_cursor = ?`,
  ).bind(
    nextStageIndex,
    nextSourceCursor,
    resultHash,
    JSON.stringify(counts),
    new Date().toISOString(),
    route.workstream_id,
    route.generation,
    route.stage_index,
    route.source_cursor,
  ).run();
}

async function activateRoute(env: Env, route: RouteRow): Promise<void> {
  const campaignId = `${WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX}:${route.generation}`;
  const result = await postImport(env, route, {
    operation: "activate", campaignId, generation: route.generation,
  });
  if (result.resultHash !== route.source_hash && result.resultHash !== undefined) {
    // The final target hash is separately stored on the route; this comparison
    // only catches an object answering for a different completed campaign.
    const target = await env.DB.prepare(
      `SELECT target_hash FROM workstream_authority_routes WHERE workstream_id = ?`,
    ).bind(route.workstream_id).first<{ target_hash: string | null }>();
    if (target?.target_hash !== result.resultHash) throw new Error("workstream_import_activation_hash_mismatch");
  }
  await env.DB.prepare(
    `UPDATE workstream_authority_routes
        SET state = 'active', activated_at = ?, last_error_code = NULL, updated_at = ?
      WHERE workstream_id = ? AND generation = ? AND state = 'verified'`,
  ).bind(new Date().toISOString(), new Date().toISOString(), route.workstream_id, route.generation).run();
}

async function quarantineRoute(env: Env, route: RouteRow, error: unknown): Promise<void> {
  const code = error instanceof Error ? error.message.slice(0, 180) : "workstream_import_failed";
  await env.DB.prepare(
    `UPDATE workstream_authority_routes
        SET state = 'quarantined', last_error_code = ?, updated_at = ?
      WHERE workstream_id = ? AND generation = ?`,
  ).bind(code, new Date().toISOString(), route.workstream_id, route.generation).run();
  await env.DB.prepare(
    `UPDATE workstream_authority_control
        SET phase = 'quarantined', reason = ?, updated_at = ?
      WHERE id = 1 AND generation = ?`,
  ).bind(code, new Date().toISOString(), route.generation).run();
}

/**
 * Execute bounded maintenance-window import work. The scheduler calls this
 * repeatedly; every page and every D1 cursor update is idempotent.
 */
export async function processWorkstreamAuthorityMigration(
  env: Env,
  control: WorkstreamAuthorityControl,
  maxOperations = 100,
): Promise<void> {
  // Leave one of the invocation's six simultaneous outbound-connection slots
  // available for control-plane/observability work. Each route operation uses
  // D1 and the target Durable Object sequentially, so five routes can progress
  // without depending on undocumented queuing above the platform ceiling.
  const concurrency = Math.min(5, maxOperations);
  let operationsRemaining = maxOperations;
  const processRoutes = async (
    routes: RouteRow[],
    operation: (env: Env, route: RouteRow) => Promise<void>,
  ): Promise<boolean> => {
    const results = await Promise.allSettled(routes.map((route) => operation(env, route)));
    let succeeded = true;
    for (const [index, result] of results.entries()) {
      if (result.status === "fulfilled") continue;
      succeeded = false;
      const route = routes[index];
      if (route) await quarantineRoute(env, route, result.reason);
    }
    return succeeded;
  };

  while (operationsRemaining > 0) {
    const batchSize = Math.min(concurrency, operationsRemaining);
    if (control.phase === "maintenance_importing") {
      const pending = await nextRoutes(env, "pending", batchSize);
      if (pending.length > 0) {
        if (!await processRoutes(pending, beginRoute)) return;
        operationsRemaining -= pending.length;
        continue;
      }
      const importing = await nextRoutes(env, "importing", batchSize);
      if (importing.length > 0) {
        if (!await processRoutes(importing, importRoutePage)) return;
        operationsRemaining -= importing.length;
        continue;
      }
      const remaining = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM workstream_authority_routes
          WHERE generation = ? AND state != 'verified'`,
      ).bind(control.generation).first<{ count: number }>();
      if (Number(remaining?.count ?? 0) === 0) {
        await env.DB.prepare(
          `UPDATE workstream_authority_control
              SET phase = 'maintenance_verified', verified_at = ?, updated_at = ?
            WHERE id = 1 AND phase = 'maintenance_importing' AND generation = ?`,
        ).bind(new Date().toISOString(), new Date().toISOString(), control.generation).run();
      }
      return;
    }
    if (control.phase === "maintenance_verified") {
      const verified = await nextRoutes(env, "verified", batchSize);
      if (verified.length > 0) {
        if (!await processRoutes(verified, activateRoute)) return;
        operationsRemaining -= verified.length;
        continue;
      }
      // Attestation is code-owned, not an operator assertion. A Worker can
      // advertise a serving contract only after every route is active, while
      // the final phase flip remains an explicit operator action.
      if (WORKSTREAM_DO_SERVING_CONTRACT_VERSION > 0) {
        await env.DB.prepare(
          `UPDATE workstream_authority_control
              SET serving_contract_version = ?, updated_at = ?
            WHERE id = 1 AND phase = 'maintenance_verified' AND generation = ?
              AND serving_contract_version < ?
              AND NOT EXISTS (
                SELECT 1 FROM workstream_authority_routes
                 WHERE generation = ? AND state != 'active'
              )`,
        ).bind(
          WORKSTREAM_DO_SERVING_CONTRACT_VERSION,
          new Date().toISOString(),
          control.generation,
          WORKSTREAM_DO_SERVING_CONTRACT_VERSION,
          control.generation,
        ).run();
      }
      // Deliberately remain in maintenance. Import success is data evidence,
      // not permission to expose a new owner; the final phase flip is manual.
      return;
    }
    return;
  }
}
