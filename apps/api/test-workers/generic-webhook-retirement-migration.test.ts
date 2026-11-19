/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AutomationDraftSchema } from "@rally/contracts";
import { createConnectorRegistry } from "@rally/connectors";
import { expect, it } from "vitest";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do-schema-migrations";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { sidekickSourceRegistrations } from "../src/durable-objects/sidekick-source-registrations";

const WORKSPACE = "00000000-0000-7000-8000-0000000ab001";
const USER = "00000000-0000-7000-8000-0000000ab002";
const WEBHOOK = "00000000-0000-7000-8000-0000000ab003";
const LINEAR = "00000000-0000-7000-8000-0000000ab004";
const SIDEKICK = "00000000-0000-7000-8000-0000000ab005";
const WEBHOOK_EVALUATOR = "00000000-0000-7000-8000-0000000ab007";
const LINEAR_EVALUATOR = "00000000-0000-7000-8000-0000000ab008";

const webhookEvaluator = {
  evaluatorId: WEBHOOK_EVALUATOR,
  source: { connectorType: "generic_webhook", connectionId: WEBHOOK, eventType: "deploy.finished" },
  when: { kind: "always" },
};
const linearEvaluator = {
  evaluatorId: LINEAR_EVALUATOR,
  source: { connectorType: "linear", connectionId: LINEAR, eventType: "linear.issue.created" },
  when: { kind: "always" },
};
const linearTrigger = {
  type: "connector_activity", connectorType: "linear", sourceBindingKey: "issues",
  suggestedSourcePluginId: "plugin_linear", eventTypes: ["linear.issue.created"], deterministicFilters: {},
};
const intervalTrigger = { type: "interval", intervalSeconds: 3_600, summary: "Hourly" };
/** A whole stored draft, so what the purge leaves is checked against the schema that reads it. */
const definition = {
  name: "Deploy and issue watcher",
  description: "Reports deploys and new issues.",
  overview: "Watches a deploy webhook and Linear.",
  instructions: "Say what happened.",
  triggers: [
    { type: "webhook", sourceBindingKey: "deploys", suggestedSourcePluginId: "plugin_webhook", eventTypes: ["deploy.finished"] },
    {
      type: "connector_activity", connectorType: "generic_webhook", sourceBindingKey: "deploys",
      suggestedSourcePluginId: "plugin_webhook", eventTypes: ["deploy.failed"], deterministicFilters: {},
    },
    linearTrigger,
    intervalTrigger,
  ],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [
    { pluginId: "plugin_webhook", recommendedTools: [], reason: "Deploys" },
    { pluginId: "plugin_linear", recommendedTools: [], reason: "Issues" },
  ],
  memoryTables: [],
  customTools: [],
  suggestedScope: "personal",
  followUpQuestion: null,
  elicitation: null,
  ready: false,
};
const rules = {
  schemaVersion: 1,
  evaluators: [
    { evaluatorKey: "deploys", source: { sourceBindingKey: "deploys", suggestedSourcePluginId: "plugin_webhook", event: { kind: "event_type", eventType: "deploy.finished" } }, when: { kind: "always" } },
    { evaluatorKey: "issues", source: { sourceBindingKey: "issues", suggestedSourcePluginId: "plugin_linear", event: { kind: "event_type", eventType: "linear.issue.created" } }, when: { kind: "always" } },
  ],
};

/** A tool that reads Linear, and one that only the webhook served. */
const linearTool = {
  name: "issue_lookup", description: "Looks an issue up.", inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
  code: "export default async () => ({})", requiredPlugins: ["plugin_webhook", "plugin_linear"],
};
const webhookTool = { ...linearTool, name: "deploy_lookup", requiredPlugins: ["plugin_webhook"] };
/**
 * A ready revision whose only trigger is a `webhook` naming no plugin, so
 * only its type says it goes, and whose tools then need a trigger it no
 * longer has. Its rule names no plugin either: only its binding key ties it
 * to the removed trigger.
 */
const toolDefinition = {
  ...definition,
  triggers: [{ type: "webhook", sourceBindingKey: "releases", eventTypes: ["release.published"] }],
  recommendedPlugins: definition.recommendedPlugins,
  customTools: [linearTool, webhookTool],
  ready: true,
};
const toolRules = {
  schemaVersion: 1,
  evaluators: [
    { evaluatorKey: "releases", source: { sourceBindingKey: "releases", event: { kind: "event_type", eventType: "release.published" } }, when: { kind: "always" } },
  ],
};

function connection(sql: SqlStorage, id: string, type: string, pluginId: string): void {
  sql.exec(
    `INSERT INTO connector_connections (id, workspace_id, connector_type, scope, owner_user_id, display_name,
       encrypted_credentials, credential_iv, granted_scopes_json, status, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, ?, 'personal', ?, ?, 'sealed', 'iv', '[]', 'healthy', '2026-11-01', '2026-11-01', ?)`,
    id, WORKSPACE, type, USER, `${type} fixture`, pluginId,
  );
}

function registration(sql: SqlStorage, evaluator: typeof webhookEvaluator): void {
  sql.exec(
    `INSERT INTO workspace_external_event_registrations (registration_id, destination_key, workspace_id,
       effective_after_event_sequence, connection_id, connector_type, event_type, evaluator_json,
       destination_kind, automation_id, state, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, ?, ?, ?, 'automation', ?, 'active', 1, 1)`,
    evaluator.evaluatorId, `automation:${SIDEKICK}`, WORKSPACE, evaluator.source.connectionId,
    evaluator.source.connectorType, evaluator.source.eventType, JSON.stringify(evaluator), SIDEKICK,
  );
}

it("retires the generic webhook at WorkspaceDO 154: connections disabled, webhook triggers removed, other connectors untouched", async () => {
  const probe = env.MIGRATION_PROBE_DO!.getByName("generic-webhook-retirement-workspace-153");
  await probe.ping();
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 153),
      component: "workspace_do",
      workerVersionId: "before",
      now: 1,
    });
    const sql = state.storage.sql;
    sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 1, 1)", WORKSPACE);
    connection(sql, WEBHOOK, "generic_webhook", "plugin_webhook");
    connection(sql, LINEAR, "linear", "plugin_linear");
    sql.exec(
      `INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, source_version,
         payload_hash, lifecycle, scope, title, description, projected_at, evaluator_projection_json,
         default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json)
       VALUES (?, ?, ?, 1, 'hash', 'active', 'personal', 'Watcher', '', 1, ?, ?, ?, ?)`,
      SIDEKICK, WORKSPACE, USER,
      JSON.stringify([webhookEvaluator, linearEvaluator]),
      JSON.stringify(["plugin_webhook", "plugin_linear"]),
      JSON.stringify({ deploys: "plugin_webhook", issues: "plugin_linear" }),
      JSON.stringify({ plugin_webhook: WEBHOOK, plugin_linear: LINEAR }),
    );
    sql.exec(
      `INSERT INTO sidekick_revisions (sidekick_id, definition_revision, definition_json, definition_hash, evaluator_rules_json, ready, created_at)
       VALUES (?, 1, ?, 'hash', ?, 0, 1)`,
      SIDEKICK, JSON.stringify(definition), JSON.stringify(rules),
    );
    sql.exec(
      `INSERT INTO sidekick_revisions (sidekick_id, definition_revision, definition_json, definition_hash, evaluator_rules_json, ready, created_at)
       VALUES (?, 2, ?, 'hash', ?, 1, 2)`,
      SIDEKICK, JSON.stringify(toolDefinition), JSON.stringify(toolRules),
    );
    sql.exec("UPDATE connector_connections SET next_poll_at = 5 WHERE id = ?", WEBHOOK);
    registration(sql, webhookEvaluator);
    registration(sql, linearEvaluator);
    for (const [id, connectionId] of [["00000000-0000-7000-8000-0000000ab010", WEBHOOK], ["00000000-0000-7000-8000-0000000ab011", LINEAR]]) {
      sql.exec(
        `INSERT INTO webhook_receipts (id, workspace_id, connection_id, signature_hash, received_at, expires_at)
         VALUES (?, ?, ?, 'signature', '2026-11-18T00:00:00Z', '2026-11-20T00:00:00Z')`,
        id, WORKSPACE, connectionId,
      );
    }
  });
  // A separate event commits the old graph before the upgrade, as in production.
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: "workspace_do",
      workerVersionId: "after",
      now: 2,
    });
    const sql = state.storage.sql;
    const one = <T extends Record<string, SqlStorageValue>>(query: string, ...binds: unknown[]) =>
      sql.exec<T>(query, ...binds).one();

    expect(one("SELECT status, encrypted_credentials, credential_iv, next_poll_at FROM connector_connections WHERE id = ?", WEBHOOK))
      .toEqual({ status: "disabled", encrypted_credentials: null, credential_iv: null, next_poll_at: null });
    expect(one("SELECT status, encrypted_credentials FROM connector_connections WHERE id = ?", LINEAR))
      .toEqual({ status: "healthy", encrypted_credentials: "sealed" });

    const directory = one<{ evaluator_projection_json: string; default_plugin_ids_json: string; activity_source_plugin_ids_json: string; connector_bindings_json: string }>(
      `SELECT evaluator_projection_json, default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json
         FROM automation_directory WHERE automation_id = ?`, SIDEKICK,
    );
    expect(JSON.parse(directory.evaluator_projection_json)).toEqual([linearEvaluator]);
    expect(JSON.parse(directory.default_plugin_ids_json)).toEqual(["plugin_linear"]);
    expect(JSON.parse(directory.activity_source_plugin_ids_json)).toEqual({ issues: "plugin_linear" });
    expect(JSON.parse(directory.connector_bindings_json)).toEqual({ plugin_linear: LINEAR });

    const revision = one<{ definition_json: string; evaluator_rules_json: string }>(
      "SELECT definition_json, evaluator_rules_json FROM sidekick_revisions WHERE sidekick_id = ? AND definition_revision = 1", SIDEKICK,
    );
    const purged = JSON.parse(revision.definition_json) as unknown;
    expect(purged).toEqual({
      ...definition,
      triggers: [linearTrigger, intervalTrigger],
      recommendedPlugins: [{ pluginId: "plugin_linear", recommendedTools: [], reason: "Issues" }],
    });
    // The stored revision reads again: a `webhook` trigger is no longer a trigger type.
    expect(AutomationDraftSchema.safeParse(purged).success).toBe(true);
    expect(JSON.parse(revision.evaluator_rules_json)).toEqual({ schemaVersion: 1, evaluators: [rules.evaluators[1]] });

    const toolRevision = one<{ definition_json: string; evaluator_rules_json: string; ready: number }>(
      "SELECT definition_json, evaluator_rules_json, ready FROM sidekick_revisions WHERE sidekick_id = ? AND definition_revision = 2", SIDEKICK,
    );
    const toolPurged = JSON.parse(toolRevision.definition_json) as unknown;
    expect(toolPurged).toEqual({
      ...toolDefinition,
      triggers: [],
      recommendedPlugins: [{ pluginId: "plugin_linear", recommendedTools: [], reason: "Issues" }],
      customTools: [{ ...linearTool, requiredPlugins: ["plugin_linear"] }],
      ready: false,
    });
    expect(toolRevision.ready).toBe(0);
    const toolParse = AutomationDraftSchema.safeParse(toolPurged);
    expect(toolParse.error?.issues ?? []).toEqual([]);
    expect(JSON.parse(toolRevision.evaluator_rules_json)).toEqual({ schemaVersion: 1, evaluators: [] });

    expect(sql.exec("SELECT registration_id, state FROM workspace_external_event_registrations ORDER BY registration_id").toArray())
      .toEqual([{ registration_id: WEBHOOK_EVALUATOR, state: "removed" }, { registration_id: LINEAR_EVALUATOR, state: "active" }]);
    expect(sql.exec("SELECT connection_id FROM webhook_receipts").toArray()).toEqual([{ connection_id: LINEAR }]);
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);

    // The removed registration stays as history, and reconciling the
    // Sidekick's sources still reads its registrations past it.
    expect(sidekickSourceRegistrations({
      storage: state.storage, workspaceId: WORKSPACE, sidekickId: SIDEKICK,
      evaluators: [], sources: [], registry: createConnectorRegistry(),
    })).toEqual([]);

    // A writer still running the old code cannot bring the generic webhook back.
    expect(() => connection(sql, "00000000-0000-7000-8000-0000000ab012", "generic_webhook", "plugin_webhook_2"))
      .toThrow(/generic_webhook_retired/);
    expect(() => sql.exec("UPDATE connector_connections SET status = 'healthy' WHERE id = ?", WEBHOOK))
      .toThrow(/generic_webhook_retired/);
    expect(() => registration(sql, { ...webhookEvaluator, evaluatorId: "00000000-0000-7000-8000-0000000ab013" }))
      .toThrow(/generic_webhook_retired/);
  });
});
