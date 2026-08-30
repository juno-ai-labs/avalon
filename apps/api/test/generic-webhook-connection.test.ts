import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthContext } from "../src/env";
import { decryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  CONNECTION_WORKSPACE_OBJECT_METHODS,
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

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
    const { auth, database, objectDatabase, env } = fixture();
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
    expect(objectDatabase.prepare("SELECT count(*) AS count FROM connector_connections").get())
      .toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'connector.authorized'").get())
      .toEqual({ count: 1 });

    const connectionId = first.connection.id;
    const rotated = await service.rotateWebhookSecret(connectionId);
    expect(rotated.endpoint).toBe(first.endpoint);
    expect(rotated.signingSecret).not.toBe(first.signingSecret);
    const row = objectDatabase.prepare(
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
    -- Written after a connection commits, now that the object is bound: the
    -- route is the recoverable control-plane edge and lives regionally.
    CREATE TABLE connector_ingress_routes (
      connection_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      provider_account_id TEXT,
      provider_user_id TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
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
  // The connection table's DDL came from this fixture before, hand-copied
  // including the creation-idempotency index the replay test depends on. It
  // comes from the object's own migration ledger now, so the index the test
  // relies on is the one production has rather than a transcription of it.
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: database,
    register: (store) => { databases.push(store); },
  });
  return {
    database,
    objectDatabase: workspace.objectDatabase,
    auth,
    env: createTestEnv({
      DB: binding,
      WORKSPACE_DOS: testWorkspaceObjectBinding(
        workspace.instance,
        CONNECTION_WORKSPACE_OBJECT_METHODS,
      ),
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    }),
  };
}
