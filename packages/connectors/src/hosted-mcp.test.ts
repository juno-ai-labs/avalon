import { describe, expect, it, vi } from "vitest";
import { neverAborts } from "./test-signals";
import {
  createHostedMcpPassthrough,
  hostedMcpToolDefinitions,
} from "./hosted-mcp";
import type { FetchLike } from "./provider-utils";
import { authorizedConnection } from "./types";

describe("hosted MCP abstraction", () => {
  it.each(["Inspect production logs", undefined, "   "])("discovers server guidance and a tool-derived fallback for %s", async (description) => {
    const passthrough = createHostedMcpPassthrough({
      providerName: "Metadata", serverUrl: "https://mcp.example.test/mcp",
      capabilities: ["provider.personal.mcp"], connectionScopes: ["personal"],
      capabilityForConnection: () => "provider.personal.mcp",
      withAccessToken: async (_connection, _signal, operation) => operation("token"),
      fetch: async (_url, init) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const request = JSON.parse(String(init?.body));
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        return rpc(request.id, request.method === "initialize"
          ? { protocolVersion: "2025-06-18", serverInfo: { name: "Example", version: "1", description },
              instructions: "Choose an account first.\nThen inspect the exact Worker." }
          : { tools: [{ name: "query_logs", description: "Query Worker logs", inputSchema: { type: "object" } }] });
      },
    });
    const connection = authorizedConnection({ id: "metadata", workspaceId: "workspace", scope: "personal",
      ownerUserId: "user", grantedScopes: ["provider.personal.mcp"], credentials: {}, config: {}, cursor: {} });
    expect((await passthrough.dynamicAgentTools.discoverCatalog!(connection, neverAborts())).server).toEqual({
      description: description?.trim() || "Available tools: query_logs: Query Worker logs",
      instructions: "Choose an account first.\nThen inspect the exact Worker.",
    });
  });

  it("preserves the live schema and treats remote annotations only as hints", () => {
    expect(hostedMcpToolDefinitions([
      {
        name: "live-search",
        description: "Search the provider",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "Future.Tool",
        description: "A tool added after Avalon shipped",
        inputSchema: { type: "object", additionalProperties: true },
      },
    ], "provider.personal.mcp")).toEqual([
      expect.objectContaining({
        name: "live-search",
        capability: "provider.personal.mcp",
        mode: "write",
        idempotency: "record_before_execute",
        inputSchema: expect.objectContaining({ required: ["query"] }),
      }),
      expect.objectContaining({
        name: "future_tool",
        providerOperationName: "Future.Tool",
        capability: "provider.personal.mcp",
        mode: "write",
        idempotency: "record_before_execute",
      }),
    ]);

    expect(() => hostedMcpToolDefinitions([
      { name: "same-name", inputSchema: { type: "object" } },
      { name: "same_name", inputSchema: { type: "object" } },
    ], "provider.personal.mcp")).toThrow(/collide/iu);
    expect(() => hostedMcpToolDefinitions([
      { name: "bad-schema", inputSchema: { type: "string" } as never },
    ], "provider.personal.mcp")).toThrow(/object/iu);
  });

  it("applies trusted deadlines by exact provider operation name", () => {
    expect(hostedMcpToolDefinitions([
      { name: "Slow.Query", inputSchema: { type: "object" } },
      { name: "ordinary-read", inputSchema: { type: "object" } },
    ], "provider.personal.mcp", {
      "Slow.Query": 300_000,
    })).toEqual([
      expect.objectContaining({
        name: "slow_query",
        providerOperationName: "Slow.Query",
        timeoutMs: 300_000,
      }),
      expect.objectContaining({ name: "ordinary-read", timeoutMs: 30_000 }),
    ]);
  });

  it("discovers paginated tools and forwards the exact live name and arguments", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let session = 0;
    const fetcher: FetchLike = async (_input, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-token");
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = request.id as number;
      if (request.method === "initialize") {
        session += 1;
        return rpc(id, { protocolVersion: "2025-06-18", capabilities: {} }, {
          "mcp-session-id": `session-${session}`,
        });
      }
      if (request.method === "tools/list") {
        const cursor = (request.params as { cursor?: string }).cursor;
        return rpc(id, cursor
          ? {
              tools: [{
                name: "Future.Tool",
                description: "Created by the MCP server",
                inputSchema: { type: "object", properties: { value: { type: "number" } } },
              }],
            }
          : {
              tools: [{
                name: "live-search",
                description: "Search live data",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
                annotations: { readOnlyHint: true },
              }],
              nextCursor: "page-2",
            });
      }
      expect(request).toMatchObject({
        method: "tools/call",
        params: { name: "Future.Tool", arguments: { value: 42 } },
      });
      return rpc(id, { structuredContent: { accepted: 42 }, content: [], isError: false });
    };
    const connection = authorizedConnection({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      scope: "personal",
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      grantedScopes: ["provider.personal.mcp"],
      credentials: { accessToken: "access-token" },
      config: {},
      cursor: {},
    });
    const passthrough = createHostedMcpPassthrough({
      providerName: "Provider",
      serverUrl: "https://mcp.example.test/mcp",
      capabilities: ["provider.personal.mcp"],
      connectionScopes: ["personal"],
      capabilityForConnection: () => "provider.personal.mcp",
      withAccessToken: (_connection, _signal, operation) => operation("access-token"),
      fetch: fetcher,
    });

    const definitions = await passthrough.dynamicAgentTools.discover(connection, neverAborts());
    expect(definitions.map((definition) => definition.name)).toEqual(["live-search", "future_tool"]);
    expect(definitions[1]?.providerOperationName).toBe("Future.Tool");
    await expect(passthrough.execute(
      connection,
      definitions[1]!.providerOperationName!,
      { value: 42 },
      neverAborts(),
    )).resolves.toMatchObject({ output: { accepted: 42 } });
    const initializeRequests = requests.filter((request) => request.method === "initialize");
    expect(initializeRequests.length).toBeGreaterThan(0);
    for (const request of initializeRequests) {
      expect(request.params).toEqual(expect.objectContaining({
        clientInfo: { name: "Rally", version: "1.0.0" },
      }));
    }
    expect(requests.filter((request) => request.method === "tools/list")).toHaveLength(4);
  });

  it("fails closed when a fresh catalog collides with an activated alias", async () => {
    let session = 0;
    let called = false;
    const fetcher: FetchLike = async (_input, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = request.id as number;
      if (request.method === "initialize") {
        session += 1;
        return rpc(id, { protocolVersion: "2025-06-18", capabilities: {} }, {
          "mcp-session-id": `session-${session}`,
        });
      }
      if (request.method === "tools/list") {
        return rpc(id, {
          tools: session === 1
            ? [{ name: "Future.Tool", inputSchema: { type: "object" } }]
            : [
                { name: "future_tool", inputSchema: { type: "object" } },
                { name: "Future.Tool", inputSchema: { type: "object" } },
              ],
        });
      }
      called = true;
      return rpc(id, { structuredContent: {}, content: [], isError: false });
    };
    const connection = authorizedConnection({
      id: "11111111-1111-4111-8111-111111111111",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      scope: "personal",
      ownerUserId: "33333333-3333-4333-8333-333333333333",
      grantedScopes: ["provider.personal.mcp"],
      credentials: { accessToken: "access-token" },
      config: {},
      cursor: {},
    });
    const passthrough = createHostedMcpPassthrough({
      providerName: "Provider",
      serverUrl: "https://mcp.example.test/mcp",
      capabilities: ["provider.personal.mcp"],
      connectionScopes: ["personal"],
      capabilityForConnection: () => "provider.personal.mcp",
      withAccessToken: (_connection, _signal, operation) => operation("access-token"),
      fetch: fetcher,
    });

    const definitions = await passthrough.dynamicAgentTools.discover(connection, neverAborts());
    await expect(passthrough.execute(
      connection,
      definitions[0]!.providerOperationName!,
      {},
      neverAborts(),
    )).rejects.toThrow(/collide/iu);
    expect(called).toBe(false);
  });

  it("discovers OAuth metadata, dynamically registers, and exchanges rotating credentials", async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return json({
          resource: "https://mcp.example.test/mcp",
          authorization_servers: ["https://mcp.example.test/tenant"],
          scopes_supported: ["default"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server/tenant") {
        return json({
          authorization_endpoint: "https://mcp.example.test/authorize",
          token_endpoint: "https://mcp.example.test/token",
          registration_endpoint: "https://mcp.example.test/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_name: "Rally",
          redirect_uris: ["https://avalon.example.test/callback"],
          token_endpoint_auth_method: "none",
          scope: "default offline_access",
        });
        return json({ client_id: "dynamic-client", token_endpoint_auth_method: "none" });
      }
      const form = new URLSearchParams(String(init?.body));
      return form.get("grant_type") === "authorization_code"
        ? json({ access_token: "access-1", refresh_token: "refresh-1", token_type: "Bearer", expires_in: 3600 })
        : json({ access_token: "access-2", refresh_token: "refresh-2", token_type: "Bearer", expires_in: 3600 });
    }) as FetchLike;
    const passthrough = createHostedMcpPassthrough({
      providerName: "Provider",
      serverUrl: "https://mcp.example.test/mcp",
      capabilities: ["provider.personal.mcp"],
      connectionScopes: ["personal"],
      capabilityForConnection: () => "provider.personal.mcp",
      withAccessToken: (_connection, _signal, operation) => operation("unused"),
      oauth: {
        redirectUri: "https://avalon.example.test/callback",
        additionalScopes: ["offline_access"],
      },
      fetch: fetcher,
    });

    const authorization = await passthrough.authorization.begin({
      state: "state-value",
      codeChallenge: "challenge-value",
    });
    const url = new URL(authorization.url);
    expect(url.searchParams.get("client_id")).toBe("dynamic-client");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value");
    expect(url.searchParams.get("resource")).toBe("https://mcp.example.test/mcp");
    expect(url.searchParams.get("scope")).toBe("default offline_access");
    await expect(passthrough.authorization.exchangeCode(authorization.state, {
      code: "code-value",
      codeVerifier: "verifier-value",
    })).resolves.toMatchObject({ access_token: "access-1", refresh_token: "refresh-1" });
    await expect(passthrough.authorization.refresh(
      authorization.state,
      "refresh-1",
      neverAborts(),
    )).resolves.toMatchObject({ access_token: "access-2", refresh_token: "refresh-2" });
    expect(calls.map((call) => call.url.pathname)).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/tenant",
      "/register",
      "/token",
      "/token",
    ]);
  });
});

function rpc(id: number, result: unknown, headers: Record<string, string> = {}): Response {
  return json({ jsonrpc: "2.0", id, result }, headers);
}

function json(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
  });
}
