import { IdSchema } from "@avalon/contracts";
import { z } from "zod";

export const WORKSPACE_PRODUCT_IMPORT_STAGES = [
  "activity_events",
  "activity_event_targets",
  "workspace_connector_events",
  "opportunity_batch_windows",
  "opportunity_batch_events",
  "work_opportunities",
  "opportunity_provenance_nodes",
  "opportunity_provenance_edges",
  "work_opportunity_provenance_roots",
  "work_opportunity_user_links",
  "work_opportunity_user_states",
  "suggested_work_sets",
  "suggested_work_ranking_rounds",
  "work_opportunity_snapshots",
  "connector_connections",
  "webhook_receipts",
  "connector_oauth_attempts",
  "external_user_identities",
  "workspace_sandbox_network_policies",
  "workspace_sandbox_network_domains",
  "workspace_sandbox_network_policy_mutations",
  "slack_agent_policies",
  "slack_agent_channel_allowlist",
  "slack_delivery_preferences",
  "slack_user_links",
  "slack_agent_contexts",
  "slack_agent_feedback",
  "slack_agent_sessions",
  "slack_agent_thread_claims",
  "slack_ingress_jobs",
  "slack_link_challenges",
  "slack_agent_pending_prompts",
  "slack_unfurled_links",
  "automation_templates",
  "automation_template_versions",
  "automation_subscriptions",
  "automation_runs",
  "automation_delivery_targets",
  "automation_email_receipts",
  "automation_email_rate_windows",
  "digest_schedules",
  "digest_schedule_times",
  "digest_delivery_targets",
  "digest_deliveries",
  "schedules",
  "resources",
  "automation_resources",
  "resource_watches",
  "resource_object_deletion_outbox",
  "notes",
  "note_transcript_segments",
  "note_privacy_change_outbox",
  "memory_scopes",
  "memory_items",
  "memory_mutations",
  "memory_index_outbox",
  "memory_tables",
  "memory_table_columns",
  "memory_table_rows",
  "memory_table_cells",
  "memory_table_mutations",
  "workstream_notification_intents",
] as const;

export const WORKSPACE_RELATIONAL_IMPORT_STAGES = WORKSPACE_PRODUCT_IMPORT_STAGES.slice(14);

export function isWorkspaceRelationalImportStage(
  stage: WorkspaceProductImportStage,
): boolean {
  return (WORKSPACE_RELATIONAL_IMPORT_STAGES as readonly string[]).includes(stage);
}

export const WorkspaceProductImportStageSchema = z.enum(WORKSPACE_PRODUCT_IMPORT_STAGES);
const ScalarSchema = z.union([z.string(), z.number(), z.null()]);

export const WorkspaceProductImportRequestSchema = z.object({
  workspaceId: IdSchema,
  stage: WorkspaceProductImportStageSchema,
  rows: z.array(z.record(z.string(), ScalarSchema)).max(200),
}).strict();

export type WorkspaceProductImportStage = z.infer<typeof WorkspaceProductImportStageSchema>;
export type WorkspaceProductImportRequest = z.infer<typeof WorkspaceProductImportRequestSchema>;
export type WorkspaceProductImportRow = WorkspaceProductImportRequest["rows"][number];
