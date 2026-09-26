import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { ConnectionService } from "../src/services/connection-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

/**
 * `GET /connections` carries each row's tool count, so Settings draws the Tools
 * column from one request. The rows live in a real `WorkspaceDO` built from its
 * own migration ledger — the stored count is a column its migration 73 added —
 * and only the provider (a Streamable HTTP MCP server) and the socket publish
 * are doubled.
 */

const USER_ID = asUserId("00000000-0000-4000-8000-000000000011");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000012");
const SERVER_URL = "https://mcp.tool-count.example.test/mcp";

const READ_TOOL = {
  name: "search_docs",
  description: "Search the corpus",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = { name: "publish_doc", description: "Publish a document", inputSchema: { type: "object" } };
const ARCHIVE_TOOL = { name: "archive_doc", description: "Archive a document", inputSchema: { type: "object" } };

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connection tool counts in the connection list", () => {
  it("counts a fixed tool surface from the row's grants without calling the provider", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const service = new ConnectionService(env, auth);
    insertConnection(object, {
      id: "00000000-0000-7000-8000-000000000101",
      connectorType: "google",
      grants: ["gmail.read"],
    });
    insertConnection(object, {
      id: "00000000-0000-7000-8000-000000000102",
      connectorType: "google",
      grants: ["gmail.send"],
      modelPluginId: "plugin_google_send",
    });

    const listed = await service.list();

    expect(listed.map((connection) => [connection.id, connection.toolCount])).toEqual([
      ["00000000-0000-7000-8000-000000000101", 5],
      ["00000000-0000-7000-8000-000000000102", 1],
    ]);
    expect(providerRequests).toEqual([]);
  });

  it("reports the count a discovered connection's last discovery stored, and follows a policy change", async () => {
    const { env, auth, object, providerRequests, published } = fixture();
    const inventory: Record<string, unknown>[] = [READ_TOOL, WRITE_TOOL];
    stubMcpServer(inventory, providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    // Creation proves the server, and the list it answers with finds a row
    // that has never been discovered and discovers it behind the response.
    await vi.waitFor(() => {
      expect(storedCount(object, connection.id)).toBe(2);
    }, { timeout: 5_000 });
    expect(published.at(-1)).toEqual(["connector_connections"]);

    // Opening Connections now is the list and nothing else.
    providerRequests.length = 0;
    expect((await service.list()).find((item) => item.id === connection.id)?.toolCount).toBe(2);
    expect(providerRequests).toEqual([]);

    // A policy save re-reads the catalog it narrows, and the list read right
    // after it already carries the narrowed number.
    await service.updateCustomMcpToolPolicy(connection.id, "read_only_tools");
    expect((await service.list()).find((item) => item.id === connection.id)?.toolCount).toBe(1);

    // The tools pane's live read is a discovery too: a server that grew a tool
    // is counted the next time somebody looks at it.
    await service.updateCustomMcpToolPolicy(connection.id, "all_tools");
    inventory.push(ARCHIVE_TOOL);
    await service.getCustomMcpSettings(connection.id);
    expect((await service.list()).find((item) => item.id === connection.id)?.toolCount).toBe(3);
  });

  it("reports no count, never zero, for a discovered connection whose discovery has not succeeded", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const server = stubMcpServer([READ_TOOL], providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    await vi.waitFor(() => {
      expect(storedCount(object, connection.id)).toBe(1);
    }, { timeout: 5_000 });
    // As a row that predates the column reads, with its server now down.
    object.prepare("UPDATE connector_connections SET discovered_tool_count = NULL WHERE id = ?").run(connection.id);
    server.down = true;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect((await service.list()).find((item) => item.id === connection.id)?.toolCount).toBeNull();
    await vi.waitFor(() => {
      expect(warnings.mock.calls.map(([entry]) => entry as { event?: string; code?: string }))
        .toContainEqual(expect.objectContaining({
          event: "connection_tool_count_refresh_failed",
          code: "provider_error",
        }));
    }, { timeout: 5_000 });
    expect(storedCount(object, connection.id)).toBeNull();
  });

  it("stores what the released per-row endpoint discovers, so older desktops keep the list current", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const inventory: Record<string, unknown>[] = [READ_TOOL];
    stubMcpServer(inventory, providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await service.createCustomMcp({
      displayName: "Acme docs",
      scope: "workspace",
      serverUrl: SERVER_URL,
      requestHeaders: { "X-Api-Key": "secret-value" },
      toolPolicy: "all_tools",
    });
    await vi.waitFor(() => {
      expect(storedCount(object, connection.id)).toBe(1);
    }, { timeout: 5_000 });

    inventory.push(WRITE_TOOL);
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 2 });
    expect(storedCount(object, connection.id)).toBe(2);
  });
});

function storedCount(object: DatabaseSync, connectionId: string): number | null {
  const row = object.prepare(
    "SELECT discovered_tool_count FROM connector_connections WHERE id = ?",
  ).get(connectionId) as { discovered_tool_count: number | null } | undefined;
  if (!row) throw new Error(`connection ${connectionId} is missing`);
  return row.discovered_tool_count;
}

function insertConnection(object: DatabaseSync, input: {
  id: string;
  connectorType: string;
  grants: string[];
  modelPluginId?: string;
}): void {
  object.prepare(
    `INSERT INTO connector_connections
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        granted_scopes_json, model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
     VALUES (?, ?, ?, 'personal', ?, 'account', ?, ?, ?, 'healthy', '{}', '{}', ?, ?)`,
  ).run(
    input.id,
    WORKSPACE_ID,
    input.connectorType,
    USER_ID,
    `Google ${input.id.slice(-3)}`,
    JSON.stringify(input.grants),
    input.modelPluginId ?? `plugin_${input.connectorType}`,
    "2026-09-26T00:00:00.000Z",
    "2026-09-26T00:00:00.000Z",
  );
}

/**
 * One Streamable HTTP MCP server, answering initialize, list, and shutdown.
 *
 * Taken down by flipping `down` rather than by stubbing `fetch` again: the
 * registry is built once per env and its hosted-MCP transport keeps the fetch
 * it was built with.
 */
function stubMcpServer(tools: readonly Record<string, unknown>[], requests: string[]): { down: boolean } {
  const server = { down: false };
  vi.stubGlobal("fetch", async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    requests.push(url.href);
    if (server.down) return new Response("gone", { status: 503 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {} }
      : { tools };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  return server;
}

function fixture(): {
  env: Env;
  auth: AuthContext;
  object: DatabaseSync;
  providerRequests: string[];
  published: string[][];
} {
  const regional = new DatabaseSync(":memory:");
  databases.push(regional);
  regional.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL);
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
  `);
  regional.prepare("INSERT INTO users (id, name) VALUES (?, 'Workspace Owner')").run(USER_ID);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  const published: string[][] = [];
  const stub = {
    ...workspaceObjectRpcs(workspace.instance, ["executeRuntimeSql"]),
    publishSync: async (topics: string[]) => {
      published.push([...topics]);
      return 0;
    },
  };
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return {
    object: workspace.objectDatabase,
    providerRequests: [],
    published,
    env: createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_API_BASE_URL: "https://api.rallywith.ai",
      CONNECTOR_CREDENTIALS_KEY: "test-connector-credentials-key",
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "google-client",
      GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "google-secret",
      WORKSPACE_DOS: binding,
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
