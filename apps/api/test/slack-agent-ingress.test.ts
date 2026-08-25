import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, SlackWorkspaceBotScopes } from "@rally/connectors";
import type { Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { __slackAgentTesting, SlackAgentService } from "../src/services/slack-agent-service";
import { slackChannelIsExternallyShared, workstreamUnfurlBlocks } from "../src/services/slack-workstream-card";
import { preRetirementProductSqliteDatabase } from "./helpers/sqlite-d1";
import { createCloudflareTestBinding, createTestD1Database, createTestEnv } from "./helpers/cloudflare-test";

// The logger only reads the observability bindings off the environment.
const logEnv = createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Job {
  id: string;
  bodyHash: string;
  status: string;
}

class IngressStatement {
  private values: unknown[] = [];
  constructor(private readonly database: IngressDatabase, private readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  first<T>() { return this.database.first(this.sql, this.values) as Promise<T | null>; }
  all<T>() { return this.database.all(this.sql) as Promise<D1Result<T>>; }
  run<T>() { return this.database.run(this.sql, this.values) as Promise<D1Result<T>>; }
}

class IngressDatabase {
  readonly jobs = new Map<string, Job>();
  readonly sessions = new Set<string>();
  readonly pendingPrompts = new Set<string>();
  readonly activityEventTypes = new Set<string>();
  readonly semanticActivityEventTypes: Array<string | null> = [];
  prepare(sql: string) { return new IngressStatement(this, sql); }

  async first(sql: string, values: unknown[]) {
    if (sql.includes("FROM slack_installation_routes") && sql.includes("team_id = ?")) {
      return {
        workspace_id: "22222222-2222-4222-8222-222222222222",
        connection_id: "11111111-1111-4111-8111-111111111111",
      };
    }
    if (sql.includes("FROM connector_connections") && sql.includes("provider_account_id = ?")) {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        provider_account_id: String(values.at(-1)),
        encrypted_credentials: "encrypted",
        credential_iv: "iv",
        status: "healthy",
      };
    }
    if (sql.includes("SELECT body_hash, status FROM slack_ingress_jobs")) {
      const job = this.jobs.get(String(values[0]));
      return job ? { body_hash: job.bodyHash, status: job.status } : null;
    }
    if (sql.includes("SELECT 1 AS routable")) {
      const sessionKey = `${String(values[0])}:${String(values[1])}:${String(values[2])}`;
      const pendingKey = `${String(values[3])}:${String(values[4])}:${String(values[5])}:${String(values[6])}`;
      return this.sessions.has(sessionKey) || this.pendingPrompts.has(pendingKey)
        ? { routable: 1 }
        : null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  async all(sql: string) {
    if (sql.includes("FROM automation_subscriptions")) {
      const triggers = [
        ...(this.activityEventTypes.size === 0 ? [] : [{
          type: "connector_activity",
          connectorType: "slack",
          sourceBindingKey: "slack_source",
          suggestedSourcePluginId: "plugin_slack",
          eventTypes: [...this.activityEventTypes],
          deterministicFilters: {},
        }]),
        ...this.semanticActivityEventTypes.map((eventType) => ({
          type: "semantic_activity",
          connectorType: "slack",
          sourceBindingKey: "slack_source",
          suggestedSourcePluginId: "plugin_slack",
          deterministicPrefilter: eventType ? { eventType } : {},
          condition: "The activity needs a response.",
        })),
      ];
      return {
        success: true,
        results: triggers.length === 0 ? [] : [{
          connector_bindings_json: JSON.stringify({ plugin_slack: "11111111-1111-4111-8111-111111111111" }),
          activity_trigger_bindings_json: JSON.stringify({ slack_source: "plugin_slack" }),
          trigger_definitions_json: JSON.stringify(triggers),
        }],
        meta: {} as D1Meta & Record<string, unknown>,
      };
    }
    throw new Error(`Unexpected all query: ${sql}`);
  }

  async run(sql: string, values: unknown[]) {
    if (sql.includes("INSERT INTO slack_ingress_jobs")) {
      const id = String(values[0]);
      if (this.jobs.has(id)) return result(0);
      this.jobs.set(id, { id, bodyHash: String(values[4]), status: "queued" });
      return result(1);
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

describe("Slack Agent durable ingress", () => {
  it("bounds and normalizes Slack Agent active-view context", () => {
    expect(__slackAgentTesting.slackAppContext({
      entities: [
        { type: "slack#/types/channel_id", value: "C123", team_id: "T1", ignored: true },
        { type: "", value: "invalid" },
      ],
    })).toEqual({
      entities: [{ type: "slack#/types/channel_id", value: "C123", teamId: "T1" }],
    });
  });

  it("recognizes the nested creator on channel-created events as an activity actor", () => {
    expect(__slackAgentTesting.slackEventActorUserIds({
      type: "channel_created",
      channel: { id: "C1", creator: "UBOT" },
    })).toEqual(["UBOT"]);
  });

  it("keeps the Slack manifest aligned with thread-follow-up scopes and events", () => {
    const manifest = JSON.parse(readFileSync(
      new URL("../../../config/provider-apps/slack.json", import.meta.url),
      "utf8",
    )) as {
      oauth_config: { scopes: { bot: string[] } };
      settings: { event_subscriptions: { bot_events: string[] } };
    };

    expect([...manifest.oauth_config.scopes.bot].sort()).toEqual([...SlackWorkspaceBotScopes].sort());
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(expect.arrayContaining([
      "file_shared",
      "member_joined_channel",
      "member_left_channel",
      "message.channels",
      "message.groups",
      "message.im",
      "reaction_added",
      "reaction_removed",
    ]));
  });

  it("classifies deterministic failures as terminal", () => {
    expect(__slackAgentTesting.slackIngressRetryable(
      new ConnectorError("provider_error", "missing_scope", { error: "missing_scope" }),
    )).toBe(false);
    expect(__slackAgentTesting.slackIngressRetryable(
      new ConnectorError("provider_error", "internal_error", { error: "internal_error" }),
    )).toBe(true);
    const expired = new ConnectorError("unauthorized", "token_expired", { error: "token_expired" });
    expect(__slackAgentTesting.slackReconnectRequired(expired)).toBe(false);
    expect(__slackAgentTesting.slackIngressRetryable(expired)).toBe(true);
    expect(__slackAgentTesting.slackReconnectRequired(
      new ConnectorError("unauthorized", "invalid_refresh_token", { error: "invalid_refresh_token" }),
    )).toBe(true);
    expect(__slackAgentTesting.slackIngressRetryable(new ApiError(422, "invalid", "invalid"))).toBe(false);
    expect(__slackAgentTesting.slackIngressRetryable(new ApiError(503, "unavailable", "unavailable"))).toBe(true);
  });

  it("recognizes explicit retries and recovers only authentic denied Rally prompts", () => {
    expect(__slackAgentTesting.isSlackRetryPrompt("try again")).toBe(true);
    expect(__slackAgentTesting.isSlackRetryPrompt("Please retry.")).toBe(true);
    expect(__slackAgentTesting.isSlackRetryPrompt("try a different analysis")).toBe(false);
    const baseMessages = [
      { user: "U1", text: "Earlier context", ts: "1.0" },
      { user: "U1", text: "<@UBOT> grab the documents above", ts: "1.1", thread_ts: "1.0" },
    ];
    const denialPrefixes = [
      "Rally needs updated Slack permissions before it can start workspace tasks here",
      "Rally couldn’t verify whether this Slack channel is public or private",
      "Avalon’s Slack workspace connection needs attention",
      "Avalon workspace tasks are not enabled for this Slack surface",
      "Avalon needs updated Slack permissions before it can start workspace tasks here",
      "Avalon couldn’t verify whether this Slack channel is public or private",
    ];
    for (const denialPrefix of denialPrefixes) {
      expect(__slackAgentTesting.recoverSlackDeniedPrompt([
        ...baseMessages,
        {
          user: "UBOT",
          text: `${denialPrefix}. Ask an admin.`,
          ts: "1.2",
          thread_ts: "1.0",
        },
      ], "U1", "UBOT")).toBe("grab the documents above");
    }
    const rallyMessages = [
      ...baseMessages,
      {
        user: "UBOT",
        text: "Rally needs updated Slack permissions before it can start workspace tasks here. Ask an admin.",
        ts: "1.2",
        thread_ts: "1.0",
      },
    ];
    expect(__slackAgentTesting.recoverSlackDeniedPrompt(rallyMessages, "U2", "UBOT")).toBeNull();
    expect(__slackAgentTesting.recoverSlackDeniedPrompt([
      rallyMessages[0]!,
      rallyMessages[1]!,
      { ...rallyMessages[2]!, user: "UATTACKER" },
    ], "U1", "UBOT")).toBeNull();
  });

  it("resolves modern private channels from conversations.info instead of ID prefixes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      channel: { id: "CPRIVATE", name: "founders-boiler-room", is_private: true, is_im: false, is_mpim: false },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    await expect(__slackAgentTesting.resolveSlackChannelType(
      logEnv,
      "xoxb-test",
      "CPRIVATE",
      "channel",
    )).resolves.toEqual({ channelType: "private", channelName: "founders-boiler-room", failure: null });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(__slackAgentTesting.slackChannelType("CPRIVATE")).toBe("unknown");
  });

  it("fails closed when Slack channel privacy or modal source metadata is unknown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: "missing_scope",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(__slackAgentTesting.resolveSlackChannelType(
      logEnv,
      "xoxb-test",
      "CUNKNOWN",
      "channel",
    )).resolves.toEqual({ channelType: "unknown", channelName: null, failure: "missing_scope" });
    expect(__slackAgentTesting.slackChannelResolutionDenial("missing_scope")).toMatchObject({
      reconnectRequired: true,
      text: expect.stringContaining("reconnect the Slack workspace"),
    });
    expect(__slackAgentTesting.slackChannelResolutionDenial("lookup_failed")).toMatchObject({
      reconnectRequired: false,
      text: expect.stringContaining("couldn’t verify whether this Slack channel is public or private"),
    });
    expect(__slackAgentTesting.modalPromptSource(undefined)).toBeNull();
    expect(__slackAgentTesting.modalPromptSource("not-json")).toBeNull();
  });

  it("bounds Slack attachment and nearby-message metadata", () => {
    const message = __slackAgentTesting.slackOriginNearbyMessage({
      ts: "1786129999.000100",
      user: "UALEX",
      text: "x".repeat(3_000),
      files: [{
        id: "FBRIEF",
        name: "monad-thesis-brief.md",
        title: "Monad thesis",
        mimetype: "text/markdown",
        filetype: "markdown",
        permalink: "https://example.slack.com/files/FBRIEF",
      }],
      attachments: [{
        title: "Landing page",
        title_link: "javascript:alert(1)",
      }],
    });

    expect(message).toMatchObject({
      timestamp: "1786129999.000100",
      userId: "UALEX",
      attachments: [
        { id: "FBRIEF", name: "monad-thesis-brief.md", mimeType: "text/markdown" },
        { id: null, name: "Landing page", permalink: null },
      ],
    });
    expect(message.text).toHaveLength(2_000);
  });

  it("extracts event-only Slack search authorization without adding it to source context", () => {
    expect(__slackAgentTesting.slackEventSearchAuthorization({
      action_token: "1786130000.abcdef.event-token",
      text: "find the latest project update",
    })).toEqual({ actionToken: "1786130000.abcdef.event-token" });
    expect(__slackAgentTesting.slackEventSearchAuthorization({ text: "no token" })).toBeUndefined();
    expect(__slackAgentTesting.slackEventSearchAuthorization({ action_token: "" })).toBeUndefined();
  });

  it("returns modal field errors synchronously", async () => {
    const service = new SlackAgentService(createTestEnv({ AVALON_REGION: "global" }));
    await expect(service.processInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "rally_start_task_submit",
        state: { values: { prompt: { value: { value: "" } } } },
      },
    }, "body-hash")).resolves.toEqual({
      response_action: "errors",
      errors: { prompt: "Describe what Rally should do." },
    });
  });

  it("resolves a modal minted before the rename, which Slack still echoes back", async () => {
    // A Slack action id is baked into a surface Slack retains: an App Home
    // view, a posted message's button, a modal already on screen. Those keep
    // the id they were minted with, so refusing the superseded spelling makes
    // every pre-deploy button fall past its branch into the generic task modal.
    const service = new SlackAgentService(createTestEnv({ AVALON_REGION: "global" }));
    await expect(service.processInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "avalon_start_task_submit",
        state: { values: { prompt: { value: { value: "" } } } },
      },
    }, "body-hash")).resolves.toEqual({
      response_action: "errors",
      errors: { prompt: "Describe what Rally should do." },
    });
  });

  it("rejects a start-task modal whose signed source metadata is missing", async () => {
    const service = new SlackAgentService(createTestEnv({ AVALON_REGION: "global" }));
    await expect(service.processInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "rally_start_task_submit",
        state: { values: { prompt: { value: { value: "Investigate this" } } } },
      },
    }, "body-hash")).resolves.toEqual({
      response_action: "errors",
      errors: { prompt: "This Slack task context expired. Close this window and start the task again." },
    });
  });

  it("queues a start-task modal for an unlinked Slack member", async () => {
    const database = new IngressDatabase();
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "rally_start_task_submit",
        private_metadata: JSON.stringify({
          kind: "shortcut",
          channelType: "public",
          channelId: "C1",
          threadTs: "1.1",
        }),
        state: { values: { prompt: { value: { value: "Investigate this" } } } },
      },
    }, "modal-body")).resolves.toEqual({ response_action: "clear" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: "interaction:modal-body" }));
  });

  it("queues a slash command without requiring a personal Slack link", async () => {
    const database = new IngressDatabase();
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processCommand({
      team_id: "T1",
      user_id: "U1",
      command: "/rally",
      text: "Summarize the incident",
      channel_id: "C1",
      channel_name: "general",
      trigger_id: "trigger-1",
    }, "command-body")).resolves.toEqual({
      response_type: "ephemeral",
      text: "Rally queued your request. I’ll continue in your Agent conversation.",
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: "command:command-body" }));
  });

  it("does not acknowledge an event until its regional queue publish succeeds", async () => {
    const database = new IngressDatabase();
    let releaseQueue!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { releaseQueue = resolve; }));
    const service = new SlackAgentService(environment(database, send));
    let settled = false;
    const operation = service.processEvent(eventPayload(), "body-hash").then((value) => {
      settled = true;
      return value;
    });

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledWith({
      kind: "slack_ingress",
      region: "global",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      jobId: "event:Ev1",
    });
    releaseQueue();
    await expect(operation).resolves.toEqual({ ok: true });
  });

  it("deduplicates completed events without publishing another queue message", async () => {
    const database = new IngressDatabase();
    database.jobs.set("event:Ev1", { id: "event:Ev1", bodyHash: "body-hash", status: "completed" });
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processEvent(eventPayload(), "body-hash"))
      .resolves.toEqual({ ok: true, duplicate: true });
    expect(send).not.toHaveBeenCalled();
  });

  it("queues only Rally-owned or pending public-channel thread replies", async () => {
    const database = new IngressDatabase();
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processEvent(channelMessagePayload("EvIgnored", "unrelated", "1.0"), "ignored-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();
    expect(database.jobs.size).toBe(0);

    database.sessions.add("11111111-1111-4111-8111-111111111111:C1:1.0");
    await expect(service.processEvent(channelMessagePayload("EvSession", "continue", "1.0"), "session-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "event:EvSession" }));

    await expect(service.processEvent(
      channelMessagePayload("EvBroadcast", "continue publicly", "1.0", "thread_broadcast"),
      "broadcast-hash",
    )).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "event:EvBroadcast" }));

    await expect(service.processEvent(channelMessagePayload("EvMentionCopy", "<@UBOT> continue", "1.0"), "mention-copy-hash"))
      .resolves.toEqual({ ok: true });
    expect(database.jobs.has("event:EvMentionCopy")).toBe(false);

    await expect(service.processEvent(channelMessagePayload("EvUnrecognizedRetry", "try again", "2.0"), "retry-hash"))
      .resolves.toEqual({ ok: true });
    expect(database.jobs.has("event:EvUnrecognizedRetry")).toBe(false);

    database.pendingPrompts.add("11111111-1111-4111-8111-111111111111:C1:2.0:U1");
    await expect(service.processEvent(channelMessagePayload("EvRetry", "try again", "2.0"), "pending-retry-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "event:EvRetry" }));
    expect(database.jobs.size).toBe(3);
  });

  it("queues an otherwise unrelated channel message when an exact Slack activity trigger is listening", async () => {
    const database = new IngressDatabase();
    database.activityEventTypes.add("slack.message.posted");
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processEvent(channelMessagePayload("EvAutomation", "customer escalation"), "activity-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: "event:EvAutomation" }));
    expect(database.jobs.has("event:EvAutomation")).toBe(true);
  });

  it("admits reaction activity only while an exact Slack automation source is active", async () => {
    const database = new IngressDatabase();
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));
    const payload = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "EvReaction",
      authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "white_check_mark",
        item_user: "U2",
        item: { type: "message", channel: "C1", ts: "1.0", channel_type: "channel" },
        event_ts: "1.1",
      },
    };

    await expect(service.processEvent(payload, "ignored-hash")).resolves.toEqual({ ok: true });
    expect(database.jobs.size).toBe(0);
    expect(send).not.toHaveBeenCalled();

    database.activityEventTypes.add("slack.reaction.added");
    await expect(service.processEvent(payload, "activity-hash")).resolves.toEqual({ ok: true });
    expect(database.jobs.has("event:EvReaction")).toBe(true);
    expect(send).toHaveBeenCalledOnce();
  });

  it("requires semantic Slack triggers to name the exact event admitted at ingress", async () => {
    const database = new IngressDatabase();
    database.semanticActivityEventTypes.push(null);
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));
    const payload = {
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: "EvSemanticReaction",
      authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
      event: {
        type: "reaction_added",
        user: "U1",
        reaction: "eyes",
        item_user: "U2",
        item: { type: "message", channel: "C1", ts: "1.0", channel_type: "channel" },
        event_ts: "1.1",
      },
    };

    await expect(service.processEvent(payload, "missing-prefilter-hash")).resolves.toEqual({ ok: true });
    expect(send).not.toHaveBeenCalled();

    database.semanticActivityEventTypes.splice(0, 1, "slack.reaction.added");
    await expect(service.processEvent(payload, "exact-prefilter-hash")).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: "event:EvSemanticReaction" }));
  });
});

function eventPayload() {
  return {
    type: "event_callback",
    api_app_id: "A1",
    team_id: "T1",
    event_id: "Ev1",
    event: { type: "message", user: "U1", channel: "D1", ts: "1.1", text: "hello" },
  };
}

function channelMessagePayload(
  eventId: string,
  text: string,
  threadTs?: string,
  subtype?: string,
) {
  return {
    type: "event_callback",
    api_app_id: "A1",
    team_id: "T1",
    event_id: eventId,
    authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
    event: {
      type: "message",
      user: "U1",
      channel: "C1",
      channel_type: "channel",
      ts: `${eventId.length}.1`,
      text,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(subtype ? { subtype } : {}),
    },
  };
}

function environment(database: IngressDatabase, send: (body: unknown) => Promise<void>): Env {
  return createTestEnv({
    DB: createTestD1Database(database),
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({ send }),
    AVALON_REGION: "global",
    SLACK_APP_ID: "A1",
  });
}

function result<T = unknown>(changes: number): D1Result<T> {
  return { success: true, results: [], meta: { changes } as D1Meta & Record<string, unknown> };
}

describe("work-stream link unfurl card", () => {
  const url = "https://with-avalon.com/app/workstreams/019fec70-fba0-7b0e-9f7a-3dd1ef56520f";

  function cardText(blocks: Record<string, unknown>[]): string {
    const section = blocks[0] as { text?: { text?: string } };
    return String(section.text?.text ?? "");
  }

  it("shows title, status, last activity, and automation origin", () => {
    const blocks = workstreamUnfurlBlocks({
      title: "Daily product brief",
      harnessStatus: "needs_input",
      lastActivityAt: "2026-08-10T12:00:00.000Z",
      automationName: "Daily monitor",
    }, url);

    const text = cardText(blocks);
    // The emoji leads the title so the state reads before the text does; the
    // word follows in the detail line so the emoji is never the only carrier.
    expect(text).toContain(`:warning: *<${url}|Daily product brief>*`);
    expect(text.split("\n")[1]).toMatch(/^Needs input · /u);
    expect(text).toContain("via Daily monitor");
    // Rendered in each reader's own timezone, and it cannot rot into a lie the
    // way a baked "24m ago" would on a card that is never re-rendered.
    expect(text).toContain(`<!date^${Math.floor(Date.parse("2026-08-10T12:00:00.000Z") / 1000)}^`);
    expect(text).not.toContain("ago");
  });

  it("omits the origin for an ad-hoc work stream", () => {
    const text = cardText(workstreamUnfurlBlocks({
      title: "Pricing restructure",
      harnessStatus: "running",
      lastActivityAt: "2026-08-10T12:00:00.000Z",
      automationName: null,
    }, url));

    expect(text).toContain(":large_green_circle: *<");
    expect(text.split("\n")[1]).toMatch(/^Running · /u);
    expect(text).not.toContain("via ");
  });

  it("badges a failed work stream, which is as actionable as one needing input", () => {
    const text = cardText(workstreamUnfurlBlocks({
      title: "Board decision",
      harnessStatus: "failed",
      lastActivityAt: "2026-08-10T12:00:00.000Z",
      automationName: null,
    }, url));

    expect(text).toContain(":red_circle: *<");
    expect(text.split("\n")[1]).toMatch(/^Failed · /u);
  });

  it("shows no status badge for a settled work stream", () => {
    // "Completed" is not something a reader can act on, and a card is only
    // rewritten when its badge changes — so a settled work stream would carry
    // that label indefinitely. Only the actionable states say anything.
    for (const harnessStatus of ["completed", "scheduled", "idle"]) {
      const text = cardText(workstreamUnfurlBlocks({
        title: "Daily product brief",
        harnessStatus,
        lastActivityAt: "2026-08-10T12:00:00.000Z",
        automationName: null,
      }, url));

      expect(text.startsWith("*<"), harnessStatus).toBe(true);
      expect(text, harnessStatus).not.toMatch(/Completed|Scheduled|Idle/u);
      expect(text.split("\n")[1], harnessStatus).toMatch(/^Updated /u);
    }
  });

  it("escapes a title that would otherwise inject mrkdwn", () => {
    const text = cardText(workstreamUnfurlBlocks({
      title: "<https://evil.example|Click me> & co",
      harnessStatus: "completed",
      lastActivityAt: null,
      automationName: null,
    }, url));

    expect(text).toContain("&lt;https://evil.example|Click me&gt; &amp; co");
    expect(text).not.toContain("<https://evil.example");
  });

  it("survives a work stream with no title, unknown status, and no activity stamp", () => {
    const text = cardText(workstreamUnfurlBlocks({
      title: "   ",
      harnessStatus: "some_future_status",
      lastActivityAt: "not-a-date",
      automationName: null,
    }, url));

    expect(text).toBe(`*<${url}|Untitled work stream>*`);
  });

  it("falls back to an anonymous card when no summary is available", () => {
    const blocks = workstreamUnfurlBlocks(null, url);
    const text = cardText(blocks);

    expect(text).toContain("*Rally*");
    expect(text).not.toContain("Needs input");
    expect(JSON.stringify(blocks)).toContain(url);
  });

  it("always offers the same open action, summary or not", () => {
    for (const blocks of [
      workstreamUnfurlBlocks(null, url),
      workstreamUnfurlBlocks({
        title: "Daily product brief",
        harnessStatus: "failed",
        lastActivityAt: null,
        automationName: null,
      }, url),
    ]) {
      expect(blocks.at(-1)).toEqual({
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "Open in Rally" },
          url,
          action_id: "rally_open_unfurl",
        }],
      });
    }
  });
});

describe("App Home task rows", () => {
  it("skips a row it cannot link instead of failing the whole App Home", () => {
    const webBase = "https://with-avalon.com";
    const good = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";

    // Minting a link throws on a non-UUID by design. In a list that must stay
    // a per-row cost: the throw would otherwise escape views.publish and take
    // account linking down with it.
    const blocks = __slackAgentTesting.linkedHome(
      logEnv,
      "Ada",
      [
        { id: "workstream-ownerless", title: "Unlinkable", harness_status: "running" },
        { id: good, title: "Quarterly planning", harness_status: "needs_input" },
      ],
      [],
      webBase,
      null,
      null,
    );

    const rendered = JSON.stringify(blocks);
    expect(rendered).toContain(`${webBase}/app/workstreams/${good}`);
    expect(rendered).toContain("Quarterly planning");
    expect(rendered).not.toContain("Unlinkable");
  });

  it("leaves drafts out of the automations it lists", () => {
    const database = preRetirementProductSqliteDatabase();
    const workspaceId = "00000000-0000-7000-8000-000000000001";
    const userId = "00000000-0000-7000-8000-000000000002";
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('${userId}', 'home-subject', 'ada@example.com', 'Ada', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Avalon Studio', 'avalon-studio', 'global', '${userId}', '2026-01-01', '2026-01-01');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state, latest_version_number, created_at, updated_at)
      VALUES
        ('00000000-0000-7000-8000-00000000000a', '${workspaceId}', '${userId}', 'Daily brief', 'Brief', 'private', 1, '2026-01-01', '2026-01-01'),
        ('00000000-0000-7000-8000-00000000000b', '${workspaceId}', '${userId}', 'Half-written monitor', 'Monitor', 'private', 1, '2026-01-01', '2026-01-01');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
      VALUES
        ('00000000-0000-7000-8000-00000000000c', '00000000-0000-7000-8000-00000000000a', 1, 'Write the brief', '[]', '${userId}', '2026-01-01'),
        ('00000000-0000-7000-8000-00000000000d', '00000000-0000-7000-8000-00000000000b', 1, 'Watch the page', '[]', '${userId}', '2026-01-01');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, status, created_at, updated_at)
      VALUES
        ('00000000-0000-7000-8000-00000000000e', '${workspaceId}', '00000000-0000-7000-8000-00000000000a', '00000000-0000-7000-8000-00000000000c',
         'personal', '${userId}', '{"type":"user","userId":"${userId}"}', 'active', '2026-01-01', '2026-01-01'),
        -- Written moments ago, which is exactly why it would otherwise win the
        -- newest-first ordering and take the whole list.
        ('00000000-0000-7000-8000-00000000000f', '${workspaceId}', '00000000-0000-7000-8000-00000000000b', '00000000-0000-7000-8000-00000000000d',
         'personal', '${userId}', '{"type":"user","userId":"${userId}"}', 'draft', '2026-08-11', '2026-08-11');
    `);

    const rows = database.prepare(__slackAgentTesting.PERSONAL_AUTOMATIONS_FOR_HOME_SQL)
      .all(workspaceId, userId) as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual(["Daily brief"]);
    database.close();
  });
});

describe("recording shared work-stream links for refresh", () => {
  const workstreamId = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";
  const summary = {
    title: "Quarterly planning",
    harnessStatus: "running",
    lastActivityAt: "2026-08-10T12:00:00.000Z",
    automationName: null,
  };

  it("records a link with the exact URL Slack reported", () => {
    const url = `https://with-avalon.com/app/workstreams/${workstreamId}`;

    expect(__slackAgentTesting.recordableUnfurlLinks(
      logEnv,
      new Map([[url, workstreamId]]),
      new Map([[workstreamId, summary]]),
    )).toEqual([{ url, workstreamId, summary }]);
  });

  it("skips an over-long link rather than storing a key that can never match", () => {
    // Reachable through the legacy handoff form, which tolerates extra
    // fragment parameters. Truncating to fit the column would store a URL that
    // no longer matches the message's link, so every later refresh would look
    // successful while the posted card stayed stale.
    const overLong = `https://with-avalon.com/open#target=${encodeURIComponent(
      `avalon://workstreams/${workstreamId}`,
    )}&x=${"a".repeat(2_100)}`;
    expect(overLong.length).toBeGreaterThan(2_000);

    expect(__slackAgentTesting.recordableUnfurlLinks(
      logEnv,
      new Map([[overLong, workstreamId]]),
      new Map([[workstreamId, summary]]),
    )).toEqual([]);
  });

  it("records nothing for a link whose card showed no summary", () => {
    const url = `https://with-avalon.com/app/workstreams/${workstreamId}`;

    expect(__slackAgentTesting.recordableUnfurlLinks(
      logEnv,
      new Map([[url, workstreamId]]),
      new Map(),
    )).toEqual([]);
  });
});

describe("unfurl audience check", () => {
  function conversationsInfo(channel: Record<string, unknown>): typeof fetch {
    return (async () => new Response(JSON.stringify({ ok: true, channel }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  }

  it("treats an ordinary 1:1 DM as internal", async () => {
    // Slack omits `is_private` from an `im` response. When the schema required
    // it the parse threw, the catch swallowed it, and every link shared in a DM
    // rendered the anonymous card with no refresh row to ever recover from.
    vi.stubGlobal("fetch", conversationsInfo({ id: "D123", is_im: true, user: "U1", is_open: true }));

    await expect(slackChannelIsExternallyShared(logEnv, "tok", "D123")).resolves.toBe(false);
  });

  it("still catches a Slack Connect DM, which also has a D channel id", async () => {
    vi.stubGlobal("fetch", conversationsInfo({ id: "D999", is_im: true, user: "U2", is_ext_shared: true }));

    await expect(slackChannelIsExternallyShared(logEnv, "tok", "D999")).resolves.toBe(true);
  });

  it("reports an unconfirmed audience as null rather than as external", async () => {
    // The two callers need to tell these apart: posting a new card fails
    // closed, but rewriting one must not redact it over a transient blip.
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ ok: false, error: "ratelimited" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch);

    await expect(slackChannelIsExternallyShared(logEnv, "tok", "CGENERAL")).resolves.toBeNull();
  });
});
