import { z } from "zod";

const ImportValueSchema = z.union([z.string(), z.number(), z.null()]);
const ImportRowSchema = z.record(z.string(), ImportValueSchema);

export const WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX = "d1-workstream-authority";
export const WORKSTREAM_AUTHORITY_IMPORT_PAGE_SIZE = 200;
export const WORKSTREAM_AUTHORITY_IMPORT_BUNDLE_STAGE_LIMIT = 40;

const IMPORT_STAGES = [
  ["workstream", "workstream", [
    "workstream_key", "parent_workspace_key", "region", "title", "description", "scope",
    "exact_state", "state_reason_code", "next_sequence_number", "next_attention_ordinal",
    "unread_tracking_start_ordinal",
    "created_at", "last_people_activity_at", "state_changed_at", "completed_at", "origin_type",
    "created_by_user_id", "automation_subscription_id", "automation_run_id", "planned_for",
    "email_address", "email_route_status", "created_from_opportunity_id", "opportunity_version",
    "opportunity_display_prompt_hash", "opportunity_execution_prompt_hash", "description_source",
    "system_kind", "title_status", "model_override", "archived_at", "updated_at",
  ]],
  ["participants", "participants", [
    "user_id", "participation_reason", "added_by_user_id", "status", "participant_epoch",
    "added_at", "removed_at", "updated_at",
  ]],
  ["runs", "runs", [
    "run_id", "substream_id", "workflow_instance_id", "status", "budget", "attempt_epoch",
    "model_iteration", "next_action_cursor", "input_fence_seq", "revision", "started_at",
    "active_elapsed_ms", "idle_elapsed_ms", "step_count", "subrequest_count", "retry_count",
    "tool_count", "input_tokens", "output_tokens", "cost_micros", "output_bytes",
    "terminal_reason", "origin", "execution_principal_json", "parent_run_id",
    "parent_tool_call_id", "chain_root_run_id", "chain_depth", "model", "usage_json",
    "error_json", "legacy_attempt_id", "lease_owner", "lease_expires_at", "heartbeat_at",
    "cancellation_requested_at", "cancellation_reason", "final_part_id", "terminalized_at",
    "delegated_task_hash", "inherited_scope_hash", "child_result_json", "child_result_hash",
    "trigger_part_id", "completed_at", "created_at", "updated_at",
  ]],
  ["run_scopes", "run_scopes", [
    "run_id", "attempt_id", "execution_principal_json", "eligible_connection_ids_json",
    "eligible_capabilities_json", "eligible_connection_capabilities_json", "trigger_policy_json",
    "routing_policy_version", "prompt_version", "tool_surface_hash", "limits_json", "scope_hash",
    "memory_context_hash", "created_at",
  ]],
  ["run_memory_contexts", "run_memory_contexts", [
    "run_id", "attempt_id", "memory_scope_ids_json", "query_text", "retrieval_mode",
    "results_json", "memory_context_hash", "created_at",
  ]],
  ["run_plugin_activations", "run_plugin_activations", [
    "run_id", "attempt_id", "plugin_id", "tool_surface_hash", "authorized_at", "activated_at",
  ]],
  ["run_lifecycle_events", "run_lifecycle_events", [
    "event_id", "run_id", "attempt_id", "event_key", "event_type", "status",
    "member_safe_payload_json", "created_at",
  ]],
  ["inference_attempts", "inference_attempts", [
    "inference_attempt_id", "run_id", "attempt_id", "turn_id", "endpoint_attempt",
    "fallback_attempt", "provider", "model", "credential_source_hash", "workspace_identity_hash",
    "routing_decision_json", "outcome", "failure_classification", "latency_ms", "ttft_ms",
    "input_tokens", "output_tokens", "reasoning_tokens", "cached_tokens", "cost_micros",
    "response_bytes", "started_at", "completed_at", "created_at",
  ]],
  ["block_dashboard_configuration_versions", "block_dashboard_configuration_versions", [
    "configuration_version_id", "version_number", "blocks_json", "created_by_user_id", "created_at",
  ]],
  ["block_dashboard_block_runs", "block_dashboard_block_runs", [
    "block_run_id", "configuration_version_id", "block_id", "prompt", "trigger_sequence", "run_id",
    "status", "markdown", "error_json", "created_at", "started_at", "completed_at",
  ]],
  ["block_dashboard_user_preferences", "block_dashboard_user_preferences", [
    "user_id", "visible", "updated_at",
  ]],
  ["parts", "parts", [
    "id", "substream_id", "sequence_number", "attention_ordinal", "role", "kind",
    "author_type", "author_user_id", "external_actor_json", "content", "client_message_id",
    "effect_intent_id", "tool_name", "tool_mode", "tool_status", "produced_by_run_id",
    "attempt_epoch", "visibility", "pinned", "message_type", "structured_content_json",
    "edited_at", "created_at", "updated_at",
  ]],
  ["part_attachments", "part_attachments", [
    "part_id", "resource_id", "position", "attachment_json",
  ]],
  ["part_mentions", "part_mentions", [
    "part_id", "mention_index", "mention_kind", "target_user_id", "connector_type",
    "start_offset", "end_offset", "attention_ordinal",
  ]],
  ["member_attention", "member_attention", [
    "user_id", "unread_tracking_start_ordinal", "seen_attention_ordinal",
    "manual_unread_from_ordinal", "latest_mention_attention_ordinal", "last_seen_at", "version",
    "updated_at",
  ]],
  ["tool_effects", "tool_effects", [
    "effect_intent_id", "run_id", "attempt_epoch", "tool_position", "occurrence_key", "tool_name",
    "mode", "request_hash", "authority_revision", "status", "result_part_id",
    "provider_operation_id", "started_at", "settled_at", "result_hash", "tool_call_id",
    "connection_id", "input_json", "output_ref", "output_summary", "error_json",
    "execution_plan_hash", "execution_plan_json", "provider_idempotency_key", "checkpoint_index",
  ]],
  ["tool_effect_checkpoints", "tool_effect_checkpoints", [
    "checkpoint_id", "effect_intent_id", "run_id", "attempt_id", "checkpoint_index", "phase",
    "member_safe_payload_json", "created_at",
  ]],
  ["attachment_tool_receipts", "attachment_tool_receipts", [
    "workspace_id", "resource_id", "tool_invocation_id", "derivative_sha256", "created_at",
  ]],
  ["elicitation_requests", "elicitation_requests", [
    "elicitation_id", "run_id", "prompt", "response_type", "options_json", "minimum_selections",
    "maximum_selections", "target_user_id", "status", "answer_json", "answered_by_user_id",
    "external_actor_json", "created_at", "answered_at",
  ]],
  ["workstream_resource_links", "workstream_resource_links", [
    "resource_id", "attached_by_user_id", "watch_enabled", "relationship_type", "resource_json",
    "attached_at", "updated_at",
  ]],
  ["resource_inventory_revision", "resource_inventory_revision", [
    "id", "revision", "updated_at",
  ]],
  ["legacy_artifacts", "legacy_artifacts", [
    "artifact_id", "run_id", "artifact_type", "title", "content_ref", "preview_text", "status",
    "metadata_json", "created_at", "updated_at",
  ]],
  ["compaction_checkpoints", "compaction_checkpoints", [
    "projection_key", "execution_principal_key", "resource_visibility_fingerprint",
    "checkpoint_template_version", "run_id", "compacted_through_sequence", "messages_json",
    "summary", "model", "context_tokens_before_compaction", "context_window_tokens",
    "input_tokens", "output_tokens", "cost_micros", "created_at", "updated_at",
  ]],
  ["plugin_activation_hints", "plugin_activation_hints", [
    "plugin_id", "activated_at", "last_authorized_at",
  ]],
  ["suggested_actions", "suggested_actions", [
    "action_id", "version", "source_activity_id", "delivery_id", "audience_kind",
    "audience_user_id", "provenance_ref", "authorization_selector_hash", "source_revisions_json",
    "source_authorization_epoch", "display_title", "display_body", "status", "created_at",
    "expires_at", "resolved_at", "retracted_at", "resolved_by_user_id", "resolution_client_id",
    "share_intent_json", "authored_part_id", "feedback_message_id",
  ]],
  ["workstream_wakeups", "workstream_wakeups", [
    "wakeup_id", "created_by_run_id", "execution_principal_json", "prompt", "due_at", "status",
    "idempotency_key", "fired_at", "cancelled_at", "version", "created_at", "updated_at",
  ]],
  ["description_refresh_state", "description_refresh_state", [
    "id", "evaluated_at", "rest_until", "consecutive_keeps", "evaluated_through_sequence",
    "window_message_count", "decision", "rejection_code", "confidence", "model",
    "previous_description", "description", "reasoning", "version", "created_at", "updated_at",
  ]],
  ["terminal_workspace", "terminal_workspace", [
    "id", "provider", "sandbox_id", "lifecycle_state", "authority_epoch", "last_command_at",
    "idle_expires_at", "created_at", "updated_at", "generation", "stable_name",
    "applied_network_revision", "version", "lifecycle_json",
  ]],
  ["terminal_tasks", "terminal_tasks", [
    "task_id", "run_id", "effect_intent_id", "sandbox_generation", "provider_task_name",
    "provider_task_id", "state", "command_sha256", "command_deadline_at", "exit_code",
    "termination_reason", "stdout_head", "stdout_tail", "stderr_head", "stderr_tail",
    "stdout_bytes", "stderr_bytes", "output_resource_id", "continuation_emitted_at", "started_at",
    "completed_at", "created_at", "updated_at",
  ]],
  ["terminal_imported_resources", "terminal_imported_resources", [
    "sandbox_generation", "resource_id", "destination_path", "source_sha256", "size_bytes",
    "state", "imported_at", "updated_at",
  ]],
  ["terminal_publication_grants", "terminal_publication_grants", [
    "grant_id", "run_id", "source_part_id", "principal_key", "repository_full_name", "base_ref",
    "head_ref", "expires_at", "consumed_by_effect_intent_id", "consumed_at", "created_at",
  ]],
  ["terminal_repository", "terminal_repository", [
    "id", "connection_id", "repository_id", "repository_full_name", "base_ref", "base_sha",
    "head_ref", "state", "bootstrapped_sandbox_generation", "read_token_expires_at",
    "selected_by_user_id", "remote_access", "created_at", "updated_at",
  ]],
  ["repository_publications", "repository_publications", [
    "publication_id", "effect_intent_id", "grant_id", "repository_full_name", "base_ref", "head_ref",
    "expected_old_sha", "requested_commit_sha", "published_sha", "state", "pull_request_number",
    "pull_request_url", "pull_request_state", "title", "body", "failure_code", "created_at",
    "updated_at", "completed_at",
  ]],
] as const;

export type WorkstreamAuthorityImportStage = typeof IMPORT_STAGES[number][0];

export const WORKSTREAM_AUTHORITY_IMPORT_STAGES = IMPORT_STAGES.map(([stage]) => stage);

export function workstreamAuthorityImportColumns(
  stage: WorkstreamAuthorityImportStage,
): readonly string[] {
  const definition = IMPORT_STAGES.find(([candidate]) => candidate === stage);
  if (!definition) throw new Error(`workstream_import_stage_unknown:${stage}`);
  return definition[2];
}

const ImportStageSchema = z.enum(WORKSTREAM_AUTHORITY_IMPORT_STAGES as [
  WorkstreamAuthorityImportStage,
  ...WorkstreamAuthorityImportStage[],
]);

const WorkstreamAuthorityImportPageRequestSchema = z.object({
  operation: z.literal("page"),
  campaignId: z.string().min(1).max(180),
  generation: z.number().int().positive(),
  commandId: z.string().min(1).max(240),
  stage: ImportStageSchema,
  priorCursor: z.string().min(1).max(240).nullable(),
  cursor: z.string().min(1).max(240),
  rows: z.array(ImportRowSchema).max(WORKSTREAM_AUTHORITY_IMPORT_PAGE_SIZE),
  stageComplete: z.boolean(),
  requestHash: z.string().min(1).max(180),
}).strict();

export const WorkstreamAuthorityImportRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("begin"),
    campaignId: z.string().min(1).max(180),
    generation: z.number().int().positive(),
    workspaceId: z.string().uuid(),
    workstreamId: z.string().uuid(),
    sourceFence: z.number().int().nonnegative(),
    sourceHash: z.string().min(1).max(180),
  }).strict(),
  WorkstreamAuthorityImportPageRequestSchema,
  z.object({
    operation: z.literal("batch"),
    campaignId: z.string().min(1).max(180),
    generation: z.number().int().positive(),
    pages: z.array(WorkstreamAuthorityImportPageRequestSchema)
      .min(1)
      .max(WORKSTREAM_AUTHORITY_IMPORT_BUNDLE_STAGE_LIMIT),
  }).strict(),
  z.object({
    operation: z.literal("verify"),
    campaignId: z.string().min(1).max(180),
    generation: z.number().int().positive(),
    expectedPageHash: z.string().min(1).max(180),
    expectedCounts: z.partialRecord(ImportStageSchema, z.number().int().nonnegative()),
  }).strict(),
  z.object({
    operation: z.literal("activate"),
    campaignId: z.string().min(1).max(180),
    generation: z.number().int().positive(),
  }).strict(),
]);

export type WorkstreamAuthorityImportRequest = z.infer<typeof WorkstreamAuthorityImportRequestSchema>;

interface ImportCursor {
  stageIndex: number;
  cursor: string | null;
  counts: Partial<Record<WorkstreamAuthorityImportStage, number>>;
}

interface MigrationRow extends Record<string, SqlStorageValue> {
  phase: string;
  cursor: string | null;
  source_fence: string | null;
  source_hash: string | null;
  result_hash: string | null;
  status: string;
}

function first<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

export function workstreamImportHash(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(stableJson(value))) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `fnv1a64:${hash.toString(16).padStart(16, "0")}`;
}

function parseCursor(value: string | null): ImportCursor {
  if (!value) return { stageIndex: 0, cursor: null, counts: {} };
  return z.object({
    stageIndex: z.number().int().nonnegative(),
    cursor: z.string().nullable(),
    counts: z.partialRecord(ImportStageSchema, z.number().int().nonnegative()),
  }).parse(JSON.parse(value));
}

function migration(
  storage: DurableObjectStorage,
  campaignId: string,
): MigrationRow | undefined {
  return first(storage.sql.exec<MigrationRow>(
    `SELECT phase, cursor, source_fence, source_hash, result_hash, status
       FROM _data_migrations WHERE campaign_id = ?`,
    campaignId,
  ));
}

const RESET_TABLES = [...IMPORT_STAGES]
  .map(([, table]) => table)
  .filter((table) => table !== "workstream")
  .reverse();

export class WorkstreamAuthorityImporter {
  constructor(private readonly storage: DurableObjectStorage) {}

  execute(request: WorkstreamAuthorityImportRequest): Record<string, unknown> {
    switch (request.operation) {
      case "begin": return this.begin(request);
      case "page": return this.page(request);
      case "batch": return this.batch(request);
      case "verify": return this.verify(request);
      case "activate": return this.activate(request);
    }
  }

  private batch(request: Extract<WorkstreamAuthorityImportRequest, { operation: "batch" }>) {
    if (request.pages.some((page) =>
      page.campaignId !== request.campaignId || page.generation !== request.generation)) {
      throw new Error("workstream_import_batch_campaign_mismatch");
    }
    const rowCount = request.pages.reduce((count, page) => count + page.rows.length, 0);
    if (rowCount > WORKSTREAM_AUTHORITY_IMPORT_PAGE_SIZE) {
      throw new Error("workstream_import_batch_row_limit");
    }
    let last: Record<string, unknown> | undefined;
    const results = request.pages.map((page) => {
      last = this.page(page);
      return last;
    });
    return { ok: true, results, resultHash: last?.resultHash };
  }

  private begin(request: Extract<WorkstreamAuthorityImportRequest, { operation: "begin" }>) {
    const expectedCampaign = `${WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX}:${request.generation}`;
    if (request.campaignId !== expectedCampaign) throw new Error("workstream_import_campaign_mismatch");
    return this.storage.transactionSync(() => {
      const identity = first(this.storage.sql.exec<{
        workstream_key: string;
        parent_workspace_key: string;
        authority_generation: number;
        authority_mode: string;
      }>(
        `SELECT workstream_key, parent_workspace_key, authority_generation, authority_mode
           FROM workstream WHERE id = 1`,
      ));
      if (!identity) throw new Error("workstream_import_identity_missing");
      if (
        identity.workstream_key !== request.workstreamId
        || identity.parent_workspace_key !== request.workspaceId
      ) throw new Error("workstream_import_identity_mismatch");
      if (identity.authority_generation > request.generation) {
        throw new Error("workstream_import_generation_stale");
      }
      const existing = migration(this.storage, request.campaignId);
      if (existing?.status === "completed") {
        return { ok: true, replayed: true, phase: existing.phase };
      }
      if (existing?.status === "running" && existing.phase === "importing") {
        if (
          existing.source_fence !== String(request.sourceFence)
          || existing.source_hash !== request.sourceHash
        ) throw new Error("workstream_import_begin_conflict");
        return { ok: true, replayed: true, phase: existing.phase };
      }
      if (existing) throw new Error("workstream_import_campaign_state_invalid");
      this.storage.sql.exec(`DELETE FROM durable_outbox`);
      this.storage.sql.exec(`DELETE FROM workstream_events`);
      this.storage.sql.exec(`DELETE FROM projection_keys`);
      this.storage.sql.exec(`DELETE FROM activity_delivery_receipts`);
      this.storage.sql.exec(`DELETE FROM compaction_jobs`);
      this.storage.sql.exec(`DELETE FROM active_output_turns`);
      this.storage.sql.exec(`DELETE FROM terminal_commands`);
      this.storage.sql.exec(`DELETE FROM run_events`);
      this.storage.sql.exec(`DELETE FROM due_work`);
      this.storage.sql.exec(`DELETE FROM grant_sessions`);
      for (const table of RESET_TABLES) this.storage.sql.exec(`DELETE FROM ${table}`);
      this.storage.sql.exec(`DELETE FROM content_refs`);
      this.storage.sql.exec(`DELETE FROM substreams WHERE id != '0'`);
      this.storage.sql.exec(
        `INSERT INTO realtime_state(id, event_sequence, updated_at) VALUES (1, 0, ?)
         ON CONFLICT(id) DO UPDATE SET event_sequence = 0, updated_at = excluded.updated_at`,
        Date.now(),
      );
      this.storage.sql.exec(
        `UPDATE workstream
            SET authority_mode = 'preparing', authority_generation = ?,
                state_reason_code = 'authority_importing', updated_at = ?
          WHERE id = 1`,
        request.generation,
        Date.now(),
      );
      this.storage.sql.exec(
        `INSERT INTO _data_migrations
           (campaign_id, target_version, phase, cursor, source_fence, source_hash,
            result_hash, pitr_bookmark, status, attempts, last_error_code, updated_at)
         VALUES (?, 2, 'importing', ?, ?, ?, NULL, NULL, 'running', 1, NULL, ?)
         ON CONFLICT(campaign_id) DO UPDATE SET
           phase = 'importing', cursor = excluded.cursor,
           source_fence = excluded.source_fence, source_hash = excluded.source_hash,
           result_hash = NULL, status = 'running', attempts = _data_migrations.attempts + 1,
           last_error_code = NULL, updated_at = excluded.updated_at`,
        request.campaignId,
        JSON.stringify({ stageIndex: 0, cursor: null, counts: {} } satisfies ImportCursor),
        String(request.sourceFence),
        request.sourceHash,
        Date.now(),
      );
      return { ok: true, replayed: false, phase: "importing" };
    });
  }

  private page(request: Extract<WorkstreamAuthorityImportRequest, { operation: "page" }>) {
    const calculatedHash = workstreamImportHash({
      campaignId: request.campaignId,
      generation: request.generation,
      stage: request.stage,
      priorCursor: request.priorCursor,
      cursor: request.cursor,
      rows: request.rows,
      stageComplete: request.stageComplete,
    });
    if (calculatedHash !== request.requestHash) throw new Error("workstream_import_page_hash_mismatch");
    return this.storage.transactionSync(() => {
      const receipt = first(this.storage.sql.exec<{ request_hash: string; result_hash: string }>(
        `SELECT request_hash, result_hash FROM _migration_command_receipts WHERE command_id = ?`,
        request.commandId,
      ));
      if (receipt) {
        if (receipt.request_hash !== request.requestHash) {
          throw new Error("workstream_import_command_conflict");
        }
        return { ok: true, replayed: true, resultHash: receipt.result_hash };
      }
      const row = migration(this.storage, request.campaignId);
      if (!row || row.status !== "running" || row.phase !== "importing") {
        throw new Error("workstream_import_not_running");
      }
      const root = first(this.storage.sql.exec<{ authority_generation: number }>(
        `SELECT authority_generation FROM workstream WHERE id = 1`,
      ));
      if (root?.authority_generation !== request.generation) {
        throw new Error("workstream_import_generation_mismatch");
      }
      const cursor = parseCursor(row.cursor);
      const expectedStage = IMPORT_STAGES[cursor.stageIndex];
      if (!expectedStage || expectedStage[0] !== request.stage) {
        throw new Error("workstream_import_stage_out_of_order");
      }
      if (cursor.cursor !== request.priorCursor) {
        throw new Error("workstream_import_prior_cursor_mismatch");
      }
      if (!request.stageComplete && request.priorCursor === request.cursor) {
        throw new Error("workstream_import_cursor_reused");
      }
      const [, table, columns] = expectedStage;
      const expectedKeys = [...columns].sort().join("\n");
      for (const importedRow of request.rows) {
        if (Object.keys(importedRow).sort().join("\n") !== expectedKeys) {
          throw new Error(`workstream_import_columns_mismatch:${request.stage}`);
        }
      }
      const placeholders = columns.map(() => "?").join(", ");
      if (table === "workstream") {
        if (request.rows.length !== 1 || !request.stageComplete) {
          throw new Error("workstream_import_root_cardinality");
        }
        const mutableColumns = columns.filter((column) =>
          column !== "workstream_key" && column !== "parent_workspace_key");
        const importedRow = request.rows[0]!;
        const changed = this.storage.sql.exec<{ id: number }>(
          `UPDATE workstream SET ${mutableColumns.map((column) => `${column} = ?`).join(", ")}
            WHERE id = 1 AND workstream_key = ? AND parent_workspace_key = ?
            RETURNING id`,
          ...mutableColumns.map((column) => importedRow[column] ?? null),
          importedRow.workstream_key ?? null,
          importedRow.parent_workspace_key ?? null,
        );
        if (changed.toArray().length !== 1) throw new Error("workstream_import_root_identity_mismatch");
      } else {
        for (const importedRow of request.rows) {
          this.storage.sql.exec(
            `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
            ...columns.map((column) => importedRow[column] ?? null),
          );
        }
      }
      const counts = { ...cursor.counts };
      counts[request.stage] = (counts[request.stage] ?? 0) + request.rows.length;
      const nextCursor: ImportCursor = request.stageComplete
        ? { stageIndex: cursor.stageIndex + 1, cursor: null, counts }
        : { stageIndex: cursor.stageIndex, cursor: request.cursor, counts };
      const resultHash = workstreamImportHash({
        prior: row.result_hash,
        requestHash: request.requestHash,
        count: counts[request.stage],
      });
      const now = Date.now();
      this.storage.sql.exec(
        `UPDATE _data_migrations SET cursor = ?, result_hash = ?, updated_at = ?
          WHERE campaign_id = ? AND phase = 'importing' AND status = 'running'`,
        JSON.stringify(nextCursor),
        resultHash,
        now,
        request.campaignId,
      );
      this.storage.sql.exec(
        `INSERT INTO _migration_command_receipts
           (command_id, campaign_id, command_kind, request_hash, result_hash, result_code, completed_at)
         VALUES (?, ?, 'import_page', ?, ?, 'applied', ?)`,
        request.commandId,
        request.campaignId,
        request.requestHash,
        resultHash,
        now,
      );
      return { ok: true, replayed: false, resultHash, nextStageIndex: nextCursor.stageIndex };
    });
  }

  private verify(request: Extract<WorkstreamAuthorityImportRequest, { operation: "verify" }>) {
    return this.storage.transactionSync(() => {
      const row = migration(this.storage, request.campaignId);
      if (row?.status === "completed" && row.phase === "verified") {
        return { ok: true, phase: "verified", resultHash: row.result_hash, replayed: true };
      }
      if (!row || row.status !== "running" || row.phase !== "importing") {
        throw new Error("workstream_import_not_running");
      }
      const cursor = parseCursor(row.cursor);
      if (cursor.stageIndex !== IMPORT_STAGES.length) {
        throw new Error("workstream_import_incomplete");
      }
      if (row.result_hash !== request.expectedPageHash) {
        throw new Error("workstream_import_page_chain_mismatch");
      }
      for (const stage of WORKSTREAM_AUTHORITY_IMPORT_STAGES) {
        if ((cursor.counts[stage] ?? 0) !== (request.expectedCounts[stage] ?? 0)) {
          throw new Error(`workstream_import_count_mismatch:${stage}`);
        }
      }
      const violation = first(this.storage.sql.exec<Record<string, SqlStorageValue>>(
        `PRAGMA foreign_key_check`,
      ));
      if (violation) throw new Error("workstream_import_foreign_key_violation");
      const orphanedRun = first(this.storage.sql.exec<{ run_id: string }>(
        `SELECT child.run_id
           FROM runs child
          WHERE (child.parent_run_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM runs parent WHERE parent.run_id = child.parent_run_id
                ))
             OR (child.chain_root_run_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM runs root WHERE root.run_id = child.chain_root_run_id
                ))
          LIMIT 1`,
      ));
      if (orphanedRun) throw new Error("workstream_import_run_lineage_orphan");
      const sequence = first(this.storage.sql.exec<{
        next_sequence_number: number;
        max_sequence: number | null;
      }>(
        `SELECT w.next_sequence_number, MAX(p.sequence_number) AS max_sequence
           FROM workstream w LEFT JOIN parts p ON TRUE WHERE w.id = 1`,
      ));
      const sourceFence = Number(row.source_fence);
      if (
        !sequence
        || sequence.next_sequence_number !== sourceFence + 1
        || (sequence.max_sequence ?? 0) > sourceFence
      ) throw new Error("workstream_import_sequence_fence_mismatch");
      const resultHash = workstreamImportHash({
        generation: request.generation,
        sourceFence,
        sourceHash: row.source_hash,
        pageHash: row.result_hash,
        counts: cursor.counts,
        maxSequence: sequence.max_sequence ?? 0,
      });
      const now = Date.now();
      this.storage.sql.exec(
        `UPDATE _data_migrations
            SET phase = 'verified', status = 'completed', result_hash = ?, updated_at = ?
          WHERE campaign_id = ?`,
        resultHash,
        now,
        request.campaignId,
      );
      this.storage.sql.exec(
        `UPDATE workstream SET state_reason_code = 'authority_import_verified', updated_at = ?
          WHERE id = 1 AND authority_generation = ?`,
        now,
        request.generation,
      );
      return { ok: true, phase: "verified", resultHash, counts: cursor.counts };
    });
  }

  private activate(request: Extract<WorkstreamAuthorityImportRequest, { operation: "activate" }>) {
    return this.storage.transactionSync(() => {
      const row = migration(this.storage, request.campaignId);
      if (!row || row.phase !== "verified" || row.status !== "completed") {
        throw new Error("workstream_import_not_verified");
      }
      const changed = this.storage.sql.exec<{ id: number }>(
        `UPDATE workstream
            SET authority_mode = 'authoritative', state_reason_code = 'authoritative', updated_at = ?
          WHERE id = 1 AND authority_generation = ?
            AND authority_mode IN ('preparing', 'authoritative')
          RETURNING id`,
        Date.now(),
        request.generation,
      );
      if (changed.toArray().length !== 1) throw new Error("workstream_import_activation_failed");
      return { ok: true, phase: "authoritative", resultHash: row.result_hash };
    });
  }
}
