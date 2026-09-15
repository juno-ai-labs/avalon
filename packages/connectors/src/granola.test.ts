import { asWorkspaceId } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { neverAborts } from "./test-signals";
import {
  createGranolaConnector,
  createGranolaWebhookEndpoint,
  GranolaCapabilities,
  verifyGranolaWebhook,
} from "./granola";
import type { FetchLike } from "./provider-utils";
import {
  type AuthorizedConnectorConnection,
  authorizedConnection,
} from "./types";

describe("Granola connector", () => {
  it("uses the live MCP tool surface only for personal connections", () => {
    const adapter = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
    });
    expect(adapter.dynamicAgentTools).toMatchObject({
      capabilities: [GranolaCapabilities.personalRead],
      connectionScopes: ["personal"],
    });
  });

  it("gives only the natural-language meeting query a five-minute deadline", async () => {
    const adapter = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: async (_input, init) => {
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
        const id = request.id as string;
        if (request.method === "initialize") {
          return jsonResponse({
            jsonrpc: "2.0",
            id,
            result: { protocolVersion: "2025-06-18", capabilities: {} },
          }, 200, { "mcp-session-id": "session-1" });
        }
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              { name: "query_granola_meetings", inputSchema: { type: "object" } },
              { name: "list_meetings", inputSchema: { type: "object" } },
            ],
          },
        });
      },
    });

    const definitions = await adapter.dynamicAgentTools!.discover(
      personalConnection(),
      AbortSignal.timeout(1_000),
    );

    expect(definitions).toEqual([
      expect.objectContaining({ name: "query_granola_meetings", timeoutMs: 300_000 }),
      expect.objectContaining({ name: "list_meetings", timeoutMs: 30_000 }),
    ]);
  });

  it("uses the documented workspace API endpoints and exact query parameters", async () => {
    const requested: URL[] = [];
    const adapter = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: async (input, init) => {
        const url = requestUrl(input);
        requested.push(url);
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${workspaceApiKey}`);
        if (url.pathname === "/v1/notes/not_1234567890abcd") {
          return jsonResponse({ id: "not_1234567890abcd", transcript: [{ text: "hello" }] });
        }
        if (url.pathname === "/v1/folders") return jsonResponse({ folders: [], hasMore: false, cursor: null });
        return jsonResponse({ notes: [], hasMore: false, cursor: null });
      },
    });

    await adapter.executeTool("list_notes", {
      createdAfter: "2026-08-01",
      updatedAfter: "2026-08-01T00:00:00.000Z",
      folderId: "fol_1234567890abcd",
      pageSize: 30,
      cursor: "next-page",
    }, workspaceToolContext());
    await adapter.executeTool("get_note", {
      noteId: "not_1234567890abcd",
      includeTranscript: true,
    }, workspaceToolContext());
    await adapter.executeTool("list_folders", { pageSize: 10 }, workspaceToolContext());

    expect(requested.map((url) => url.pathname)).toEqual([
      "/v1/notes",
      "/v1/notes/not_1234567890abcd",
      "/v1/folders",
    ]);
    expect(Object.fromEntries(requested[0]!.searchParams)).toEqual({
      created_after: "2026-08-01",
      updated_after: "2026-08-01T00:00:00.000Z",
      folder_id: "fol_1234567890abcd",
      cursor: "next-page",
      page_size: "30",
    });
    expect(Object.fromEntries(requested[1]!.searchParams)).toEqual({ include: "transcript" });
    expect(Object.fromEntries(requested[2]!.searchParams)).toEqual({ page_size: "10" });
  });

  it("registers only the workspace webhook scope and retains the one-time signing secret", async () => {
    const fetcher: FetchLike = async (input, init) => {
      expect(requestUrl(input).pathname).toBe("/v1/webhook-endpoints");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${workspaceApiKey}`);
      expect(JSON.parse(String(init?.body))).toEqual({
        url: "https://api.example.test/ingest/granola/connection-id",
        scopes: ["workspace"],
        events: ["note.access_granted", "note.edited", "note.generated", "note.regenerated"],
      });
      return jsonResponse({
        id: "whe_1234567890abcd",
        signing_secret: `whsec_${base64(new Uint8Array(32).fill(7))}`,
      }, 201);
    };
    await expect(createGranolaWebhookEndpoint(
      workspaceApiKey,
      "https://api.example.test/ingest/granola/connection-id",
      neverAborts(),
      fetcher,
    )).resolves.toEqual({
      id: "whe_1234567890abcd",
      signingSecret: `whsec_${base64(new Uint8Array(32).fill(7))}`,
    });
  });

  it("verifies Standard Webhooks signatures before parsing Granola events", async () => {
    const event = {
      event_id: "11111111-1111-4111-8111-111111111111",
      event_type: "note.edited",
      note_id: "not_1234567890abcd",
      occurred_at: "2026-08-07T20:00:00.000Z",
      data: { changed_fields: ["summary"] },
    } as const;
    const rawBody = JSON.stringify(event);
    const timestamp = 1_775_763_600;
    const secretBytes = new Uint8Array(32).fill(9);
    const signingSecret = `whsec_${base64(secretBytes)}`;
    const signature = await hmacBase64(
      secretBytes,
      `${event.event_id}.${timestamp}.${rawBody}`,
    );
    await expect(verifyGranolaWebhook({
      signingSecret,
      rawBody: new TextEncoder().encode(rawBody),
      webhookId: event.event_id,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${signature}`,
      now: timestamp * 1_000,
    })).resolves.toMatchObject(event);
    await expect(verifyGranolaWebhook({
      signingSecret,
      rawBody: `${rawBody} `,
      webhookId: event.event_id,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${signature}`,
      now: timestamp * 1_000,
    })).rejects.toThrow(/signature is invalid/u);
  });

  it("accepts ISO offsets and rejects replayed, missing, or header-mismatched webhook identities", async () => {
    const event = {
      event_id: "11111111-1111-4111-8111-111111111111",
      event_type: "note.generated",
      note_id: "not_1234567890abcd",
      occurred_at: "2026-08-07T13:00:00-07:00",
    } as const;
    const rawBody = JSON.stringify(event);
    const timestamp = 1_775_763_600;
    const secretBytes = new Uint8Array(32).fill(4);
    const signingSecret = `whsec_${base64(secretBytes)}`;
    const signature = await hmacBase64(secretBytes, `${event.event_id}.${timestamp}.${rawBody}`);

    await expect(verifyGranolaWebhook({
      signingSecret,
      rawBody,
      webhookId: event.event_id,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${signature}`,
      now: timestamp * 1_000,
    })).resolves.toMatchObject(event);
    await expect(verifyGranolaWebhook({
      signingSecret,
      rawBody,
      webhookId: event.event_id,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${signature}`,
      now: (timestamp + 301) * 1_000,
    })).rejects.toThrow(/outside the replay window/u);
    await expect(verifyGranolaWebhook({
      signingSecret,
      rawBody,
      webhookId: null,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${signature}`,
      now: timestamp * 1_000,
    })).rejects.toThrow(/headers are missing/u);

    const otherWebhookId = "22222222-2222-4222-8222-222222222222";
    const otherSignature = await hmacBase64(secretBytes, `${otherWebhookId}.${timestamp}.${rawBody}`);
    await expect(verifyGranolaWebhook({
      signingSecret,
      rawBody,
      webhookId: otherWebhookId,
      webhookTimestamp: String(timestamp),
      webhookSignature: `v1,${otherSignature}`,
      now: timestamp * 1_000,
    })).rejects.toThrow(/identity does not match/u);
  });

  it("uses protected-resource discovery, DCR, PKCE, and encrypted callback state for personal OAuth", async () => {
    const calls: URL[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return jsonResponse({
          resource: "https://mcp.granola.ai/mcp",
          authorization_servers: ["https://mcp-auth.granola.ai"],
          scopes_supported: ["mcp"],
        });
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return jsonResponse({
          authorization_endpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
          token_endpoint: "https://mcp-auth.granola.ai/oauth2/token",
          registration_endpoint: "https://mcp-auth.granola.ai/oauth2/register",
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        });
      }
      if (url.pathname === "/oauth2/register") {
        const registration = JSON.parse(String(init?.body));
        expect(registration).toMatchObject({
          redirect_uris: ["https://api.example.test/connections/granola/callback"],
          grant_types: ["authorization_code", "refresh_token"],
          token_endpoint_auth_method: "client_secret_post",
        });
        return jsonResponse({
          client_id: "dynamic-client",
          client_secret: "dynamic-secret",
          token_endpoint_auth_method: "client_secret_post",
        }, 201);
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    const adapter = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: fetcher,
    });
    const authorization = await adapter.beginAuthorization!({
      connectionScope: "personal",
      state: "opaque-state",
      codeChallenge: "pkce-challenge",
      scopes: ["mcp", "offline_access"],
    });
    const url = new URL(authorization.url);
    expect(url.origin).toBe("https://mcp-auth.granola.ai");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dynamic-client",
      state: "opaque-state",
      code_challenge: "pkce-challenge",
      code_challenge_method: "S256",
      resource: "https://mcp.granola.ai/mcp",
      scope: "mcp offline_access",
    });
    expect(authorization.state).toMatchObject({
      clientId: "dynamic-client",
      clientSecret: "dynamic-secret",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(calls.map((call) => call.pathname)).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server",
      "/oauth2/register",
    ]);
  });

  it("exchanges a personal OAuth callback and binds the MCP account identity to its active workspace", async () => {
    const fetcher: FetchLike = async (input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/oauth2/token") {
        const form = new URLSearchParams(String(init?.body));
        expect(Object.fromEntries(form)).toMatchObject({
          grant_type: "authorization_code",
          code: "authorization-code",
          code_verifier: "pkce-verifier",
          client_id: "dynamic-client",
          client_secret: "dynamic-secret",
          resource: "https://mcp.granola.ai/mcp",
        });
        return jsonResponse({
          access_token: "personal-token",
          refresh_token: "personal-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
          scope: "mcp offline_access",
        });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      const id = request.id as string;
      if (request.method === "initialize") {
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "Granola", version: "1" },
          },
        }, 200, { "mcp-session-id": "session-1" });
      }
      if (request.method === "tools/list") {
        return jsonResponse({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [{
              name: "get_account_info",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
            }],
          },
        });
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id,
        result: {
          structuredContent: {
            accountInfo: {
              emailAddress: "person@example.test",
              activeWorkspace: {
                workspaceId: asWorkspaceId("8a5b9362-e54c-4a39-8159-199e266e5f91"),
                workspaceName: "Example workspace",
              },
            },
          },
          isError: false,
        },
      });
    };
    const adapter = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: fetcher,
      now: () => Date.parse("2026-08-07T20:00:00.000Z"),
    });
    await expect(adapter.handleAuthorizationCallback!({
      connectionScope: "personal",
      code: "authorization-code",
      codeVerifier: "pkce-verifier",
      authorizationState: {
        resource: "https://mcp.granola.ai/mcp",
        authorizationEndpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
        tokenEndpoint: "https://mcp-auth.granola.ai/oauth2/token",
        clientId: "dynamic-client",
        clientSecret: "dynamic-secret",
        tokenEndpointAuthMethod: "client_secret_post",
        scope: "mcp offline_access",
      },
    })).resolves.toMatchObject({
      providerAccountId: expect.stringMatching(/^granola:[0-9a-f]{32}$/u),
      providerAccountName: "person@example.test",
      workspaceName: "Example workspace",
      accessToken: "personal-token",
      refreshToken: "personal-refresh-token",
      expiresAt: "2026-08-07T21:00:00.000Z",
    });
  });

  it("preserves secret-safe OAuth callback stages for provider and schema failures", async () => {
    const authorizationState = {
      resource: "https://mcp.granola.ai/mcp",
      authorizationEndpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
      tokenEndpoint: "https://mcp-auth.granola.ai/oauth2/token",
      clientId: "dynamic-client",
      clientSecret: "dynamic-secret",
      tokenEndpointAuthMethod: "client_secret_post" as const,
      scope: "mcp offline_access",
    };
    const callback = {
      connectionScope: "personal" as const,
      code: "authorization-code",
      codeVerifier: "pkce-verifier",
      authorizationState,
    };
    const tokenFailure = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: async () => jsonResponse({ error: "invalid_grant" }, 401),
    });
    await expect(tokenFailure.handleAuthorizationCallback!(callback)).rejects.toMatchObject({
      code: "unauthorized",
      details: { oauthStage: "token_exchange", status: 401 },
    });

    const schemaFailure = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: async () => jsonResponse({ access_token: 123, token_type: "Bearer" }),
    });
    await expect(schemaFailure.handleAuthorizationCallback!(callback)).rejects.toMatchObject({
      code: "provider_error",
      // Which field: the token came back as a number. The value does not travel.
      details: { oauthStage: "token_exchange", responseInvalid: true, responseIssues: "access_token:invalid_type" },
    });

    const mcpFailure = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: async (input) => requestUrl(input).pathname === "/oauth2/token"
        ? jsonResponse({ access_token: "personal-token", token_type: "Bearer" })
        : jsonResponse({ error: "not_authorized" }, 401),
    });
    await expect(mcpFailure.handleAuthorizationCallback!(callback)).rejects.toMatchObject({
      code: "unauthorized",
      details: { oauthStage: "mcp_account_lookup", status: 401 },
    });
  });

  it("enforces the personal/workspace capability boundary", async () => {
    const adapter = createGranolaConnector({
      redirectUri: "https://api.example.test/connections/granola/callback",
      fetch: async () => jsonResponse({ notes: [] }),
    });
    await expect(adapter.executeTool("list_notes", {}, {
      ...workspaceToolContext(),
      connection: { ...workspaceConnection(), grantedScopes: [] },
    })).rejects.toThrow(/has not granted/u);
    await expect(adapter.executeTool("query_granola_meetings", { query: "decisions" }, workspaceToolContext()))
      .rejects.toThrow(/has not granted/u);
  });
});

const workspaceApiKey = `grn_${"a".repeat(32)}`;

function workspaceConnection(): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "granola-workspace-connection",
    workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a"),
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [GranolaCapabilities.workspaceRead],
    credentials: { apiKey: workspaceApiKey },
    cursor: {},
    config: {},
  });
}

function personalConnection(): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "granola-personal-connection",
    workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a"),
    scope: "personal",
    ownerUserId: "33333333-3333-4333-8333-333333333333",
    grantedScopes: [GranolaCapabilities.personalRead],
    credentials: { accessToken: "personal-token" },
    cursor: {},
    config: {},
  });
}

function workspaceToolContext() {
  return {
    connection: workspaceConnection(),
    principal: { type: "workspace" as const, workspaceId: asWorkspaceId("025a3f3d-6749-495a-8425-7640a0dbf27a") },
    signal: neverAborts(),
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
}

function jsonResponse(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
  });
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function hmacBase64(keyBytes: Uint8Array, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return base64(signature);
}
