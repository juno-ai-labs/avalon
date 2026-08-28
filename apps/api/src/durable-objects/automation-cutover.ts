import { AgentModelOverrideSchema, AutomationDraftSchema, asAutomationId, asWorkspaceId } from "@rally/contracts";
import { z } from "zod";
import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { automationAgentName } from "./names";
import { canonicalTranscriptJson } from "./ordered-transcript-sqlite/canonical-payload-store";

const CutoverRequestSchema = z.object({
  workspaceId: z.string().uuid(),
  expectedDraftIds: z.array(z.string().uuid()),
}).strict();

type ProjectionWriter = (input: unknown) => Promise<{ applied: boolean }>;

function rows(
  storage: DurableObjectStorage,
  sql: string,
  ...bindings: SqlStorageValue[]
): Record<string, SqlStorageValue>[] {
  return storage.sql.exec<Record<string, SqlStorageValue>>(sql, ...bindings).toArray();
}

/** All values the destructive half can remove, captured as one stable witness. */
function legacyAutomationWitness(storage: DurableObjectStorage, workspaceId: string): unknown {
  const automationScope = `memory_scope_id IN (
    SELECT memory_scope_id FROM memory_scopes
     WHERE workspace_id = ? AND kind = 'automation'
  )`;
  return {
    subscriptions: rows(storage,
      `SELECT * FROM automation_subscriptions WHERE workspace_id = ? ORDER BY id`, workspaceId),
    schedules: rows(storage,
      `SELECT * FROM schedules WHERE workspace_id = ? AND automation_subscription_id IS NOT NULL ORDER BY id`, workspaceId),
    runs: rows(storage,
      `SELECT * FROM automation_runs WHERE workspace_id = ? ORDER BY id`, workspaceId),
    deliveryTargets: rows(storage,
      `SELECT target.* FROM automation_delivery_targets target
        JOIN automation_subscriptions subscription ON subscription.id = target.automation_subscription_id
       WHERE subscription.workspace_id = ? ORDER BY target.id`, workspaceId),
    resources: rows(storage,
      `SELECT resource.* FROM automation_resources resource
        JOIN automation_subscriptions subscription ON subscription.id = resource.automation_subscription_id
       WHERE subscription.workspace_id = ? ORDER BY resource.automation_subscription_id, resource.resource_id`, workspaceId),
    emailReceipts: rows(storage,
      `SELECT * FROM automation_email_receipts WHERE workspace_id = ?
       ORDER BY automation_subscription_id, resend_email_id`, workspaceId),
    emailRateWindows: rows(storage,
      `SELECT * FROM automation_email_rate_windows WHERE workspace_id = ?
       ORDER BY automation_subscription_id, window_started_at`, workspaceId),
    privateTemplates: rows(storage,
      `SELECT * FROM automation_templates WHERE workspace_id = ? AND sharing_state = 'private' ORDER BY id`, workspaceId),
    privateTemplateVersions: rows(storage,
      `SELECT version.* FROM automation_template_versions version
        JOIN automation_templates template ON template.id = version.template_id
       WHERE template.workspace_id = ? AND template.sharing_state = 'private'
       ORDER BY version.template_id, version.version_number`, workspaceId),
    memoryScopes: rows(storage,
      `SELECT * FROM memory_scopes WHERE workspace_id = ? AND kind = 'automation' ORDER BY memory_scope_id`, workspaceId),
    memoryItems: rows(storage,
      `SELECT * FROM memory_items WHERE ${automationScope} ORDER BY memory_item_id`, workspaceId),
    memoryMutations: rows(storage,
      `SELECT * FROM memory_mutations WHERE ${automationScope} ORDER BY memory_mutation_id`, workspaceId),
    memoryIndexOutbox: rows(storage,
      `SELECT * FROM memory_index_outbox WHERE ${automationScope} ORDER BY outbox_id`, workspaceId),
    memoryTables: rows(storage,
      `SELECT * FROM memory_tables WHERE ${automationScope} ORDER BY memory_table_id`, workspaceId),
    memoryTableColumns: rows(storage,
      `SELECT column.* FROM memory_table_columns column
        JOIN memory_tables memory_table ON memory_table.memory_table_id = column.memory_table_id
       WHERE memory_table.memory_scope_id IN (
         SELECT memory_scope_id FROM memory_scopes WHERE workspace_id = ? AND kind = 'automation'
       ) ORDER BY column.memory_table_id, column.position`, workspaceId),
    memoryTableRows: rows(storage,
      `SELECT * FROM memory_table_rows WHERE ${automationScope} ORDER BY memory_table_row_id`, workspaceId),
    memoryTableCells: rows(storage,
      `SELECT cell.* FROM memory_table_cells cell
        JOIN memory_tables memory_table ON memory_table.memory_table_id = cell.memory_table_id
       WHERE memory_table.memory_scope_id IN (
         SELECT memory_scope_id FROM memory_scopes WHERE workspace_id = ? AND kind = 'automation'
       ) ORDER BY cell.memory_table_id, cell.memory_table_row_id, cell.memory_table_column_id`, workspaceId),
    memoryTableMutations: rows(storage,
      `SELECT * FROM memory_table_mutations WHERE ${automationScope} ORDER BY memory_table_mutation_id`, workspaceId),
  };
}

type LegacyMemoryRecordKind =
  | "scope"
  | "item"
  | "mutation"
  | "index_receipt"
  | "table"
  | "table_column"
  | "table_row"
  | "table_cell"
  | "table_mutation";

function legacyMemoryRecords(
  storage: DurableObjectStorage,
  workspaceId: string,
  automationId: string,
): Array<{ kind: LegacyMemoryRecordKind; recordId: string; payload: Record<string, SqlStorageValue> }> {
  const scopeRows = rows(storage,
    `SELECT * FROM memory_scopes
      WHERE workspace_id = ? AND kind = 'automation' AND owner_id = ?
      ORDER BY memory_scope_id`, workspaceId, automationId);
  const scopeIds = scopeRows.map((row) => String(row.memory_scope_id));
  if (scopeIds.length === 0) return [];
  const placeholders = scopeIds.map(() => "?").join(",");
  const records: Array<{ kind: LegacyMemoryRecordKind; recordId: string; payload: Record<string, SqlStorageValue> }> = [];
  const add = (
    kind: LegacyMemoryRecordKind,
    id: string,
    sourceRows: Record<string, SqlStorageValue>[],
  ): void => {
    for (const row of sourceRows) records.push({ kind, recordId: String(row[id]), payload: row });
  };
  add("scope", "memory_scope_id", scopeRows);
  add("item", "memory_item_id", rows(storage,
    `SELECT * FROM memory_items WHERE memory_scope_id IN (${placeholders}) ORDER BY memory_item_id`, ...scopeIds));
  add("mutation", "memory_mutation_id", rows(storage,
    `SELECT * FROM memory_mutations WHERE memory_scope_id IN (${placeholders}) ORDER BY memory_mutation_id`, ...scopeIds));
  add("index_receipt", "outbox_id", rows(storage,
    `SELECT * FROM memory_index_outbox WHERE memory_scope_id IN (${placeholders}) ORDER BY outbox_id`, ...scopeIds));
  const tableRows = rows(storage,
    `SELECT * FROM memory_tables WHERE memory_scope_id IN (${placeholders}) ORDER BY memory_table_id`, ...scopeIds);
  add("table", "memory_table_id", tableRows);
  const tableIds = tableRows.map((row) => String(row.memory_table_id));
  if (tableIds.length === 0) return records;
  const tablePlaceholders = tableIds.map(() => "?").join(",");
  add("table_column", "memory_table_column_id", rows(storage,
    `SELECT * FROM memory_table_columns WHERE memory_table_id IN (${tablePlaceholders})
      ORDER BY memory_table_id, position`, ...tableIds));
  add("table_row", "memory_table_row_id", rows(storage,
    `SELECT * FROM memory_table_rows WHERE memory_table_id IN (${tablePlaceholders})
      ORDER BY memory_table_id, memory_table_row_id`, ...tableIds));
  for (const row of rows(storage,
    `SELECT * FROM memory_table_cells WHERE memory_table_id IN (${tablePlaceholders})
      ORDER BY memory_table_id, memory_table_row_id, memory_table_column_id`, ...tableIds)) {
    records.push({
      kind: "table_cell",
      recordId: `${String(row.memory_table_row_id)}:${String(row.memory_table_column_id)}`,
      payload: row,
    });
  }
  add("table_mutation", "memory_table_mutation_id", rows(storage,
    `SELECT * FROM memory_table_mutations WHERE memory_scope_id IN (${placeholders})
      ORDER BY memory_table_mutation_id`, ...scopeIds));
  return records;
}

function epoch(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Final WorkspaceDO schedule shape: connector and digest scheduling only. */
export function removeLegacyAutomationSchema(storage: DurableObjectStorage): void {
  const names = new Set(storage.sql.exec<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table'`,
  ).toArray().map((row) => row.name));
  if (!names.has("automation_subscriptions")) return;
  storage.transactionSync(() => {
    storage.sql.exec(`DELETE FROM memory_scopes WHERE kind = 'automation'`);
    storage.sql.exec(`CREATE TABLE schedules_cutover (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_connection_id TEXT,
      digest_schedule_id TEXT REFERENCES digest_schedules(id) ON DELETE CASCADE,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('calendar', 'interval')),
      rrule TEXT,
      interval_seconds INTEGER,
      timezone TEXT NOT NULL,
      next_run_at TEXT NOT NULL,
      last_run_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((connector_connection_id IS NOT NULL) + (digest_schedule_id IS NOT NULL) = 1),
      CHECK ((schedule_type = 'calendar' AND rrule IS NOT NULL AND interval_seconds IS NULL)
        OR (schedule_type = 'interval' AND rrule IS NULL AND interval_seconds IS NOT NULL))
    ) STRICT`);
    storage.sql.exec(`INSERT INTO schedules_cutover
      (id, workspace_id, connector_connection_id, digest_schedule_id, schedule_type,
       rrule, interval_seconds, timezone, next_run_at, last_run_at, enabled,
       version, created_at, updated_at)
      SELECT id, workspace_id, connector_connection_id, digest_schedule_id, schedule_type,
             rrule, interval_seconds, timezone, next_run_at, last_run_at, enabled,
             version, created_at, updated_at
        FROM schedules WHERE automation_subscription_id IS NULL`);
    storage.sql.exec(`DROP TABLE schedules`);
    storage.sql.exec(`ALTER TABLE schedules_cutover RENAME TO schedules`);
    storage.sql.exec(`CREATE INDEX schedules_due_idx ON schedules(enabled, next_run_at, id)`);
    storage.sql.exec(`CREATE INDEX schedules_digest_idx
      ON schedules(digest_schedule_id) WHERE digest_schedule_id IS NOT NULL`);
    for (const table of [
      "automation_email_receipts",
      "automation_email_rate_windows",
      "automation_delivery_targets",
      "automation_resources",
      "automation_runs",
      "automation_subscriptions",
    ]) storage.sql.exec(`DROP TABLE ${table}`);
    storage.sql.exec(`DELETE FROM automation_templates WHERE sharing_state = 'private'`);
    const violation = storage.sql.exec<Record<string, SqlStorageValue>>(`PRAGMA foreign_key_check`).toArray()[0];
    if (violation) throw new Error("automation_cutover_foreign_key_violation");
  });
}

export function automationCutoverWitness(
  storage: DurableObjectStorage,
  workspaceId: string,
): { draftIds: string[] } {
  const campaign = storage.sql.exec<{ state: string }>(
    `SELECT state FROM automation_cutover_campaign WHERE id = 1`,
  ).toArray()[0];
  if (campaign?.state === "completed") return { draftIds: [] };
  return {
    draftIds: storage.sql.exec<{ id: string }>(
      `SELECT id FROM automation_subscriptions
        WHERE workspace_id = ? AND status = 'draft' ORDER BY id`,
      workspaceId,
    ).toArray().map((row) => row.id),
  };
}

/** Cross-object awaits are receipt-fenced; deletion remains one final local transaction. */
export async function cutoverWorkspaceAutomations(input: {
  env: Env;
  storage: DurableObjectStorage;
  request: unknown;
  applyProjection: ProjectionWriter;
}): Promise<{ state: "completed"; imported: number; discardedDrafts: number; sourceHash: string }> {
  const request = CutoverRequestSchema.parse(input.request);
  const prior = input.storage.sql.exec<{
    state: string;
    source_hash: string | null;
    source_witness_json: string | null;
  }>(`SELECT state, source_hash, source_witness_json FROM automation_cutover_campaign WHERE id = 1`)
    .toArray()[0];
  if (prior?.state === "completed") {
    const witness = prior.source_witness_json ? JSON.parse(prior.source_witness_json) : {};
    return {
      state: "completed",
      imported: Number(witness.acceptedCount ?? 0),
      discardedDrafts: Number(witness.draftCount ?? 0),
      sourceHash: prior.source_hash ?? "fresh",
    };
  }

  const rows = input.storage.sql.exec<Record<string, SqlStorageValue>>(
    `SELECT subscription.*, template.owner_user_id AS template_owner_user_id,
            template.name, template.description, version.instructions, version.overview,
            version.trigger_definitions_json, version.required_capabilities_json,
            version.expected_outputs_json, version.default_behavior_json,
            version.recommended_plugins_json, version.memory_tables_json
       FROM automation_subscriptions subscription
       JOIN automation_templates template ON template.id = subscription.template_id
       JOIN automation_template_versions version ON version.id = subscription.template_version_id
      WHERE subscription.workspace_id = ? ORDER BY subscription.id`,
    request.workspaceId,
  ).toArray();
  const draftIds = rows.filter((row) => row.status === "draft").map((row) => String(row.id)).sort();
  const expectedDraftIds = [...request.expectedDraftIds].sort();
  if (JSON.stringify(draftIds) !== JSON.stringify(expectedDraftIds)) {
    throw new Error("automation_cutover_draft_witness_mismatch");
  }
  const accepted = rows.filter((row) => row.status !== "draft" && row.lifecycle_state === "visible");
  const witness = {
    acceptedIds: accepted.map((row) => String(row.id)),
    draftIds,
    acceptedCount: accepted.length,
    draftCount: draftIds.length,
  };
  const sourceHash = await sha256(canonicalTranscriptJson(
    legacyAutomationWitness(input.storage, request.workspaceId),
  ));
  if (prior?.source_hash && prior.source_hash !== sourceHash) {
    throw new Error("automation_cutover_source_changed");
  }
  input.storage.sql.exec(
    `INSERT INTO automation_cutover_campaign
       (id, workspace_id, state, source_hash, source_witness_json, cursor_json, updated_at)
     VALUES (1, ?, 'importing', ?, ?, '{}', ?)
     ON CONFLICT(id) DO UPDATE SET state = 'importing', source_hash = excluded.source_hash,
       source_witness_json = excluded.source_witness_json, updated_at = excluded.updated_at`,
    request.workspaceId,
    sourceHash,
    JSON.stringify(witness),
    Date.now(),
  );

  for (const row of accepted) {
    const automationId = String(row.id);
    const triggers = z.array(z.unknown()).parse(JSON.parse(String(row.trigger_definitions_json)));
    const unsupportedTrigger = triggers.some((trigger) => {
      const kind = typeof trigger === "object" && trigger !== null && "type" in trigger
        ? (trigger as { type?: unknown }).type : null;
      return kind !== "manual" && kind !== "calendar" && kind !== "interval";
    });
    const definition = AutomationDraftSchema.parse({
      name: row.name,
      description: row.description,
      overview: String(row.overview) || row.description,
      instructions: row.instructions,
      triggers,
      requiredCapabilities: JSON.parse(String(row.required_capabilities_json)),
      expectedOutputs: JSON.parse(String(row.expected_outputs_json)),
      requestedDelivery: [],
      defaultBehavior: JSON.parse(String(row.default_behavior_json)),
      recommendedPlugins: JSON.parse(String(row.recommended_plugins_json)),
      memoryTables: JSON.parse(String(row.memory_tables_json)),
      suggestedScope: row.scope,
      followUpQuestion: null,
      elicitation: null,
      ready: true,
    });
    const deliveryTargets = input.storage.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT target_type, connection_id, slack_team_id, slack_user_id, email_address
         FROM automation_delivery_targets
        WHERE automation_subscription_id = ? AND status <> 'disabled' ORDER BY target_type`,
      automationId,
    ).toArray().map((target) => target.target_type === "email"
      ? { type: "email" as const, emailAddress: String(target.email_address) }
      : {
          type: "slack_agent_dm" as const,
          connectionId: String(target.connection_id),
          slackTeamId: String(target.slack_team_id),
          slackUserId: String(target.slack_user_id),
        });
    const createdAt = epoch(String(row.created_at)) ?? 0;
    const updatedAt = epoch(String(row.updated_at)) ?? createdAt;
    const schedules = input.storage.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT id, schedule_type, rrule, interval_seconds, timezone, next_run_at
         FROM schedules WHERE automation_subscription_id = ? ORDER BY id`, automationId,
    ).toArray().map((schedule) => ({
      scheduleId: String(schedule.id),
      kind: schedule.schedule_type as "calendar" | "interval",
      definition: schedule.schedule_type === "interval"
        ? { intervalSeconds: Number(schedule.interval_seconds), acceptedAt: createdAt }
        : { rrule: String(schedule.rrule), timezone: String(schedule.timezone), acceptedAt: createdAt },
      nextDueAt: epoch(String(schedule.next_run_at)),
    }));
    const runs = input.storage.sql.exec<Record<string, SqlStorageValue>>(
      `SELECT id, workstream_id, trigger_type, planned_for, status,
              workflow_instance_id, created_at, started_at, completed_at
         FROM automation_runs WHERE automation_subscription_id = ? ORDER BY created_at, id`,
      automationId,
    ).toArray().map((run) => ({
      runId: String(run.id),
      workstreamId: String(run.workstream_id),
      triggerType: String(run.trigger_type),
      plannedFor: run.planned_for === null ? null : epoch(String(run.planned_for)),
      status: run.status,
      workflowInstanceId: run.workflow_instance_id === null ? null : String(run.workflow_instance_id),
      createdAt: epoch(String(run.created_at)) ?? 0,
      updatedAt: epoch(run.completed_at === null
        ? run.started_at === null ? String(run.created_at) : String(run.started_at)
        : String(run.completed_at)) ?? 0,
    }));
    const principal = z.object({ userId: z.string().uuid().optional() }).passthrough()
      .parse(JSON.parse(String(row.execution_principal_json)));
    const authorUserId = row.owner_user_id === null
      ? principal.userId ?? String(row.template_owner_user_id)
      : String(row.owner_user_id);
    const source = {
      definition,
      status: row.status,
      unsupportedTrigger,
      scope: row.scope,
      defaultPluginIds: z.array(z.string()).parse(JSON.parse(String(row.default_plugins_json))),
      activitySourcePluginIds: z.record(z.string(), z.string())
        .parse(JSON.parse(String(row.activity_trigger_bindings_json))),
      connectorBindings: z.record(z.string(), z.string())
        .parse(JSON.parse(String(row.connector_bindings_json))),
      deliveryTargets,
      emailAddress: row.email_address === null ? null : String(row.email_address),
      modelOverride: row.model_override === null ? null : AgentModelOverrideSchema.parse(row.model_override),
      createdAt,
      updatedAt,
      schedules,
      runs,
      memoryRecords: legacyMemoryRecords(input.storage, request.workspaceId, automationId),
      // The inbound-email ledger travels with the automation. Without it the
      // new object starts with an empty dedupe table, so a Resend webhook
      // retry that straddles the cutover — the same message, redelivered
      // minutes later — finds no receipt, admits the email a second time, and
      // runs the automation again with output a person receives twice. The
      // rate window comes along for the same reason: dropping it hands every
      // automation a fresh hourly allowance at exactly the moment the fleet is
      // being restarted. Both tables were already hashed into the witness, so
      // they were being protected from changing underneath the cutover without
      // ever being carried through it.
      inboundEmailReceipts: input.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT resend_email_id, svix_id, payload_ref, workstream_id, automation_run_id,
                received_at, processed_at, error_json
           FROM automation_email_receipts
          WHERE workspace_id = ? AND automation_subscription_id = ?
          ORDER BY resend_email_id`,
        request.workspaceId,
        automationId,
      ).toArray().map((receipt) => ({
        resendEmailId: String(receipt.resend_email_id),
        svixId: String(receipt.svix_id),
        payloadRef: receipt.payload_ref === null ? null : String(receipt.payload_ref),
        workstreamId: receipt.workstream_id === null ? null : String(receipt.workstream_id),
        runId: receipt.automation_run_id === null ? null : String(receipt.automation_run_id),
        receivedAt: epoch(String(receipt.received_at)) ?? createdAt,
        // A legacy receipt records an attempt, not an outcome vocabulary this
        // object shares. `error_json` is the one honest signal it carries.
        refused: receipt.error_json !== null,
      })),
      inboundEmailRateWindows: input.storage.sql.exec<Record<string, SqlStorageValue>>(
        `SELECT window_started_at, accepted_count
           FROM automation_email_rate_windows
          WHERE workspace_id = ? AND automation_subscription_id = ?
          ORDER BY window_started_at`,
        request.workspaceId,
        automationId,
      ).toArray().map((window) => ({
        windowStartedAt: epoch(String(window.window_started_at)) ?? createdAt,
        acceptedCount: Number(window.accepted_count),
      })),
    };
    const automationSourceHash = await sha256(canonicalTranscriptJson(source));
    const agent = await durableObjectStubForWorkspace(
      input.env,
      input.env.AUTOMATION_AGENTS,
      asWorkspaceId(request.workspaceId),
      automationAgentName(input.env.AVALON_REGION, asWorkspaceId(request.workspaceId), asAutomationId(automationId)),
    );
    const receipt = await agent.importAcceptedAutomation({
      schemaVersion: 1,
      automationId,
      workspaceId: request.workspaceId,
      authorUserId,
      region: input.env.AVALON_REGION,
      sourceHash: automationSourceHash,
      source,
    });
    if (receipt.sourceHash !== automationSourceHash) throw new Error("automation_cutover_import_receipt_mismatch");
    await input.applyProjection({
      schemaVersion: 1,
      automationId,
      workspaceId: request.workspaceId,
      authorUserId,
      authorityGeneration: receipt.authorityGeneration,
      projectionVersion: 1,
      payloadHash: automationSourceHash,
      lifecycle: receipt.lifecycle,
      scope: row.scope,
      title: definition.name,
      description: definition.description,
      nextRunAt: schedules.reduce<number | null>((value, schedule) => (
        schedule.nextDueAt !== null && (value === null || schedule.nextDueAt < value)
          ? schedule.nextDueAt : value
      ), null),
      attentionCode: unsupportedTrigger ? "unsupported_trigger"
        : row.status === "error" ? "legacy_runtime_error" : null,
    });
  }

  if (await sha256(canonicalTranscriptJson(
    legacyAutomationWitness(input.storage, request.workspaceId),
  )) !== sourceHash) {
    throw new Error("automation_cutover_source_changed");
  }
  input.storage.sql.exec(
    `UPDATE automation_cutover_campaign SET state = 'cleaning', updated_at = ? WHERE id = 1`,
    Date.now(),
  );
  removeLegacyAutomationSchema(input.storage);
  input.storage.sql.exec(
    `UPDATE automation_cutover_campaign
        SET state = 'completed', completed_at = ?, updated_at = ? WHERE id = 1`,
    Date.now(),
    Date.now(),
  );
  return { state: "completed", imported: accepted.length, discardedDrafts: draftIds.length, sourceHash };
}
