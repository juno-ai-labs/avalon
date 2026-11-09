import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { encryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import { __integrationTesting } from "../src/services/integrations";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

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
  // Workspace setup moved to the real workerd installation suite.
  it("refuses a verified delivery whose event Rally does not model, by name, before any receipt", async () => {
    // Granola's own list has three events and Rally's understanding of it has
    // been wrong once. An unknown name used to fail schema validation as a
    // 500, which Standard Webhooks retries for four days before Granola
    // disables the endpoint; now it is the named 400 every other ingress gives.
    const { auth, database, env, payloadPut, queueSend } = fixture();
    const secretBytes = new TextEncoder().encode("webhook-signing-secret");
    const connectionId = crypto.randomUUID();
    const encrypted = await encryptString(JSON.stringify({ apiKey: API_KEY, webhookEndpointId: "whe_1234567890abcd", webhookSigningSecret: `whsec_${base64(secretBytes)}` }), CREDENTIAL_KEY, connectionId);
    database.prepare(`INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, display_name, encrypted_credentials, credential_iv,
       granted_scopes_json, model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
      VALUES (?, ?, 'granola', 'workspace', NULL, 'Granola workspace', ?, ?, '["granola.workspace.read"]', 'plugin_granola_fixture', 'healthy', '{}', '{}', ?, ?)`)
      .run(connectionId, auth.workspaceId, encrypted.ciphertext, encrypted.iv, new Date().toISOString(), new Date().toISOString());
    const event = {
      event_id: "33333333-3333-4333-8333-333333333333",
      event_type: "note.regenerated",
      note_id: "not_1234567890abcd",
      occurred_at: "2026-08-07T13:00:00-07:00",
    } as const;
    const rawBodyText = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = await hmacBase64(secretBytes, `${event.event_id}.${timestamp}.${rawBodyText}`);
    const headers = { webhookId: event.event_id, webhookTimestamp: String(timestamp), webhookSignature: `v1,${signature}` };
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const refusal = await new ConnectionService(env).ingestGranolaWebhook(connectionId, new TextEncoder().encode(rawBodyText), headers)
      .then(() => null, (error: unknown) => error);

    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({ status: 400, code: "unsupported_webhook_event", details: { provider: "granola", eventType: "note.regenerated" } });
    expect((refusal as ApiError).message).toContain("note.regenerated");
    expect(warnings.mock.calls.map(([entry]) => entry)).toContainEqual(expect.objectContaining({
      event: "connector_webhook_event_refused", connector_type: "granola", connection_id: connectionId, event_type: "note.regenerated",
    }));
    expect(queueSend).not.toHaveBeenCalled();
    expect(payloadPut).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT count(*) AS count FROM activities").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT count(*) AS count FROM webhook_receipts").get()).toEqual({ count: 0 });
    warnings.mockRestore();
  });

  it("claims the receipt through the typed object RPC without a credential crossing in plaintext", async () => {
    const connectionId = "00000000-0000-4000-8000-000000000010";
    const secretBytes = new TextEncoder().encode("webhook-signing-secret");
    const signingSecret = `whsec_${base64(secretBytes)}`;
    const regional = new DatabaseSync(":memory:");
    databases.push(regional);
    regional.exec(`
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
      INSERT INTO connector_ingress_routes
        (connection_id, workspace_id, region, connector_type, scope, status, updated_at)
      VALUES ('${connectionId}', '${WORKSPACE_ID}', 'global', 'granola', 'workspace',
              'active', '2026-01-01T00:00:00.000Z');
    `);
    const workspace = createTestWorkspaceDO({
      workspaceId: WORKSPACE_ID,
      regionalDatabase: regional,
      register: (created) => { databases.push(created); },
    });
    const encrypted = await encryptString(
      JSON.stringify({
        apiKey: API_KEY,
        webhookEndpointId: "whe_1234567890abcd",
        webhookSigningSecret: signingSecret,
      }),
      CREDENTIAL_KEY,
      connectionId,
    );
    workspace.objectDatabase.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
        display_name, encrypted_credentials, credential_iv, credential_key_version,
        granted_scopes_json, status, cursor_json, config_json,
        created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'granola', 'workspace', NULL, 'workspace:abc', 'Granola workspace',
               ?, ?, 1, '["granola.workspace.read"]', 'healthy', '{}', '{}',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'plugin_granola')`,
    ).run(connectionId, WORKSPACE_ID, encrypted.ciphertext, encrypted.iv);

    // A real WorkspaceDO answers, but every request and result that crosses
    // the doubled transport is recorded, so the test can prove the plaintext
    // API key and signing secret never ride the RPC boundary in either
    // direction — only the encrypted envelope and the delivery identity do.
    const exchanges: string[] = [];
    const rpcs = workspaceObjectRpcs(workspace.instance, [
      "executeRuntimeSql",
      "claimWebhookReceipt",
    ]);
    const stub = Object.fromEntries(Object.entries(rpcs).map(([name, method]) => [
      name,
      async (...args: unknown[]) => {
        exchanges.push(`${name}:request:${JSON.stringify(args)}`);
        const result = await (method as (...called: unknown[]) => Promise<unknown>)(...args);
        exchanges.push(`${name}:result:${JSON.stringify(result)}`);
        return result;
      },
    ]));
    const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => stub,
      jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
    });
    const payloadPut = vi.fn(async () => null);
    const queueSend = vi.fn(async () => undefined);
    const env = createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: payloadPut }),
      ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send: queueSend }),
      WORKSPACE_DOS: binding,
    });
    const event = {
      event_id: "22222222-2222-4222-8222-222222222222",
      event_type: "note.generated",
      note_id: "not_2234567890abcd",
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

    const first = await service.ingestGranolaWebhook(connectionId, rawBody, headers);
    const retry = await service.ingestGranolaWebhook(connectionId, rawBody, headers);

    // The second delivery is the receipt claim's duplicate outcome — the
    // object's returned witness, not a physical write counter read in the
    // Worker.
    expect(first.duplicate).toBe(false);
    expect(retry.duplicate).toBe(true);
    const claims = exchanges.filter((entry) => entry.startsWith("claimWebhookReceipt:request:"));
    expect(claims).toHaveLength(2);
    // Both deliveries claim the same delivery identity — the receipt key the
    // verifier derived, which is what makes the second one a duplicate.
    const claimedHashes = claims.map((entry) => /"signatureHash":"([^"]+)"/u.exec(entry)?.[1]);
    expect(claimedHashes[0]).toBeTruthy();
    expect(claimedHashes[1]).toBe(claimedHashes[0]);
    for (const exchange of exchanges) {
      expect(exchange).not.toContain(API_KEY);
      expect(exchange).not.toContain(signingSecret);
      expect(exchange).not.toContain("webhook-signing-secret");
    }
  });

  it("queues the share and the transcript it implies as two events through the workspace object, and two again on retry", async () => {
    // The path production runs: the workspace object claims the receipt and
    // every activity leaves through the Queue. A share of a generated note is
    // two queue messages with their own ingress identities, the transcript
    // carrying the note's occurrence key as its own field; a retry sends the
    // same two again, and the object dedupes them — never one, never three.
    const connectionId = "00000000-0000-4000-8000-000000000011";
    const secretBytes = new TextEncoder().encode("webhook-signing-secret");
    const signingSecret = `whsec_${base64(secretBytes)}`;
    const regional = new DatabaseSync(":memory:");
    databases.push(regional);
    regional.exec(`
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
      INSERT INTO connector_ingress_routes
        (connection_id, workspace_id, region, connector_type, scope, status, updated_at)
      VALUES ('${connectionId}', '${WORKSPACE_ID}', 'global', 'granola', 'workspace',
              'active', '2026-01-01T00:00:00.000Z');
    `);
    const workspace = createTestWorkspaceDO({
      workspaceId: WORKSPACE_ID,
      regionalDatabase: regional,
      register: (created) => { databases.push(created); },
    });
    const encrypted = await encryptString(
      JSON.stringify({ apiKey: API_KEY, webhookEndpointId: "whe_1234567890abcd", webhookSigningSecret: signingSecret }),
      CREDENTIAL_KEY,
      connectionId,
    );
    workspace.objectDatabase.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
        display_name, encrypted_credentials, credential_iv, credential_key_version,
        granted_scopes_json, status, cursor_json, config_json,
        created_at, updated_at, model_plugin_id)
       VALUES (?, ?, 'granola', 'workspace', NULL, 'workspace:abc', 'Granola workspace',
               ?, ?, 1, '["granola.workspace.read"]', 'healthy', '{}', '{}',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'plugin_granola')`,
    ).run(connectionId, WORKSPACE_ID, encrypted.ciphertext, encrypted.iv);
    const rpcs = workspaceObjectRpcs(workspace.instance, ["executeRuntimeSql", "claimWebhookReceipt"]);
    const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => rpcs,
      jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
    });
    const queueSend = vi.fn<(message: unknown) => Promise<void>>(async () => undefined);
    const env = createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({ put: vi.fn(async () => null) }),
      ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send: queueSend }),
      WORKSPACE_DOS: binding,
    });
    const noteReads: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      noteReads.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json({ id: "not_2234567890abcd", summary_markdown: "## Recap", summary_text: "Recap" });
    }));
    const event = {
      event_id: "55555555-5555-4555-8555-555555555555",
      event_type: "note.access_granted",
      note_id: "not_2234567890abcd",
      occurred_at: "2026-09-16T12:51:00-04:00",
    } as const;
    const rawBodyText = JSON.stringify(event);
    const rawBody = new TextEncoder().encode(rawBodyText);
    const timestamp = Math.floor(Date.now() / 1_000);
    const signature = await hmacBase64(secretBytes, `${event.event_id}.${timestamp}.${rawBodyText}`);
    const headers = { webhookId: event.event_id, webhookTimestamp: String(timestamp), webhookSignature: `v1,${signature}` };
    const service = new ConnectionService(env);

    const first = await service.ingestGranolaWebhook(connectionId, rawBody, headers);
    const retry = await service.ingestGranolaWebhook(connectionId, rawBody, headers);

    expect(first.duplicate).toBe(false);
    expect(first.derivedActivityIds).toHaveLength(1);
    expect(retry.duplicate).toBe(true);
    expect(noteReads).toEqual(["GET /v1/notes/not_2234567890abcd", "GET /v1/notes/not_2234567890abcd"]);
    const queued = queueSend.mock.calls.map(([message]) => message as {
      kind: string;
      request: { ingressEventId: string; event: { activity: { eventType: string; dedupeKey: string; occurrenceKey?: string; metadata: Record<string, unknown> } } };
    });
    expect(queued.map((message) => message.kind)).toEqual(Array(4).fill("workspace_connector_event"));
    const firstDelivery = queued.slice(0, 2);
    const retryDelivery = queued.slice(2);
    for (const delivery of [firstDelivery, retryDelivery]) {
      // The two hashes and Queue sends run concurrently. Queue delivery does
      // not promise their call order; the contract is exactly one event of
      // each type for both the original delivery and its retry.
      expect(delivery.map((message) => message.request.event.activity.eventType).sort())
        .toEqual(["note.access_granted", "note.generated"]);
      expect(new Set(delivery.map((message) => message.request.ingressEventId)).size).toBe(2);
    }
    const firstShare = firstDelivery.find(
      (message) => message.request.event.activity.eventType === "note.access_granted",
    )!;
    const firstTranscript = firstDelivery.find(
      (message) => message.request.event.activity.eventType === "note.generated",
    )!;
    expect(firstTranscript.request.event.activity).toMatchObject({
      dedupeKey: `${event.event_id}:generated`,
      occurrenceKey: `granola:${connectionId}:note:not_2234567890abcd:transcript`,
      metadata: { noteId: "not_2234567890abcd", changedFields: [], derivedFrom: "note.access_granted" },
    });
    expect(firstShare.request.event.activity.occurrenceKey).toBeUndefined();
    expect(firstShare.request.ingressEventId).toBe(first.activityId);
    expect(firstTranscript.request.ingressEventId).toBe(first.derivedActivityIds![0]);
  });
});

describe("Granola personal automation catalog", () => {
  it("preserves the meeting-query deadline from live discovery", async () => {
    const { database, env } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000011";
    const encrypted = await encryptString(
      JSON.stringify({ accessToken: "personal-token" }),
      CREDENTIAL_KEY,
      connectionId,
    );
    database.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
        display_name, encrypted_credentials, credential_iv, credential_key_version,
        granted_scopes_json, model_plugin_id, status, cursor_json, config_json,
        created_at, updated_at)
       VALUES (?, ?, 'granola', 'personal', ?, 'granola:person', 'Granola', ?, ?, 1,
               '["granola.personal.read"]', 'plugin_granola', 'healthy', '{}', '{}',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(connectionId, WORKSPACE_ID, USER_ID, encrypted.ciphertext, encrypted.iv);
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = request.id as string;
      if (request.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-06-18", capabilities: {} },
        }, { headers: { "mcp-session-id": "session-1" } });
      }
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            { name: "query_granola_meetings", inputSchema: { type: "object" } },
            { name: "list_meetings", inputSchema: { type: "object" } },
          ],
        },
      });
    }));

    const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(
      env,
      WORKSPACE_ID,
      USER_ID,
    );

    expect(catalog).toEqual([
      expect.objectContaining({
        pluginId: "plugin_granola",
        tools: [
          expect.objectContaining({
            name: "granola_query_granola_meetings",
            canonicalName: "query_granola_meetings",
            timeoutMs: 300_000,
          }),
          expect.objectContaining({
            name: "granola_list_meetings",
            canonicalName: "list_meetings",
            timeoutMs: 30_000,
          }),
        ],
      }),
    ]);
  });

  it("names the tool and field a drifted catalog failed, and lists nothing from it", async () => {
    const { database, env } = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const connectionId = "00000000-0000-4000-8000-000000000011";
    const encrypted = await encryptString(
      JSON.stringify({ accessToken: "personal-token" }),
      CREDENTIAL_KEY,
      connectionId,
    );
    database.prepare(
      `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
        display_name, encrypted_credentials, credential_iv, credential_key_version,
        granted_scopes_json, model_plugin_id, status, cursor_json, config_json,
        created_at, updated_at)
       VALUES (?, ?, 'granola', 'personal', ?, 'granola:person', 'Granola', ?, ?, 1,
               '["granola.personal.read"]', 'plugin_granola', 'healthy', '{}', '{}',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run(connectionId, WORKSPACE_ID, USER_ID, encrypted.ciphertext, encrypted.iv);
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = request.id as string;
      if (request.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id,
          result: { protocolVersion: "2025-06-18", capabilities: {} },
        }, { headers: { "mcp-session-id": "session-1" } });
      }
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            // The catalog drifted: a schema that is not an object schema.
            { name: "query_granola_meetings", inputSchema: { type: "array" } },
            { name: "list_meetings", inputSchema: { type: "object" } },
          ],
        },
      });
    }));

    const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(
      env,
      WORKSPACE_ID,
      USER_ID,
    );

    // The plugin is left out of the catalog, and the row names the tool and
    // the field rather than the class name `ZodError`.
    expect(catalog).toEqual([]);
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "dynamic_connector_tools_unavailable",
      surface: "automation_creator",
      error_code: expect.stringMatching(/^dynamic_connector_tools_unavailable:tools\.0\.inputSchema/u),
    }));
    warning.mockRestore();
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
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      access_class TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (workspace_id, user_id)
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
    INSERT INTO workspace_members (workspace_id, user_id, status)
    VALUES ('${WORKSPACE_ID}', '${USER_ID}', 'active');
  `);
  const binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
    batch: (statements: D1PreparedStatement[]) => Promise.all(
      statements.map((statement) => (statement as unknown as SqliteD1Statement).run()),
    ),
  });
  const payloadPut = vi.fn(async () => null);
  const queueSend = vi.fn<(message: unknown) => Promise<void>>(async () => undefined);
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
