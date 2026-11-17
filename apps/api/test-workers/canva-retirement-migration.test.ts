/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";

const WORKSPACE = "00000000-0000-7000-8000-0000000ca001";
const USER = "00000000-0000-7000-8000-0000000ca002";
const CANVA = "00000000-0000-7000-8000-0000000ca003";
const LINEAR = "00000000-0000-7000-8000-0000000ca004";
const SIDEKICK = "00000000-0000-7000-8000-0000000ca005";
const DESIGN = "00000000-0000-7000-8000-0000000ca006";
const CANVA_EVALUATOR = "00000000-0000-7000-8000-0000000ca007";
const LINEAR_EVALUATOR = "00000000-0000-7000-8000-0000000ca008";
const WORKSTREAM = "00000000-0000-7000-8000-0000000ca009";

const canvaEvaluator = {
  evaluatorId: CANVA_EVALUATOR,
  source: { connectorType: "canva", connectionId: CANVA, eventType: "canva.design.updated", resourceId: DESIGN },
  when: { kind: "always" },
};
const linearEvaluator: { evaluatorId: string; source: { connectorType: string; connectionId: string; eventType: string; resourceId?: string }; when: { kind: string } } = {
  evaluatorId: LINEAR_EVALUATOR,
  source: { connectorType: "linear", connectionId: LINEAR, eventType: "linear.issue.created" },
  when: { kind: "always" },
};
const definition = {
  title: "Design and issue watcher",
  triggers: [
    { kind: "external_event", sourceBindingKey: "design", suggestedSourcePluginId: "plugin_canva" },
    { kind: "external_event", sourceBindingKey: "issues", suggestedSourcePluginId: "plugin_linear" },
    { kind: "schedule", cron: "0 9 * * 1" },
  ],
  recommendedPlugins: [{ pluginId: "plugin_canva" }, { pluginId: "plugin_linear" }],
};
const rules = {
  schemaVersion: 1,
  evaluators: [
    { evaluatorKey: "design", source: { sourceBindingKey: "design", suggestedSourcePluginId: "plugin_canva", event: { kind: "event_type", eventType: "canva.design.updated" } }, when: { kind: "always" } },
    { evaluatorKey: "issues", source: { sourceBindingKey: "issues", suggestedSourcePluginId: "plugin_linear", event: { kind: "event_type", eventType: "linear.issue.created" } }, when: { kind: "always" } },
  ],
};

function connection(sql: SqlStorage, id: string, type: string, pluginId: string): void {
  sql.exec(
    `INSERT INTO connector_connections (id, workspace_id, connector_type, scope, owner_user_id, display_name,
       encrypted_credentials, credential_iv, granted_scopes_json, status, next_poll_at, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, ?, 'personal', ?, ?, 'sealed', 'iv', '[]', 'healthy', '2026-11-17T00:00:00Z', '2026-11-01', '2026-11-01', ?)`,
    id, WORKSPACE, type, USER, `${type} · ada@example.com`, pluginId,
  );
}

it("retires Canva at WorkspaceDO 152: connections disabled, triggers removed, other connectors untouched", async () => {
  const probe = env.MIGRATION_PROBE_DO!.getByName("canva-retirement-workspace-151");
  await probe.ping();
  await runInDurableObject(probe, (_instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 151),
      component: "workspace_do",
      workerVersionId: "before",
      now: 1,
    });
    const sql = state.storage.sql;
    sql.exec("INSERT INTO workspace_identity VALUES (1, ?, 'global', 'wnam', 1, 1)", WORKSPACE);
    connection(sql, CANVA, "canva", "plugin_canva");
    connection(sql, LINEAR, "linear", "plugin_linear");
    sql.exec(
      `INSERT INTO automation_directory (automation_id, workspace_id, author_user_id, source_version,
         payload_hash, lifecycle, scope, title, description, projected_at, evaluator_projection_json,
         default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json)
       VALUES (?, ?, ?, 1, 'hash', 'active', 'personal', 'Watcher', '', 1, ?, ?, ?, ?)`,
      SIDEKICK, WORKSPACE, USER,
      JSON.stringify([canvaEvaluator, linearEvaluator]),
      JSON.stringify(["plugin_canva", "plugin_linear"]),
      JSON.stringify({ design: "plugin_canva", issues: "plugin_linear" }),
      JSON.stringify({ plugin_canva: CANVA, plugin_linear: LINEAR }),
    );
    sql.exec(
      `INSERT INTO sidekick_revisions (sidekick_id, definition_revision, definition_json, definition_hash, evaluator_rules_json, ready, created_at)
       VALUES (?, 1, ?, 'hash', ?, 1, 1)`,
      SIDEKICK, JSON.stringify(definition), JSON.stringify(rules),
    );
    for (const evaluator of [canvaEvaluator, linearEvaluator]) {
      sql.exec(
        `INSERT INTO workspace_external_event_registrations (registration_id, destination_key, workspace_id,
           effective_after_event_sequence, connection_id, connector_type, event_type, resource_id, evaluator_json,
           destination_kind, automation_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, 'automation', ?, 'active', 1, 1)`,
        evaluator.evaluatorId, `automation:${SIDEKICK}`, WORKSPACE, evaluator.source.connectionId,
        evaluator.source.connectorType, evaluator.source.eventType, evaluator.source.resourceId ?? null,
        JSON.stringify(evaluator), SIDEKICK,
      );
    }
    sql.exec(
      `INSERT INTO schedules (id, workspace_id, connector_connection_id, schedule_type, interval_seconds, timezone,
         next_run_at, enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'interval', 600, 'UTC', '2026-11-17T00:10:00Z', 1, '2026-11-01', '2026-11-01')`,
      CANVA_EVALUATOR, WORKSPACE, CANVA,
    );
    sql.exec(
      `INSERT INTO resources (id, workspace_id, connection_id, provider, resource_type, title, metadata_json,
         attachment_status, protected_access_json, created_at, updated_at)
       VALUES (?, ?, ?, 'canva', 'canva_design', 'Launch deck', '{}', 'attached', '{"v":1,"sealed":"x"}', '2026-11-01', '2026-11-01')`,
      DESIGN, WORKSPACE, CANVA,
    );
    sql.exec(
      `INSERT INTO resource_watches (id, workspace_id, workstream_id, resource_id, connection_id, watch_type, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'design', '2026-11-01', '2026-11-01')`,
      "00000000-0000-7000-8000-0000000ca010", WORKSPACE, WORKSTREAM, DESIGN, CANVA,
    );
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

    expect(one("SELECT status, encrypted_credentials, credential_iv, next_poll_at FROM connector_connections WHERE id = ?", CANVA))
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
      "SELECT definition_json, evaluator_rules_json FROM sidekick_revisions WHERE sidekick_id = ?", SIDEKICK,
    );
    expect(JSON.parse(revision.definition_json)).toEqual({
      ...definition,
      triggers: [definition.triggers[1], definition.triggers[2]],
      recommendedPlugins: [{ pluginId: "plugin_linear" }],
    });
    expect(JSON.parse(revision.evaluator_rules_json)).toEqual({ schemaVersion: 1, evaluators: [rules.evaluators[1]] });

    expect(sql.exec("SELECT registration_id, state FROM workspace_external_event_registrations ORDER BY registration_id").toArray())
      .toEqual([{ registration_id: CANVA_EVALUATOR, state: "removed" }, { registration_id: LINEAR_EVALUATOR, state: "active" }]);
    expect(one("SELECT enabled FROM schedules WHERE id = ?", CANVA_EVALUATOR)).toEqual({ enabled: 0 });
    expect(sql.exec("SELECT id FROM resource_watches").toArray()).toEqual([]);
    expect(one("SELECT title, protected_access_json FROM resources WHERE id = ?", DESIGN))
      .toEqual({ title: "Launch deck", protected_access_json: null });
    expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);

    // A writer still running the old code cannot bring Canva back.
    expect(() => connection(sql, "00000000-0000-7000-8000-0000000ca011", "canva", "plugin_canva_2")).toThrow(/canva_retired/);
    expect(() => sql.exec("UPDATE connector_connections SET status = 'healthy' WHERE id = ?", CANVA)).toThrow(/canva_retired/);
  });
});
