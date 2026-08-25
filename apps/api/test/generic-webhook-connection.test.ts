import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthContext } from "../src/env";
import { decryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000002");
const CREDENTIAL_KEY = "generic-webhook-test-key";

class SqliteStatement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<T>({ success: true, results: [], meta: { changes: Number(result.changes) } });
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: {},
    });
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("generic webhook connection lifecycle", () => {
  it("replays idempotent creation and rotates the endpoint secret", async () => {
    const { auth, database, env } = fixture();
    const service = new ConnectionService(env, auth);
    const input = {
      displayName: "Support intake",
      scope: "workspace" as const,
      eventTypes: ["ticket.created"],
      idempotencyKey: "create-support-intake",
    };

    const first = await service.createWebhook(input);
    const replay = await service.createWebhook(input);
    expect(replay).toEqual(first);
    await expect(service.createWebhook({ ...input, displayName: "Different intake" }))
      .rejects.toMatchObject({ status: 409, code: "idempotency_key_reused" });
    expect(database.prepare("SELECT count(*) AS count FROM connector_connections").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'connector.authorized'").get())
      .toEqual({ count: 1 });

    const connectionId = first.connection.id;
    const rotated = await service.rotateWebhookSecret(connectionId);
    expect(rotated.endpoint).toBe(first.endpoint);
    expect(rotated.signingSecret).not.toBe(first.signingSecret);
    const row = database.prepare(
      "SELECT encrypted_credentials, credential_iv FROM connector_connections WHERE id = ?",
    ).get(connectionId) as { encrypted_credentials: string; credential_iv: string };
    await expect(decryptString(
      row.encrypted_credentials,
      row.credential_iv,
      CREDENTIAL_KEY,
      connectionId,
    )).resolves.toBe(JSON.stringify({ signingSecret: rotated.signingSecret }));
  });
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE connector_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      granted_scopes_json TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      status TEXT NOT NULL,
      cursor_json TEXT NOT NULL,
      config_json TEXT NOT NULL,
      last_sync_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX active_model_plugin
      ON connector_connections(workspace_id, model_plugin_id) WHERE status != 'disabled';
    CREATE UNIQUE INDEX generic_webhook_creation_idempotency_idx
      ON connector_connections(
        workspace_id, scope, COALESCE(owner_user_id, ''),
        json_extract(config_json, '$.creationIdempotencyKey')
      )
      WHERE connector_type = 'generic_webhook' AND status != 'disabled'
        AND json_extract(config_json, '$.creationIdempotencyKey') IS NOT NULL;
    CREATE TABLE audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_user_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO users (id, name) VALUES ('${USER_ID}', 'Webhook Admin');
  `);
  const binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteStatement(database.prepare(sql))),
  });
  const auth: AuthContext = {
    sessionId: "session",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "owner",
  };
  return {
    database,
    auth,
    env: createTestEnv({
      DB: binding,
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    }),
  };
}
