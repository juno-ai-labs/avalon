import { describe, expect, it, vi } from "vitest";
import {
  callSlackMcp,
  createSlackConnector,
  parseSlackAgentInvocation,
  slackApi,
  SlackCapabilities,
  SlackWorkspaceBotScopes,
  verifySlackRequest,
} from "./slack";
import type { FetchLike } from "./provider-utils";
import { connectorCapabilitySupportsScope } from "./types";

describe("Slack connector", () => {
  it("verifies exact signed bytes and rejects replayed timestamps", async () => {
    const body = JSON.stringify({ type: "event_callback", team_id: "T1" });
    const timestamp = "1786032000";
    const signature = await slackSignature("secret", timestamp, body);
    await expect(verifySlackRequest({
      signingSecret: "secret",
      rawBody: body,
      timestamp,
      signature,
      now: Number(timestamp) * 1_000,
    })).resolves.toMatchObject({ body });
    await expect(verifySlackRequest({
      signingSecret: "secret",
      rawBody: `${body} `,
      timestamp,
      signature,
      now: Number(timestamp) * 1_000,
    })).rejects.toThrow(/signature is invalid/i);
    await expect(verifySlackRequest({
      signingSecret: "secret",
      rawBody: body,
      timestamp,
      signature,
      now: Number(timestamp) * 1_000 + 5 * 60_000 + 1,
    })).rejects.toThrow(/replay window/i);
  });

  it("separates workspace Agent OAuth from personal MCP OAuth", async () => {
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("oauth.v2.access")) return json({
        ok: true,
        access_token: "xoxb-bot",
        bot_user_id: "UBOT",
        app_id: "AAVALON",
        team: { id: "TACME", name: "Acme" },
      });
      if (url.pathname.endsWith("oauth.v2.user.access")) return json({
        ok: true,
        access_token: "xoxp-user",
        authed_user: { id: "UADA" },
        team: { id: "TACME", name: "Acme" },
      });
      if (url.pathname.endsWith("team.billing.info")) return json({ ok: true, plan: "plus" });
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      appId: "AAVALON",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const workspace = await adapter.beginAuthorization!({
      connectionScope: "workspace",
      state: "state",
      scopes: ["assistant:write", "chat:write"],
    });
    const workspaceUrl = new URL(workspace.url);
    expect(workspaceUrl.pathname).toBe("/oauth/v2/authorize");
    expect(workspaceUrl.searchParams.get("scope")?.split(",")).toContain("assistant:write");
    expect(workspaceUrl.searchParams.has("user_scope")).toBe(false);
    await expect(adapter.handleAuthorizationCallback!({ code: "bot-code", connectionScope: "workspace" })).resolves.toMatchObject({
      providerAccountId: "TACME",
      botAccessToken: "xoxb-bot",
      workspaceName: "Acme",
    });

    const personal = await adapter.beginAuthorization!({
      connectionScope: "personal",
      state: "state",
      codeChallenge: "challenge",
      scopes: ["search:read.public", "chat:write"],
    });
    const personalUrl = new URL(personal.url);
    expect(personalUrl.pathname).toBe("/oauth/v2_user/authorize");
    expect(personalUrl.searchParams.get("scope")).toBe("search:read.public,chat:write");
    expect(personalUrl.searchParams.has("user_scope")).toBe(false);
    expect(personalUrl.searchParams.get("code_challenge_method")).toBe("S256");
    await expect(adapter.handleAuthorizationCallback!({ code: "user-code", codeVerifier: "verifier", connectionScope: "personal" })).resolves.toMatchObject({
      providerAccountId: "TACME:UADA",
      userAccessToken: "xoxp-user",
      slackUserId: "UADA",
    });

    expect(adapter.manifest).toMatchObject({
      type: "slack",
      surfaces: ["resource", "messaging_agent"],
      messagingAgent: { capability: SlackCapabilities.agent, supportsAppHome: true, supportsStreaming: true },
    });
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.agent, "workspace")).toBe(true);
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.agent, "personal")).toBe(false);
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.search, "personal")).toBe(true);
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.search, "workspace")).toBe(false);
    expect(SlackWorkspaceBotScopes).toContain("users:read.email");
    expect(SlackWorkspaceBotScopes).toContain("users:read");
  });

  it("discovers the hosted MCP tool name before invoking it", async () => {
    const requests: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const fetcher: FetchLike = vi.fn(async (_input, init) => {
      headers.push(new Headers(init?.headers));
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(request);
      if (request.method === "initialize") return json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "Slack MCP", version: "1" },
        },
      }, { "mcp-session-id": "session-1" });
      if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (request.method === "tools/list") return json({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: "slack_search", inputSchema: { type: "object" } }] },
      });
      return json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "one result" }] } });
    });
    await expect(callSlackMcp("xoxp-user", "search", { query: "project gizmo" }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({ content: [{ text: "one result" }] });
    expect(requests.map((request) => request.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    expect(requests[3]).toMatchObject({ method: "tools/call", params: { name: "slack_search", arguments: { query: "project gizmo" } } });
    expect(headers[0]?.get("accept")).toBe("application/json, text/event-stream");
    expect(headers[1]?.get("mcp-session-id")).toBe("session-1");
    expect(headers[1]?.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("preserves Slack MCP rate-limit timing for durable callers", async () => {
    const fetcher: FetchLike = vi.fn(async () => json(
      { error: "ratelimited" },
      { "retry-after": "9" },
      429,
    ));

    await expect(callSlackMcp(
      "xoxp-user",
      "search",
      { query: "project gizmo" },
      AbortSignal.timeout(1_000),
      fetcher,
    )).rejects.toMatchObject({ details: { status: 429, retryAfterMs: 9_000 } });
  });

  it("rejects free workspace plans and refreshes user-only MCP tokens", async () => {
    const calls: URL[] = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push(url);
      if (url.pathname.endsWith("oauth.v2.access")) return json({ ok: true, access_token: "xoxb-bot", team: { id: "TFREE", name: "Free" } });
      if (url.pathname.endsWith("team.billing.info")) return json({ ok: true, plan: "free" });
      if (url.pathname.endsWith("auth.revoke")) return json({ ok: true, revoked: true });
      if (url.pathname.endsWith("oauth.v2.user.access")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return json({ ok: true, access_token: "xoxe.xoxp-new", refresh_token: "xoxe-new", expires_in: 43_200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
      now: () => 1_786_032_000_000,
    });

    await expect(adapter.handleAuthorizationCallback!({ code: "bot-code", connectionScope: "workspace" }))
      .rejects.toThrow(/paid Slack workspace plan/iu);
    expect(calls.filter((url) => url.pathname.endsWith("auth.revoke"))).toHaveLength(1);

    await expect(adapter.refreshCredentials!({
      id: "connection",
      workspaceId: "workspace",
      scope: "personal",
      ownerUserId: "user",
      grantedScopes: [SlackCapabilities.search],
      credentials: { userAccessToken: "xoxe.xoxp-old", refreshToken: "xoxe-old" },
      cursor: {},
      config: {},
    }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      userAccessToken: "xoxe.xoxp-new",
      refreshToken: "xoxe-new",
      expiresAt: "2026-08-07T04:00:00.000Z",
    });
  });

  it("does not hide a partially failed credential revocation", async () => {
    const fetcher: FetchLike = vi.fn(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("authorization");
      if (authorization === "Bearer xoxe-refresh") return json({ ok: false, error: "invalid_auth" });
      if (authorization === "Bearer xoxb-access") return json({ ok: false, error: "ratelimited" });
      throw new Error(`Unexpected authorization ${authorization}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });

    await expect(adapter.revoke!({
      id: "connection",
      workspaceId: "workspace",
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: [SlackCapabilities.agent],
      credentials: { botAccessToken: "xoxb-access", refreshToken: "xoxe-refresh" },
      cursor: {},
      config: {},
    }, AbortSignal.timeout(1_000))).rejects.toThrow(/ratelimited/iu);
  });

  it("parses verified event, interaction, and slash-command invocations", () => {
    expect(parseSlackAgentInvocation({
      kind: "event",
      envelope: { type: "event_callback", team_id: "T1", event_id: "Ev1", event: { type: "message", user: "U1" } },
    })).toMatchObject({ kind: "event", teamId: "T1", eventId: "Ev1" });
    expect(parseSlackAgentInvocation({
      kind: "interaction",
      payload: { type: "shortcut", team: { id: "T1" }, user: { id: "U1" } },
    })).toMatchObject({ kind: "interaction", teamId: "T1", userId: "U1" });
    expect(parseSlackAgentInvocation({
      kind: "command",
      payload: { team_id: "T1", user_id: "U1", command: "/avalon", text: "help", channel_id: "D1", trigger_id: "tr1", response_url: null },
    })).toMatchObject({ kind: "command", command: "/avalon", text: "help" });
  });

  it("runtime-checks Slack Web API requests and success responses", async () => {
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("assistant.search.context")) return json({
        ok: true,
        results: {
          users: [{ user_id: "U1", full_name: "Ada" }],
          messages: [{
            team_id: "T1",
            channel_id: "C1",
            message_ts: "123.456",
            content: "Project update",
            permalink: "https://example.slack.com/archives/C1/p123456",
          }],
        },
        response_metadata: { next_cursor: "" },
      });
      if (url.pathname.endsWith("users.lookupByEmail")) return json({
        ok: true,
        user: {
          id: "UADA",
          team_id: "TACME",
          deleted: false,
          is_bot: false,
          profile: { email: "ada@example.com" },
        },
      });
      if (url.pathname.endsWith("users.info")) return json({
        ok: true,
        user: {
          id: "UADA",
          team_id: "TACME",
          deleted: false,
          is_bot: false,
          profile: { display_name: "Ada", email: "ada@example.com" },
        },
      });
      return json({ ok: true, plan: 42 });
    });

    await expect(slackApi("xoxb", "assistant.search.context", {
      query: "project",
      action_token: "action",
      content_types: ["messages", "users"],
    }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({ results: { users: [{ user_id: "U1" }] } });
    await expect(slackApi("xoxb", "team.billing.info", {}, AbortSignal.timeout(1_000), fetcher))
      .rejects.toThrow(/malformed response/iu);
    await expect(slackApi("xoxb", "users.lookupByEmail", {
      email: "ada@example.com",
    }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({
      user: { id: "UADA", team_id: "TACME", deleted: false },
    });
    await expect(slackApi("xoxb", "users.info", {
      user: "UADA",
    }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({
      user: { id: "UADA", team_id: "TACME", profile: { email: "ada@example.com" } },
    });
    await expect(slackApi("xoxb", "users.lookupByEmail", {
      email: "not-an-email",
    }, AbortSignal.timeout(1_000), fetcher)).rejects.toThrow();
    await expect(slackApi("xoxb", "conversations.open", {
      users: ["U1"],
    } as never, AbortSignal.timeout(1_000), fetcher)).rejects.toThrow();
    await expect(slackApi("xoxb", "chat.postMessage", {
      channel: "C1",
      text: "x".repeat(40_001),
    }, AbortSignal.timeout(1_000), fetcher)).rejects.toThrow();
  });
});

async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function json(value: unknown, headers: HeadersInit = {}, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
}
