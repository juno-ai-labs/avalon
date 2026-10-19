import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { createApolloConnector } from "./apollo";
import { ConnectorRegistry } from "./index";
import { authorizedConnection, type ConnectorConnectionContext } from "./types";
import { neverAborts } from "./test-signals";

const redirectUri = "https://api.example.test/connections/apollo/callback";
const owner = asUserId("33333333-3333-4333-8333-333333333333");
function connection(scope: "personal" | "workspace" = "personal") {
  return authorizedConnection({
    id: "11111111-1111-4111-8111-111111111111",
    workspaceId: asWorkspaceId("22222222-2222-4222-8222-222222222222"),
    scope, ownerUserId: scope === "personal" ? owner : null,
    grantedScopes: ["apollo.personal.mcp"], credentials: { accessToken: "fixture-access" },
    config: {}, cursor: {},
  } satisfies ConnectorConnectionContext);
}

describe("Apollo.io personal connector", () => {
  it("registers a personal-only deferred tool surface without event ingestion", async () => {
    const adapter = new ConnectorRegistry([createApolloConnector({ redirectUri })]).get("apollo");
    expect(adapter.manifest.supportedScopes).toEqual(["personal"]);
    expect(adapter.manifest.tools).toEqual([]);
    expect(adapter.manifest.activityTypes).toEqual([]);
    expect(adapter.dynamicAgentTools?.connectionScopes).toEqual(["personal"]);
    await expect(adapter.beginAuthorization!({ connectionScope: "workspace" })).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(adapter.handleAuthorizationCallback!({ connectionScope: "workspace" })).rejects.toMatchObject({ code: "invalid_configuration" });
    await expect(adapter.dynamicAgentTools!.discover(connection("workspace"), neverAborts())).rejects.toMatchObject({ code: "invalid_configuration" });
  });

  it.each(["https://api.rallywith.ai", "https://enterprise.api.rallywith.ai"])("discovers OAuth, exchanges PKCE, rotates and revokes credentials for %s", async (origin) => {
    const redirect = `${origin}/connections/apollo/callback`;
    const grants: string[] = [];
    let revoked = false;
    const adapter = createApolloConnector({ redirectUri: redirect, now: () => Date.parse("2026-10-19T12:00:00Z"), fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://mcp.apollo.io");
      if (url.pathname.includes("oauth-protected-resource")) return Response.json({
        resource: "https://mcp.apollo.io/mcp", authorization_servers: ["https://mcp.apollo.io"],
        scopes_supported: ["read_user_profile", "mixed_people_api_search"],
      });
      if (url.pathname.includes("oauth-authorization-server")) return Response.json({
        issuer: "https://mcp.apollo.io", authorization_endpoint: "https://mcp.apollo.io/mcp/oauth_metadata/redirect_to_authorize",
        token_endpoint: "https://mcp.apollo.io/api/v1/oauth/token", revocation_endpoint: "https://mcp.apollo.io/api/v1/oauth/revoke",
        registration_endpoint: "https://mcp.apollo.io/api/v1/oauth/applications/register_oauth_client",
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      });
      if (url.pathname.endsWith("register_oauth_client")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ client_name: "Rally", redirect_uris: [redirect], token_endpoint_auth_method: "client_secret_post", scope: "read_user_profile mixed_people_api_search" });
        return Response.json({ client_id: "fixture-client", client_secret: "fixture-secret", token_endpoint_auth_method: "client_secret_post" });
      }
      const form = new URLSearchParams(String(init?.body));
      if (url.pathname.endsWith("/revoke")) {
        expect(form.get("token")).toBe("fixture-rotated-refresh");
        expect(form.get("token_type_hint")).toBe("refresh_token");
        revoked = true;
        return new Response(null, { status: 200 });
      }
      expect(url.pathname).toBe("/api/v1/oauth/token");
      expect(form.get("client_id")).toBe("fixture-client");
      expect(form.get("client_secret")).toBe("fixture-secret");
      expect(form.get("resource")).toBe("https://mcp.apollo.io/mcp");
      grants.push(form.get("grant_type")!);
      if (form.get("grant_type") === "authorization_code") {
        expect(form.get("code_verifier")).toBe("fixture-verifier");
        expect(form.get("redirect_uri")).toBe(redirect);
        return Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", token_type: "Bearer", expires_in: 3600 });
      }
      expect(form.get("refresh_token")).toBe("fixture-refresh");
      return Response.json({ access_token: "fixture-rotated-access", refresh_token: "fixture-rotated-refresh", token_type: "Bearer", expires_in: 7200 });
    } });
    const started = await adapter.beginAuthorization!({ connectionScope: "personal", state: "fixture-state", codeChallenge: "fixture-challenge" });
    const url = new URL(started.url);
    expect(url.pathname).toBe("/mcp/oauth_metadata/redirect_to_authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ state: "fixture-state", code_challenge: "fixture-challenge", code_challenge_method: "S256", resource: "https://mcp.apollo.io/mcp" });
    const credentials = await adapter.handleAuthorizationCallback!({ connectionScope: "personal", authorizationState: started.state, code: "fixture-code", codeVerifier: "fixture-verifier" });
    expect(credentials).toMatchObject({ accessToken: "fixture-access", refreshToken: "fixture-refresh", providerAccountId: "https://mcp.apollo.io/mcp", expiresAt: "2026-10-19T13:00:00.000Z" });
    const personal = connection(); personal.credentials = credentials;
    personal.credentials = await adapter.refreshCredentials!(personal, neverAborts());
    expect(personal.credentials).toMatchObject({ accessToken: "fixture-rotated-access", refreshToken: "fixture-rotated-refresh", expiresAt: "2026-10-19T14:00:00.000Z" });
    await adapter.revoke!(personal, neverAborts());
    expect(grants).toEqual(["authorization_code", "refresh_token"]);
    expect(revoked).toBe(true);
  });

  it("forwards the live Apollo operation and arguments and refuses another person's principal", async () => {
    const calls: unknown[] = [];
    const adapter = createApolloConnector({ redirectUri, fetch: async (url, init) => {
      expect(String(url)).toBe("https://mcp.apollo.io/mcp");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-access");
      const request = JSON.parse(String(init?.body));
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      let result: unknown;
      if (request.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {} };
      else if (request.method === "tools/list") result = { tools: [{ name: "search_people", description: "Find prospects", inputSchema: { type: "object", properties: { titles: { type: "array", items: { type: "string" } } } }, annotations: { readOnlyHint: true } }] };
      else { calls.push(request.params); result = { content: [{ type: "text", text: "Found a prospect" }] }; }
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    } });
    const personal = connection();
    const tools = await adapter.dynamicAgentTools!.discover(personal, neverAborts());
    expect(tools.map((tool) => ({ name: tool.name, capability: tool.capability, mode: tool.mode })))
      .toEqual([{ name: "search_people", capability: "apollo.personal.mcp", mode: "write" }]);
    const context = { connection: personal, principal: { type: "user" as const, userId: owner, workspaceId: personal.workspaceId }, signal: neverAborts() };
    await adapter.executeTool("search_people", { titles: ["VP Sales"] }, context);
    expect(calls).toEqual([{ name: "search_people", arguments: { titles: ["VP Sales"] } }]);
    await expect(adapter.executeTool("search_people", {}, { ...context, principal: { ...context.principal, userId: asUserId("44444444-4444-4444-8444-444444444444") } })).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toHaveLength(1);
  });

  it("marks a revoked refresh grant as reconnect required", async () => {
    const adapter = createApolloConnector({ redirectUri, fetch: async () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    const personal = connection();
    personal.credentials = { accessToken: "expired", refreshToken: "revoked", resource: "https://mcp.apollo.io/mcp", authorizationEndpoint: "https://mcp.apollo.io/auth", tokenEndpoint: "https://mcp.apollo.io/api/v1/oauth/token", clientId: "fixture-client", scope: "read_user_profile", tokenEndpointAuthMethod: "none" };
    await expect(adapter.refreshCredentials!(personal, neverAborts())).rejects.toMatchObject({ code: "unauthorized", details: { reconnectRequired: true } });
  });
});
