import { asUserId, asWorkspaceId } from "@rally/contracts";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthContext, Env, HonoAppEnv } from "../src/env";
import { requireAuth } from "../src/middleware/auth";
import { errorHandler } from "../src/middleware/errors";
import { connectionRoutes } from "../src/routes/connections";
import { ConnectionService } from "../src/services/connection-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { drainWaitUntil } from "./helpers/cloudflare-workers";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { createTestWorkspaceDO, workspaceObjectRpcs } from "./helpers/workspace-object-rpcs";

/**
 * `GET /connections` carries each row's tool count, so Settings draws the Tools
 * column from one request. The regional database is the checked-in migrations;
 * the rows live in a real `WorkspaceDO` built from its own migration ledger —
 * the stored count is a column its migration 73 added — and only the provider
 * (a Streamable HTTP MCP server) and the socket publish are doubled.
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

describe("the connection list's reads", () => {
  it("reads owner names and personal delivery surfaces concurrently, and lists both", async () => {
    // The two reads the list makes once it has its rows: owner names from the
    // regional database, and the Slack identity links from the Organization
    // object. Each start and finish is recorded; the owners' read finishes a
    // turn of the event loop after it starts, so a list that waits for it
    // before asking for the links records the links only after it.
    const events: string[] = [];
    const ownersRead = (database: D1Database): D1Database => new Proxy(database, {
      get: (target, property) => property !== "prepare"
        ? Reflect.get(target, property, target)
        : (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("FROM users WHERE id IN")) return statement;
          return new Proxy(statement, {
            get: (prepared, member) => member !== "bind"
              ? Reflect.get(prepared, member, prepared)
              : (...values: unknown[]) => {
                const bound = prepared.bind(...values);
                return new Proxy(bound, {
                  get: (read, method) => method !== "all" ? Reflect.get(read, method, read) : async () => {
                    events.push("owners:start");
                    const result = await bound.all();
                    await new Promise((resolve) => setImmediate(resolve));
                    events.push("owners:end");
                    return result;
                  },
                });
              },
          });
        },
    });
    const { env, auth, object } = fixture({
      slack: true,
      regional: ownersRead,
      onRuntimeSql: (input, phase) => { if (JSON.stringify(input).includes("slack_user_links")) events.push(`links:${phase}`); },
    });
    const connectionId = "00000000-0000-7000-8000-000000000501";
    insertConnection(object, { id: connectionId, connectorType: "slack", grants: [] });
    object.prepare(`INSERT INTO slack_user_links
      (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status, created_at, updated_at)
      VALUES ('link', ?, ?, ?, 'T1', 'U1', 'active', '2026-09-26T00:00:00.000Z', '2026-09-26T00:00:00.000Z')`)
      .run(WORKSPACE_ID, connectionId, USER_ID);

    const listed = await new ConnectionService(env, auth).list();

    expect(listed.map((connection) => [connection.id, connection.ownerName, connection.userDelivery])).toEqual([[
      connectionId,
      "Workspace Owner",
      { targetType: "slack_agent_dm", label: "Slack", description: "A direct message from Rally in your Slack." },
    ]]);
    // Concurrent, in either order: each read starts before the other ends.
    expect(events.indexOf("owners:start")).toBeLessThan(events.lastIndexOf("links:end"));
    expect(events.indexOf("links:start")).toBeLessThan(events.lastIndexOf("owners:end"));
  });
});

describe("connection tool counts in the connection list", () => {
  it("counts a fixed tool surface from the row's grants, with the page tools activation adds, without calling the provider", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const service = new ConnectionService(env, auth);
    // `gmail.read` authors eight tools; search and draft listing each add
    // a continuation tool on activation, so the agent sees ten.
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

    expect(listed.map((connection) => [connection.id, connection.toolCount, connection.toolCountMissing])).toEqual([
      ["00000000-0000-7000-8000-000000000101", 10, null],
      ["00000000-0000-7000-8000-000000000102", 2, null],
    ]);
    expect(providerRequests).toEqual([]);
  });

  it("says a row has no count because this region does not register its connector", async () => {
    const { env, auth, object } = fixture();
    const service = new ConnectionService(env, auth);
    // Linear is registered only where its OAuth client is configured, and
    // this env configures none — as a region whose rollout gate is off.
    insertConnection(object, {
      id: "00000000-0000-7000-8000-000000000104",
      connectorType: "linear",
      grants: ["linear.read"],
    });

    const listed = await service.list();

    expect(listed.map((connection) => [connection.id, connection.toolCount, connection.toolCountMissing])).toEqual([
      ["00000000-0000-7000-8000-000000000104", null, "connector_unavailable"],
    ]);
  });

  it("reports the count a discovered connection's last discovery stored, and follows a policy change", async () => {
    const { env, auth, object, providerRequests, published, publishedConnectionIds } = fixture();
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
    await drainWaitUntil();
    expect(storedCount(object, connection.id)).toBe(2);
    expect(published.at(-1)).toEqual(["connector_connections"]);
    // Only the connection's own audience refetches: its owner if personal.
    expect(publishedConnectionIds.at(-1)).toBe(connection.id);

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

  it("reports no count, never zero, and spends the list's one discovery once when it fails", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const server = stubMcpServer([READ_TOOL], providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);
    expect(storedCount(object, connection.id)).toBe(1);
    // As a row that predates migration 73 reads, with its server now down.
    forgetCount(object, connection.id);
    server.down = true;
    providerRequests.length = 0;
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // The list that starts the discovery says so.
    expect(listed(await service.list(), connection.id)).toEqual({ toolCount: null, toolCountMissing: "counting" });
    await drainWaitUntil();
    expect(warnings.mock.calls.map(([entry]) => entry as { event?: string; code?: string }))
      .toContainEqual(expect.objectContaining({
        event: "connection_tool_count_refresh_failed",
        code: "provider_error",
      }));
    expect(storedCount(object, connection.id)).toBeNull();
    const firstAttempt = providerRequests.length;
    expect(firstAttempt).toBeGreaterThan(0);

    // A second open of the tab is the list and nothing else: the failed
    // attempt is not retried behind it, and the row says it is not counted.
    expect(listed(await service.list(), connection.id)).toEqual({ toolCount: null, toolCountMissing: "not_counted" });
    await drainWaitUntil();
    expect(providerRequests.length).toBe(firstAttempt);
  });

  it("starts one discovery between two lists that find the same row uncounted at once", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const server = stubMcpServer([READ_TOOL, WRITE_TOOL], providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);
    forgetCount(object, connection.id);
    server.toolLists = 0;

    // Two members' windows focusing together: both lists read the row
    // uncounted and unclaimed before either background claim runs.
    const [first, second] = await Promise.all([service.list(), service.list()]);
    expect(listed(first, connection.id).toolCountMissing).toBe("counting");
    expect(listed(second, connection.id).toolCountMissing).toBe("counting");
    await drainWaitUntil();

    expect(server.toolLists).toBe(1);
    expect(storedCount(object, connection.id)).toBe(2);
  });

  it("backfills server metadata once for an existing counted connection without blocking the list", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const server = stubMcpServer([READ_TOOL], providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);
    object.prepare("UPDATE connector_connections SET config_json = json_remove(config_json, '$.mcpServerMetadata') WHERE id = ?")
      .run(connection.id);
    server.toolLists = 0;
    const [first, second] = await Promise.all([service.list(), service.list()]);
    expect(listed(first, connection.id)).toEqual({ toolCount: 1, toolCountMissing: null });
    expect(listed(second, connection.id)).toEqual({ toolCount: 1, toolCountMissing: null });
    await drainWaitUntil();
    expect(server.toolLists).toBe(1);
    expect(object.prepare("SELECT json_extract(config_json, '$.mcpServerMetadata.description') AS description FROM connector_connections WHERE id = ?")
      .get(connection.id)).toEqual({ description: "Available tools: search_docs: Search the corpus" });
    await service.list();
    await drainWaitUntil();
    expect(server.toolLists).toBe(1);
  });

  it("clears a stored count when a discovery fails, so a broken connection never shows its old number", async () => {
    const { env, auth, object, providerRequests, published, publishedConnectionIds } = fixture();
    const inventory: Record<string, unknown>[] = [READ_TOOL, WRITE_TOOL];
    const server = stubMcpServer(inventory, providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);
    expect(storedCount(object, connection.id)).toBe(2);
    published.length = 0;
    publishedConnectionIds.length = 0;

    // A 5xx leaves the row `healthy` — only an authorization refusal moves
    // the status — so the count is what has to stop claiming tools.
    server.down = true;
    await expect(service.getToolCount(connection.id, new AbortController().signal)).rejects.toThrow();
    expect(storedCount(object, connection.id)).toBeNull();
    expect(listed(await service.list(), connection.id)).toEqual({ toolCount: null, toolCountMissing: "not_counted" });
    // Open clients are told, once, and only the connection's audience.
    expect(published).toEqual([["connector_connections"]]);
    expect(publishedConnectionIds).toEqual([connection.id]);

    // A server that recovers is counted by the next discovery.
    server.down = false;
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 2 });
    expect(storedCount(object, connection.id)).toBe(2);

    // A catalog `load_plugin` would refuse — two names that collide once
    // normalized — offers the agent none of these tools, so it clears too.
    inventory.push({ ...READ_TOOL, name: "search-docs" });
    await expect(service.getToolCount(connection.id, new AbortController().signal)).rejects.toThrow();
    expect(storedCount(object, connection.id)).toBeNull();
  });

  it("drops a discovery that finishes after a policy change instead of overwriting the newer count", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const server = stubMcpServer([READ_TOOL, WRITE_TOOL], providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);
    expect(storedCount(object, connection.id)).toBe(2);

    // A discovery taken under `all_tools`, parked at the server's answer.
    const held = holdNextToolList(server);
    const late = service.getToolCount(connection.id, new AbortController().signal);
    await held.arrived;
    await service.updateCustomMcpToolPolicy(connection.id, "read_only_tools");
    expect(storedCount(object, connection.id)).toBe(1);

    held.release();
    expect(await late).toEqual({ count: 2 });
    expect(storedCount(object, connection.id)).toBe(1);
    expect(object.prepare("SELECT json_extract(config_json, '$.mcpServerMetadata.description') AS description FROM connector_connections WHERE id = ?")
      .get(connection.id)).toEqual({ description: "Available tools: search_docs: Search the corpus" });
  });

  it("drops a discovery that finishes after a reconnect to another account", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const server = stubMcpServer([READ_TOOL, WRITE_TOOL], providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);

    const held = holdNextToolList(server);
    const late = service.getToolCount(connection.id, new AbortController().signal);
    await held.arrived;
    // A reconnect as someone else lands while the discovery is in flight.
    object.prepare(
      `UPDATE connector_connections SET provider_account_id = 'another-account', discovered_tool_count = NULL,
        config_json = json_set(config_json, '$.mcpServerMetadata', json('{"description":"New account guidance"}')) WHERE id = ?`,
    ).run(connection.id);

    held.release();
    expect(await late).toEqual({ count: 2 });
    expect(storedCount(object, connection.id)).toBeNull();
    expect(object.prepare("SELECT json_extract(config_json, '$.mcpServerMetadata.description') AS description FROM connector_connections WHERE id = ?")
      .get(connection.id)).toEqual({ description: "New account guidance" });
  });

  it("stores what the released per-row endpoint discovers, so older desktops keep the list current", async () => {
    const { env, auth, object, providerRequests } = fixture();
    const inventory: Record<string, unknown>[] = [READ_TOOL];
    stubMcpServer(inventory, providerRequests);
    const service = new ConnectionService(env, auth);
    const { connection } = await createAndCount(service);
    expect(storedCount(object, connection.id)).toBe(1);

    inventory.push(WRITE_TOOL);
    expect(await service.getToolCount(connection.id, new AbortController().signal)).toEqual({ count: 2 });
    expect(storedCount(object, connection.id)).toBe(2);
  });

  it("carries the count and the reason it is missing through GET /connections", async () => {
    const { env, object } = fixture({ devAuth: true });
    insertConnection(object, {
      id: "00000000-0000-7000-8000-000000000105",
      connectorType: "google",
      grants: ["gmail.read"],
    });
    insertConnection(object, {
      id: "00000000-0000-7000-8000-000000000106",
      connectorType: "linear",
      grants: ["linear.read"],
    });
    const app = new Hono<HonoAppEnv>();
    app.use("*", requireAuth);
    app.route("/connections", connectionRoutes);
    app.onError(errorHandler);

    const response = await app.request("/connections", {
      headers: { "x-rally-dev-user-id": USER_ID, "x-rally-dev-workspace-id": WORKSPACE_ID },
    }, env);

    expect(response.status).toBe(200);
    const body = await response.json() as { items: Array<{ id: string; toolCount: unknown; toolCountMissing: unknown }> };
    expect(body.items.map((item) => [item.id, item.toolCount, item.toolCountMissing])).toEqual([
      ["00000000-0000-7000-8000-000000000105", 10, null],
      ["00000000-0000-7000-8000-000000000106", null, "connector_unavailable"],
    ]);
  });
});

async function createAndCount(service: ConnectionService) {
  const created = await service.createCustomMcp({
    displayName: "Acme docs",
    scope: "workspace",
    serverUrl: SERVER_URL,
    requestHeaders: { "X-Api-Key": "secret-value" },
    toolPolicy: "all_tools",
  });
  await drainWaitUntil();
  return created;
}

function listed(connections: Awaited<ReturnType<ConnectionService["list"]>>, id: string) {
  const connection = connections.find((item) => item.id === id);
  if (!connection) throw new Error(`connection ${id} is not listed`);
  return { toolCount: connection.toolCount, toolCountMissing: connection.toolCountMissing };
}

/** As a row that predates migration 73 reads: never counted, never claimed. */
function forgetCount(object: DatabaseSync, connectionId: string): void {
  object.prepare(
    `UPDATE connector_connections
        SET discovered_tool_count = NULL, tool_count_backfill_attempted_at = NULL
      WHERE id = ?`,
  ).run(connectionId);
}

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
    `Connection ${input.id.slice(-3)}`,
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
interface StubMcpServer {
  down: boolean;
  /** How many `tools/list` requests reached the server: one per discovery. */
  toolLists: number;
  /** Taken by the next `tools/list`, which answers only once it resolves. */
  hold: { arrived: () => void; release: Promise<void> } | null;
}

function stubMcpServer(tools: readonly Record<string, unknown>[], requests: string[]): StubMcpServer {
  const server: StubMcpServer = { down: false, toolLists: 0, hold: null };
  vi.stubGlobal("fetch", async (target: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    requests.push(url.href);
    if (server.down) return new Response("gone", { status: 503 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "tools/list") server.toolLists += 1;
    if (request.method === "tools/list" && server.hold) {
      const hold = server.hold;
      server.hold = null;
      hold.arrived();
      await hold.release;
    }
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: {} }
      : { tools };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  return server;
}

function holdNextToolList(server: StubMcpServer): { arrived: Promise<void>; release: () => void } {
  let arrived!: () => void;
  let release!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });
  server.hold = { arrived, release: new Promise<void>((resolve) => { release = resolve; }) };
  return { arrived: arrival, release };
}

function fixture(options: {
  devAuth?: boolean;
  /** Registers Slack, whose delivery surface needs a personal identity link. */
  slack?: boolean;
  /** Stands between the service and the regional database. */
  regional?: (database: D1Database) => D1Database;
  /** Sees every statement the service routes to the Organization object. */
  onRuntimeSql?: (input: unknown, phase: "start" | "end") => void;
} = {}): {
  env: Env;
  auth: AuthContext;
  object: DatabaseSync;
  providerRequests: string[];
  published: string[][];
  publishedConnectionIds: Array<string | null>;
} {
  const regional = migratedSqliteDatabase();
  databases.push(regional);
  const at = "2026-09-26T00:00:00.000Z";
  regional.prepare(`INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES (?, 'tool-count', 'tool-count@example.test', 'Workspace Owner', ?, ?)`).run(USER_ID, at, at);
  regional.prepare(`INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES (?, 'Tool count', 'tool-count', 'global', ?, ?, ?)`).run(WORKSPACE_ID, USER_ID, at, at);
  regional.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES (?, ?, 'owner', 'active', ?)`).run(WORKSPACE_ID, USER_ID, at);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  const published: string[][] = [];
  const publishedConnectionIds: Array<string | null> = [];
  const rpcs = workspaceObjectRpcs(workspace.instance, ["executeRuntimeSql"]);
  const executeRuntimeSql = rpcs.executeRuntimeSql as (...args: unknown[]) => unknown;
  const stub = {
    ...rpcs,
    executeRuntimeSql: async (...args: unknown[]) => {
      options.onRuntimeSql?.(args[0], "start");
      try { return await executeRuntimeSql(...args); } finally { options.onRuntimeSql?.(args[0], "end"); }
    },
    publishSync: async (topics: string[], _workspaceId: string, _placement: unknown, detail?: { connectionId?: string }) => {
      published.push([...topics]);
      publishedConnectionIds.push(detail?.connectionId ?? null);
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
    publishedConnectionIds,
    env: createTestEnv({
      DB: options.regional ? options.regional(sqliteD1(regional)) : sqliteD1(regional),
      AVALON_REGION: "global",
      ...(options.slack
        ? { SLACK_CLIENT_ID: "slack-client", SLACK_CLIENT_SECRET: "slack-secret", SLACK_SIGNING_SECRET: "slack-signing" }
        : {}),
      ...(options.devAuth
        ? { APP_ENV: "development", RALLY_DEV_AUTH: "true" }
        : { APP_ENV: "test" }),
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
