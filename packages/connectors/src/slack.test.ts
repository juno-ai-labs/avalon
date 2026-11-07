import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";
import { neverAborts } from "./test-signals";
import {
  createSlackConnector,
  joinSlackPublicChannel,
  normalizeSlackActivity,
  parseSlackAgentInvocation,
  slackApi,
  slackActivityEventType,
  slackExternalRoom,
  slackInstallationId,
  slackMessagePath,
  slackAgentActivationAcknowledgement,
  SlackActivityEventTypes,
  SlackCapabilities,
  SlackWorkspaceCapabilities,
  SlackWorkspaceBotScopes,
  slackTools,
  verifySlackRequest,
} from "./slack";
import type { FetchLike } from "./provider-utils";
import {
  type AuthorizedConnectorConnection,
  acknowledgeConnectorAgentActivation,
  authorizedConnection,
  connectorCapabilitySupportsScope,
  type ConnectorError,
} from "./types";

describe("Slack connector", () => {
  it("offers only tool-backed capabilities when it refuses one it lacks", async () => {
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: async () => {
        throw new Error("A refused tool must never reach Slack");
      },
    });

    const refusal = await adapter.executeTool("create_canvas", { title: "Notes" }, {
      connection: slackWorkspaceToolConnection(),
      principal: { type: "workspace", workspaceId: asWorkspaceId("8f7c6014-d46d-4285-8eb2-cac59f1b301c") },
      signal: neverAborts(),
    }).then(
      () => { throw new Error("A tool the connection cannot call must be refused"); },
      (error: unknown) => error as ConnectorError,
    );

    const available = (refusal.details as { available?: string[] } | undefined)?.available ?? [];
    // Slack is the connector where the grant and the model-callable surface
    // genuinely differ. `slack.agent` and `slack.notifications.write` are
    // control-plane grants with no tool behind them, so answering "what can I
    // do instead?" with either of them sends the model after something it
    // cannot call — worse than the bare refusal this replaced.
    expect(available).not.toContain(SlackCapabilities.agent);
    expect(available).not.toContain(SlackCapabilities.notificationsWrite);
    expect(available).toContain(SlackCapabilities.messagesWrite);
    expect(available).toContain(SlackCapabilities.search);
    // Everything offered is a capability some tool in this plugin declares.
    const toolCapabilities = new Set(adapter.agentPlugin.tools.map((tool) => tool.capability));
    expect(available.filter((capability: string) => !toolCapabilities.has(capability))).toEqual([]);
  });

  it("declares expressive activity triggers with typed Slack filters", () => {
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
    });
    expect(adapter.manifest.activityTriggers.map((trigger) => trigger.eventType))
      .toEqual(SlackActivityEventTypes);
    expect(adapter.manifest.activityTriggers.find((trigger) => trigger.eventType === "slack.reaction.added"))
      .toMatchObject({
        filterFields: expect.arrayContaining([
          expect.objectContaining({ key: "channelId", valueType: "string" }),
          expect.objectContaining({ key: "reaction", valueType: "string" }),
        ]),
      });
  });

  it("normalizes messages, mentions, edits, and reactions without copying raw envelopes", () => {
    const replyEnvelope = {
      type: "event_callback",
      team_id: "TACME",
      event_id: "EvReply",
      event_time: 1_786_032_000,
      event: {
        type: "message",
        user: "UADA",
        channel: "CENG",
        channel_type: "channel",
        ts: "1786032000.000200",
        thread_ts: "1786031900.000100",
        text: "<@UBEN> please investigate",
      },
    };
    expect(slackActivityEventType(replyEnvelope)).toBe("slack.message.replied");
    expect(normalizeSlackActivity(slackWorkspaceConnection(), replyEnvelope, null)).toMatchObject({
      provider: "slack",
      providerEventId: "EvReply",
      eventType: "slack.message.replied",
      providerResourceId: "CENG:1786032000.000200",
      textSnippet: "<@UBEN> please investigate",
      payloadRef: null,
      metadata: {
        teamId: "TACME",
        channelId: "CENG",
        userId: "UADA",
        threadTs: "1786031900.000100",
        isThread: true,
        // The binding key the host resolves the reply under, spelled here.
        externalConversationPath: ["CENG", "1786031900.000100"],
        externalConversationInstallationId: "slack:TACME",
      },
      externalPeople: expect.arrayContaining([
        expect.objectContaining({ providerUserId: "UADA", role: "actor" }),
        expect.objectContaining({ providerUserId: "UBEN", role: "mentioned" }),
      ]),
    });

    const editedEnvelope = {
      type: "event_callback",
      team_id: "TACME",
      event_id: "EvEdit",
      event: {
        type: "message",
        subtype: "message_changed",
        channel: "CENG",
        event_ts: "1786032001.000100",
        message: { user: "UADA", ts: "1786032000.000200", text: "updated" },
      },
    };
    expect(slackActivityEventType(editedEnvelope)).toBe("slack.message.edited");
    expect(normalizeSlackActivity(slackWorkspaceConnection(), editedEnvelope, null)).toMatchObject({
      eventType: "slack.message.edited",
      textSnippet: "updated",
      metadata: { messageTs: "1786032000.000200" },
    });

    const reactionEnvelope = {
      type: "event_callback",
      team_id: "TACME",
      event_id: "EvReaction",
      event: {
        type: "reaction_added",
        user: "UADA",
        reaction: "white_check_mark",
        item_user: "UBEN",
        item: { type: "message", channel: "CENG", ts: "1786032000.000200", channel_type: "channel" },
        event_ts: "1786032002.000100",
      },
    };
    expect(normalizeSlackActivity(slackWorkspaceConnection(), reactionEnvelope, null)).toMatchObject({
      eventType: "slack.reaction.added",
      providerResourceId: "CENG:1786032000.000200",
      metadata: { reaction: "white_check_mark", itemUserId: "UBEN", itemType: "message" },
    });

    const fileReactionEnvelope = {
      ...reactionEnvelope,
      event_id: "EvFileReaction",
      event: {
        ...reactionEnvelope.event,
        item: { type: "file", file: "FREPORT" },
      },
    };
    expect(normalizeSlackActivity(slackWorkspaceConnection(), fileReactionEnvelope, null)).toMatchObject({
      eventType: "slack.reaction.added",
      resourceType: "slack_file",
      providerResourceId: "FREPORT",
      metadata: { itemType: "file", fileId: "FREPORT" },
    });
  });

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
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.personalMcp, "personal")).toBe(true);
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.personalMcp, "workspace")).toBe(false);
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.search, "personal")).toBe(true);
    expect(connectorCapabilitySupportsScope(adapter, SlackCapabilities.search, "workspace")).toBe(true);
    expect(adapter.dynamicAgentTools).toMatchObject({
      capabilities: [SlackCapabilities.personalMcp],
      connectionScopes: ["personal"],
    });
    expect(SlackWorkspaceBotScopes).toContain("users:read.email");
    expect(SlackWorkspaceBotScopes).toContain("users:read");
    expect(SlackWorkspaceBotScopes).toContain("channels:read");
    expect(SlackWorkspaceBotScopes).toContain("channels:join");
    expect(SlackWorkspaceBotScopes).toContain("channels:history");
    expect(SlackWorkspaceBotScopes).toContain("groups:read");
    expect(SlackWorkspaceBotScopes).toContain("groups:history");
    expect(SlackWorkspaceBotScopes).toContain("mpim:history");
    expect(SlackWorkspaceBotScopes).toContain("files:read");
    expect(SlackWorkspaceBotScopes).toContain("reactions:read");
    expect(SlackWorkspaceBotScopes).toContain("reactions:write");
    expect(SlackWorkspaceBotScopes).toContain("channels:manage");
    expect(SlackWorkspaceBotScopes).toContain("search:read.public");
    expect(SlackWorkspaceBotScopes).toContain("search:read.files");
    expect(SlackWorkspaceBotScopes).toContain("search:read.users");
    expect(SlackWorkspaceBotScopes).not.toContain("search:read.private");
  });

  it("asks Slack who a personal token belongs to when the OAuth body names nobody", async () => {
    const calls: string[] = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push(url.pathname);
      // Slack's own envelope minus the user identity — `ok: true` with a
      // `team`, which is what the production failures must have carried:
      // they logged no `response_invalid`, so the body satisfied
      // `SlackOAuthSuccessSchema`, and that schema requires `team`.
      if (url.pathname.endsWith("oauth.v2.user.access")) return json({
        ok: true,
        access_token: "xoxp-user",
        token_type: "user",
        scope: "search:read.public,chat:write",
        team: { id: "TACME", name: "Acme" },
      });
      if (url.pathname.endsWith("auth.test")) {
        expect(init?.headers).toBeDefined();
        // A divergent header, to pin which source wins: the recovery fills a
        // gap and never overrides what this authorization itself granted.
        return json({ ok: true, user_id: "UADA" }, { "x-oauth-scopes": "im:history" });
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

    await expect(adapter.handleAuthorizationCallback!({ code: "user-code", codeVerifier: "verifier", connectionScope: "personal" }))
      .resolves.toMatchObject({
        providerAccountId: "TACME:UADA",
        slackUserId: "UADA",
        userAccessToken: "xoxp-user",
        teamId: "TACME",
        oauthScopes: ["chat:write", "search:read.public"],
      });
    expect(calls).toEqual(["/api/oauth.v2.user.access", "/api/auth.test"]);
  });

  it("does not spend an auth.test call when the OAuth body already names the user", async () => {
    const calls: string[] = [];
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push(url.pathname);
      if (url.pathname.endsWith("oauth.v2.user.access")) return json({
        ok: true,
        access_token: "xoxp-user",
        authed_user: { id: "UADA", scope: "chat:write" },
        team: { id: "TACME", name: "Acme" },
      });
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });

    await expect(adapter.handleAuthorizationCallback!({ code: "user-code", codeVerifier: "verifier", connectionScope: "personal" }))
      .resolves.toMatchObject({ providerAccountId: "TACME:UADA", slackUserId: "UADA" });
    expect(calls).toEqual(["/api/oauth.v2.user.access"]);
  });

  it("recovers the granted scopes from the identity call when the body names none", async () => {
    const calls: string[] = [];
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push(url.pathname);
      // No `scope` and no user: without the recovery this connection is stored
      // with an empty grant, which `refreshCredentials` then carries forward.
      if (url.pathname.endsWith("oauth.v2.user.access")) return json({
        ok: true,
        access_token: "xoxp-user",
        team: { id: "TACME", name: "Acme" },
      });
      if (url.pathname.endsWith("auth.test")) {
        return json({ ok: true, user_id: "UADA" }, { "x-oauth-scopes": "chat:write, search:read.public" });
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

    await expect(adapter.handleAuthorizationCallback!({ code: "user-code", codeVerifier: "verifier", connectionScope: "personal" }))
      .resolves.toMatchObject({
        slackUserId: "UADA",
        oauthScopes: ["chat:write", "search:read.public"],
      });
    expect(calls).toEqual(["/api/oauth.v2.user.access", "/api/auth.test"]);
  });

  it("attributes every OAuth callback failure to the phase that produced it", async () => {
    const respond = new Map<string, () => Response>();
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: async (input) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
        const handler = respond.get(url.pathname);
        if (!handler) throw new Error(`Unexpected URL ${url}`);
        return handler();
      },
    });
    const failure = async (): Promise<ConnectorError> => {
      try {
        await adapter.handleAuthorizationCallback!({ code: "user-code", codeVerifier: "verifier", connectionScope: "personal" });
      } catch (error) {
        return error as ConnectorError;
      }
      throw new Error("The callback resolved where it was expected to fail");
    };

    // Slack refused the code. Its own vocabulary is what an operator needs, and
    // it must survive the stage being attached.
    respond.set("/api/oauth.v2.user.access", () => json({ ok: false, error: "invalid_code" }));
    expect(await failure()).toMatchObject({
      code: "provider_error",
      details: { oauthStage: "token_exchange", error: "invalid_code" },
    });

    // Slack answered with a body this adapter does not model. Which field is
    // the whole diagnosis, and the body's values do not travel with it.
    respond.set("/api/oauth.v2.user.access", () => json({ ok: true, team: { id: "TACME" }, authed_user: { access_token: 123 } }));
    expect(await failure()).toMatchObject({
      code: "provider_error",
      details: { oauthStage: "token_exchange", responseIssues: "authed_user.access_token:invalid_type" },
    });

    // Slack answered, but with nothing this connection can be built from.
    respond.set("/api/oauth.v2.user.access", () => json({ ok: true, team: { id: "TACME" } }));
    expect(await failure()).toMatchObject({
      code: "provider_error",
      details: { oauthStage: "account_identity", responseInvalid: true },
    });

    // A token arrived, and Slack still would not name its owner.
    respond.set("/api/oauth.v2.user.access", () => json({ ok: true, access_token: "xoxp-user", team: { id: "TACME" } }));
    respond.set("/api/auth.test", () => json({ ok: true }));
    expect(await failure()).toMatchObject({
      code: "provider_error",
      details: { oauthStage: "account_identity", responseInvalid: true },
    });

    // The identity lookup itself was refused. That is Slack's answer, not ours.
    respond.set("/api/auth.test", () => json({ ok: false, error: "token_revoked" }));
    expect(await failure()).toMatchObject({
      code: "unauthorized",
      details: { oauthStage: "account_identity", error: "token_revoked" },
    });
  });

  it("keeps legacy personal grants on their reviewed static surface", async () => {
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/api/users.info");
      return json({
        ok: true,
        user: { id: "UALEX", team_id: "TACME", name: "alex", profile: { display_name: "Alex" } },
      });
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = authorizedConnection({
      id: "connection-slack-personal-legacy",
      workspaceId: asWorkspaceId("8f7c6014-d46d-4285-8eb2-cac59f1b301c"),
      scope: "personal",
      ownerUserId: "8046c3d3-4e9c-458b-8edb-653be8b809c9",
      grantedScopes: [SlackCapabilities.usersRead],
      credentials: { userAccessToken: "xoxp-legacy" },
      cursor: {},
      config: {},
    });

    await expect(adapter.dynamicAgentTools!.discover(connection, neverAborts()))
      .rejects.toMatchObject({ code: "unsupported_capability" });
    expect(fetcher).not.toHaveBeenCalled();

    await expect(adapter.executeTool("read_user_profile", { user_id: "UALEX" }, {
      connection,
      principal: { type: "user", userId: asUserId("8046c3d3-4e9c-458b-8edb-653be8b809c9") },
      signal: neverAborts(),
    })).resolves.toMatchObject({ output: { user: { id: "UALEX" } } });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("exposes every requested read and write tool to workspace Slack connections", () => {
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
    });
    const requestedTools = [
      "find_users",
      "search_messages",
      "read_message_context",
      "read_channel",
      "read_thread",
      "read_file",
      "find_channels",
      "list_channel_members",
      "send_message",
      "add_reaction",
      "create_conversation",
    ];
    expect(requestedTools.every((name) => slackTools.some((tool) => tool.name === name))).toBe(true);
    for (const capability of SlackWorkspaceCapabilities) {
      expect(connectorCapabilitySupportsScope(adapter, capability, "workspace")).toBe(true);
    }
  });

  it("states the create_conversation choice at tool level and validates it at execution", () => {
    const definition = slackTools.find((tool) => tool.name === "create_conversation");
    expect(definition).toMatchObject({
      description: expect.stringMatching(/exactly one.*`name`.*channel.*`user_ids`.*direct or group message/iu),
      inputSchema: {
        properties: {
          name: { description: expect.stringContaining("Omit it when using `user_ids`.") },
          user_ids: { description: expect.stringContaining("Omit it when using `name`.") },
          is_private: { description: expect.stringMatching(/ignored for direct and group messages.*cannot be changed later/iu) },
        },
      },
    });

    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
    });
    expect(adapter.validateToolInput?.("create_conversation", {})).toBeInstanceOf(Error);
    expect(adapter.validateToolInput?.("create_conversation", {
      name: "project-alpha",
      user_ids: ["UALEX"],
    })).toBeInstanceOf(Error);
    expect(adapter.validateToolInput?.("create_conversation", { name: "Project Alpha" })).toBeInstanceOf(Error);
    expect(adapter.validateToolInput?.("create_conversation", { name: "project-alpha" })).toBeNull();
    expect(adapter.validateToolInput?.("create_conversation", { user_ids: ["UALEX"] })).toBeNull();
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
    }, neverAborts(), fetcher)).resolves.toMatchObject({
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
    }, neverAborts(), fetcher)).resolves.toMatchObject({
      messages: [
        { user: "U1", text: "<@UBOT> investigate" },
        { user: "UBOT", text: "Not yet" },
      ],
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("runtime-checks bounded nearby-message reads", async () => {
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(url.searchParams.get("channel")).toBe("CIDEAS");
      expect(url.searchParams.get("latest")).toBe("1786130000.000100");
      expect(url.searchParams.get("inclusive")).toBe("false");
      expect(url.searchParams.get("limit")).toBe("8");
      return json({
        ok: true,
        messages: [{
          ts: "1786129999.000100",
          user: "UALEX",
          text: "Latest business idea",
          files: [{
            id: "FBRIEF",
            name: "monad-thesis-brief.md",
            mimetype: "text/markdown",
            permalink: "https://example.slack.com/files/FBRIEF",
          }],
        }],
      });
    });

    await expect(slackApi("xoxb", "conversations.history", {
      channel: "CIDEAS",
      latest: "1786130000.000100",
      inclusive: false,
      limit: 8,
    }, neverAborts(), fetcher)).resolves.toMatchObject({
      messages: [{ user: "UALEX", files: [{ id: "FBRIEF" }] }],
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
    }, neverAborts())).resolves.toMatchObject({
      botAccessToken: "xoxe.xoxb-new",
      refreshToken: "xoxe-next",
      expiresAt: "2026-08-07T04:00:00.000Z",
      oauthScopes: [...SlackWorkspaceBotScopes].sort(),
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a refreshed workspace token that is still missing a required scope", async () => {
    const missingScope = "users:read.email";
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
    }, neverAborts())).rejects.toMatchObject({
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
    }, neverAborts())).rejects.toMatchObject({
      code: "unauthorized",
      message: "invalid_refresh_token",
      // The name of this test was the only place the verdict appeared. Slack
      // answers a refused refresh with HTTP 200, so nothing downstream can
      // infer it, and without the flag the host left the connection healthy.
      details: { reconnectRequired: true },
    });
  });

  it("keys a Slack message by its thread root, and a top-level message by itself", () => {
    expect(slackMessagePath({ channelId: "C1", threadTs: "10.1", messageTs: "10.5" })).toEqual(["C1", "10.1"]);
    // A top-level message, and every message in a room that disallows threads,
    // is its own root: two addressed messages there have two keys.
    expect(slackMessagePath({ channelId: "G1", threadTs: null, messageTs: "10.5" })).toEqual(["G1", "10.5"]);
    expect(slackMessagePath({ channelId: "G1", threadTs: undefined, messageTs: "10.6" })).toEqual(["G1", "10.6"]);
    expect(slackInstallationId("T1")).toBe("slack:T1");
  });

  it("classifies a group DM by is_mpim rather than its ID prefix, and never by its Slack name", () => {
    expect(slackExternalRoom({ id: "G1", name: "mpdm-alice--bob--carol-1", is_mpim: true, is_private: true }))
      .toEqual({
        kind: "shared",
        visibility: "private",
        threadable: true,
        archived: false,
        displayName: "Group DM: alice, bob, carol",
        externallyShared: false,
      });
    expect(slackExternalRoom({ id: "C1", name: "launch", is_private: false })).toMatchObject({
      kind: "shared", visibility: "public", displayName: "launch",
    });
    // `is_private` is optional on the wire; only an explicit false is public.
    expect(slackExternalRoom({ id: "G2", name: "secret" })).toMatchObject({ visibility: "private" });
    expect(slackExternalRoom({ id: "D1", is_im: true })).toMatchObject({ kind: "direct" });
    expect(slackExternalRoom({ id: "G3", is_mpim: true, is_non_threadable: true, is_archived: true }))
      .toMatchObject({ threadable: false, archived: true, displayName: "Group DM" });
    // A Slack Connect room, shared or still pending, stays public but is marked.
    expect(slackExternalRoom({ id: "C2", name: "general", is_private: false, is_ext_shared: true }))
      .toMatchObject({ visibility: "public", externallyShared: true });
    expect(slackExternalRoom({ id: "C3", name: "general", is_private: false, is_pending_ext_shared: true }))
      .toMatchObject({ externallyShared: true });
  });

  it("distinguishes a missing app scope from an unjoinable channel", async () => {
    const missingScope: FetchLike = vi.fn(async () => json({ ok: false, error: "missing_scope" }));
    await expect(joinSlackPublicChannel(
      "xoxb-test",
      "CNEW",
      neverAborts(),
      missingScope,
    )).rejects.toMatchObject({ code: "provider_error", message: "missing_scope" });

    const restricted: FetchLike = vi.fn(async () => json({ ok: false, error: "restricted_action" }));
    await expect(joinSlackPublicChannel(
      "xoxb-test",
      "CNEW",
      neverAborts(),
      restricted,
    )).resolves.toBe("skipped");
  });

  it("propagates transient join failures to the ingress retry loop", async () => {
    const fetcher: FetchLike = vi.fn(async () => json({ ok: false, error: "internal_error" }));
    await expect(joinSlackPublicChannel(
      "xoxb-test",
      "CNEW",
      neverAborts(),
      fetcher,
    )).rejects.toMatchObject({ code: "provider_error", message: "internal_error" });
  });

  it("reports a last search page as a null cursor rather than Slack's blank", async () => {
    // Slack reports a last page as `next_cursor: ""`, and the cursor
    // description tells the caller to stop when it is `null`. Handed the blank
    // verbatim the caller reads another page, cannot send it back because the
    // string branch rejects it, and either invents a token or sends `null` and
    // re-fetches page one forever. Same repair `boundXPage` makes for X.
    const fetcher: FetchLike = async () => json({
      ok: true,
      results: { messages: [{ channel_id: "CIDEAS", message_ts: "1786130000.000100" }], next_cursor: "" },
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = slackWorkspaceToolConnection();
    const context = {
      connection,
      principal: { type: "workspace" as const, workspaceId: asWorkspaceId(connection.workspaceId) },
      invocationAuthorization: { slackActionToken: "event-only-action-token" },
      signal: neverAborts(),
    };

    await expect(adapter.executeTool("search_messages", { query: "gizmo" }, context))
      .resolves.toMatchObject({ pagination: { continuations: [] } });
    await expect(adapter.executeTool("search", { query: "gizmo" }, context))
      .resolves.toMatchObject({ pagination: { continuations: [] } });
  });

  it("uses hidden event authorization for workspace message search", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/api/assistant.search.context");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      return json({
        ok: true,
        results: {
          messages: [{ channel_id: "CIDEAS", message_ts: "1786130000.000100", content: "Project Gizmo" }],
          next_cursor: "",
        },
      });
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = slackWorkspaceToolConnection();

    await expect(adapter.executeTool("search_messages", {
      query: "project gizmo",
      channel_id: "CIDEAS",
      author_user_id: "UALEX",
    }, {
      connection,
      principal: { type: "workspace", workspaceId: asWorkspaceId(connection.workspaceId) },
      invocationAuthorization: { slackActionToken: "event-only-action-token" },
      signal: neverAborts(),
    })).resolves.toMatchObject({ output: { messages: [{ channel_id: "CIDEAS" }] } });
    expect(requests[0]).toMatchObject({
      action_token: "event-only-action-token",
      channel_types: ["public_channel"],
      content_types: ["messages"],
    });
    expect(String(requests[0]?.query)).toContain("in:<#CIDEAS>");
    expect(String(requests[0]?.query)).toContain("from:<@UALEX>");

    await expect(adapter.executeTool("search_messages", { query: "project gizmo" }, {
      connection,
      principal: { type: "workspace", workspaceId: asWorkspaceId(connection.workspaceId) },
      signal: neverAborts(),
    })).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("executes workspace Slack reads through bounded Web API methods", async () => {
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1);
      if (url.hostname === "files.slack.com") {
        return new Response("# Business idea\nUseful details", {
          headers: { "content-type": "text/markdown", "content-length": "30" },
        });
      }
      if (method === "users.list") return json({
        ok: true,
        members: [{ id: "UALEX", team_id: "TACME", name: "alex", real_name: "Alex Example", profile: { email: "alex@example.com" } }],
        response_metadata: { next_cursor: "" },
      });
      if (method === "conversations.list") return json({
        ok: true,
        channels: [{ id: "CIDEAS", name: "thinking-out-loud", is_private: false, is_member: true }],
        response_metadata: { next_cursor: "" },
      });
      if (method === "conversations.history" && url.searchParams.has("latest")) return json({
        ok: true,
        messages: [
          { ts: "1786130000.000100", user: "UALEX", text: "Target idea" },
          { ts: "1786129999.000100", user: "UADA", text: "Before" },
        ],
        has_more: false,
      });
      if (method === "conversations.history" && url.searchParams.has("oldest")) return json({
        ok: true,
        messages: [{ ts: "1786130001.000100", user: "UADA", text: "After" }],
        has_more: false,
      });
      if (method === "conversations.history") return json({
        ok: true,
        messages: [{ ts: "1786130000.000100", user: "UALEX", text: "Channel message" }],
        has_more: false,
        response_metadata: { next_cursor: "" },
      });
      if (method === "conversations.replies") return json({
        ok: true,
        messages: [{ ts: "1786130000.000100", user: "UALEX", text: "Thread root" }],
        has_more: false,
      });
      if (method === "files.info") return json({
        ok: true,
        file: {
          id: "FBRIEF",
          name: "brief.md",
          mimetype: "text/markdown",
          filetype: "markdown",
          size: 30,
          url_private_download: "https://files.slack.com/files-pri/TACME-FBRIEF/brief.md",
          permalink: "https://acme.slack.com/files/FBRIEF",
        },
      });
      if (method === "users.info") return json({
        ok: true,
        user: { id: "UALEX", team_id: "TACME", name: "alex", profile: { display_name: "Alex" } },
      });
      if (method === "conversations.members") return json({
        ok: true,
        members: ["UALEX", "UADA"],
        response_metadata: { next_cursor: "" },
      });
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = slackWorkspaceToolConnection();
    const context = {
      connection,
      principal: { type: "workspace" as const, workspaceId: asWorkspaceId(connection.workspaceId) },
      signal: neverAborts(),
    };

    await expect(adapter.executeTool("find_users", { query: "alex" }, context))
      .resolves.toMatchObject({ output: { users: [{ id: "UALEX" }] } });
    await expect(adapter.executeTool("find_channels", { query: "thinking" }, context))
      .resolves.toMatchObject({ output: { channels: [{ id: "CIDEAS" }] } });
    await expect(adapter.executeTool("read_message_context", {
      channel_id: "CIDEAS",
      message_ts: "1786130000.000100",
    }, context)).resolves.toMatchObject({ output: { target: { text: "Target idea" }, before: [{ text: "Before" }], after: [{ text: "After" }] } });
    await expect(adapter.executeTool("read_channel", { channel_id: "CIDEAS" }, context))
      .resolves.toMatchObject({ output: { messages: [{ text: "Channel message" }] } });
    await expect(adapter.executeTool("read_thread", {
      channel_id: "CIDEAS",
      thread_ts: "1786130000.000100",
    }, context)).resolves.toMatchObject({ output: { messages: [{ text: "Thread root" }] } });
    await expect(adapter.executeTool("read_file", { file_id: "FBRIEF" }, context))
      .resolves.toMatchObject({ output: { file: { id: "FBRIEF" }, content: "# Business idea\nUseful details" } });
    await expect(adapter.executeTool("read_user_profile", { user_id: "UALEX" }, context))
      .resolves.toMatchObject({ output: { user: { id: "UALEX" } } });
    await expect(adapter.executeTool("list_channel_members", { channel_id: "CIDEAS" }, context))
      .resolves.toMatchObject({ output: { member_user_ids: ["UALEX", "UADA"] } });
  });

  it("executes workspace Slack writes with stable provider identities", async () => {
    const requests: Array<{ method: string; body: Record<string, unknown> }> = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ method, body });
      if (method === "chat.postMessage") return json({ ok: true, channel: "CIDEAS", ts: "1786130000.000100" });
      if (method === "reactions.add") return json({ ok: false, error: "already_reacted" });
      if (method === "conversations.create") return json({
        ok: true,
        channel: { id: "CNEW", name: "project-alpha", is_private: false },
      });
      if (method === "conversations.open") return json({
        ok: true,
        channel: { id: "DNEW", is_im: false, is_mpim: true },
      });
      throw new Error(`Unexpected URL ${url}`);
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = slackWorkspaceToolConnection();
    const context = {
      connection,
      principal: { type: "workspace" as const, workspaceId: asWorkspaceId(connection.workspaceId) },
      providerIdempotencyKey: "tool-receipt-send-message",
      signal: neverAborts(),
    };

    await expect(adapter.executeTool("send_message", { channel_id: "CIDEAS", text: "Hello" }, context))
      .resolves.toMatchObject({ providerOperationId: "CIDEAS:1786130000.000100" });
    await expect(adapter.executeTool("add_reaction", {
      channel_id: "CIDEAS",
      timestamp: "1786130000.000100",
      name: "eyes",
    }, context)).resolves.toMatchObject({ providerOperationId: "CIDEAS:1786130000.000100:eyes" });
    await expect(adapter.executeTool("create_conversation", {
      name: "project-alpha",
      is_private: false,
    }, context)).resolves.toMatchObject({ providerOperationId: "CNEW" });
    await expect(adapter.executeTool("create_conversation", {
      user_ids: ["UALEX", "UADA"],
      is_private: true,
    }, context)).resolves.toMatchObject({ providerOperationId: "DNEW" });
    expect(requests.find((request) => request.method === "chat.postMessage")?.body.client_msg_id)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(requests.find((request) => request.method === "conversations.open")?.body)
      .toEqual({ users: "UALEX,UADA" });
  });

  it("reports a bot send's reply thread by its root, and a personal send's never", async () => {
    // Only the workspace bot's conversations reach Rally's ingress, so only a
    // bot send has a thread the host can route replies from. A reply in an
    // existing thread keys on that thread's root, not on the new message.
    const fetcher: FetchLike = vi.fn(async () => json({ ok: true, channel: "D1", ts: "1786130000.000200" }));
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const bot = authorizedConnection({
      ...slackWorkspaceConnection(),
      grantedScopes: [...SlackWorkspaceCapabilities],
      credentials: { botAccessToken: "xoxb-test", teamId: "T1" },
    });
    const botContext = {
      connection: bot,
      principal: { type: "workspace" as const, workspaceId: asWorkspaceId(bot.workspaceId) },
      signal: neverAborts(),
    };
    await expect(adapter.executeTool("send_message", { channel_id: "D1", text: "Updates?" }, botContext))
      .resolves.toMatchObject({
        externalConversation: { installationId: "slack:T1", path: ["D1", "1786130000.000200"] },
      });
    await expect(adapter.executeTool("send_message", {
      channel_id: "D1", text: "Following up", thread_ts: "1786120000.000100",
    }, botContext)).resolves.toMatchObject({
      externalConversation: { installationId: "slack:T1", path: ["D1", "1786120000.000100"] },
    });

    const person = authorizedConnection({
      id: "connection-slack-personal",
      workspaceId: asWorkspaceId("8f7c6014-d46d-4285-8eb2-cac59f1b301c"),
      scope: "personal",
      ownerUserId: "8046c3d3-4e9c-458b-8edb-653be8b809c9",
      grantedScopes: [SlackCapabilities.messagesWrite],
      credentials: { userAccessToken: "xoxp-person", teamId: "T1" },
      cursor: {},
      config: {},
    });
    const sent = await adapter.executeTool("send_message", { channel_id: "D1", text: "Updates?" }, {
      connection: person,
      principal: { type: "user", userId: asUserId("8046c3d3-4e9c-458b-8edb-653be8b809c9") },
      signal: neverAborts(),
    });
    expect(sent).not.toHaveProperty("externalConversation");
  });

  it("posts a message body as a markdown block, so its tables render", async () => {
    // Slack reads `chat.postMessage`'s `text` as mrkdwn, which has no tables:
    // a Sidekick's report posted there showed every row as literal pipes.
    const requests: Array<Record<string, unknown>> = [];
    let next = 0;
    const fetcher: FetchLike = vi.fn(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      next += 1;
      return json({ ok: true, channel: "CIDEAS", ts: `1786130000.00010${next}` });
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = slackWorkspaceToolConnection();
    const context = {
      connection,
      principal: { type: "workspace" as const, workspaceId: asWorkspaceId(connection.workspaceId) },
      providerIdempotencyKey: "tool-receipt-send-report",
      signal: neverAborts(),
    };

    const table = "**Web traffic**\n\n| Metric | Oct 30 |\n|---|---:|\n| Visitors | 84 |";
    await expect(adapter.executeTool("send_message", {
      channel_id: "CIDEAS", text: table, thread_ts: "1786120000.000100",
    }, context)).resolves.toMatchObject({ providerOperationId: "CIDEAS:1786130000.000101" });
    expect(requests[0]).toMatchObject({
      channel: "CIDEAS",
      thread_ts: "1786120000.000100",
      text: "Web traffic\n\n| Metric | Oct 30 |\n|---|---:|\n| Visitors | 84 |",
      blocks: [{ type: "markdown", text: table }],
    });

    // A body past Slack's markdown limit posts as consecutive messages in the
    // same thread, each with its own idempotency key, and reports the first.
    requests.length = 0;
    const long = Array.from({ length: 300 }, (_, row) => `| row ${row} | ${"x".repeat(60)} |`).join("\n");
    await expect(adapter.executeTool("send_message", {
      channel_id: "CIDEAS", text: long, thread_ts: "1786120000.000100",
    }, context)).resolves.toMatchObject({ providerOperationId: "CIDEAS:1786130000.000102" });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.thread_ts)).toEqual(["1786120000.000100", "1786120000.000100"]);
    expect(new Set(requests.map((request) => request.client_msg_id)).size).toBe(2);
    expect(requests.map((request) => (request.blocks as Array<{ text: string }>)[0]!.text).join("\n")).toBe(long);

    // Posted top-level, the rest continues in the first message's thread, so
    // a reply anywhere in it reaches the root the send binds.
    requests.length = 0;
    await expect(adapter.executeTool("send_message", { channel_id: "CIDEAS", text: long }, context))
      .resolves.toMatchObject({ providerOperationId: "CIDEAS:1786130000.000104" });
    expect(requests.map((request) => request.thread_ts)).toEqual([undefined, "1786130000.000104"]);
  });

  it("reports the first message when a later part of a long post fails", async () => {
    // The first part is already visible, so the receipt must still record it;
    // throwing would lose it and let a re-send post that part twice.
    let calls = 0;
    const fetcher: FetchLike = vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? json({ ok: true, channel: "CIDEAS", ts: "1786130000.000101" })
        : json({ ok: false, error: "ratelimited" });
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const connection = slackWorkspaceToolConnection();
    const long = Array.from({ length: 300 }, (_, row) => `line ${row} ${"x".repeat(60)}`).join("\n");
    const sent = await adapter.executeTool("send_message", { channel_id: "CIDEAS", text: long }, {
      connection,
      principal: { type: "workspace" as const, workspaceId: asWorkspaceId(connection.workspaceId) },
      signal: neverAborts(),
    });
    expect(sent).toMatchObject({
      providerOperationId: "CIDEAS:1786130000.000101",
      output: { channel_id: "CIDEAS", timestamp: "1786130000.000101", parts_posted: 1, parts_total: 2, failure: "ratelimited" },
      summary: "Posted 1 of 2 parts of a Slack message to CIDEAS; part 2 failed (ratelimited) and the rest was not sent",
    });
    expect(calls).toBe(2);
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
      workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062"),
      scope: "personal",
      ownerUserId: "user",
      grantedScopes: [SlackCapabilities.search],
      credentials: { userAccessToken: "xoxe.xoxp-old", refreshToken: "xoxe-old" },
      cursor: {},
      config: {},
    }, neverAborts())).resolves.toMatchObject({
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

    await expect(adapter.revoke!(authorizedConnection({
      id: "connection",
      workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062"),
      scope: "workspace",
      ownerUserId: null,
      grantedScopes: [SlackCapabilities.agent],
      credentials: { botAccessToken: "xoxb-access", refreshToken: "xoxe-refresh" },
      cursor: {},
      config: {},
    }), neverAborts())).rejects.toThrow(/ratelimited/iu);
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

  it("swaps one reaction for the next, taking off only what Avalon put there", async () => {
    const calls: { method: string; body: unknown }[] = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      calls.push({ method: url.pathname, body: JSON.parse(String(init?.body)) });
      return json({ ok: true });
    });
    const adapter = slackAdapterWith(fetcher);
    await expect(adapter.messagingAgent!.execute({
      kind: "reaction",
      channelId: "C1",
      timestamp: "123.456",
      add: "gear",
      remove: "brain",
      fallback: "gear",
    }, reactionContext())).resolves.toEqual({
      success: true,
      reaction: "gear",
      removed: true,
      alreadyPresent: false,
    });
    // The removal names the emoji Avalon last placed and nothing else, so a
    // member's own reaction on the same message is never collected with it.
    expect(calls).toEqual([
      { method: "/api/reactions.remove", body: { channel: "C1", name: "brain", timestamp: "123.456" } },
      { method: "/api/reactions.add", body: { channel: "C1", name: "gear", timestamp: "123.456" } },
    ]);
  });

  it("treats a reaction a member already removed as the state it wanted", async () => {
    const fetcher: FetchLike = vi.fn(async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      return json(url.pathname.endsWith("reactions.remove") ? { ok: false, error: "no_reaction" } : { ok: true });
    });
    await expect(slackAdapterWith(fetcher).messagingAgent!.execute({
      kind: "reaction",
      channelId: "C1",
      timestamp: "123.456",
      add: "white_check_mark",
      remove: "gear",
      fallback: "white_check_mark",
    }, reactionContext())).resolves.toEqual({
      success: true,
      reaction: "white_check_mark",
      removed: false,
      alreadyPresent: false,
    });
  });

  it("falls back to Avalon's own emoji when a workspace configured one Slack lacks", async () => {
    const names: string[] = [];
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (!url.pathname.endsWith("reactions.add")) return json({ ok: true });
      const name = String((JSON.parse(String(init?.body)) as { name: string }).name);
      names.push(name);
      // Slack has no way to check a custom emoji exists in advance, so the
      // refusal is the check and the fallback is the recovery.
      return json(name === "company_ship_it" ? { ok: false, error: "invalid_name" } : { ok: true });
    });
    await expect(slackAdapterWith(fetcher).messagingAgent!.execute({
      kind: "reaction",
      channelId: "C1",
      timestamp: "123.456",
      add: "company_ship_it",
      remove: null,
      fallback: "white_check_mark",
    }, reactionContext())).resolves.toEqual({
      success: true,
      reaction: "white_check_mark",
      removed: false,
      alreadyPresent: false,
    });
    expect(names).toEqual(["company_ship_it", "white_check_mark"]);
  });

  it("does not spend a call removing the reaction it is about to add", async () => {
    const fetcher: FetchLike = vi.fn(async () => json({ ok: true }));
    await slackAdapterWith(fetcher).messagingAgent!.execute({
      kind: "reaction",
      channelId: "C1",
      timestamp: "123.456",
      add: "gear",
      remove: "gear",
      fallback: "gear",
    }, reactionContext());
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("plans and executes the shared activation acknowledgement idempotently", async () => {
    let attempts = 0;
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/api/reactions.add");
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C1",
        name: "eyes",
        timestamp: "123.456",
      });
      attempts += 1;
      return json(attempts === 1 ? { ok: true } : { ok: false, error: "already_reacted" });
    });
    const adapter = createSlackConnector({
      clientId: "client",
      clientSecret: "secret",
      signingSecret: "signing",
      redirectUri: "https://api.example.com/connections/slack/callback",
      fetch: fetcher,
    });
    const invocation = parseSlackAgentInvocation({
      kind: "event",
      envelope: {
        type: "event_callback",
        team_id: "T1",
        event_id: "Ev1",
        event: {
          type: "app_mention",
          user: "U1",
          channel: "C1",
          ts: "123.456",
          thread_ts: "100.000",
          text: "<@UBOT> investigate",
        },
      },
    });
    expect(slackAgentActivationAcknowledgement(invocation)).toEqual({
      kind: "reaction",
      channelId: "C1",
      timestamp: "123.456",
      add: "eyes",
      remove: null,
      fallback: "eyes",
    });
    const context = {
      connection: slackWorkspaceConnection(),
      signal: neverAborts(),
    };

    await expect(acknowledgeConnectorAgentActivation(
      adapter.messagingAgent!,
      invocation,
      context,
    )).resolves.toEqual({ success: true, reaction: "eyes", removed: false, alreadyPresent: false });
    await expect(acknowledgeConnectorAgentActivation(
      adapter.messagingAgent!,
      invocation,
      context,
    )).resolves.toEqual({ success: true, reaction: "eyes", removed: false, alreadyPresent: true });

    const commandInvocation = parseSlackAgentInvocation({
      kind: "command",
      payload: {
        team_id: "T1",
        user_id: "U1",
        command: "/avalon",
        text: "investigate",
        channel_id: "C1",
        trigger_id: "tr1",
        response_url: null,
      },
    });
    expect(slackAgentActivationAcknowledgement(commandInvocation)).toBeNull();
    await expect(acknowledgeConnectorAgentActivation(
      adapter.messagingAgent!,
      commandInvocation,
      context,
    )).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await expect(acknowledgeConnectorAgentActivation(
      adapter.messagingAgent!,
      invocation,
      {
        ...context,
        connection: { ...context.connection, grantedScopes: [] },
      },
    )).rejects.toThrow(/has not granted slack\.agent/iu);
    expect(fetcher).toHaveBeenCalledTimes(2);

    const malformedSource = parseSlackAgentInvocation({
      kind: "event",
      envelope: {
        type: "event_callback",
        team_id: "T1",
        event_id: "EvMalformed",
        event: {
          type: "app_mention",
          user: "U1",
          channel: { id: "C1" },
          ts: 123.456,
        },
      },
    });
    expect(slackAgentActivationAcknowledgement(malformedSource)).toBeNull();
  });

  it("runtime-checks Slack Web API requests and success responses", async () => {
    const fetcher: FetchLike = vi.fn(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
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

    // The failing field rides on the error, code-shaped, for the API's reason
    // helpers to read; the body's values do not.
    await expect(slackApi("xoxb", "team.billing.info", {}, neverAborts(), fetcher))
      .rejects.toMatchObject({
        code: "provider_error",
        message: expect.stringMatching(/malformed response/iu),
        details: { responseIssues: expect.stringMatching(/^[A-Za-z0-9_:.-]+$/u) },
      });
    await expect(slackApi("xoxb", "team.billing.info", {}, neverAborts(), fetcher))
      .rejects.toMatchObject({ details: { responseIssues: expect.stringContaining("invalid_type") } });
    await expect(slackApi("xoxb", "users.lookupByEmail", {
      email: "ada@example.com",
    }, neverAborts(), fetcher)).resolves.toMatchObject({
      user: { id: "UADA", team_id: "TACME", deleted: false },
    });
    await expect(slackApi("xoxb", "users.info", {
      user: "UADA",
    }, neverAborts(), fetcher)).resolves.toMatchObject({
      user: { id: "UADA", team_id: "TACME", profile: { email: "ada@example.com" } },
    });
    await expect(slackApi("xoxb", "conversations.info", {
      channel: "CPRIVATE",
    }, neverAborts(), fetcher)).resolves.toMatchObject({
      channel: { id: "CPRIVATE", is_private: true },
    });
    await expect(slackApi("xoxb", "users.lookupByEmail", {
      email: "not-an-email",
    }, neverAborts(), fetcher)).rejects.toThrow();
    await expect(slackApi("xoxb", "conversations.open", {
      users: ["U1"],
    } as never, neverAborts(), fetcher)).rejects.toThrow();
    await expect(slackApi("xoxb", "chat.postMessage", {
      channel: "C1",
      text: "x".repeat(40_001),
    }, neverAborts(), fetcher)).rejects.toThrow();
  });
});

async function slackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  return `v0=${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function slackAdapterWith(fetcher: FetchLike) {
  return createSlackConnector({
    clientId: "client",
    clientSecret: "secret",
    signingSecret: "signing",
    redirectUri: "https://api.example.com/connections/slack/callback",
    fetch: fetcher,
  });
}

function reactionContext() {
  return { connection: slackWorkspaceConnection(), signal: neverAborts() };
}

function json(value: unknown, headers: HeadersInit = {}, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
}

function slackWorkspaceConnection(): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "connection-slack",
    workspaceId: asWorkspaceId("8f7c6014-d46d-4285-8eb2-cac59f1b301c"),
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [SlackCapabilities.agent],
    credentials: { botAccessToken: "xoxb-test" },
    cursor: {},
    config: {},
  });
}

function slackWorkspaceToolConnection(): AuthorizedConnectorConnection {
  return authorizedConnection({
    ...slackWorkspaceConnection(),
    grantedScopes: [...SlackWorkspaceCapabilities],
  });
}
