/**
 * What the workspace's generic SQL port refuses, and what a write through it
 * invalidates.
 *
 * These are the tables `executeRuntimeSql` consults on every statement the
 * compatibility port accepts: which ones a write to must re-derive an alarm
 * from, which ones have been converted to typed RPC and so may no longer be
 * named generically, and which ones back a sidebar list that has to be pushed
 * again. They live outside `workspace-do.ts` because they are a policy
 * table rather than object behavior — the lists grow as domains are converted,
 * and each entry carries the reasoning for its inclusion or its deliberate
 * absence.
 */
export const WORKSPACE_ALARM_SOURCE_TABLES = new Set([
  "schedules",
  "resource_watches",
  "resources",
  "resource_versions",
  "resource_object_deletion_outbox",
  "note_resource_deletion_outbox",
  "note_privacy_change_outbox",
  "memory_index_outbox",
  "slack_ingress_jobs",
  "slack_agent_thread_claims",
  "slack_agent_pending_prompts",
  "slack_link_challenges",
  "slack_unfurled_links",
]);

export const WORKSPACE_TYPED_RPC_ONLY_TABLES = [
  "workstream_notification_intents",
  // Converted to typed methods, so a generic statement naming one is a
  // mistake rather than a legacy caller. Refusing it here is what makes the
  // routing entries in `WORKSPACE_LOCAL_TABLES` more than a courtesy: the
  // statement reaches this object and is told why, instead of executing
  // against storage nobody meant to reach generically.
  "automation_directory",
  "realtime_transcription_sessions",
  "realtime_transcription_ticket_receipts",
  // Claims live on `claimWebhookReceipt`; the only generic statements left
  // naming this table are the connection service's pre-cutover branches, which
  // run only when WORKSPACE_DOS is unbound and so never reach this object.
  // `connector_oauth_attempts` is deliberately absent: the attempt-bind
  // statement batched with a connection mutation in
  // `persistConnectionMutation` still arrives generically, and refusing the
  // table here would break that atomic pair.
  "webhook_receipts",
  // The memory domain is typed methods now. `memory_index_outbox` is the one
  // deliberate omission: the schedule's alarm-target derivation in
  // `workspace-schedule-execution.ts` still reads its due time generically
  // through the object's local executor, alongside the other alarm sources.
  "memory_scopes",
  "memory_items",
  "memory_items_fts",
  "memory_mutations",
  "memory_tables",
  "memory_table_columns",
  "memory_table_rows",
  "memory_table_rows_fts",
  "memory_table_cells",
  "memory_table_mutations",
  // The Slack agent session, context, and feedback tables are typed methods
  // now. `slack_link_challenges`, `slack_agent_thread_claims`,
  // `slack_agent_pending_prompts`, and `slack_ingress_jobs` are deliberately
  // absent: the schedule's alarm-target derivation reads their due times
  // generically through this object's local executor, alongside the other
  // alarm sources.
  "slack_agent_sessions",
  "slack_agent_contexts",
  "slack_agent_feedback",
] as const;

export function typedRpcOnlyWorkspaceTable(sql: string): string | null {
  return WORKSPACE_TYPED_RPC_ONLY_TABLES.find((table) => (
    new RegExp(`\\b${table}\\b`, "iu").test(sql)
  )) ?? null;
}

/**
 * Which sidebar list a write invalidates, by the table it writes.
 *
 * Every mutation of these tables — a desktop REST write, a Workflow, and the
 * scheduler advancing `next_run_at` after a run — reaches this object through
 * `executeRuntimeSql`, so one check here covers writers that have no request
 * to hang an invalidation off. The template tables are in the list because the
 * sidebar row's name, description and update badge are read from them.
 */
export const SIDEBAR_LIST_SOURCE_TABLES = new Map<string, SidebarList>([
  ["automation_subscriptions", "automations"],
  ["automation_templates", "automations"],
  ["automation_template_versions", "automations"],
  ["notes", "notes"],
]);

export type SidebarList = "automations" | "notes";

export function workspaceMutationTarget(sql: string): string | null {
  return /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?([\w]+)["`\]]?/iu
    .exec(sql)?.[1]?.toLowerCase() ?? null;
}
