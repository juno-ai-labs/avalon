import { asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import {
  createCustomMcpConnector,
  customMcpToolPolicy,
  listCustomMcpToolInventory,
  selectCustomMcpTools,
} from "./custom-mcp";
import type { FetchLike } from "./provider-utils";
import { neverAborts } from "./test-signals";
import { authorizedConnection, type ConnectorConnectionContext } from "./types";

const WORKSPACE_ID = asWorkspaceId("22222222-2222-4222-8222-222222222222");
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

const READ_TOOL = {
  name: "search_docs",
  description: "Search the corpus",
  inputSchema: { type: "object" as const, properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const WRITE_TOOL = {
  name: "publish_doc",
  description: "Publish a document",
  inputSchema: { type: "object" as const, properties: { id: { type: "string" } } },
  annotations: { readOnlyHint: false, destructiveHint: true },
};
/** Most servers annotate nothing at all, which is the case a policy has to get right. */
const UNANNOTATED_TOOL = {
  name: "run_job",
  description: "Run a job",
  inputSchema: { type: "object" as const },
};

function connection(overrides: Partial<ConnectorConnectionContext> = {}) {
  return authorizedConnection({
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: WORKSPACE_ID,
    scope: "personal",
    ownerUserId: OWNER_ID,
    grantedScopes: ["custom_mcp.tools"],
    credentials: { authMode: "headers", requestHeaders: { "x-api-key": "secret-value" } },
    config: { serverUrl: "https://mcp.example.test/mcp", authMode: "headers", toolPolicy: "all_tools" },
    cursor: {},
    ...overrides,
  });
}

/** A server that answers the whole Streamable HTTP lifecycle from one catalog. */
function mcpServer(input: {
  tools: readonly Record<string, unknown>[];
  onRequest?: (request: Record<string, unknown>, headers: Headers, url: URL) => void;
}): FetchLike {
  return async (target, init) => {
    const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
    input.onRequest?.(request, new Headers(init?.headers), url);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const id = request.id as number;
    if (request.method === "initialize") {
      return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    }
    if (request.method === "tools/list") {
      return json({ jsonrpc: "2.0", id, result: { tools: input.tools } });
    }
    return json({
      jsonrpc: "2.0",
      id,
      result: { structuredContent: { called: (request.params as { name: string }).name }, content: [] },
    });
  };
}

describe("custom MCP connector", () => {
  it("dials the connection's own server with the headers it stores", async () => {
    const seen: Array<{ url: string; auth: string | null; apiKey: string | null }> = [];
    const adapter = createCustomMcpConnector({
      redirectUri: "https://api.example.test/connections/custom-mcp/callback",
      fetch: mcpServer({
        tools: [READ_TOOL],
        onRequest: (_request, headers, url) => seen.push({
          url: url.href,
          auth: headers.get("authorization"),
          apiKey: headers.get("x-api-key"),
        }),
      }),
    });

    const definitions = await adapter.dynamicAgentTools!.discover(
      connection({ config: {
        serverUrl: "https://second.example.test/rpc",
        authMode: "headers",
        toolPolicy: "all_tools",
      } }),
      neverAborts(),
    );

    expect(definitions.map((definition) => definition.name)).toEqual(["search_docs"]);
    expect(seen[0]?.url).toBe("https://second.example.test/rpc");
    expect(seen[0]?.apiKey).toBe("secret-value");
    // Header authentication carries no bearer token, and a stray empty one
    // would be sent to a third-party server on every request.
    expect(seen[0]?.auth).toBeNull();
  });

  it("keeps a read-only workspace connection to the tools the server marks read-only", async () => {
    const called: string[] = [];
    const adapter = createCustomMcpConnector({
      redirectUri: "https://api.example.test/connections/custom-mcp/callback",
      fetch: mcpServer({
        tools: [READ_TOOL, WRITE_TOOL, UNANNOTATED_TOOL],
        onRequest: (request) => {
          if (request.method === "tools/call") called.push(String((request.params as { name: string }).name));
        },
      }),
    });
    const readOnly = connection({
      scope: "workspace",
      ownerUserId: null,
      config: {
        serverUrl: "https://mcp.example.test/mcp",
        authMode: "headers",
        toolPolicy: "read_only_tools",
      },
    });

    const definitions = await adapter.dynamicAgentTools!.discover(readOnly, neverAborts());
    expect(definitions.map((definition) => definition.name)).toEqual(["search_docs"]);
    // An unannotated tool is a write until the server says otherwise; treating
    // an absent hint as read-only would admit every one of them.
    expect(definitions.every((definition) => definition.mode === "write")).toBe(true);

    // The policy is enforced again against the catalog read before the call, so
    // an activation taken while the connection allowed everything cannot spend
    // a write after the policy narrowed.
    await expect(adapter.executeTool("publish_doc", { id: "doc-1" }, {
      connection: readOnly,
      principal: { type: "workspace", workspaceId: WORKSPACE_ID },
      signal: neverAborts(),
    })).rejects.toThrow(/no longer exposes/iu);
    expect(called).toEqual([]);

    await expect(adapter.executeTool("search_docs", { query: "invoices" }, {
      connection: readOnly,
      principal: { type: "workspace", workspaceId: WORKSPACE_ID },
      signal: neverAborts(),
    })).resolves.toMatchObject({ output: { called: "search_docs" } });
    expect(called).toEqual(["search_docs"]);
  });

  it("holds the read-only policy to workspace connections", () => {
    const personal = connection({
      config: {
        serverUrl: "https://mcp.example.test/mcp",
        authMode: "headers",
        toolPolicy: "read_only_tools",
      },
    });
    // A personal connection acts as its owner and is usable by nobody else, so
    // the stored value is ignored rather than quietly narrowing their own tools.
    expect(customMcpToolPolicy(personal)).toBe("all_tools");
    expect(customMcpToolPolicy(connection({
      scope: "workspace",
      ownerUserId: null,
      config: {
        serverUrl: "https://mcp.example.test/mcp",
        authMode: "headers",
        toolPolicy: "read_only_tools",
      },
    }))).toBe("read_only_tools");
  });

  it("selects by the server's own read-only hint and nothing else", () => {
    expect(selectCustomMcpTools([READ_TOOL, WRITE_TOOL, UNANNOTATED_TOOL], "read_only_tools")
      .map((tool) => tool.name)).toEqual(["search_docs"]);
    expect(selectCustomMcpTools([READ_TOOL, WRITE_TOOL, UNANNOTATED_TOOL], "all_tools")
      .map((tool) => tool.name)).toEqual(["search_docs", "publish_doc", "run_job"]);
  });

  it("refuses a connection whose configuration is not a usable server", async () => {
    const adapter = createCustomMcpConnector({
      redirectUri: "https://api.example.test/connections/custom-mcp/callback",
      fetch: mcpServer({ tools: [READ_TOOL] }),
    });
    await expect(adapter.dynamicAgentTools!.discover(
      connection({ config: { serverUrl: "http://mcp.example.test/mcp", authMode: "headers" } }),
      neverAborts(),
    )).rejects.toThrow(/server configuration/iu);
  });

  it("reports every advertised tool to a person, with the policy that withholds it", async () => {
    const inventory = await listCustomMcpToolInventory(
      connection({
        scope: "workspace",
        ownerUserId: null,
        config: {
          serverUrl: "https://mcp.example.test/mcp",
          authMode: "headers",
          toolPolicy: "read_only_tools",
        },
      }),
      neverAborts(),
      { fetch: mcpServer({ tools: [READ_TOOL, WRITE_TOOL, UNANNOTATED_TOOL] }) },
    );

    expect(inventory.policy).toBe("read_only_tools");
    expect(inventory.tools).toEqual([
      { name: "search_docs", description: "Search the corpus", readOnly: true, destructive: false, available: true },
      { name: "publish_doc", description: "Publish a document", readOnly: false, destructive: true, available: false },
      { name: "run_job", description: "Run a job", readOnly: false, destructive: false, available: false },
    ]);
  });

  it("authorizes against the server the request names, trusting the resource's own metadata", async () => {
    const requested: string[] = [];
    const fetcher: FetchLike = async (target, init) => {
      const url = new URL(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
      requested.push(url.href);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({
          resource: "https://tenant.example.test/mcp",
          // A different origin from the MCP resource: the case a code-authored
          // connector would refuse, and the one a configured server must allow.
          authorization_servers: ["https://login.identity.test"],
          scopes_supported: ["mcp"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return json({
          authorization_endpoint: "https://login.identity.test/authorize",
          token_endpoint: "https://login.identity.test/token",
          registration_endpoint: "https://login.identity.test/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
        });
      }
      if (url.pathname === "/register") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_name: "Rally",
          redirect_uris: ["https://api.example.test/connections/custom-mcp/callback"],
        });
        return json({ client_id: "registered-client", client_secret: "registered-secret" });
      }
      const form = new URLSearchParams(String(init?.body));
      return form.get("grant_type") === "authorization_code"
        ? json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 })
        : json({ access_token: "access-2", token_type: "Bearer", expires_in: 3600 });
    };
    const adapter = createCustomMcpConnector({
      redirectUri: "https://api.example.test/connections/custom-mcp/callback",
      fetch: fetcher,
    });

    const authorization = await adapter.beginAuthorization!({
      state: "state-value-that-is-long",
      codeChallenge: "challenge-value-that-is-long",
      connectionScope: "workspace",
      serverUrl: "https://tenant.example.test/mcp",
    });
    expect(new URL(authorization.url).origin).toBe("https://login.identity.test");
    expect(requested[0]).toBe("https://tenant.example.test/.well-known/oauth-protected-resource/mcp");

    const credentials = await adapter.handleAuthorizationCallback!({
      code: "code-value",
      codeVerifier: "verifier-value-that-is-long",
      connectionScope: "workspace",
      authorizationState: authorization.state,
    });
    // The resource is the account identity: a reconnect that landed on another
    // server would not match, and there is no user the server has to name.
    expect(credentials).toMatchObject({
      providerAccountId: "https://tenant.example.test/mcp",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      clientId: "registered-client",
    });

    // The server issued no new refresh token, which most do not. Dropping the
    // stored one would make the next refresh impossible.
    await expect(adapter.refreshCredentials!({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: WORKSPACE_ID,
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: ["custom_mcp.tools"],
      credentials: { ...credentials },
      config: {
        serverUrl: "https://tenant.example.test/mcp",
        authMode: "oauth",
        toolPolicy: "all_tools",
      },
      cursor: {},
    }, neverAborts())).resolves.toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
  });

  it("refuses an authorization whose server advertises a different protected resource", async () => {
    const adapter = createCustomMcpConnector({
      redirectUri: "https://api.example.test/connections/custom-mcp/callback",
      fetch: async () => json({
        resource: "https://somewhere.else.test/mcp",
        authorization_servers: ["https://login.identity.test"],
      }),
    });
    await expect(adapter.beginAuthorization!({
      state: "state-value-that-is-long",
      codeChallenge: "challenge-value-that-is-long",
      connectionScope: "personal",
      serverUrl: "https://tenant.example.test/mcp",
    })).rejects.toThrow(/unexpected protected resource/iu);
  });
});

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });
}
