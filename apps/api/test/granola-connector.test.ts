import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../src/env";
import { decryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000002");
const API_KEY = `grn_${"a".repeat(32)}`;
const CREDENTIAL_KEY = "granola-test-credential-key";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
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
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("Granola workspace connection", () => {
  it("registers a workspace webhook and stores both secrets only in the encrypted connection envelope", async () => {
    const { auth, database, env } = fixture();
    const requests: Array<{ url: URL; body: unknown; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      requests.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({
        id: "whe_1234567890abcd",
        signing_secret: `whsec_${btoa("webhook-signing-secret")}`,
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));

    const result = await new ConnectionService(env, auth).createGranolaWorkspace({
      apiKey: API_KEY,
      capabilities: ["granola.workspace.read"],
    });
    expect(result.connection).toMatchObject({
      connectorType: "granola",
      scope: "workspace",
      displayName: "Granola workspace",
      grantedCapabilities: ["granola.workspace.read"],
    });
    expect(JSON.stringify(result)).not.toContain(API_KEY);
    expect(JSON.stringify(result)).not.toContain("webhook-signing-secret");
    expect(requests).toEqual([expect.objectContaining({
      url: new URL("https://public-api.granola.ai/v1/webhook-endpoints"),
      authorization: `Bearer ${API_KEY}`,
      body: {
        url: expect.stringMatching(/^https:\/\/api\.example\.test\/ingest\/granola\//u),
        scopes: ["workspace"],
        events: ["note.access_granted", "note.edited", "note.generated", "note.regenerated"],
      },
    })]);

    const row = database.prepare(
      `SELECT id, encrypted_credentials, credential_iv, provider_account_id, config_json
       FROM connector_connections WHERE connector_type = 'granola'`,
    ).get() as Record<string, unknown>;
    expect(String(row.encrypted_credentials)).not.toContain(API_KEY);
    expect(row.provider_account_id).not.toContain(API_KEY);
    expect(row.config_json).toBe("{}");
    const decrypted = JSON.parse(await decryptString(
      String(row.encrypted_credentials),
      String(row.credential_iv),
      CREDENTIAL_KEY,
      String(row.id),
    ));
    expect(decrypted).toEqual({
      apiKey: API_KEY,
      webhookEndpointId: "whe_1234567890abcd",
      webhookSigningSecret: `whsec_${btoa("webhook-signing-secret")}`,
    });
    expect(database.prepare(
      "SELECT metadata_json FROM audit_events WHERE target_id = ?",
    ).get(String(row.id))).toEqual({
      metadata_json: JSON.stringify({
        provider: "granola",
        scope: "workspace",
        capabilities: ["granola.workspace.read"],
      }),
    });
  });

  it("rejects a second active workspace key before contacting Granola", async () => {
    const { auth, database, env } = fixture();
    database.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, display_name,
        granted_scopes_json, model_plugin_id, status, cursor_json, config_json,
        created_at, updated_at)
       VALUES ('existing', ?, 'granola', 'workspace', NULL, 'Granola workspace',
               '["granola.workspace.read"]', 'plugin_granola', 'healthy', '{}', '{}',
               '2026-01-01', '2026-01-01')`,
    ).run(WORKSPACE_ID);
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);
    await expect(new ConnectionService(env, auth).createGranolaWorkspace({
      apiKey: API_KEY,
      capabilities: ["granola.workspace.read"],
    })).rejects.toMatchObject({ status: 409, code: "granola_workspace_connection_exists" });
    expect(providerFetch).not.toHaveBeenCalled();
  });

  it("accepts an offset webhook timestamp and re-enqueues its canonical activity on provider retry", async () => {
    const { auth, database, env, payloadPut, queueSend } = fixture();
    const secretBytes = new TextEncoder().encode("webhook-signing-secret");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "whe_1234567890abcd",
      signing_secret: `whsec_${base64(secretBytes)}`,
    }), { status: 201, headers: { "content-type": "application/json" } })));
    const created = await new ConnectionService(env, auth).createGranolaWorkspace({
      apiKey: API_KEY,
      capabilities: ["granola.workspace.read"],
    });
    const event = {
      event_id: "11111111-1111-4111-8111-111111111111",
      event_type: "note.generated",
      note_id: "not_1234567890abcd",
      occurred_at: "2026-08-07T13:00:00-07:00",
    } as const;
    const rawBodyText = JSON.stringify(event);
    const rawBody = new TextEncoder().encode(rawBodyText);
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = await hmacBase64(
      secretBytes,
      `${event.event_id}.${timestamp}.${rawBodyText}`,
    );
    const headers = {
      webhookId: event.event_id,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${signature}`,
    };
    const service = new ConnectionService(env);

    const first = await service.ingestGranolaWebhook(created.connection.id, rawBody, headers);
    const retry = await service.ingestGranolaWebhook(created.connection.id, rawBody, headers);

    expect(first).toMatchObject({ duplicate: false });
    expect(retry).toEqual({ duplicate: true, activityId: first.activityId });
    expect(queueSend).toHaveBeenCalledTimes(2);
    expect(queueSend).toHaveBeenNthCalledWith(1, expect.objectContaining({ activityId: first.activityId }));
    expect(queueSend).toHaveBeenNthCalledWith(2, expect.objectContaining({ activityId: first.activityId }));
    expect(payloadPut).toHaveBeenCalledTimes(2);
    expect(database.prepare("SELECT count(*) AS count FROM activities").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT count(*) AS count FROM webhook_receipts").get()).toEqual({ count: 1 });
  });
});

function fixture() {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
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
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
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
    CREATE TABLE webhook_receipts (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      signature_hash TEXT NOT NULL,
      received_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      UNIQUE (connection_id, signature_hash)
    );
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      connection_scope TEXT NOT NULL,
      connection_owner_user_id TEXT,
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_type TEXT,
      provider_resource_id TEXT,
      actor_json TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      text_snippet TEXT NOT NULL,
      payload_ref TEXT,
      visibility_json TEXT NOT NULL,
      entity_keys_json TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      raw_content_hash TEXT,
      target_user_ids_json TEXT NOT NULL DEFAULT '[]',
      external_people_json TEXT NOT NULL DEFAULT '[]',
      processing_status TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      UNIQUE (connection_id, provider_event_id, event_type),
      UNIQUE (connection_id, dedupe_key)
    );
    INSERT INTO users (id, name) VALUES ('${USER_ID}', 'Granola Admin');
  `);
  const binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
    batch: (statements: D1PreparedStatement[]) => Promise.all(
      statements.map((statement) => (statement as unknown as SqliteD1Statement).run()),
    ),
  });
  const payloadPut = vi.fn(async () => null);
  const queueSend = vi.fn(async () => undefined);
  const auth: AuthContext = {
    sessionId: "session",
    userId: USER_ID,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role: "owner",
  };
  return {
    database,
    payloadPut,
    queueSend,
    env: createTestEnv({
      DB: binding,
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: payloadPut }),
      ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send: queueSend }),
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    }),
    auth,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacBase64(keyBytes: Uint8Array, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}
