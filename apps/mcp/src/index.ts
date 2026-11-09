import { createMcpHandler } from "@modelcontextprotocol/server";

import { IDENTITY_REGION } from "@rally/contracts/regions";
import { MCP_HOSTED_REDIRECT_ORIGINS, MCP_SCOPE } from "@rally/contracts/mcp-oauth";
import { DEFAULT_MAX_ATTACHMENT_BYTES } from "@rally/contracts";

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

/**
 * The largest MCP request: the largest artifact Rally takes
 * (`DEFAULT_MAX_ATTACHMENT_BYTES`) as base64, four bytes for every three,
 * plus 1 MiB for the JSON-RPC envelope around it (tool name, arguments, a
 * site's file paths). Anything larger is refused 413 before it is parsed. A
 * deployment that raises the API's `MAX_ATTACHMENT_BYTES` above the default
 * must raise this too: this Worker cannot read that variable.
 */
export const MCP_MAX_REQUEST_BYTES = Math.ceil(DEFAULT_MAX_ATTACHMENT_BYTES / 3) * 4 + 1_048_576;

const OAUTH_ROUTES: Record<string, string> = { "/register": "/mcp-oauth/register", "/token": "/mcp-oauth/token", "/revoke": "/mcp-oauth/revoke" };

/**
 * Whether a browser-based client's `Origin` is a hosted client's, compared as
 * the exact serialized origin (scheme, host and port), so `http://claude.ai`
 * and an opaque `null` origin are refused like any other.
 */
export function isHostedClientOrigin(origin: string): boolean {
  return (MCP_HOSTED_REDIRECT_ORIGINS as readonly string[]).includes(origin);
}

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
      // Streamed rather than buffered, so the API's own bound on these small
      // bodies refuses an oversized one without this isolate holding it.
      // `duplex` is what a streamed request body requires outside workerd.
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: { "content-type": request.headers.get("content-type") ?? "application/x-www-form-urlencoded" },
        body: request.body,
        duplex: "half",
      };
      const response = await api.fetch(new Request(forwarded, init));
      const answer = new Response(response.body, response);
      for (const [name, value] of Object.entries(CORS_HEADERS)) answer.headers.set(name, value);
      return answer;
    }

    if (url.pathname !== "/mcp") return new Response("Not found", { status: 404 });
    // A browser-based client must come from a hosted client's origin; a
    // native or server-side client sends no Origin at all. Decided before the
    // bearer, because a preflight carries none.
    const requestOrigin = request.headers.get("origin");
    let allowedOrigin: string | null = null;
    if (requestOrigin !== null) {
      if (!isHostedClientOrigin(requestOrigin)) return Response.json({ error: "origin_not_allowed" }, { status: 403 });
      allowedOrigin = requestOrigin;
    }
    const cors = allowedOrigin === null ? {} : {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { ...cors,
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
        "Access-Control-Max-Age": "600" } });
    }
    const bearer = inspectBearer(request.headers.get("authorization"));
    if (!bearer.ok) {
      // RFC 9728 §5.1: the challenge names the metadata, which is how a
      // client discovers where to sign the person in.
      const error = bearer.reason === "missing" ? "" : `, error="invalid_token"`;
      return new Response(JSON.stringify({ error: bearer.reason === "missing" ? "unauthorized" : "invalid_token" }), {
        status: 401,
        headers: {
          ...CORS_HEADERS,
          ...cors,
          "content-type": "application/json",
          "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"${error}`,
          "Access-Control-Expose-Headers": "WWW-Authenticate",
        },
      });
    }
    const api = regionalApi(env, bearer.region);
    if (!api) return Response.json({ error: "region_unavailable" }, { status: 503, headers: cors });
    const rally = new RallyApi(api, bearer.token, bearer.region);
    // One stateless server per request, for the connected person. The SDK's
    // handler serves both the 2026-07-28 revision and 2025-era clients.
    const response = await createMcpHandler(async () => {
      const server = createRallyMcpServer(rally);
      (await rallySkillCatalog()).attach(server);
      return server;
    }, { maxRequestBodySize: MCP_MAX_REQUEST_BYTES }).fetch(request);
    // The SDK's own 413 says only that the body is too large. Plain text grows
    // when JSON escapes it, so a text file under Rally's limit can still land
    // here; the answer says how to send it instead.
    if (response.status === 413) {
      return Response.json({ error: "request_too_large", error_description:
        `This request is larger than Rally accepts. Send large files, text included, as base64, which grows by exactly a third; a single file may be up to ${DEFAULT_MAX_ATTACHMENT_BYTES / 1_000_000} MB.` },
        { status: 413, headers: cors });
    }
    if (allowedOrigin === null) return response;
    const answered = new Response(response.body, response);
    for (const [name, value] of Object.entries(cors)) answered.headers.set(name, value);
    return answered;
  },
} satisfies ExportedHandler<Env>;
