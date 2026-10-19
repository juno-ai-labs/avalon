import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const workspace = "00000000-0000-7000-8000-000000000121";

describe("Apollo connector migration", () => {
  it("preserves existing credentials, tool counts, OAuth pointers and connector dependents while admitting Apollo", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("apollo-populated-v120");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 120),
        component: "workspace_do", workerVersionId: "before-apollo", now: 1 });
      const sql = state.storage.sql;
      sql.exec("INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at) VALUES (1, ?, 'global', 'wnam', 1, 1)", workspace);
      sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, encrypted_credentials, granted_scopes_json, model_plugin_id, created_at, updated_at, discovered_tool_count, tool_count_backfill_attempted_at)
        VALUES ('existing', ?, 'ashby', 'workspace', 'Hiring', 'encrypted-fixture', '[]', 'plugin_ashby', 'now', 'now', 7, 'then')`, workspace);
      sql.exec(`INSERT INTO connector_oauth_attempts
        (id, region, provider, user_id, workspace_id, status, connection_id, expires_at, completed_at, created_at, updated_at, telemetry_operation_id, telemetry_scope, telemetry_reconnect)
        VALUES ('old-attempt', 'global', 'ashby', 'member', ?, 'succeeded', 'existing', 'later', 'now', 'now', 'now', 'operation', 'workspace', 1)`, workspace);
      sql.exec("INSERT INTO webhook_receipts (id, workspace_id, connection_id, signature_hash, received_at, expires_at) VALUES ('receipt', ?, 'existing', 'signature', 'now', 'later')", workspace);
      sql.exec(`INSERT INTO connector_installations
        (connection_id, workspace_id, attempt_id, user_id, input_hash, generation, document_json)
        VALUES ('existing', ?, 'installation', 'member', 'hash', 1, '{}')`, workspace);
    });
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({ storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: "workspace_do", workerVersionId: "with-apollo", now: 2 });
      const sql = state.storage.sql;
      expect(sql.exec("SELECT encrypted_credentials, discovered_tool_count, tool_count_backfill_attempted_at FROM connector_connections WHERE id = 'existing'").one())
        .toEqual({ encrypted_credentials: "encrypted-fixture", discovered_tool_count: 7, tool_count_backfill_attempted_at: "then" });
      expect(sql.exec("SELECT provider, connection_id, telemetry_operation_id, telemetry_reconnect FROM connector_oauth_attempts WHERE id = 'old-attempt'").one())
        .toEqual({ provider: "ashby", connection_id: "existing", telemetry_operation_id: "operation", telemetry_reconnect: 1 });
      expect(sql.exec("SELECT id, connection_id FROM webhook_receipts").toArray()).toEqual([{ id: "receipt", connection_id: "existing" }]);
      expect(sql.exec("SELECT connection_id, document_json FROM connector_installations").toArray()).toEqual([{ connection_id: "existing", document_json: "{}" }]);
      sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, granted_scopes_json, model_plugin_id, created_at, updated_at)
        VALUES ('apollo', ?, 'apollo', 'personal', 'member', 'Apollo.io', '["apollo.personal.mcp"]', 'plugin_apollo', 'now', 'now')`, workspace);
      sql.exec(`INSERT INTO connector_oauth_attempts
        (id, region, provider, user_id, workspace_id, status, connection_id, expires_at, created_at, updated_at)
        VALUES ('apollo-attempt', 'global', 'apollo', 'member', ?, 'pending', 'apollo', 'later', 'now', 'now')`, workspace);
      expect(sql.exec("SELECT connection_id FROM connector_oauth_attempts WHERE id = 'apollo-attempt'").one()).toEqual({ connection_id: "apollo" });
      expect(() => sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, granted_scopes_json, model_plugin_id, created_at, updated_at)
        VALUES ('duplicate', ?, 'apollo', 'personal', 'member', 'Duplicate', '[]', 'plugin_duplicate', 'now', 'now')`, workspace)).toThrow(/UNIQUE constraint/u);
      expect(() => sql.exec("UPDATE connector_connections SET workspace_id = 'another-workspace' WHERE id = 'apollo'")).toThrow(/workspace_identity_mismatch/u);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
