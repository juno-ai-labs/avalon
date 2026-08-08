import { describe, expect, it, vi } from "vitest";
import {
  callSlackMcp,
  createSlackConnector,
  joinAllSlackPublicChannels,
  joinSlackPublicChannel,
  parseSlackAgentInvocation,
  slackApi,
  SlackCapabilities,
  SlackWorkspaceBotScopes,
  verifySlackRequest,
} from "./slack";
import type { FetchLike } from "./provider-utils";
import { connectorCapabilitySupportsScope, type ConnectorConnectionContext } from "./types";

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
        scope: SlackWorkspaceBotScopes.join(","),
        bot_user_id: "UBOT",
        app_id: "AAVALON",
        team: { id: "TACME", name: "Acme" },
      });
      if (url.pathname.endsWith("oauth.v2.user.access")) return json({
        ok: true,
        access_token: "xoxp-user",
        authed_user: { id: "UADA", scope: "search:read.public,chat:write" },
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
      oauthScopes: ["chat:write", "search:read.public"],
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
    expect(SlackWorkspaceBotScopes).toContain("channels:read");
    expect(SlackWorkspaceBotScopes).toContain("channels:join");
    expect(SlackWorkspaceBotScopes).toContain("channels:history");
    expect(SlackWorkspaceBotScopes).toContain("groups:read");
    expect(SlackWorkspaceBotScopes).toContain("groups:history");
  });

  it("uses Slack's query transport for conversations.info", async () => {
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      expect(url.searchParams.get("channel")).toBe("CPUBLIC");
      return json({
        ok: true,
        channel: { id: "CPUBLIC", is_private: false, is_im: false, is_mpim: false },
      });
    });

    await expect(slackApi("xoxb", "conversations.info", {
      channel: "CPUBLIC",
    }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({
      channel: { id: "CPUBLIC", is_private: false },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reads a bounded Slack thread using conversations.replies query transport", async () => {
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      expect(url.searchParams.get("channel")).toBe("C1");
      expect(url.searchParams.get("ts")).toBe("1.0");
      expect(url.searchParams.get("limit")).toBe("15");
      return json({
        ok: true,
        messages: [
          { type: "message", user: "U1", text: "<@UBOT> investigate", ts: "1.0" },
          { type: "message", user: "UBOT", text: "Not yet", ts: "1.1", thread_ts: "1.0" },
        ],
        response_metadata: { next_cursor: "" },
      });
    });

    await expect(slackApi("xoxb", "conversations.replies", {
      channel: "C1",
      ts: "1.0",
      limit: 15,
    }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({
      messages: [
        { user: "U1", text: "<@UBOT> investigate" },
        { user: "UBOT", text: "Not yet" },
      ],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("marks a workspace authorization unhealthy when required bot scopes are missing", async () => {
    const missingScope = "channels:read";
    const grantedScopes = SlackWorkspaceBotScopes.filter((scope) => scope !== missingScope).join(",");
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: vi.fn(async () => json({ ok: true }, { "x-oauth-scopes": grantedScopes })),
    });

    await expect(adapter.healthCheck(slackWorkspaceConnection())).resolves.toEqual({
      ok: false,
      message: `Slack authorization is missing required permissions: ${missingScope}`,
      reconnectRequired: true,
    });
  });

  it("rejects and revokes an OAuth grant that omits a required workspace scope", async () => {
    const missingScope = "channels:join";
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("oauth.v2.access")) return json({
        ok: true,
        access_token: "xoxb-partial",
        scope: SlackWorkspaceBotScopes.filter((scope) => scope !== missingScope).join(","),
        team: { id: "TACME", name: "Acme" },
      });
      if (url.pathname.endsWith("auth.revoke")) {
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        return json({ ok: true, revoked: true });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });

    await expect(adapter.handleAuthorizationCallback!({
      code: "partial-code",
      connectionScope: "workspace",
    })).rejects.toThrow(`missing required permissions: ${missingScope}`);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("verifies every required bot scope during workspace health checks", async () => {
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: vi.fn(async () => json({ ok: true }, {
        "x-oauth-scopes": SlackWorkspaceBotScopes.join(","),
      })),
    });

    await expect(adapter.healthCheck(slackWorkspaceConnection())).resolves.toEqual({
      ok: true,
      message: "Slack authorization is healthy",
    });
  });

  it("refreshes workspace credentials and recovers granted scopes from auth.test", async () => {
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("oauth.v2.access")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return json({
          ok: true,
          access_token: "xoxe.xoxb-new",
          refresh_token: "xoxe-next",
          expires_in: 43_200,
        });
      }
      if (url.pathname.endsWith("auth.test")) {
        return json({ ok: true }, { "x-oauth-scopes": SlackWorkspaceBotScopes.join(",") });
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

    await expect(adapter.refreshCredentials!({
      ...slackWorkspaceConnection(),
      credentials: { botAccessToken: "xoxe.xoxb-old", refreshToken: "xoxe-current" },
    }, AbortSignal.timeout(1_000))).resolves.toMatchObject({
      botAccessToken: "xoxe.xoxb-new",
      refreshToken: "xoxe-next",
      expiresAt: "2026-08-07T04:00:00.000Z",
      oauthScopes: [...SlackWorkspaceBotScopes].sort(),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a refreshed workspace token that is still missing a required scope", async () => {
    const missingScope = "search:read.users";
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: vi.fn(async () => json({
        ok: true,
        access_token: "xoxe.xoxb-new",
        refresh_token: "xoxe-next",
        expires_in: 43_200,
        scope: SlackWorkspaceBotScopes.filter((scope) => scope !== missingScope).join(","),
      })),
    });

    await expect(adapter.refreshCredentials!({
      ...slackWorkspaceConnection(),
      credentials: { botAccessToken: "xoxe.xoxb-old", refreshToken: "xoxe-current" },
    }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: "unauthorized",
      details: { missingScopes: [missingScope] },
    });
  });

  it("classifies an invalid Slack refresh token as reconnect-required authorization failure", async () => {
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: vi.fn(async () => json({ ok: false, error: "invalid_refresh_token" })),
    });

    await expect(adapter.refreshCredentials!({
      ...slackWorkspaceConnection(),
      credentials: { botAccessToken: "xoxe.xoxb-old", refreshToken: "xoxe-invalid" },
    }, AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: "unauthorized",
      message: "invalid_refresh_token",
    });
  });

  it("paginates through and joins all active public Slack channels idempotently", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      const body = method === "conversations.list"
        ? Object.fromEntries(url.searchParams)
        : JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      if (method === "conversations.list" && !body.cursor) return json({
        ok: true,
        channels: [
          { id: "CJOIN", is_private: false, is_archived: false, is_member: false },
          { id: "CMEMBER", is_private: false, is_archived: false, is_member: true },
          { id: "CARCHIVED", is_private: false, is_archived: true, is_member: false },
        ],
        response_metadata: { next_cursor: "next-page" },
      });
      if (method === "conversations.list") return json({
        ok: true,
        channels: [
          { id: "CFULL", is_private: false, is_archived: false, is_member: false },
          { id: "CALREADY", is_private: false, is_archived: false, is_member: false },
        ],
        response_metadata: { next_cursor: "" },
      });
      if (body.channel === "CJOIN") return json({ ok: true, channel: { id: "CJOIN" } });
      if (body.channel === "CFULL") return json({ ok: false, error: "too_many_members" });
      if (body.channel === "CALREADY") return json({
        ok: true,
        channel: { id: "CALREADY" },
        warning: "already_in_channel",
      });
      throw new Error(`Unexpected Slack request ${method}`);
    });

    await expect(joinAllSlackPublicChannels(
      "xoxb-test",
      AbortSignal.timeout(1_000),
      fetcher,
    )).resolves.toEqual({ joined: 1, alreadyMember: 2, skipped: 2, complete: true });
    expect(requests.filter(({ method }) => method === "conversations.list")).toEqual([
      { method: "conversations.list", body: { exclude_archived: "true", limit: "200", types: "public_channel" } },
      { method: "conversations.list", body: { exclude_archived: "true", limit: "200", types: "public_channel", cursor: "next-page" } },
    ]);
    expect(requests.filter(({ method }) => method === "conversations.join").map(({ body }) => body.channel))
      .toEqual(["CJOIN", "CFULL", "CALREADY"]);
  });

  it("returns a resumable partial sync when Slack rate-limits a channel join", async () => {
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.list")) return json({
        ok: true,
        channels: [{ id: "CNEW", is_private: false, is_archived: false, is_member: false }],
        response_metadata: { next_cursor: "" },
      });
      return json({ error: "ratelimited" }, { "retry-after": "9" }, 429);
    });

    await expect(joinAllSlackPublicChannels(
      "xoxb-test",
      AbortSignal.timeout(1_000),
      fetcher,
    )).resolves.toEqual({
      joined: 0,
      alreadyMember: 0,
      skipped: 0,
      complete: false,
      retryAfterMs: 9_000,
    });
  });

  it("uses a conservative continuation delay for Slack's API-level rate-limit error", async () => {
    const fetcher: FetchLike = vi.fn(async () => json({ ok: false, error: "ratelimited" }));
    await expect(joinAllSlackPublicChannels(
      "xoxb-test",
      AbortSignal.timeout(1_000),
      fetcher,
    )).resolves.toMatchObject({ complete: false, retryAfterMs: 60_000 });
  });

  it("distinguishes a missing app scope from an unjoinable channel", async () => {
    const missingScope: FetchLike = vi.fn(async () => json({ ok: false, error: "missing_scope" }));
    await expect(joinSlackPublicChannel(
      "xoxb-test",
      "CNEW",
      AbortSignal.timeout(1_000),
      missingScope,
    )).rejects.toMatchObject({ code: "provider_error", message: "missing_scope" });

    const restricted: FetchLike = vi.fn(async () => json({ ok: false, error: "restricted_action" }));
    await expect(joinSlackPublicChannel(
      "xoxb-test",
      "CNEW",
      AbortSignal.timeout(1_000),
      restricted,
    )).resolves.toBe("skipped");
  });

  it("propagates transient join failures to the ingress retry loop", async () => {
    const fetcher: FetchLike = vi.fn(async () => json({ ok: false, error: "internal_error" }));
    await expect(joinSlackPublicChannel(
      "xoxb-test",
      "CNEW",
      AbortSignal.timeout(1_000),
      fetcher,
    )).rejects.toMatchObject({ code: "provider_error", message: "internal_error" });
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
      if (url.pathname.endsWith("oauth.v2.access")) return json({ ok: true, access_token: "xoxb-bot", scope: SlackWorkspaceBotScopes.join(","), team: { id: "TFREE", name: "Free" } });
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
    const fetcher: FetchLike = vi.fn(async (input, init) => {
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
      if (url.pathname.endsWith("users.lookupByEmail")) {
        expect(init?.method).toBe("GET");
        expect(url.searchParams.get("email")).toBe("ada@example.com");
        return json({
        ok: true,
        user: {
          id: "UADA",
          team_id: "TACME",
          deleted: false,
          is_bot: false,
          profile: { email: "ada@example.com" },
        },
        });
      }
      if (url.pathname.endsWith("users.info")) {
        expect(init?.method).toBe("GET");
        expect(url.searchParams.get("user")).toBe("UADA");
        return json({
        ok: true,
        user: {
          id: "UADA",
          team_id: "TACME",
          deleted: false,
          is_bot: false,
          profile: { display_name: "Ada", email: "ada@example.com" },
        },
        });
      }
      if (url.pathname.endsWith("conversations.info")) return json({
        ok: true,
        channel: {
          id: "CPRIVATE",
          is_private: true,
          is_im: false,
          is_mpim: false,
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
    await expect(slackApi("xoxb", "conversations.info", {
      channel: "CPRIVATE",
    }, AbortSignal.timeout(1_000), fetcher)).resolves.toMatchObject({
      channel: { id: "CPRIVATE", is_private: true },
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

function slackWorkspaceConnection(): ConnectorConnectionContext {
  return {
    id: "connection-slack",
    workspaceId: "workspace-avalon",
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [SlackCapabilities.agent],
    credentials: { botAccessToken: "xoxb-test" },
    cursor: {},
    config: {},
  };
}
