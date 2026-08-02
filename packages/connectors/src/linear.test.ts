import { NormalizedActivitySchema } from "@avalon/contracts";
import { describe, expect, it } from "vitest";
import {
  createLinearConnector,
  LinearCapabilities,
  normalizeLinearWebhook,
  verifyLinearWebhook,
} from "./linear";
import type { FetchLike } from "./provider-utils";
import type { ConnectorConnectionContext } from "./types";

const AVALON_WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AVALON_CONNECTION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Linear connector", () => {
  it("uses app-actor PKCE OAuth and returns the installed organization identity", async () => {
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/oauth/token") {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code_verifier")).toBe("v".repeat(43));
        return jsonResponse({
          access_token: "linear-access",
          refresh_token: "linear-refresh",
          expires_in: 3600,
          scope: "read,issues:create",
          token_type: "Bearer",
        });
      }
      if (url.pathname === "/graphql") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer linear-access");
        return jsonResponse({
          data: {
            viewer: {
              id: "app-user-1",
              name: "Avalon",
              organization: { id: "linear-org-1", name: "Acme", urlKey: "acme" },
            },
          },
        });
      }
      throw new Error(`Unexpected Linear URL: ${url}`);
    };
    const adapter = linearAdapter(fetcher);
    const authorization = await adapter.beginAuthorization!({
      state: "s".repeat(32),
      codeChallenge: "c".repeat(43),
      scopes: ["issues:create"],
    });
    const url = new URL(authorization.url);
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")?.split(",")).toEqual(["read", "issues:create"]);

    await expect(adapter.handleAuthorizationCallback!({
      code: "authorization-code",
      codeVerifier: "v".repeat(43),
    })).resolves.toMatchObject({
      accessToken: "linear-access",
      refreshToken: "linear-refresh",
      appUserId: "app-user-1",
      organizationId: "linear-org-1",
      providerAccountId: "linear-org-1",
      providerAccountName: "Acme",
    });
  });

  it("rotates credentials and retries one API request after a 401", async () => {
    const authorizations: string[] = [];
    let refreshes = 0;
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/oauth/token") {
        refreshes += 1;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("refresh_token")).toBe("old-refresh");
        return jsonResponse({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "read",
        });
      }
      if (url.pathname === "/graphql") {
        const authorization = new Headers(init?.headers).get("authorization") ?? "";
        authorizations.push(authorization);
        if (authorization === "Bearer old-access") return jsonResponse({ message: "expired" }, 401);
        return jsonResponse({ data: { teams: { nodes: [{ id: "team-1", name: "Core" }], pageInfo: { hasNextPage: false } } } });
      }
      throw new Error(`Unexpected Linear URL: ${url}`);
    };
    const adapter = linearAdapter(fetcher);
    const connection = linearConnection([LinearCapabilities.read]);
    const result = await adapter.executeTool("linear.list_teams", {}, {
      connection,
      principal: { type: "workspace", workspaceId: AVALON_WORKSPACE_ID },
      signal: AbortSignal.timeout(1_000),
    });
    expect(result.output).toMatchObject({ nodes: [{ id: "team-1", name: "Core" }] });
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
    expect(connection.credentials).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh" });
  });

  it("hydrates provider resources into bounded agent context", async () => {
    const fetcher: FetchLike = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      expect(request.query).toContain("AvalonReadDocument");
      return jsonResponse({
        data: {
          document: { id: "document-1", title: "Design", content: "x".repeat(50_000) },
        },
      });
    };
    const adapter = linearAdapter(fetcher);
    const hydrated = await adapter.hydrateResource!(linearConnection([]), {
      resource_type: "linear_document",
      provider_resource_id: "document-1",
    }, AbortSignal.timeout(1_000));
    expect(hydrated).toMatchObject({ id: "document-1", title: "Design" });
    expect((hydrated as { content: string }).content).toHaveLength(40_000);
  });

  it("verifies the exact raw webhook and normalizes only the installed organization", async () => {
    const now = 1_788_000_000_000;
    const secret = "linear-webhook-secret";
    const rawBody = JSON.stringify({
      type: "Issue",
      action: "create",
      organizationId: "linear-org-1",
      webhookId: "webhook-1",
      webhookTimestamp: now,
      createdAt: new Date(now).toISOString(),
      actor: { id: "person-1", name: "Ada" },
      data: {
        id: "issue-1",
        identifier: "AVA-42",
        title: "Ship connectors",
        description: "Connect Linear to Avalon",
        url: "https://linear.app/acme/issue/AVA-42",
      },
    });
    const verified = await verifyLinearWebhook({
      secret,
      rawBody,
      signatureHeader: await hmacHex(secret, rawBody),
      deliveryHeader: "11111111-1111-4111-8111-111111111111",
      eventHeader: "Issue",
      timestampHeader: String(now),
      now,
    });
    const activity = normalizeLinearWebhook(linearConnection([]), verified, "r2://payload/linear");
    expect(activity).toMatchObject({
      provider: "linear",
      providerEventId: "11111111-1111-4111-8111-111111111111",
      eventType: "linear.issue.create",
      resourceType: "linear_issue",
      providerResourceId: "issue-1",
      payloadRef: "r2://payload/linear",
    });
    expect(() => NormalizedActivitySchema.parse({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", ...activity })).not.toThrow();

    const wrongOrganization = linearConnection([]);
    wrongOrganization.credentials.organizationId = "linear-org-2";
    expect(() => normalizeLinearWebhook(wrongOrganization, verified)).toThrow(/organization/i);
    await expect(verifyLinearWebhook({
      secret,
      rawBody,
      signatureHeader: "0".repeat(64),
      deliveryHeader: "11111111-1111-4111-8111-111111111111",
      now,
    })).rejects.toThrow(/signature/i);
  });
});

function linearAdapter(fetcher: FetchLike) {
  return createLinearConnector({
    clientId: "linear-client",
    clientSecret: "linear-secret",
    redirectUri: "https://api.avalon.test/connections/linear/callback",
    fetch: fetcher,
    now: () => 1_788_000_000_000,
  });
}

function linearConnection(grantedScopes: string[]): ConnectorConnectionContext {
  return {
    id: AVALON_CONNECTION_ID,
    workspaceId: AVALON_WORKSPACE_ID,
    scope: "workspace",
    ownerUserId: null,
    grantedScopes,
    credentials: {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: "2099-01-01T00:00:00.000Z",
      organizationId: "linear-org-1",
    },
    cursor: {},
    config: { region: "global" },
  };
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
