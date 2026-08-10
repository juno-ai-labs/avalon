import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError, SlackWorkspaceBotScopes } from "@avalon/connectors";
import type { Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { __slackAgentTesting, SlackAgentService } from "../src/services/slack-agent-service";

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
  run<T>() { return this.database.run(this.sql, this.values) as Promise<D1Result<T>>; }
}

class IngressDatabase {
  readonly jobs = new Map<string, Job>();
  readonly sessions = new Set<string>();
  readonly pendingPrompts = new Set<string>();
  prepare(sql: string) { return new IngressStatement(this, sql); }

  async first(sql: string, values: unknown[]) {
    if (sql.includes("FROM connector_connections") && sql.includes("provider_account_id = ?")) {
      return {
        id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "22222222-2222-4222-8222-222222222222",
        provider_account_id: String(values[0]),
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
      "message.channels",
      "message.groups",
      "message.im",
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

  it("recognizes explicit retries and recovers only authentic denied Avalon prompts", () => {
    expect(__slackAgentTesting.isSlackRetryPrompt("try again")).toBe(true);
    expect(__slackAgentTesting.isSlackRetryPrompt("Please retry.")).toBe(true);
    expect(__slackAgentTesting.isSlackRetryPrompt("try a different analysis")).toBe(false);
    const messages = [
      { user: "U1", text: "Earlier context", ts: "1.0" },
      { user: "U1", text: "<@UBOT> grab the documents above", ts: "1.1", thread_ts: "1.0" },
      {
        user: "UBOT",
        text: "Avalon workspace tasks are not enabled for this Slack surface. Ask an admin.",
        ts: "1.2",
        thread_ts: "1.0",
      },
    ];
    expect(__slackAgentTesting.recoverSlackDeniedPrompt(messages, "U1", "UBOT"))
      .toBe("grab the documents above");
    expect(__slackAgentTesting.recoverSlackDeniedPrompt(messages, "U2", "UBOT")).toBeNull();
    expect(__slackAgentTesting.recoverSlackDeniedPrompt([
      messages[0]!,
      messages[1]!,
      { ...messages[2]!, user: "UATTACKER" },
    ], "U1", "UBOT")).toBeNull();
  });

  it("resolves modern private channels from conversations.info instead of ID prefixes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      channel: { id: "CPRIVATE", name: "founders-boiler-room", is_private: true, is_im: false, is_mpim: false },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    await expect(__slackAgentTesting.resolveSlackChannelType(
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
    const service = new SlackAgentService({ AVALON_REGION: "global" } as Env);
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
      errors: { prompt: "Describe what Avalon should do." },
    });
  });

  it("rejects a start-task modal whose signed source metadata is missing", async () => {
    const service = new SlackAgentService({ AVALON_REGION: "global" } as Env);
    await expect(service.processInteraction({
      type: "view_submission",
      team: { id: "T1" },
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "avalon_start_task_submit",
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
        callback_id: "avalon_start_task_submit",
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
      command: "/avalon",
      text: "Summarize the incident",
      channel_id: "C1",
      channel_name: "general",
      trigger_id: "trigger-1",
    }, "command-body")).resolves.toEqual({
      response_type: "ephemeral",
      text: "Avalon queued your request. I’ll continue in your Agent conversation.",
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

  it("queues only Avalon-owned or pending public-channel thread replies", async () => {
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
  return {
    DB: database as unknown as D1Database,
    ACTIVITY_QUEUE: { send } as unknown as Queue,
    AVALON_REGION: "global",
    SLACK_APP_ID: "A1",
  } as Env;
}

function result<T = unknown>(changes: number): D1Result<T> {
  return { success: true, results: [], meta: { changes } as D1Meta & Record<string, unknown> };
}
