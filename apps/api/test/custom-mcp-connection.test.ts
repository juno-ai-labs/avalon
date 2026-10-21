import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { decryptString } from "../src/lib/crypto";
import { ConnectionService } from "../src/services/connection-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const MEMBER_ID = asUserId("00000000-0000-4000-8000-000000000003");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000002");
const CREDENTIAL_KEY = "custom-mcp-connection-test-key";
const SERVER_URL = "https://mcp.example.test/mcp";

const READ_TOOL = {
  name: "search_docs",
  description: "Search the corpus",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = {
  name: "publish_doc",
  description: "Publish a document",
  inputSchema: { type: "object" },
};

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("custom MCP connections", () => {
  it("stores a header-authenticated server only once it answers, and reports its live catalog", async () => {
    const { auth, database, env } = fixture();
    const requests: Array<{ url: string; apiKey: string | null }> = [];
    stubMcpServer([READ_TOOL, WRITE_TOOL], requests);
    const service = new ConnectionService(env, auth);

    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "read_only_tools",
    });

    expect(connection).toMatchObject({
      connectorType: "custom_mcp",
      displayName: "Acme docs",
      scope: "workspace",
      grantedCapabilities: ["custom_mcp.tools"],
      settingsKind: "custom_mcp_tools",
      status: "healthy",
    });
    expect(requests.every((request) => request.url === SERVER_URL)).toBe(true);
    expect(requests[0]?.apiKey).toBe("secret-value");

    const row = database.prepare(
      "SELECT config_json, encrypted_credentials, credential_iv, provider_account_id, model_plugin_id FROM connector_connections WHERE id = ?",
    ).get(connection.id) as {
      config_json: string;
      encrypted_credentials: string;
      credential_iv: string;
      provider_account_id: string;
      model_plugin_id: string;
    };
    expect(JSON.parse(row.config_json)).toMatchObject({
      serverUrl: SERVER_URL,
      authMode: "headers",
      toolPolicy: "read_only_tools",
    });
    expect(row.provider_account_id).toBe(SERVER_URL);
    expect(row.model_plugin_id).toBe("plugin_custom_mcp");
    // The headers are a credential: encrypted at rest, bound to the connection,
    // and never returned to a client.
    await expect(decryptString(
      row.encrypted_credentials,
      row.credential_iv,
      CREDENTIAL_KEY,
      connection.id,
    )).resolves.toBe(JSON.stringify({ authMode: "headers", requestHeaders: { "X-Api-Key": "secret-value" } }));

    const settings = await service.getCustomMcpSettings(connection.id);
    expect(settings).toMatchObject({
      serverUrl: SERVER_URL,
      authMode: "headers",
      toolPolicy: "read_only_tools",
      toolPolicyEditable: true,
      toolsUnavailable: null,
    });
    expect(settings.tools).toEqual([
      { name: "search_docs", description: "Search the corpus", readOnly: true, destructive: false, available: true },
      { name: "publish_doc", description: "Publish a document", readOnly: false, destructive: false, available: false },
    ]);
  });

  it("leaves nothing behind when the server cannot be used", async () => {
    const { auth, database, env } = fixture();
    vi.stubGlobal("fetch", async () => new Response("no", { status: 502 }));
    const service = new ConnectionService(env, auth);

    await expect(service.createCustomMcp({
      displayName: "Broken",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).rejects.toMatchObject({ status: 422, code: "custom_mcp_unreachable" });

    // A row that stays would hold its plugin name, appear in Connections, and
    // fail every run that loaded it.
    expect(database.prepare("SELECT count(*) AS count FROM connector_connections").get())
      .toEqual({ count: 0 });
  });

  it("ends a stalled tool count with the existing Settings inventory deadline", async () => {
    vi.useFakeTimers();
    const { auth, env } = fixture();
    stubMcpServer([READ_TOOL]);
    const providerFetch = globalThis.fetch;
    let stall = false;
    let started!: () => void;
    const providerStarted = new Promise<void>((resolve) => { started = resolve; });
    vi.stubGlobal("fetch", (target: string | URL | Request, init?: RequestInit) => {
      if (!stall || init?.method === "DELETE") return providerFetch(target, init);
      started();
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs", scope: "workspace", serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
    });
    stall = true;
    const caller = new AbortController();
    let outcome: unknown;
    const pending = service.getToolCount(connection.id, caller.signal)
      .then((value) => { outcome = value; }, (error: unknown) => { outcome = error; });
    await providerStarted;
    await vi.advanceTimersByTimeAsync(20_000);
    try {
      expect(outcome).toMatchObject({ name: "TimeoutError" });
    } finally {
      caller.abort();
      await pending;
    }
  });

  it.each(["personal", "workspace"] as const)("counts static tools from granted capabilities for a %s connection", async (scope) => {
    const { auth, env, database } = fixture();
    env.GOOGLE_CONNECTOR_OAUTH_CLIENT_ID = "test-client";
    env.GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET = "test-secret";
    stubMcpServer([READ_TOOL]);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Google", scope, serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" }, toolPolicy: "all_tools",
    });
    database.prepare("UPDATE connector_connections SET connector_type = 'google', granted_scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["gmail.read"]), connection.id);
    // Eight authored `gmail.read` tools plus search and draft-list continuation
    // tools generated on activation.
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 10 });
    database.prepare("UPDATE connector_connections SET granted_scopes_json = ? WHERE id = ?")
      .run(JSON.stringify(["gmail.send"]), connection.id);
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 2 });
  });

  it("refuses a tool count when connection prefixes make remote tool names collide", async () => {
    const { auth, env } = fixture();
    const inventory = [READ_TOOL];
    stubMcpServer(inventory);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    // The provider can change its inventory after connection setup. These names
    // differ within 64 characters, but collide once Rally prefixes their wire names.
    inventory.splice(0, inventory.length,
      { ...READ_TOOL, name: `${"a".repeat(60)}x` },
      { ...READ_TOOL, name: `${"a".repeat(60)}y` },
    );

    await expect(service.getToolCount(connection.id, new AbortController().signal))
      .rejects.toMatchObject({
        code: "provider_error",
        message: expect.stringContaining("collide after model-facing normalization"),
      });
  });

  it("narrows a workspace connection's tools when the policy changes, and refuses the toggle on a personal one", async () => {
    const { auth, database, env } = fixture();
    stubMcpServer([READ_TOOL, WRITE_TOOL]);
    const service = new ConnectionService(env, auth);

    const workspace = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    expect((await service.getCustomMcpSettings(workspace.connection.id)).tools
      .filter((tool) => tool.available)
      .map((tool) => tool.name)).toEqual(["search_docs", "publish_doc"]);

    expect(await service.getToolCount(workspace.connection.id, new AbortController().signal)).toEqual({ count: 2 });
    const updated = await service.updateCustomMcpToolPolicy(workspace.connection.id, "read_only_tools");
    expect(await service.getToolCount(workspace.connection.id, new AbortController().signal)).toEqual({ count: 1 });
    expect(updated.toolPolicy).toBe("read_only_tools");
    expect(updated.tools.filter((tool) => tool.available).map((tool) => tool.name)).toEqual(["search_docs"]);
    expect((await service.getCustomMcpSettings(workspace.connection.id)).toolPolicy).toBe("read_only_tools");

    const personal = await service.createCustomMcp({
      displayName: "My docs",
      scope: "personal",
      serverUrl: "https://personal.example.test/mcp",
      requestHeaders: { "X-Api-Key": "personal-value" },
      toolPolicy: "read_only_tools",
    });
    const personalSettings = await service.getCustomMcpSettings(personal.connection.id);
    expect(personalSettings).toMatchObject({ toolPolicy: "all_tools", toolPolicyEditable: false });
    // Stored as `all_tools`, not merely reported as it: the adapter reads the
    // same field for every scope, so a personal row that kept the requested
    // value would narrow the owner's own tools with no way to widen them again.
    const personalRow = database.prepare(
      "SELECT config_json FROM connector_connections WHERE id = ?",
    ).get(personal.connection.id) as { config_json: string };
    expect(JSON.parse(personalRow.config_json)).toMatchObject({ toolPolicy: "all_tools" });
    await expect(service.updateCustomMcpToolPolicy(personal.connection.id, "read_only_tools"))
      .rejects.toMatchObject({ status: 422, code: "custom_mcp_policy_unsupported" });
  });

  it("refuses a read-only connection to a server that marks nothing read-only", async () => {
    const { auth, database, env } = fixture();
    // The server advertises a tool, so counting the raw catalog would accept
    // this. The policy leaves nothing to call, and every activation would fail.
    stubMcpServer([WRITE_TOOL]);
    const service = new ConnectionService(env, auth);

    await expect(service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "read_only_tools",
    })).rejects.toMatchObject({
      status: 422,
      code: "custom_mcp_unreachable",
      // The message a person can act on: choose "All tools". The generic
      // empty-catalog wording would leave them guessing at their own server.
      message: expect.stringContaining("marks none of its tools read-only"),
    });
    expect(database.prepare("SELECT count(*) AS count FROM connector_connections").get())
      .toEqual({ count: 0 });

    // The same server is usable with the policy that can reach it.
    await expect(service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).resolves.toMatchObject({ connection: { displayName: "Acme docs" } });
  });

  it("refuses a policy change that would leave the connection able to call nothing", async () => {
    const { auth, env } = fixture();
    stubMcpServer([WRITE_TOOL]);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });

    // Narrowing this to read-only would leave the plugin unloadable, which
    // creation already refuses; arriving there by a settings change is the
    // same outcome with nothing to tell the person why.
    await expect(service.updateCustomMcpToolPolicy(connection.id, "read_only_tools"))
      .rejects.toMatchObject({ status: 422, code: "custom_mcp_policy_admits_nothing" });
    expect((await service.getCustomMcpSettings(connection.id)).toolPolicy).toBe("all_tools");

    // A server that cannot be reached is not evidence about the policy, so it
    // does not block the change.
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 503 }));
    await expect(service.updateCustomMcpToolPolicy(connection.id, "read_only_tools"))
      .resolves.toMatchObject({ toolPolicy: "read_only_tools" });
  });

  it("does not offer a member a policy control their change would be refused by", async () => {
    const { auth, env } = fixture();
    stubMcpServer([READ_TOOL, WRITE_TOOL]);
    const { connection } = await new ConnectionService(env, auth).createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    const memberService = new ConnectionService(env, {
      sessionId: "session",
      userId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    // A member may read the catalog — knowing what the workspace can call is
    // theirs to know — but the control they would be 403'd on is not offered.
    const settings = await memberService.getCustomMcpSettings(connection.id);
    expect(settings).toMatchObject({ toolPolicy: "all_tools", toolPolicyEditable: false });
    expect(settings.tools.map((tool) => tool.name)).toEqual(["search_docs", "publish_doc"]);
    await expect(memberService.updateCustomMcpToolPolicy(connection.id, "read_only_tools"))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
  });

  it("keeps a workspace server an administrator's decision", async () => {
    const { env } = fixture();
    stubMcpServer([READ_TOOL]);
    const memberService = new ConnectionService(env, {
      sessionId: "session",
      userId: MEMBER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "member",
    });

    await expect(memberService.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });

    // Their own connection is theirs to make.
    await expect(memberService.createCustomMcp({
      displayName: "My docs",
      scope: "personal",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    })).resolves.toMatchObject({ connection: { scope: "personal" } });
  });

  it("reports an unreachable server as an unreadable catalog rather than a failed screen", async () => {
    const { auth, env } = fixture();
    stubMcpServer([READ_TOOL]);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });

    vi.stubGlobal("fetch", async () => new Response("gone", { status: 503 }));
    const settings = await service.getCustomMcpSettings(connection.id);
    expect(settings).toMatchObject({ serverUrl: SERVER_URL, toolPolicy: "all_tools", tools: [] });
    expect(settings.toolsUnavailable).toMatch(/503/u);
  });
});

/** One Streamable HTTP MCP server, answering initialize, list, and shutdown. */
function stubMcpServer(
  tools: readonly Record<string, unknown>[],
  requests: Array<{ url: string; apiKey: string | null }> = [],
): void {
  vi.stubGlobal("fetch", async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    const headers = new Headers(init?.headers);
    requests.push({ url: url.href, apiKey: headers.get("x-api-key") });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const id = request.id as number;
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {} }
      : { tools };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
}

/**
 * The regional database is the checked-in migrations, and `connector_connections`
 * lives where production keeps it: in a real `WorkspaceDO` built from its own
 * migration ledger. `database` is that object's store. Only the MCP server and
 * the socket publish are doubled.
 */
function fixture() {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  const at = "2026-09-26T00:00:00.000Z";
  const insertUser = regional.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  insertUser.run(USER_ID, "custom-mcp-owner", "owner@example.test", "Workspace Owner", at, at);
  insertUser.run(MEMBER_ID, "custom-mcp-member", "member@example.test", "Workspace Member", at, at);
  regional.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Custom MCP', 'custom-mcp', 'global', ?, ?, ?)`).run(WORKSPACE_ID, USER_ID, at, at);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  const stub = {
    ...workspaceObjectRpcs(workspace.instance, ["executeRuntimeSql"]),
    publishSync: async () => 0,
  };
  const workspaceObjects: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => workspaceObjects,
  });
  const database = workspace.objectDatabase;
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
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      PUBLIC_API_BASE_URL: "https://api.example.test",
      CONNECTOR_CREDENTIALS_KEY: CREDENTIAL_KEY,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      WORKSPACE_DOS: workspaceObjects,
    }),
  };
}
