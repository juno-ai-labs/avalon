import { createMcpHandler } from "@modelcontextprotocol/server";

import { IDENTITY_REGION } from "@rally/contracts/regions";
import { MCP_HOSTED_REDIRECT_ORIGINS, MCP_SCOPE } from "@rally/contracts/mcp-oauth";

import { inspectBearer, RallyApi, regionalApi } from "./api";
import type { Env } from "./env";
import { createRallyMcpServer } from "./server";
import { rallySkillCatalog } from "./skills";

/**
 * Rally's MCP server for its users, at `mcp.rallywith.ai`. It is the OAuth
 * protected resource and publishes the authorization server's metadata; the
 * registration, token and revocation endpoints it names are forwarded to the
 * identity deployment's API, and the consent page is the browser app's.
 * `docs/rally-mcp.md`.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
};

/** OAuth's public endpoints carry no cookie and no ambient authority, so any origin may read them (a browser-based MCP inspector does). */
function publicJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store" } });
}

/** RFC 9728: which authorization server issues tokens for `/mcp`. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    resource_name: "Rally",
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [MCP_SCOPE],
  };
}

/** RFC 8414: the authorization server, whose consent page is the browser app's. */
export function authorizationServerMetadata(origin: string, browserOrigin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${browserOrigin}/app/oauth/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    revocation_endpoint: `${origin}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
  };
}

const OAUTH_ROUTES: Record<string, string> = { "/register": "/mcp-oauth/register", "/token": "/mcp-oauth/token", "/revoke": "/mcp-oauth/revoke" };

const hostedOriginHostnames = MCP_HOSTED_REDIRECT_ORIGINS.map((origin) => new URL(origin).hostname);

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    if (request.method === "OPTIONS" && url.pathname !== "/mcp") return new Response(null, { status: 204, headers: CORS_HEADERS });

    // Clients ask for the resource metadata at the root or under the
    // resource's own path (RFC 9728 §3.1), and for the server metadata at the
    // root; older MCP clients also try OpenID's name for it.
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return publicJson(protectedResourceMetadata(origin));
    }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      return publicJson(authorizationServerMetadata(origin, env.BROWSER_APP_ORIGIN));
    }

    const oauthPath = OAUTH_ROUTES[url.pathname];
    if (oauthPath) {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST" } });
      // Registration and tokens live with identity; this is a configured
      // service binding, never a caller-chosen host.
      const api = regionalApi(env, IDENTITY_REGION);
      if (!api) return publicJson({ error: "temporarily_unavailable", error_description: "Rally is unavailable" }, 503);
      const forwarded = new URL(oauthPath, "https://api.internal");
      const response = await api.fetch(new Request(forwarded, {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
        body: await request.arrayBuffer(),
      }));
      const answer = new Response(response.body, response);
      for (const [name, value] of Object.entries(CORS_HEADERS)) answer.headers.set(name, value);
      return answer;
    }

    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    const bearer = inspectBearer(request.headers.get("authorization"));
    if (!bearer.ok) {
      // RFC 9728 §5.1: the challenge names the metadata, which is how a
      // client discovers where to sign the person in.
      const error = bearer.reason === "missing" ? "" : `, error="invalid_token"`;
      return new Response(JSON.stringify({ error: bearer.reason === "missing" ? "unauthorized" : "invalid_token" }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          "content-type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"${error}`,
          "Access-Control-Expose-Headers": "WWW-Authenticate",
        },
      });
    }
    // A browser-based client must come from a hosted client's origin; a
    // native or server-side client sends no Origin at all.
    const requestOrigin = request.headers.get("origin");
    if (requestOrigin !== null && !hostedOriginHostnames.includes(new URL(requestOrigin).hostname)) {
      return Response.json({ error: "origin_not_allowed" }, { status: 403 });
    }
    const api = regionalApi(env, bearer.region);
    if (!api) return Response.json({ error: "region_unavailable" }, { status: 503 });
    const rally = new RallyApi(api, bearer.token, bearer.region);
    // One stateless server per request, for the connected person. The SDK's
    // handler serves both the 2026-07-28 revision and 2025-era clients; its
    // request body bound is the SDK's own default (4 MiB), see
    // `docs/rally-mcp.md#failure-modes-and-limits`.
    return createMcpHandler(async () => {
      const server = createRallyMcpServer(rally);
      (await rallySkillCatalog()).attach(server);
      return server;
    }).fetch(request);
  },
} satisfies ExportedHandler<Env>;
