import { ConnectorResourceAuthorizationRequestSchema, asUserId, asWorkspaceId } from "@rally/contracts";
import { addWorkspaceTarget, parseWorkspaceTarget } from "@rally/contracts/workspace-target";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { AuthContext, Env } from "../src/env";
import { decryptString, encryptString, sealString } from "../src/lib/crypto";
import { desktopHandoffUrl } from "../src/lib/desktop-handoff";
import { __connectionServiceTesting, ConnectionService } from "../src/services/connection-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, testWorkspaceObjectBinding } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const OTHER_USER_ID = asUserId("00000000-0000-4000-8000-000000000002");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000003");

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function testRsaPrivateKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const body = Buffer.from(bytes).toString("base64").match(/.{1,64}/gu)!.join("\n");
  const begin = [["-----BEGIN", "PRIVATE"].join(" "), "KEY-----"].join(" ");
  const end = [["-----END", "PRIVATE"].join(" "), "KEY-----"].join(" ");
  return `${begin}\n${body}\n${end}`;
}

/**
 * A real `WorkspaceDO` over its own schema answers the attempt RPCs, and the
 * facade's remaining generic statements reach the same object through
 * `executeRuntimeSql` — only the transport is doubled. `oauth_states` and the
 * ingress-route projection stay on the regional database, as in production.
 */
function fixture(): { regional: DatabaseSync; object: DatabaseSync; env: Env; auth: AuthContext } {
  const regional = new DatabaseSync(":memory:");
  databases.push(regional);
  regional.exec(`
    CREATE TABLE oauth_states (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_verifier_encrypted TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      return_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
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
    CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
  `);
  regional.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, status, role)
     VALUES (?, ?, 'active', 'owner')`,
  ).run(WORKSPACE_ID, USER_ID);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  return {
    regional,
    object: workspace.objectDatabase,
    env: createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_API_BASE_URL: "https://api.rallywith.ai",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
      DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
      BROWSER_APP_ORIGIN: "https://app.rallywith.ai",
      OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
      CONNECTOR_CREDENTIALS_KEY: "test-connector-credentials-key",
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, [
        "startConnectorOAuthAttempt",
        "abandonConnectorOAuthAttempt",
        "extendConnectorOAuthAttempt",
        "finishConnectorOAuthAttempt",
        "connectorOAuthAttempt",
        "bindConnectorOAuthAttemptTelemetry",
        "executeRuntimeSql",
      ]),
    }),
    auth: {
      sessionId: "session",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "owner",
    },
  };
}

function insertAttempt(
  object: DatabaseSync,
  input: {
    id: string;
    userId?: string;
    status?: string;
    connectionId?: string | null;
    errorCode?: string | null;
    expiresAt: string;
  },
): void {
  object.prepare(
    `INSERT INTO connector_oauth_attempts
     (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
      expires_at, completed_at, created_at, updated_at)
     VALUES (?, 'global', 'linear', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.userId ?? USER_ID,
    WORKSPACE_ID,
    input.status ?? "pending",
    input.connectionId ?? null,
    input.errorCode ?? null,
    input.expiresAt,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

function insertConnection(object: DatabaseSync, id: string): void {
  object.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, granted_scopes_json, status, cursor_json, config_json,
      created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'linear', 'workspace', NULL, NULL, 'Linear', '[]', 'healthy',
             '{}', '{}', ?, ?, ?)`,
  ).run(id, WORKSPACE_ID, new Date().toISOString(), new Date().toISOString(), `plugin_linear_${id.slice(-4)}`);
}

async function insertGoogleConnection(object: DatabaseSync, env: Env, id: string): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify({ accessToken: "google-access-token" }),
    env.CONNECTOR_CREDENTIALS_KEY,
    id,
  );
  object.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      granted_scopes_json, status, cursor_json, config_json, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'google', 'personal', ?, 'google-account', 'Google', ?, ?, 1,
             '["sheets.write"]', 'healthy', '{}', '{}', ?, ?, 'plugin_google')`,
  ).run(id, WORKSPACE_ID, USER_ID, encrypted.ciphertext, encrypted.iv, new Date().toISOString(), new Date().toISOString());
}

function resourceAuthorizationRequest(connectionId: string) {
  return ConnectorResourceAuthorizationRequestSchema.parse({
    kind: "connector_resource_authorization",
    provider: "google",
    connectionId,
    capability: "sheets.write",
    operation: "edit",
    resource: { id: "sheet-1", type: "document", name: "Ellen Buckley Assessment" },
    parentId: "00000000-0000-4000-8000-000000000020",
    substreamId: "0",
    failedToolInvocationId: "00000000-0000-4000-8000-000000000030:turn:1:tool:0",
    continuationId: "00000000-0000-4000-8000-000000000040",
  });
}

function allowResourceConversationAccess(connectionId: string): void {
  vi.spyOn(WorkstreamObjectClient.prototype, "readResourceAuthorizationRecovery")
    .mockImplementation(async () => resourceAuthorizationRequest(connectionId));
}

describe("connector OAuth handoff", () => {
  it("starts a provider-neutral resource authorization with Google's exact-file Picker", async () => {
    const { auth, env, object, regional } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000010";
    allowResourceConversationAccess(connectionId);
    await insertGoogleConnection(object, env, connectionId);
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      id: "sheet-1",
      name: "Ellen Buckley Assessment",
      mimeType: "application/vnd.google-apps.spreadsheet",
      isAppAuthorized: false,
      capabilities: { canEdit: true },
    })));
    const started = await new ConnectionService(env, auth).beginResourceAuthorization(
      connectionId, resourceAuthorizationRequest(connectionId), 2,
    );
    expect(started.status).toBe("pending");
    const url = new URL(started.url!);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.file");
    expect(url.searchParams.get("file_ids")).toBe("sheet-1");
    expect(regional.prepare("SELECT purpose FROM oauth_states").get()).toEqual({
      purpose: "resource_authorization",
    });
  });

  it("rejects a target without its durable failed-tool recovery", async () => {
    const { auth, env, object, regional } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000010";
    allowResourceConversationAccess(connectionId);
    await insertGoogleConnection(object, env, connectionId);
    await expect(new ConnectionService(env, auth).beginResourceAuthorization(
      connectionId,
      { ...resourceAuthorizationRequest(connectionId), failedToolInvocationId: "forged-tool" },
      2,
    )).rejects.toMatchObject({ status: 404, code: "resource_authorization_recovery_missing" });
    expect(regional.prepare("SELECT COUNT(*) AS count FROM oauth_states").get()).toEqual({ count: 0 });
  });

  it("enforces personal ownership and organization admin authority before a resource grant", async () => {
    const { auth, env, object } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000011";
    allowResourceConversationAccess(connectionId);
    await insertGoogleConnection(object, env, connectionId);
    const request = resourceAuthorizationRequest(connectionId);
    await expect(new ConnectionService(env, { ...auth, userId: OTHER_USER_ID, role: "member" })
      .beginResourceAuthorization(connectionId, request, 2))
      .rejects.toMatchObject({ status: 404, code: "connection_not_found" });
    object.prepare("UPDATE connector_connections SET scope = 'workspace', owner_user_id = NULL WHERE id = ?")
      .run(connectionId);
    await expect(new ConnectionService(env, { ...auth, userId: OTHER_USER_ID, role: "member" })
      .beginResourceAuthorization(connectionId, request, 2))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
  });

  it("refuses to open the provider flow after conversation access is lost", async () => {
    const { auth, env, object, regional } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000014";
    await insertGoogleConnection(object, env, connectionId);
    vi.spyOn(WorkstreamObjectClient.prototype, "readResourceAuthorizationRecovery")
      .mockRejectedValue({ status: 403, code: "workstream_access_denied" });
    await expect(new ConnectionService(env, auth).beginResourceAuthorization(
      connectionId, resourceAuthorizationRequest(connectionId), 2,
    )).rejects.toMatchObject({ status: 403, code: "workstream_access_denied" });
    expect(regional.prepare("SELECT COUNT(*) AS count FROM oauth_states").get()).toEqual({ count: 0 });
  });

  it("settles a denied resource grant and refuses its consumed or expired state", async () => {
    const { auth, env, object, regional } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000012";
    allowResourceConversationAccess(connectionId);
    await insertGoogleConnection(object, env, connectionId);
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockImplementation(async () => Response.json({
      id: "sheet-1", name: "Ellen Buckley Assessment", mimeType: "application/vnd.google-apps.spreadsheet", isAppAuthorized: false,
      capabilities: { canEdit: true },
    })));
    const started = await new ConnectionService(env, auth).beginResourceAuthorization(
      connectionId, resourceAuthorizationRequest(connectionId), 2,
    );
    const state = new URL(started.url!).searchParams.get("state")!;
    const callback = new ConnectionService(env);
    const target = new URL(await callback.completeResourceAuthorizationDenial("google", state));
    expect(target.searchParams.get("status")).toBe("denied");
    expect((await new ConnectionService(env, auth).getOAuthAttempt(started.attemptId)).status).toBe("denied");
    await expect(callback.completeResourceAuthorizationDenial("google", state))
      .rejects.toMatchObject({ status: 401, code: "invalid_oauth_state" });
    expect(regional.prepare("SELECT consumed_at FROM oauth_states WHERE id = ?").get(state))
      .toMatchObject({ consumed_at: expect.any(String) });

    const next = await new ConnectionService(env, auth).beginResourceAuthorization(
      connectionId, resourceAuthorizationRequest(connectionId), 2,
    );
    const expired = new URL(next.url!).searchParams.get("state")!;
    regional.prepare("UPDATE oauth_states SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?")
      .run(expired);
    await expect(callback.completeResourceAuthorizationDenial("google", expired))
      .rejects.toMatchObject({ status: 401, code: "invalid_oauth_state" });
  });

  it("completes the exact Picker file with canonical naming and a member-authored continuation", async () => {
    const { auth, env, object } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000013";
    allowResourceConversationAccess(connectionId);
    await insertGoogleConnection(object, env, connectionId);
    const storedCredentials = object.prepare("SELECT encrypted_credentials FROM connector_connections WHERE id = ?")
      .get(connectionId);
    let granted = false;
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        granted = true;
        return Response.json({ access_token: "temporary-picker-token", token_type: "Bearer", expires_in: 3600 });
      }
      return Response.json({
        id: "sheet-1", name: "Canonical Ellen Buckley Assessment", mimeType: "application/vnd.google-apps.spreadsheet", isAppAuthorized: granted,
        capabilities: { canEdit: true },
      });
    }));
    const admitted: Array<{ auth: AuthContext; input: unknown }> = [];
    const spy = vi.spyOn(WorkstreamObjectClient.prototype, "createMessage")
      .mockImplementation(async function (this: WorkstreamObjectClient, input) {
        admitted.push({ auth: (this as unknown as { auth: AuthContext }).auth, input });
        return {} as Awaited<ReturnType<WorkstreamObjectClient["createMessage"]>>;
      });
    try {
      const started = await new ConnectionService(env, auth).beginResourceAuthorization(
        connectionId, resourceAuthorizationRequest(connectionId), 2,
      );
      const state = new URL(started.url!).searchParams.get("state")!;
      const target = new URL(await new ConnectionService(env).completeResourceAuthorization(
        "google", "picker-code", state, ["sheet-1"],
      ));
      expect(target.searchParams.get("status")).toBe("connected");
      expect(admitted).toEqual([{
        auth: expect.objectContaining({ userId: USER_ID, principal: "resource_authorization" }),
        input: expect.objectContaining({
          text: "Document “Canonical Ellen Buckley Assessment” was authorized.",
          clientMessageId: `resource-authorization:${resourceAuthorizationRequest(connectionId).continuationId}`,
          runMode: "queue",
        }),
      }]);
      expect((await new ConnectionService(env, auth).getOAuthAttempt(started.attemptId)).status).toBe("succeeded");
      expect(object.prepare("SELECT encrypted_credentials FROM connector_connections WHERE id = ?")
        .get(connectionId)).toEqual(storedCredentials);
    } finally {
      spy.mockRestore();
    }
  });

  it("admits the same continuation without Picker when the file is already authorized", async () => {
    const { auth, env, object, regional } = fixture();
    const connectionId = "00000000-0000-4000-8000-000000000015";
    allowResourceConversationAccess(connectionId);
    await insertGoogleConnection(object, env, connectionId);
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({
      id: "sheet-1",
      name: "Canonical Ellen Buckley Assessment",
      mimeType: "application/vnd.google-apps.spreadsheet",
      isAppAuthorized: true,
      capabilities: { canEdit: true },
    })));
    const admit = vi.spyOn(WorkstreamObjectClient.prototype, "createMessage")
      .mockResolvedValue({} as Awaited<ReturnType<WorkstreamObjectClient["createMessage"]>>);
    const started = await new ConnectionService(env, auth).beginResourceAuthorization(
      connectionId, resourceAuthorizationRequest(connectionId), 2,
    );
    expect(started).toMatchObject({ status: "succeeded", url: null });
    expect(admit).toHaveBeenCalledWith(expect.objectContaining({
      text: "Document “Canonical Ellen Buckley Assessment” was authorized.",
      clientMessageId: `resource-authorization:${resourceAuthorizationRequest(connectionId).continuationId}`,
    }));
    expect(regional.prepare("SELECT consumed_at FROM oauth_states").get())
      .toMatchObject({ consumed_at: expect.any(String) });
    expect((await new ConnectionService(env, auth).getOAuthAttempt(started.attemptId)).status).toBe("succeeded");
  });

  it("persists Apollo personal OAuth and reconnects the same owner's connection", async () => {
    const { auth, env, object, regional } = fixture();
    regional.exec("CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
    regional.prepare("INSERT INTO users (id, name) VALUES (?, ?)").run(USER_ID, "Apollo owner");
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.apollo.io/mcp", authorization_servers: ["https://mcp.apollo.io"], scopes_supported: ["read_user_profile", "mixed_people_api_search"] });
      if (url.includes("oauth-authorization-server")) return Response.json({ authorization_endpoint: "https://mcp.apollo.io/authorize", token_endpoint: "https://mcp.apollo.io/token", registration_endpoint: "https://mcp.apollo.io/register", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      if (url.endsWith("/register")) return Response.json({ client_id: "apollo-fixture-client", token_endpoint_auth_method: "none" });
      if (url.endsWith("/token")) return Response.json({ access_token: "apollo-fixture-access", refresh_token: "apollo-fixture-refresh", token_type: "Bearer", expires_in: 3600 });
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const service = new ConnectionService(env, auth);
    await expect(service.beginProvider("apollo", { scope: "workspace", capabilities: ["apollo.personal.mcp"], desktopHandoffVersion: 2 }))
      .rejects.toMatchObject({ code: "invalid_connector_scope" });
    const started = await service.beginProvider("apollo", { scope: "personal", capabilities: ["apollo.personal.mcp"], desktopHandoffVersion: 2 });
    const target = await new ConnectionService(env).completeProvider("apollo", "fixture-code", new URL(started.url).searchParams.get("state")!);
    expect(new URL(target).searchParams.get("provider")).toBe("apollo");
    const row = object.prepare("SELECT id, scope, owner_user_id, encrypted_credentials, credential_iv, config_json FROM connector_connections WHERE connector_type = 'apollo'").get()!;
    expect(row).toMatchObject({ scope: "personal", owner_user_id: USER_ID });
    expect(String(row.encrypted_credentials)).not.toContain("apollo-fixture-access");
    const storedCredentials = JSON.parse(await decryptString(String(row.encrypted_credentials), String(row.credential_iv), env.CONNECTOR_CREDENTIALS_KEY, String(row.id)));
    expect(storedCredentials).toMatchObject({ accessToken: "apollo-fixture-access", refreshToken: "apollo-fixture-refresh", clientId: "apollo-fixture-client" });
    expect(JSON.parse(String(row.config_json))).toMatchObject({ providerTenantId: "https://mcp.apollo.io/mcp", providerUserId: null });
    expect(await service.getOAuthAttempt(started.attemptId)).toMatchObject({ status: "succeeded", connectionId: row.id });
    object.prepare("UPDATE connector_connections SET discovered_tool_count = 1 WHERE id = ?").run(String(row.id));
    expect(await service.list()).toEqual([expect.objectContaining({
      id: row.id, connectorType: "apollo", scope: "personal", ownerUserId: USER_ID, ownerName: "Apollo owner",
    })]);
    const reconnect = await service.reconnect(String(row.id), 2);
    await new ConnectionService(env).completeProvider("apollo", "next-code", new URL(reconnect.url).searchParams.get("state")!);
    expect(object.prepare("SELECT id FROM connector_connections WHERE connector_type = 'apollo'").all()).toEqual([{ id: row.id }]);
  });

  it("starts Canva desktop authorization without feature flags", async () => {
    const { auth, env } = fixture();
    const redirectUri = "http://127.0.0.1:4321/callback";
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth-protected-resource")) return Response.json({ resource: "https://mcp.canva.com", authorization_servers: ["https://mcp.canva.com"] });
      if (url.includes("oauth-authorization-server")) return Response.json({ authorization_endpoint: "https://mcp.canva.com/authorize", token_endpoint: "https://mcp.canva.com/token", registration_endpoint: "https://mcp.canva.com/register", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post"] });
      if (url.endsWith("/register")) {
        expect(JSON.parse(String(init?.body)).redirect_uris).toEqual([redirectUri]);
        return Response.json({ client_id: "fixture-client", client_secret: "fixture-secret", token_endpoint_auth_method: "client_secret_post" });
      }
      throw new Error(`Unexpected provider request: ${url}`);
    });
    const result = await new ConnectionService(env, auth).beginProvider("canva", {
      scope: "personal", capabilities: ["canva.personal.mcp"], loopbackRedirectUri: redirectUri, desktopHandoffVersion: 2,
    });
    expect(new URL(result.url).searchParams.get("redirect_uri")).toBe(redirectUri);
  });

  it("rejects public completion of a desktop Canva authorization without consuming it", async () => {
    const { env, regional } = fixture();
    const sealed = await sealString(JSON.stringify({
      provider: "canva", scope: "personal", verifier: "verifier",
      authorizationState: { redirectUri: "http://127.0.0.1:4321/callback" },
    }), env.OAUTH_STATE_ENCRYPTION_KEY);
    regional.prepare(`INSERT INTO oauth_states
      (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id, return_uri, expires_at)
      VALUES (?, 'global', 'canva', 'connector', ?, ?, ?, 'avalon://auth/complete', ?)`)
      .run("canva-state", sealed, USER_ID, WORKSPACE_ID, new Date(Date.now() + 60_000).toISOString());
    const service = new ConnectionService(env);
    await expect(service.completeProvider("canva", "code", "canva-state"))
      .rejects.toMatchObject({ code: "authentication_required" });
    await expect(service.completeProviderDenial("canva", "canva-state"))
      .rejects.toMatchObject({ code: "authentication_required" });
    expect(regional.prepare("SELECT consumed_at FROM oauth_states WHERE id = ?").get("canva-state"))
      .toEqual({ consumed_at: null });
  });

  it("persists a versioned addressed return for a capable desktop start", async () => {
    const { auth, env, regional } = fixture();

    await new ConnectionService(env, auth).beginGoogle({
      scope: "personal",
      capabilities: ["gmail.read"],
      desktopHandoffVersion: 2,
    });

    const row = regional.prepare("SELECT return_uri FROM oauth_states").get() as { return_uri: string };
    const target = new URL(row.return_uri);
    expect(target.hostname).toBe("workspace");
    expect(target.pathname).toBe(`/global/${WORKSPACE_ID}/auth/complete`);
  });

  it("returns a browser start to the browser's completion page, not a desktop deep link", async () => {
    const { auth, env, regional } = fixture();
    const service = new ConnectionService(env, auth);
    const started = await service.beginGoogle({ scope: "personal", capabilities: ["gmail.read"], desktopHandoffVersion: "browser" });

    const row = regional.prepare("SELECT id, return_uri FROM oauth_states").get() as { id: string; return_uri: string };
    expect(row.return_uri).toBe("https://app.rallywith.ai/connections/complete");

    const target = await service.failProviderAttempt("google", row.id, "provider_failed");
    expect(target).toBe(`https://app.rallywith.ai/connections/complete?provider=google&region=global&attempt=${started.attemptId}&status=failed&error=provider_failed`);
    // A browser target is a page already; it never goes through the desktop handoff.
    expect(desktopHandoffUrl(env, target)).toBe(target);
    // Any other web URL is not a redirect target: it lands on the handoff page.
    expect(new URL(desktopHandoffUrl(env, "https://evil.example.test/connections/complete")).pathname).toBe("/auth/desktop/");
  });

  it("persists the legacy return when the route maps an absent capability to version one", async () => {
    const { auth, env, regional } = fixture();

    await new ConnectionService(env, auth).beginGoogle({
      scope: "personal",
      capabilities: ["gmail.read"],
      desktopHandoffVersion: 1,
    });

    expect(regional.prepare("SELECT return_uri FROM oauth_states").get()).toEqual({
      return_uri: "avalon://auth/complete",
    });
  });

  it("preserves an addressed return through both GitHub OAuth legs", async () => {
    const { auth, env, regional } = fixture();
    const githubEnv = {
      ...env,
      GITHUB_APP_ID: "1",
      GITHUB_APP_CLIENT_ID: "Iv1.test",
      GITHUB_APP_CLIENT_SECRET: "secret",
      GITHUB_APP_PRIVATE_KEY: await testRsaPrivateKey(),
      GITHUB_APP_SLUG: "rally-test",
      GITHUB_WEBHOOK_SECRET: "webhook-secret",
    };
    vi.stubGlobal("fetch", vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(
      JSON.stringify({ id: 42 }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const service = new ConnectionService(githubEnv, auth);
    const started = await service.beginGitHub({
      scope: "workspace",
      capabilities: ["github.metadata.read"],
      desktopHandoffVersion: 2,
    });
    const installState = new URL(started.url).searchParams.get("state")!;

    await service.setupGitHub("42", installState);

    const rows = regional.prepare(
      "SELECT purpose, return_uri FROM oauth_states ORDER BY purpose",
    ).all() as Array<{ purpose: string; return_uri: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.return_uri).toBe(rows[1]!.return_uri);
    expect(parseWorkspaceTarget(new URL(rows[0]!.return_uri))).toEqual({
      region: "global",
      workspaceId: WORKSPACE_ID,
    });
  });

  it("keeps the desktop target in a fragment on the no-store handoff surface", () => {
    const target = `avalon://auth/complete?provider=linear&region=global&attempt=${"a".repeat(43)}&status=denied&error=oauth_denied`;
    const handoff = new URL(desktopHandoffUrl({ PUBLIC_WEB_BASE_URL: "https://with-avalon.com" }, target));

    expect(handoff.origin).toBe("https://with-avalon.com");
    expect(handoff.pathname).toBe("/auth/desktop/");
    expect(handoff.search).toBe("");
    expect(new URLSearchParams(handoff.hash.slice(1)).get("target")).toBe(target);
    expect(__connectionServiceTesting.normalizeOAuthErrorCode("Provider denied access!"))
      .toBe("provider_denied_access");
  });

  it("derives the same minimal ingress route shape used by the migration triggers", () => {
    expect(__connectionServiceTesting.connectorIngressRouteValues({
      id: "connection",
      workspace_id: WORKSPACE_ID,
      connector_type: "github",
      scope: "workspace",
      provider_account_id: "installation",
      status: "needs_reconnect",
      config_json: JSON.stringify({ githubUserId: "github-user" }),
      updated_at: "2026-08-18T00:00:00.000Z",
    }, "global")).toEqual({
      connectionId: "connection",
      workspaceId: WORKSPACE_ID,
      region: "global",
      connectorType: "github",
      scope: "workspace",
      providerAccountId: "installation",
      providerUserId: "github-user",
      status: "active",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
  });

  it("returns an active attempt only to its initiating workspace principal", async () => {
    const { auth, object, env } = fixture();
    const attemptId = "a".repeat(43);
    insertAttempt(object, { id: attemptId, expiresAt: "2099-01-01T00:00:00.000Z" });

    await expect(new ConnectionService(env, auth).getOAuthAttempt(attemptId)).resolves.toEqual({
      attemptId,
      provider: "linear",
      status: "pending",
      connectionId: null,
      errorCode: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await expect(new ConnectionService(env, { ...auth, userId: OTHER_USER_ID }).getOAuthAttempt(attemptId))
      .rejects.toMatchObject({ status: 404, code: "oauth_attempt_not_found" });
  });

  it("durably converts an expired pending attempt into a terminal failure", async () => {
    const { auth, object, env } = fixture();
    const attemptId = "b".repeat(43);
    insertAttempt(object, { id: attemptId, expiresAt: "2020-01-01T00:00:00.000Z" });

    await expect(new ConnectionService(env, auth).getOAuthAttempt(attemptId)).resolves.toMatchObject({
      attemptId,
      status: "failed",
      errorCode: "oauth_attempt_expired",
    });
    expect(object.prepare("SELECT status, error_code FROM connector_oauth_attempts WHERE id = ?")
      .get(attemptId)).toEqual({ status: "failed", error_code: "oauth_attempt_expired" });
  });

  it("lets a callback that already consumed valid state win an expiry reconciliation race", async () => {
    const { auth, object, env } = fixture();
    const attemptId = "c".repeat(43);
    const connectionId = "00000000-0000-7000-8000-000000000004";
    insertConnection(object, connectionId);
    insertAttempt(object, { id: attemptId, expiresAt: "2020-01-01T00:00:00.000Z" });
    const service = new ConnectionService(env, auth);

    await service.getOAuthAttempt(attemptId);
    await (service as unknown as {
      finishOAuthAttempt(
        workspaceId: string,
        id: string,
        status: "succeeded",
        result: { connectionId: string },
      ): Promise<void>;
    }).finishOAuthAttempt(WORKSPACE_ID, attemptId, "succeeded", { connectionId });

    expect(object.prepare(
      "SELECT status, connection_id, error_code FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "succeeded",
      connection_id: connectionId,
      error_code: null,
    });
  });

  it("extends and revives an expiry-reconciled attempt for GitHub's second OAuth leg", async () => {
    const { auth, object, env } = fixture();
    const attemptId = "d".repeat(43);
    const expiresAt = "2099-01-01T00:10:00.000Z";
    insertAttempt(object, {
      id: attemptId,
      status: "failed",
      errorCode: "oauth_attempt_expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const service = new ConnectionService(env, auth);

    await (service as unknown as {
      extendOAuthAttempt(workspaceId: string, id: string, nextExpiry: string): Promise<void>;
    }).extendOAuthAttempt(WORKSPACE_ID, attemptId, expiresAt);

    expect(object.prepare(
      "SELECT status, error_code, completed_at, expires_at FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "pending",
      error_code: null,
      completed_at: null,
      expires_at: expiresAt,
    });
  });

  it("reconciles a healthy committed connection as success after a later callback step fails", async () => {
    const { auth, object, env, regional } = fixture();
    const attemptId = "e".repeat(43);
    const state = "s".repeat(32);
    const connectionId = "00000000-0000-7000-8000-000000000005";
    insertAttempt(object, {
      id: attemptId,
      status: "failed",
      errorCode: "oauth_state_already_used",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const service = new ConnectionService(env, auth);
    // Prepared on the service's own routed database, as every production
    // caller does: the facade refuses a statement prepared on a foreign port.
    const routed = (service as unknown as { env: Env }).env;
    await (service as unknown as {
      persistConnectionMutation(
        statement: D1PreparedStatement,
        id: string,
        connectionIdValue: string,
      ): Promise<D1Result<unknown>>;
    }).persistConnectionMutation(
      routed.DB.prepare(
        `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, granted_scopes_json, status, cursor_json, config_json,
          created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'linear', 'workspace', NULL, NULL, 'Linear', '[]', 'healthy',
                 '{}', '{}', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z',
                 'plugin_linear')`,
      ).bind(connectionId, WORKSPACE_ID),
      attemptId,
      connectionId,
    );
    const sealedState = await sealString(
      JSON.stringify({ attemptId }),
      env.OAUTH_STATE_ENCRYPTION_KEY,
    );
    const returnUri = addWorkspaceTarget(new URL("avalon://auth/complete"), {
      region: "global",
      workspaceId: WORKSPACE_ID,
    }).toString();
    regional.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
        return_uri, expires_at, consumed_at)
       VALUES (?, 'global', 'linear', 'connector', ?, ?, ?, ?, ?, NULL)`,
    ).run(state, sealedState, USER_ID, WORKSPACE_ID, returnUri, "2099-01-01T00:00:00.000Z");

    const target = new URL(await service.failProviderAttempt("linear", state, "audit_write_failed"));

    expect(target.searchParams.get("status")).toBe("connected");
    expect(target.searchParams.get("connection")).toBe(connectionId);
    expect(parseWorkspaceTarget(target)).toEqual({ region: "global", workspaceId: WORKSPACE_ID });
    expect(object.prepare(
      "SELECT status, connection_id, error_code FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "succeeded",
      connection_id: connectionId,
      error_code: null,
    });
  });

  it("keeps addressed routing when recovery settles an attempt as failed", async () => {
    const { auth, object, env, regional } = fixture();
    const attemptId = "f".repeat(43);
    const state = "t".repeat(32);
    insertAttempt(object, { id: attemptId, expiresAt: "2099-01-01T00:00:00.000Z" });
    const sealedState = await sealString(JSON.stringify({ attemptId }), env.OAUTH_STATE_ENCRYPTION_KEY);
    const returnUri = addWorkspaceTarget(new URL("avalon://auth/complete"), {
      region: "global",
      workspaceId: WORKSPACE_ID,
    }).toString();
    regional.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
        return_uri, expires_at, consumed_at)
       VALUES (?, 'global', 'linear', 'connector', ?, ?, ?, ?, ?, NULL)`,
    ).run(state, sealedState, USER_ID, WORKSPACE_ID, returnUri, "2099-01-01T00:00:00.000Z");

    const target = new URL(await new ConnectionService(env, auth)
      .failProviderAttempt("linear", state, "provider_failed"));

    expect(target.searchParams.get("status")).toBe("failed");
    expect(target.searchParams.get("error")).toBe("provider_failed");
    expect(parseWorkspaceTarget(target)).toEqual({ region: "global", workspaceId: WORKSPACE_ID });
  });

  it("always returns to the hosted handoff when GitHub setup recovery also fails", async () => {
    const response = await createApp().request(
      `https://github.with-avalon.com/connections/github/setup?installation_id=1&state=${"x".repeat(20)}`,
      undefined,
      createTestEnv({
        ALLOWED_ORIGINS: "app://avalon",
        AVALON_REGION: "global",
        GITHUB_INGRESS_BASE_URL: "https://github.with-avalon.com",
        PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
        DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
        LOG_LEVEL: "error",
      }),
    );

    expect(response.status).toBe(302);
    const handoff = new URL(response.headers.get("location")!);
    const target = new URL(new URLSearchParams(handoff.hash.slice(1)).get("target")!);
    expect(handoff.pathname).toBe("/auth/desktop/");
    expect(target.searchParams.get("provider")).toBe("github");
    expect(target.searchParams.get("status")).toBe("failed");
    expect(target.searchParams.get("error")).toBe("invalid_oauth_state");
  });
});
