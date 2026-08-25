import { asUserId } from "@rally/contracts";
import { asWorkspaceId } from "@rally/contracts";
import { NormalizedActivitySchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import {
  createNotionConnector,
  normalizeNotionWebhook,
  NotionCapabilities,
  readNotionWebhookVerificationToken,
  verifyNotionWebhook,
} from "./notion";
import type { FetchLike } from "./provider-utils";
import {
  type AuthorizedConnectorConnection,
  authorizedConnection,
} from "./types";

const INTEGRATION_ID = "11111111-1111-4111-8111-111111111111";
const NOTION_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const BOT_ID = "33333333-3333-4333-8333-333333333333";
const AVALON_USER_ID = asUserId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
const AVALON_WORKSPACE_ID = asWorkspaceId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
const AVALON_CONNECTION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("Notion connector", () => {
  it("uses user-authorized public OAuth for a workspace connection and returns an install-specific bot identity", async () => {
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/v1/oauth/token");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Basic ${btoa("notion-client:notion-secret")}`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        grant_type: "authorization_code",
        code: "notion-code",
        redirect_uri: "https://api.avalon.test/connections/notion/callback",
      });
      return jsonResponse({
        access_token: "notion-access",
        refresh_token: "notion-refresh",
        token_type: "bearer",
        bot_id: BOT_ID,
        workspace_id: NOTION_WORKSPACE_ID,
        workspace_name: "Acme Notes",
        owner: {
          type: "user",
          user: { id: "notion-user-1", name: "Ada Lovelace", person: { email: "ada@example.com" } },
        },
      });
    };
    const adapter = notionAdapter(fetcher);
    expect(adapter.manifest.supportedScopes).toEqual(["personal", "workspace"]);
    const authorization = await adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      connectionScope: "workspace",
      scopes: [NotionCapabilities.read, NotionCapabilities.commentRead],
    });
    const url = new URL(authorization.url);
    expect(url.searchParams.get("owner")).toBe("user");
    expect(url.searchParams.get("state")).toBe("s".repeat(32));
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.has("code_challenge")).toBe(false);

    await expect(adapter.handleAuthorizationCallback!({
      code: "notion-code",
      codeVerifier: "v".repeat(43),
      connectionScope: "workspace",
    })).resolves.toMatchObject({
      accessToken: "notion-access",
      refreshToken: "notion-refresh",
      botId: BOT_ID,
      notionWorkspaceId: NOTION_WORKSPACE_ID,
      notionOwnerUserId: "notion-user-1",
      notionOwnerUserName: "Ada Lovelace",
      notionOwnerUserEmail: "ada@example.com",
      integrationId: INTEGRATION_ID,
      providerAccountId: BOT_ID,
      providerAccountName: "Acme Notes",
    });
  });

  it("uses hosted MCP discovery, DCR, and PKCE for a personal Notion connection", async () => {
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return jsonResponse({ error: "not_found" }, 404);
      }
      if (url.pathname === "/.well-known/oauth-protected-resource") {
        return jsonResponse({
          resource: "https://mcp.notion.com/mcp",
          authorization_servers: ["https://mcp.notion.com"],
          scopes_supported: ["default"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://mcp.notion.com/authorize",
          token_endpoint: "https://mcp.notion.com/token",
          registration_endpoint: "https://mcp.notion.com/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      }
      if (url.pathname === "/register") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          client_name: "Avalon",
          redirect_uris: ["https://api.avalon.test/connections/notion/callback"],
          token_endpoint_auth_method: "none",
        });
        return jsonResponse({ client_id: "notion-mcp-client", token_endpoint_auth_method: "none" });
      }
      expect(url.pathname).toBe("/token");
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code_verifier")).toBe("v".repeat(43));
      return jsonResponse({
        access_token: "notion-mcp-access",
        refresh_token: "notion-mcp-refresh",
        token_type: "Bearer",
        expires_in: 28_800,
        scope: "default",
        user_id: "notion-user-1",
        workspace_id: NOTION_WORKSPACE_ID,
        email_domain: "example.com",
      });
    };
    const adapter = createNotionConnector({
      redirectUri: "https://api.avalon.test/connections/notion/callback",
      fetch: fetcher,
    });
    const authorization = await adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      connectionScope: "personal",
      scopes: [NotionCapabilities.personalMcp],
    });
    const url = new URL(authorization.url);
    expect(url.origin).toBe("https://mcp.notion.com");
    expect(url.searchParams.get("resource")).toBe("https://mcp.notion.com/mcp");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    await expect(adapter.handleAuthorizationCallback!({
      code: "notion-code",
      codeVerifier: "v".repeat(43),
      connectionScope: "personal",
      authorizationState: authorization.state,
    })).resolves.toMatchObject({
      connectionMode: "hosted_mcp",
      providerAccountId: `${NOTION_WORKSPACE_ID}:notion-user-1`,
      providerAccountName: "example.com",
      accessToken: "notion-mcp-access",
      refreshToken: "notion-mcp-refresh",
      tokenScope: "default",
      resource: "https://mcp.notion.com/mcp",
      clientId: "notion-mcp-client",
      tokenEndpointAuthMethod: "none",
    });
    expect(adapter.dynamicAgentTools).toMatchObject({
      capabilities: [NotionCapabilities.personalMcp],
      connectionScopes: ["personal"],
    });
    await expect(adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      connectionScope: "workspace",
      scopes: [NotionCapabilities.read],
    })).rejects.toThrow(/public integration client ID and secret/iu);
  });

  it("rotates a refresh token, retries once, and retrieves bounded Markdown", async () => {
    const authorizations: string[] = [];
    let refreshes = 0;
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/v1/oauth/token") {
        refreshes += 1;
        expect(JSON.parse(String(init?.body))).toEqual({ grant_type: "refresh_token", refresh_token: "old-refresh" });
        return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", token_type: "bearer" });
      }
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      authorizations.push(authorization);
      expect(new Headers(init?.headers).get("notion-version")).toBe("2026-03-11");
      if (authorization === "Bearer old-access") return jsonResponse({ message: "token expired" }, 401);
      if (url.pathname.endsWith("/markdown")) {
        return jsonResponse({ object: "page_markdown", id: "page-1", markdown: "# Roadmap\n\nShip it", truncated: false, unknown_block_ids: [] });
      }
      return jsonResponse({ object: "page", id: "page-1", url: "https://notion.so/page-1" });
    };
    const adapter = notionAdapter(fetcher);
    const connection = notionConnection([NotionCapabilities.read]);
    const result = await adapter.executeTool("retrieve_page", { pageId: "page-1" }, {
      connection,
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: AbortSignal.timeout(1_000),
    });
    expect(result.output).toMatchObject({
      page: { object: "page", id: "page-1" },
      markdown: { markdown: "# Roadmap\n\nShip it", avalonTruncated: false },
    });
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access", "Bearer new-access"]);
    expect(connection.credentials).toMatchObject({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      botId: BOT_ID,
      notionWorkspaceId: NOTION_WORKSPACE_ID,
    });
  });

  it("creates pages through the fixed enhanced-Markdown tool surface", async () => {
    let sentBody: Record<string, unknown> | null = null;
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/v1/pages");
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse({ object: "page", id: "created-page", url: "https://notion.so/created-page" });
    };
    const adapter = notionAdapter(fetcher);
    const result = await adapter.executeTool("create_page", {
      parentPageId: "parent-page",
      title: "Launch plan",
      markdown: "## Checklist\n\n- [ ] Ship",
    }, {
      connection: notionConnection([NotionCapabilities.insert]),
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: AbortSignal.timeout(1_000),
    });
    expect(sentBody).toEqual({
      parent: { page_id: "parent-page" },
      markdown: "# Launch plan\n\n## Checklist\n\n- [ ] Ship",
    });
    expect(result.providerOperationId).toBe("created-page");
  });

  it("rejects a user principal even when the Notion workspace connection grants the tool", async () => {
    const adapter = notionAdapter(async () => {
      throw new Error("A refused principal must not reach Notion");
    });

    await expect(adapter.executeTool("retrieve_page", { pageId: "page-1" }, {
      connection: notionConnection([NotionCapabilities.read]),
      principal: { type: "user", userId: AVALON_USER_ID },
      signal: AbortSignal.timeout(1_000),
    })).rejects.toThrow(/workspace connection is not available/iu);
  });

  it("hydrates provider resources into bounded agent context", async () => {
    const fetcher: FetchLike = async (input) => {
      expect(requestUrl(input).pathname).toBe("/v1/comments/comment-1");
      return jsonResponse({
        object: "comment",
        id: "comment-1",
        rich_text: [{ type: "text", plain_text: "x".repeat(90_000) }],
      });
    };
    const hydrated = await notionAdapter(fetcher).hydrateResource!(notionConnection([NotionCapabilities.commentRead]), {
      resource_type: "notion_comment",
      provider_resource_id: "comment-1",
    }, AbortSignal.timeout(1_000));
    const richText = (hydrated as { rich_text: Array<{ plain_text: string }> }).rich_text;
    expect(richText[0]?.plain_text).toHaveLength(80_000);
  });

  it("handles the verification challenge and routes bot-accessible webhook events to the workspace", async () => {
    expect(readNotionWebhookVerificationToken(JSON.stringify({ verification_token: "notion-signing-secret" }))).toBe("notion-signing-secret");
    const event = {
      id: "44444444-4444-4444-8444-444444444444",
      timestamp: "2026-08-01T18:00:00.000Z",
      workspace_id: NOTION_WORKSPACE_ID,
      workspace_name: "Acme Notes",
      subscription_id: "55555555-5555-4555-8555-555555555555",
      integration_id: INTEGRATION_ID,
      api_version: "2026-03-11",
      type: "page.content_updated",
      authors: [{ id: "notion-user-1", type: "person" }],
      accessible_by: [{ id: BOT_ID, type: "bot" }, { id: "notion-user-1", type: "person" }],
      attempt_number: 2,
      entity: { id: "66666666-6666-4666-8666-666666666666", type: "page" },
      data: { parent: { id: "77777777-7777-4777-8777-777777777777", type: "page" } },
    };
    const rawBody = JSON.stringify(event);
    expect(readNotionWebhookVerificationToken(rawBody)).toBeNull();
    const secret = "notion-signing-secret";
    const verified = await verifyNotionWebhook({
      secret,
      rawBody,
      signatureHeader: `sha256=${await hmacHex(secret, rawBody)}`,
      expectedIntegrationId: INTEGRATION_ID,
    });
    const activity = normalizeNotionWebhook(notionConnection([]), verified, "r2://payload/notion");
    expect(activity).toMatchObject({
      provider: "notion",
      providerEventId: event.id,
      eventType: "notion.page.content_updated",
      resourceType: "notion_page",
      providerResourceId: event.entity.id,
      connectionScope: "workspace",
      connectionOwnerUserId: null,
      visibility: { scope: "workspace" },
      targetUserIds: [],
      payloadRef: "r2://payload/notion",
    });
    expect(() => NormalizedActivitySchema.parse({ id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", ...activity })).not.toThrow();

    const inaccessible = notionConnection([]);
    inaccessible.credentials.botId = "88888888-8888-4888-8888-888888888888";
    expect(() => normalizeNotionWebhook(inaccessible, verified)).toThrow(/cannot access/i);
    await expect(verifyNotionWebhook({
      secret,
      rawBody,
      signatureHeader: await hmacHex(secret, rawBody),
    })).rejects.toThrow(/signature/i);
  });
});

function notionAdapter(fetcher: FetchLike) {
  return createNotionConnector({
    clientId: "notion-client",
    clientSecret: "notion-secret",
    redirectUri: "https://api.avalon.test/connections/notion/callback",
    integrationId: INTEGRATION_ID,
    fetch: fetcher,
  });
}

function notionConnection(grantedScopes: string[]): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: AVALON_CONNECTION_ID,
    workspaceId: AVALON_WORKSPACE_ID,
    scope: "workspace",
    ownerUserId: null,
    grantedScopes,
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      botId: BOT_ID,
      notionWorkspaceId: NOTION_WORKSPACE_ID,
      integrationId: INTEGRATION_ID,
    },
    cursor: {},
    config: { region: "global" },
  });
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
