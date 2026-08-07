import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorError } from "@avalon/connectors";
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
  it("bounds untrusted Slack context and classifies deterministic failures as terminal", () => {
    const augmented = __slackAgentTesting.appendSlackContext(
      "Summarize this channel",
      "assistant.search.context",
      { messages: [{ content: "x".repeat(100_000) }] },
    );
    expect(augmented.length).toBeLessThanOrEqual(50_000);
    expect(augmented).toContain("[context truncated]");
    expect(__slackAgentTesting.slackContextChannelId({
      entities: [{
        type: "slack#/types/message_context",
        value: { message_ts: "1.2", channel_id: "CACTIVE" },
      }],
    })).toBe("CACTIVE");
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

  it("resolves modern private channels from conversations.info instead of ID prefixes", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      channel: { id: "CPRIVATE", is_private: true, is_im: false, is_mpim: false },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);

    await expect(__slackAgentTesting.resolveSlackChannelType(
      "xoxb-test",
      "CPRIVATE",
      "channel",
    )).resolves.toEqual({ channelType: "private", failure: null });
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
    )).resolves.toEqual({ channelType: "unknown", failure: "missing_scope" });
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
