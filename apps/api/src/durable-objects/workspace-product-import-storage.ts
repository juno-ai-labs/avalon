import type {
  WorkspaceProductImportRow,
  WorkspaceProductImportStage,
} from "./workspace-product-import";
import { isWorkspaceRelationalImportStage } from "./workspace-product-import";

type Kind = "value" | "epoch" | "integer" | "json_object" | "json_array" | "suggested_status";
type Column = readonly [target: string, source?: string, kind?: Kind, fallback?: string | number | null];

interface ImportShape {
  table: string;
  key: readonly string[];
  columns: readonly Column[];
}

const at = (name: string): Column => [name, name, "epoch"];
const value = (name: string, source = name, fallback: string | number | null = null): Column => (
  [name, source, "value", fallback]
);
const integer = (name: string, source = name, fallback: number | null = 0): Column => (
  [name, source, "integer", fallback]
);
const jsonObject = (name: string, source = name, fallback = "{}"): Column => (
  [name, source, "json_object", fallback]
);
const jsonArray = (name: string, source = name, fallback = "[]"): Column => (
  [name, source, "json_array", fallback]
);

const IMPORT_SHAPES: Partial<Record<WorkspaceProductImportStage, ImportShape>> = {
  activity_events: {
    table: "workspace_activity_events",
    key: ["event_sequence"],
    columns: [
      integer("event_sequence", "log_sequence"), value("event_id", "id"), value("event_type"),
      value("subject_type"), value("subject_id"), integer("subject_sequence_number", "subject_sequence_number", null),
      value("actor_type"), value("actor_user_id"), value("actor_label", "actor_label", ""),
      value("title"), value("body", "body", ""), value("canonical_url"), value("audience_kind"),
      value("audience_user_id"), value("audience_workstream_id"), integer("digestible", "digestible", 1),
      at("occurred_at"), at("created_at"), value("source_kind"), value("source_id"), value("dedupe_key"),
      jsonObject("metadata_json"),
    ],
  },
  activity_event_targets: {
    table: "workspace_activity_event_targets",
    key: ["event_id", "user_id", "relation"],
    columns: [value("event_id"), value("user_id"), value("relation"), at("created_at")],
  },
  workspace_connector_events: {
    table: "workspace_connector_events",
    key: ["event_id"],
    columns: [
      integer("event_sequence"), value("event_id"), value("payload_hash"), value("connection_id"),
      value("connection_scope"), value("connection_owner_user_id"), value("connector_type"),
      value("provider"), value("provider_event_id"), value("event_type"), value("resource_type"),
      value("provider_resource_id"), jsonObject("actor_json"), jsonObject("subject_json"), integer("occurred_at"),
      integer("received_at"), value("title"), value("summary", "summary", ""),
      value("text_snippet", "text_snippet", ""), value("payload_ref"), jsonObject("visibility_json"),
      jsonArray("target_user_ids_json", "target_user_ids_json"),
      jsonArray("entity_keys_json", "entity_keys_json"), value("dedupe_key"),
      value("raw_content_hash"), jsonObject("metadata_json"),
      jsonArray("external_people_json", "external_people_json"), value("processing_status"),
      integer("processing_attempt", "processing_attempt", -1), value("workflow_instance_id"),
      integer("claimed_at", "claimed_at", null), integer("processed_at", "processed_at", null),
      value("processing_error"), integer("created_at"), integer("updated_at"),
    ],
  },
  opportunity_batch_windows: {
    table: "opportunity_batch_windows",
    key: ["window_id"],
    columns: [
      value("window_id", "id"), value("partition_key"), value("audience_scope"), value("audience_user_id"),
      at("first_event_at"), at("last_event_at"), at("process_after"), value("status"),
      integer("attempt", "attempt", 0), value("lease_id"), at("lease_expires_at"), at("created_at"),
      at("updated_at"), at("completed_at"),
    ],
  },
  opportunity_batch_events: {
    table: "opportunity_batch_events",
    key: ["batch_event_id"],
    columns: [
      value("batch_event_id", "id"), value("window_id"), value("partition_key"), value("source_kind"),
      value("source_id"), at("occurred_at"), integer("input_characters"), value("status"),
      integer("attempt_count"), value("error_text"), at("created_at"), at("updated_at"),
    ],
  },
  work_opportunities: {
    table: "work_opportunities",
    key: ["opportunity_id"],
    columns: [
      value("opportunity_id", "id"), value("audience_scope"), value("audience_user_id"),
      value("display_prompt"), value("execution_prompt"), value("admission_reasoning"), value("provider_icon"),
      value("source_label"), value("source_fingerprint"), integer("version", "version", 1),
      value("display_prompt_hash"), value("execution_prompt_hash"), value("status"),
      value("created_workstream_id"), value("created_message_id"), value("started_by_user_id"),
      value("start_idempotency_key"), at("expires_at"), at("created_at"), at("updated_at"), at("started_at"),
    ],
  },
  opportunity_provenance_nodes: {
    table: "opportunity_provenance_nodes",
    key: ["node_id"],
    columns: [
      value("node_id", "id"), value("node_kind"), value("source_id"), value("provider"),
      value("provider_tenant_id"), value("canonical_url"), value("label", "label", ""), at("occurred_at"),
      value("visibility_scope"), value("visibility_user_id"), jsonObject("locator_json"), at("created_at"),
    ],
  },
  opportunity_provenance_edges: {
    table: "opportunity_provenance_edges",
    key: ["parent_node_id", "child_node_id", "relationship"],
    columns: [value("parent_node_id"), value("child_node_id"), value("relationship"), at("created_at")],
  },
  work_opportunity_provenance_roots: {
    table: "work_opportunity_provenance_roots",
    key: ["opportunity_id", "node_id"],
    columns: [value("opportunity_id"), value("node_id"), integer("position")],
  },
  work_opportunity_user_links: {
    table: "work_opportunity_user_links",
    key: ["link_id"],
    columns: [
      value("link_id", "id"), value("opportunity_id"), value("user_id"), value("role"), value("resolution"),
      value("reasoning", "reasoning", ""), value("provenance_node_id"), at("created_at"), at("updated_at"),
    ],
  },
  work_opportunity_user_states: {
    table: "work_opportunity_user_states",
    key: ["opportunity_id", "user_id"],
    columns: [
      value("opportunity_id"), value("user_id"), value("status"), integer("impression_count"),
      at("first_impressed_at"), at("last_impressed_at"), at("resolved_at"),
      value("created_workstream_id"), at("updated_at"),
    ],
  },
  suggested_work_sets: {
    table: "suggested_work_sets",
    key: ["user_id"],
    columns: [
      value("user_id"), value("candidate_fingerprint", "candidate_fingerprint", ""),
      jsonArray("opportunity_ids_json", "opportunity_ids_json"),
      value("ranking_reasoning", "ranking_reasoning", ""), value("model"),
      ["status", "status", "suggested_status", "stale"], at("due_at"), integer("request_seq"),
      value("lease_id"), at("lease_expires_at"), at("last_ranked_at"), at("created_at"), at("updated_at"),
    ],
  },
  suggested_work_ranking_rounds: {
    table: "suggested_work_ranking_rounds",
    key: ["round_id"],
    columns: [
      value("round_id", "id"), value("user_id"), jsonArray("candidate_ids_json", "candidate_ids_json"),
      jsonArray("selected_ids_json", "selected_ids_json"), value("reasoning", "reasoning", ""),
      value("model"), integer("round_number"), at("created_at"),
    ],
  },
  work_opportunity_snapshots: {
    table: "work_opportunity_snapshots",
    key: ["snapshot_id"],
    columns: [
      value("snapshot_id", "id"), value("opportunity_id"), integer("opportunity_version", "opportunity_version", 1),
      value("selected_by_user_id"), value("display_prompt_hash"), value("execution_prompt_hash"),
      jsonArray("identity_links_json", "identity_links_json"), jsonArray("provenance_json", "provenance_json"),
      at("created_at"),
    ],
  },
};

const RELATIONAL_KEYS = {
  connector_connections: ["id"],
  webhook_receipts: ["id"],
  connector_oauth_attempts: ["id"],
  external_user_identities: ["id"],
  workspace_sandbox_network_policies: ["workspace_id"],
  workspace_sandbox_network_domains: ["workspace_id", "domain"],
  workspace_sandbox_network_policy_mutations: ["workspace_id", "id"],
  slack_agent_policies: ["connection_id"],
  slack_agent_channel_allowlist: ["connection_id", "slack_channel_id"],
  slack_delivery_preferences: ["connection_id", "user_id"],
  slack_user_links: ["id"],
  slack_agent_contexts: ["connection_id", "slack_user_id"],
  slack_agent_feedback: ["id"],
  slack_agent_sessions: ["id"],
  slack_agent_thread_claims: ["connection_id", "slack_channel_id", "slack_thread_ts"],
  slack_ingress_jobs: ["id"],
  slack_link_challenges: ["token_hash"],
  slack_agent_pending_prompts: [
    "connection_id", "slack_channel_id", "slack_thread_ts", "slack_user_id",
  ],
  slack_unfurled_links: ["connection_id", "slack_channel_id", "slack_message_ts", "url"],
  automation_templates: ["id"],
  automation_template_versions: ["id"],
  automation_subscriptions: ["id"],
  automation_runs: ["id"],
  automation_delivery_targets: ["id"],
  automation_email_receipts: ["resend_email_id", "automation_subscription_id"],
  automation_email_rate_windows: ["automation_subscription_id", "window_started_at"],
  digest_schedules: ["id"],
  digest_schedule_times: ["digest_schedule_id", "minute_of_day"],
  digest_delivery_targets: ["id"],
  digest_deliveries: ["id"],
  schedules: ["id"],
  resources: ["id"],
  automation_resources: ["automation_subscription_id", "resource_id"],
  resource_watches: ["id"],
  resource_object_deletion_outbox: ["object_ref"],
  notes: ["id"],
  note_transcript_segments: ["id"],
  note_privacy_change_outbox: ["id"],
  memory_scopes: ["memory_scope_id"],
  memory_items: ["memory_item_id"],
  memory_mutations: ["memory_mutation_id"],
  memory_index_outbox: ["outbox_id"],
  memory_tables: ["memory_table_id"],
  memory_table_columns: ["memory_table_column_id"],
  memory_table_rows: ["memory_table_row_id"],
  memory_table_cells: ["memory_table_row_id", "memory_table_column_id"],
  memory_table_mutations: ["memory_table_mutation_id"],
  workstream_notification_intents: ["intent_id"],
} as const satisfies Partial<Record<WorkspaceProductImportStage, readonly string[]>>;

function importRelationalRows(
  storage: DurableObjectStorage,
  stage: WorkspaceProductImportStage,
  rows: WorkspaceProductImportRow[],
): number {
  if (!isWorkspaceRelationalImportStage(stage)) throw new Error("workspace_import_stage_unknown");
  const keys = RELATIONAL_KEYS[stage as keyof typeof RELATIONAL_KEYS];
  if (!keys) throw new Error(`workspace_import_keys_missing:${stage}`);
  return storage.transactionSync(() => {
    let accepted = 0;
    for (const row of rows) {
      const columns = Object.keys(row).sort();
      if (columns.length === 0 || columns.some((column) => !/^[a-z][a-z0-9_]*$/u.test(column))) {
        throw new Error(`workspace_import_columns_invalid:${stage}`);
      }
      if (keys.some((key) => !(key in row))) throw new Error(`workspace_import_key_missing:${stage}`);
      const values = columns.map((column) => row[column] ?? null) as SqlStorageValue[];
      storage.sql.exec(
        `INSERT OR IGNORE INTO ${stage} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        ...values,
      );
      const keyValues = keys.map((key) => row[key] ?? null) as SqlStorageValue[];
      const stored = storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT ${columns.join(", ")} FROM ${stage}
          WHERE ${keys.map((key) => `${key} IS ?`).join(" AND ")} LIMIT 1`,
        ...keyValues,
      ).toArray()[0];
      if (!stored || columns.some((column, index) => stored[column] !== values[index])) {
        throw new Error(`workspace_import_conflict:${stage}`);
      }
      accepted += 1;
    }
    return accepted;
  });
}

function converted(row: WorkspaceProductImportRow, column: Column): SqlStorageValue {
  const [, source = column[0], kind = "value", fallback = null] = column;
  const raw = row[source] ?? fallback;
  if (raw === null) return null;
  if (kind === "integer") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`workspace_product_import_integer_invalid:${source}`);
    }
    return Math.trunc(parsed);
  }
  if (kind === "epoch") {
    if (typeof raw === "number") return Math.trunc(raw);
    const parsed = Date.parse(String(raw));
    if (!Number.isFinite(parsed)) throw new Error(`workspace_product_import_timestamp_invalid:${source}`);
    return parsed;
  }
  if (kind === "json_object" || kind === "json_array") {
    const serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
    const parsed: unknown = JSON.parse(serialized);
    const valid = kind === "json_array"
      ? Array.isArray(parsed)
      : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
    if (!valid) throw new Error(`workspace_product_import_json_shape_invalid:${source}`);
    return serialized;
  }
  if (kind === "suggested_status") return raw === "ranking" ? "stale" : String(raw);
  return raw;
}

/** Idempotent, FK-ordered maintenance import into an otherwise empty WorkspaceDO. */
export function importWorkspaceProductRows(
  storage: DurableObjectStorage,
  stage: WorkspaceProductImportStage,
  rows: WorkspaceProductImportRow[],
): number {
  const shape = IMPORT_SHAPES[stage];
  if (!shape) return importRelationalRows(storage, stage, rows);
  const columns = shape.columns.map(([target]) => target);
  const placeholders = columns.map(() => "?").join(", ");
  return storage.transactionSync(() => {
    let accepted = 0;
    for (const row of rows) {
      const values = shape.columns.map((column) => converted(row, column));
      storage.sql.exec(
        `INSERT OR IGNORE INTO ${shape.table} (${columns.join(", ")}) VALUES (${placeholders})`,
        ...values,
      );
      const expected = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const keyValues = shape.key.map((column) => expected[column] ?? null);
      const stored = storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT ${columns.join(", ")} FROM ${shape.table}
          WHERE ${shape.key.map((column) => `${column} IS ?`).join(" AND ")} LIMIT 1`,
        ...keyValues,
      ).toArray()[0];
      const matches = stored !== undefined && columns.every((column) => stored[column] === expected[column]);
      if (!matches) throw new Error(`workspace_product_import_conflict:${stage}`);
      accepted += 1;
    }
    return accepted;
  });
}
