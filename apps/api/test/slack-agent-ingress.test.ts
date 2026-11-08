import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ConnectorError } from "@rally/connectors";
import type { Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { __slackAgentTesting, SlackAgentService } from "../src/services/slack-agent-service";
import { linkUnfurlBlocks, slackChannelIsExternallyShared, slackUnfurlLinkTargets } from "../src/services/slack-workstream-card";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  createTestWorkspaceDO,
  SLACK_WORKSPACE_OBJECT_METHODS,
  workspaceObjectRpcs,
} from "./helpers/workspace-object-rpcs";

// The logger only reads the observability bindings off the environment.
const logEnv = createTestEnv({ AVALON_REGION: "global", LOG_LEVEL: "error" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

const INGRESS_WORKSPACE = "22222222-2222-4222-8222-222222222222";
const INGRESS_CONNECTION = "11111111-1111-4111-8111-111111111111";

/**
 * The durable ingress over a real WorkspaceDO: the enqueue, its dedupe, and
 * the thread-routability read are typed methods now, so the SQL under these
 * tests is the object's own rather than a re-implementation keyed on SQL
 * substrings. Only the activity-registration answer stays a hand stub — that
 * surface is the connector-event domain's, not this one's.
 */
class IngressDatabase {
  readonly regional = migratedSqliteDatabase();
  readonly objectDatabase: DatabaseSync;
  readonly instance: ReturnType<typeof createTestWorkspaceDO>["instance"];
  readonly activityEventTypes = new Set<string>();
  readonly semanticActivityEventTypes: Array<string | null> = [];

  constructor() {
    databases.push(this.regional);
    this.regional.prepare(
      `INSERT INTO slack_installation_routes
         (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
       VALUES ('T1', 'global', ?, ?, 'active', '2026-01-01', '2026-01-01')`,
    ).run(INGRESS_WORKSPACE, INGRESS_CONNECTION);
    const created = createTestWorkspaceDO({
      workspaceId: INGRESS_WORKSPACE,
      regionalDatabase: this.regional,
      register: (database) => { databases.push(database); },
    });
    this.instance = created.instance;
    this.objectDatabase = created.objectDatabase;
    // The enqueue path reads the connection row but never decrypts it, so the
    // credential fields carry the same placeholders the old double answered.
    this.objectDatabase.prepare(
      `INSERT INTO connector_connections
         (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
          display_name, encrypted_credentials, credential_iv, credential_key_version,
          granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
          model_plugin_id)
       VALUES (?, ?, 'slack', 'workspace', NULL, 'T1', 'Slack', 'encrypted', 'iv', 1,
               '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
               'plugin_slack_workspace')`,
    ).run(INGRESS_CONNECTION, INGRESS_WORKSPACE);
  }

  jobCount(): number {
    return Number((this.objectDatabase.prepare(
      "SELECT COUNT(*) AS count FROM slack_ingress_jobs",
    ).get() as { count: number }).count);
  }

  hasJob(id: string): boolean {
    return this.objectDatabase.prepare(
      "SELECT 1 AS present FROM slack_ingress_jobs WHERE id = ?",
    ).get(id) !== undefined;
  }

  seedCompletedJob(id: string, bodyHash: string): void {
    this.objectDatabase.prepare(
      `INSERT INTO slack_ingress_jobs
         (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
          status, attempt_count, received_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'T1', ?, 'event', NULL, 'completed', 1,
               '2026-01-01', '2026-01-01', '2026-01-01')`,
    ).run(id, INGRESS_WORKSPACE, INGRESS_CONNECTION, bodyHash);
  }

  /** A thread bound to a Sidekick run, as the run's own send binds it. */
  seedBoundThread(channelId: string, threadTs: string): void {
    this.objectDatabase.prepare(
      `INSERT INTO external_conversation_bindings
         (installation_id, path_json, target_kind, space_id, parent_kind, parent_id, substream_id,
          state, suspended_reason, claim_key, created_at, updated_at)
       VALUES ('slack:T1', json_array(?, ?), 'conversation', NULL, 'automation',
               '00000000-0000-7000-8000-0000000c1e40', '00000000-0000-7000-8000-0000000c1e41',
               'active', NULL, NULL, '2026-01-01', '2026-01-01')`,
    ).run(channelId, threadTs);
  }

  seedPendingPrompt(channelId: string, threadTs: string, slackUserId: string): void {
    this.objectDatabase.prepare(
      `INSERT INTO slack_agent_pending_prompts
         (connection_id, slack_channel_id, slack_thread_ts, slack_user_id, prompt,
          denial_reason, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'retry me', 'policy', '2099-01-01T00:00:00.000Z',
               '2026-01-01', '2026-01-01')`,
    ).run(INGRESS_CONNECTION, channelId, threadTs, slackUserId);
  }
}

const databases: DatabaseSync[] = [];

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
    )).resolves.toEqual({
      channelType: "private", channelName: "founders-boiler-room", failure: null, threadable: true, externallyShared: false,
    });
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
    database.seedCompletedJob("event:Ev1", "body-hash");
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
    expect(database.jobCount()).toBe(0);

    database.seedBoundThread("C1", "1.0");
    await expect(service.processEvent(channelMessagePayload("EvBound", "continue", "1.0"), "bound-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "event:EvBound" }));

    await expect(service.processEvent(
      channelMessagePayload("EvBroadcast", "continue publicly", "1.0", "thread_broadcast"),
      "broadcast-hash",
    )).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "event:EvBroadcast" }));

    await expect(service.processEvent(channelMessagePayload("EvMentionCopy", "<@UBOT> continue", "1.0"), "mention-copy-hash"))
      .resolves.toEqual({ ok: true });
    expect(database.hasJob("event:EvMentionCopy")).toBe(false);

    await expect(service.processEvent(channelMessagePayload("EvUnrecognizedRetry", "try again", "2.0"), "retry-hash"))
      .resolves.toEqual({ ok: true });
    expect(database.hasJob("event:EvUnrecognizedRetry")).toBe(false);

    database.seedPendingPrompt("C1", "2.0", "U1");
    await expect(service.processEvent(channelMessagePayload("EvRetry", "try again", "2.0"), "pending-retry-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ jobId: "event:EvRetry" }));
    expect(database.jobCount()).toBe(3);
  });

  it("queues the bot's own room lifecycle whatever automations listen, and nobody else's membership", async () => {
    // An invitation, a removal, an archive and a renumbered room each move a
    // binding, so they reach the queue even with no automation subscribed and
    // even though the bot is their actor. Another member joining moves none.
    const database = new IngressDatabase();
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));
    const lifecycle = (eventId: string, event: Record<string, unknown>) => ({
      type: "event_callback",
      api_app_id: "A1",
      team_id: "T1",
      event_id: eventId,
      authorizations: [{ team_id: "T1", user_id: "UBOT", is_bot: true }],
      event,
    });

    await service.processEvent(lifecycle("EvInvited", {
      type: "member_joined_channel", user: "UBOT", channel: "C1", channel_type: "C", inviter: "U1",
    }), "invited-hash");
    await service.processEvent(lifecycle("EvRemoved", {
      type: "member_left_channel", user: "UBOT", channel: "C1", channel_type: "C",
    }), "removed-hash");
    await service.processEvent(lifecycle("EvArchived", { type: "channel_archive", channel: "C1", user: "U1" }), "archived-hash");
    await service.processEvent(lifecycle("EvMoved", {
      type: "channel_id_changed", old_channel_id: "C1", new_channel_id: "C2",
    }), "moved-hash");
    await service.processEvent(lifecycle("EvOtherJoined", {
      type: "member_joined_channel", user: "U2", channel: "C1", channel_type: "C",
    }), "other-hash");

    for (const jobId of ["event:EvInvited", "event:EvRemoved", "event:EvArchived", "event:EvMoved"]) {
      expect(database.hasJob(jobId)).toBe(true);
    }
    expect(database.hasJob("event:EvOtherJoined")).toBe(false);
  });

  it("queues an otherwise unrelated channel message when an exact Slack activity trigger is listening", async () => {
    const database = new IngressDatabase();
    database.activityEventTypes.add("slack.message.posted");
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(environment(database, send));

    await expect(service.processEvent(channelMessagePayload("EvAutomation", "customer escalation"), "activity-hash"))
      .resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobId: "event:EvAutomation" }));
    expect(database.hasJob("event:EvAutomation")).toBe(true);
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
    expect(database.jobCount()).toBe(0);
    expect(send).not.toHaveBeenCalled();

    database.activityEventTypes.add("slack.reaction.added");
    await expect(service.processEvent(payload, "activity-hash")).resolves.toEqual({ ok: true });
    expect(database.hasJob("event:EvReaction")).toBe(true);
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
  const workspaceStub = {
    // The real object's typed Slack methods and its runtime SQL port, so
    // every WorkspaceDO-authority statement lands in the object's own store.
    ...workspaceObjectRpcs(database.instance, SLACK_WORKSPACE_OBJECT_METHODS),
    // The one hand stub left: activity registrations belong to the
    // connector-event domain, and these tests toggle them as a fact.
    hasActiveExternalEventRegistration: async (input: { eventType: string }) => ({
      active: database.activityEventTypes.has(input.eventType)
        || database.semanticActivityEventTypes.includes(input.eventType),
    }),
  };
  const workspaceNamespace = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => workspaceStub,
  });
  return createTestEnv({
    DB: sqliteD1(database.regional),
    INTERACTIVE_QUEUE: createCloudflareTestBinding<Queue>({ send }),
    WORKSPACE_DOS: workspaceNamespace,
    AVALON_REGION: "global",
    SLACK_APP_ID: "A1",
  });
}

describe("Rally link unfurl card", () => {
  const url = "https://with-avalon.com/app/global/1111117Hxt1fAWDjN7TW/canvas/1111117Hxt1fAWDjN7TX";
  const cardText = (blocks: Record<string, unknown>[]) => String((blocks[0] as { text: { text: string } }).text.text);

  it("links the title and escapes what would otherwise inject mrkdwn", () => {
    expect(cardText(linkUnfurlBlocks("Launch <plan> & notes", url))).toBe(`*<${url}|Launch &lt;plan&gt; &amp; notes>*`);
  });

  it("falls back to an anonymous card when there is no title", () => {
    const blocks = linkUnfurlBlocks(null, url);
    expect(cardText(blocks)).toContain("*Rally*");
    expect(JSON.stringify(blocks)).toContain(url);
  });

  it("always offers the same open action, titled or not", () => {
    for (const blocks of [linkUnfurlBlocks(null, url), linkUnfurlBlocks("Daily product brief", url)]) {
      expect(blocks.at(-1)).toEqual({
        type: "actions",
        elements: [{ type: "button", text: { type: "plain_text", text: "Open in Rally" }, url, action_id: "rally_open_unfurl" }],
      });
    }
  });
});

describe("App Home", () => {
  const webBase = "https://rallywith.ai";
  const workspaceId = "00000000-0000-7000-8000-000000000001";
  const common = {
    description: "Brief",
    emailAddress: null,
    scope: "personal",
    status: "active",
    nextRunAt: null,
    lastRunAt: null,
    updatedAt: "2026-11-08T00:00:00.000Z",
  };
  const sidekicks = (items: Record<string, unknown>[]) => __slackAgentTesting.sidekicksForHome(items);
  const home = (items: Record<string, unknown>[]) => __slackAgentTesting.linkedHome(
    "Ada", sidekicks(items), webBase, "global", workspaceId, null, null,
  );
  const texts = (blocks: Record<string, unknown>[]) => blocks.flatMap((block) => {
    const text = (block.text as { text?: string } | undefined)?.text;
    const elements = Array.isArray(block.elements) ? block.elements as { text?: string | { text?: string } }[] : [];
    return [
      ...(text ? [text] : []),
      ...elements.map((element) => typeof element.text === "string" ? element.text : element.text?.text ?? ""),
    ];
  });
  const headers = (blocks: Record<string, unknown>[]) => blocks
    .filter((block) => block.type === "header")
    .map((block) => (block.text as { text: string }).text);
  // What a member reads, and every action id a view carries.
  const retiredLabels = /Start a task|Needs attention & recent tasks|automation|Try now|Summarize this thread/iu;
  const actionIds = (blocks: Record<string, unknown>[]) => [...JSON.stringify(blocks).matchAll(/"action_id":"([^"]+)"/gu)].map((match) => match[1]);

  it("names what Rally does from Slack, the Sidekicks, and nothing it no longer offers", () => {
    const blocks = home([{
      ...common, id: "00000000-0000-7000-8000-00000000000e", name: "Daily <brief>", lastRunAt: "2026-11-07T09:00:00.000Z",
    }]);

    expect(headers(blocks)).toEqual(["Welcome, Ada", "Sidekicks"]);
    expect(texts(blocks)).toContain("A Sidekick can work from Slack for you: it can start from Slack activity and send what it finds back here. Mentioning Rally or sending it a DM does not start work; start a Canvas or set up a Sidekick in Rally.");
    expect(texts(blocks)).toContain(
      "*<https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7Tj/|Daily &lt;brief&gt;>*\nActive · <!date^1794042000^Last run {date_short_pretty} at {time}|Last run 2026-11-07 09:00 UTC>",
    );
    const actions = blocks.find((block) => block.type === "actions") as { elements: { text: { text: string }; action_id: string }[] };
    expect(actions.elements.map((element) => [element.text.text, element.action_id])).toEqual([
      ["Create Sidekick", "rally_create_automation"],
      ["Notifications", "rally_preferences"],
    ]);
    expect(texts(blocks).join("\n")).toContain("<https://rallywith.ai/privacy|Privacy> · <https://rallywith.ai/help/|Help>");
    expect(texts(blocks).join("\n")).not.toMatch(retiredLabels);
    expect(actionIds(blocks)).toEqual(["rally_create_automation", "rally_preferences", "rally_open_personal_tools"]);
  });

  it("lists a waiting Sidekick's question under Needs input, and a delegation wait without one", () => {
    const blocks = home([
      { ...common, id: "00000000-0000-7000-8000-00000000000e", name: "Daily brief", runState: "needs_input", needsInput: true, pendingQuestion: "Which inbox should I read?" },
      { ...common, id: "00000000-0000-7000-8000-00000000000f", name: "Revenue analyst", status: "paused", needsInput: true, pendingQuestion: null },
      { ...common, id: "00000000-0000-7000-8000-000000000010", name: "Team digest", scope: "workspace", runState: "working" },
    ]);

    expect(headers(blocks)).toEqual(["Welcome, Ada", "Needs input", "Sidekicks"]);
    const body = texts(blocks);
    expect(body).toContain("*<https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7Tj/|Daily brief>*\nWhich inbox should I read?");
    expect(body).toContain("*<https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7Tk/|Revenue analyst>*\nOpen it in Rally to see what it needs.");
    expect(body).toContain("*<https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7Tk/|Revenue analyst>*\n:warning: Needs input · Not run yet");
    expect(body).toContain("*<https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7Tm/|Team digest>*\n:large_green_circle: Working · Not run yet");
  });

  it("shows no Needs input section when nothing waits, and says so when there are no Sidekicks", () => {
    const blocks = home([]);
    expect(headers(blocks)).toEqual(["Welcome, Ada", "Sidekicks"]);
    expect(texts(blocks)).toContain("No Sidekicks yet. Create one in Rally to have it work from Slack for you.");
  });

  it("leaves drafts out and keeps the Organization's Sidekicks the sidebar lists", () => {
    expect(sidekicks([
      { ...common, id: "00000000-0000-7000-8000-00000000000e", name: "Daily brief" },
      { ...common, id: "00000000-0000-7000-8000-00000000000f", name: "Half-written monitor", status: "draft" },
      { ...common, id: "00000000-0000-7000-8000-000000000010", name: "Team brief", scope: "workspace" },
    ]).map((row) => row.name)).toEqual(["Daily brief", "Team brief"]);
  });

  it("offers the unlinked member what Rally does from Slack and no example prompts", () => {
    const blocks = __slackAgentTesting.unlinkedHome();
    expect(headers(blocks)).toEqual(["Meet Rally"]);
    expect(texts(blocks)).toContain("A Sidekick can work from Slack for you: it can start from Slack activity and send what it finds back here. Mentioning Rally or sending it a DM does not start work; start a Canvas or set up a Sidekick in Rally.");
    expect(texts(blocks).join("\n")).not.toMatch(retiredLabels);
    expect(actionIds(blocks)).toEqual(["rally_connect"]);
  });
});

describe("which shared links get a card", () => {
  const scope = { webBaseUrls: ["https://rallywith.ai", "https://with-avalon.com"], region: "global", workspaceId: "00000000-0000-7000-8000-000000000001" };
  const canvas = "https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/";
  const sidekick = "https://with-avalon.com/app/global/1111117Hxt1fAWDjN7TW/sk/1111117Hxt1fAWDjN7TY/";

  it("reads this Organization's Canvas and Sidekick links on either site domain, by the URL Slack reported", () => {
    expect(slackUnfurlLinkTargets([{ url: canvas }, { url: sidekick }], scope)).toEqual(new Map([
      [canvas, { kind: "canvas", region: "global", workspaceId: "00000000-0000-7000-8000-000000000001", canvasId: "00000000-0000-7000-8000-000000000002" }],
      [sidekick, { kind: "sidekick", region: "global", workspaceId: "00000000-0000-7000-8000-000000000001", sidekickId: "00000000-0000-7000-8000-000000000003" }],
    ]));
  });

  it("leaves another Organization's, a retired Thread's and a look-alike host's links to Slack", () => {
    expect(slackUnfurlLinkTargets([
      { url: "https://rallywith.ai/app/global/1111117Hxt1fAWDjN7Te/cv/1111117Hxt1fAWDjN7TX/" },
      { url: "https://rallywith.ai/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/1111117Hxt1fAWDjN7TY" },
      { url: "https://with-avalon.com/app/workstreams/019fec70-fba0-7b0e-9f7a-3dd1ef56520f" },
      { url: "https://evil.example/app/global/1111117Hxt1fAWDjN7TW/cv/1111117Hxt1fAWDjN7TX/" },
      { url: 42 },
    ], scope).size).toBe(0);
  });

  it("names the Canvas on its card, linked to the URL Slack reported, and nothing more", () => {
    expect(linkUnfurlBlocks("Q4 board deck", canvas)).toEqual([
      { type: "section", text: { type: "mrkdwn", text: `*<${canvas}|Q4 board deck>*` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Rally" }, url: canvas, action_id: "rally_open_unfurl" }] },
    ]);
    expect(JSON.stringify(linkUnfurlBlocks(null, canvas))).not.toContain("Q4 board deck");
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

describe("a Slack answer this binary does not model", () => {
  it("names the field in the reason that reaches the connection row and the ingress job", () => {
    // `invalid_slack_data` is persisted on the ingress job and written to the
    // connection's `error_json`, and it said only that something in Slack's
    // body was off. The path is schema shape; the body's values stay behind.
    const rejection = z.strictObject({ channel: z.strictObject({ is_private: z.boolean() }) })
      .safeParse({ channel: { is_private: "member content must remain absent" } });
    if (rejection.success) throw new Error("expected a rejection");

    const reason = __slackAgentTesting.slackErrorReason(rejection.error);
    expect(reason).toBe("invalid_slack_data:channel.is_private:invalid_type");
  });

  it("reads the field the adapter attached to a malformed response, which is how one actually arrives", () => {
    // `slackApiResponse` parses the body and throws `provider_error` with the
    // paths attached; a raw `ZodError` never reaches these helpers in
    // production. The word `provider_error` alone is what an outage says.
    const wrapped = new ConnectorError("provider_error", "Slack conversations.info returned a malformed response", {
      formErrors: [],
      fieldErrors: { channel: ["Invalid input"] },
      responseIssues: "channel.is_private:invalid_type",
    });
    expect(__slackAgentTesting.slackErrorReason(wrapped)).toBe("invalid_slack_data:channel.is_private:invalid_type");
    // A detail that is not code-shaped is not a path list, and is not carried.
    expect(__slackAgentTesting.slackErrorReason(new ConnectorError("provider_error", "x", { responseIssues: "member content: alice@example.com" })))
      .toBe("provider_error");
  });

  it("persists one ingress code per drift, not one per array slot", () => {
    // The exhausted-job notice dedups on exact `error_code` equality, and
    // Slack's origin shapes are bounded arrays of strict objects: without the
    // fold, one contract drift would page once per element index.
    const rejection = z.strictObject({ nearbyMessages: z.array(z.strictObject({ text: z.string().max(3) })) })
      .safeParse({ nearbyMessages: [{ text: "ok" }, { text: "ok" }, { text: "member content must remain absent" }] });
    if (rejection.success) throw new Error("expected a rejection");
    expect(__slackAgentTesting.slackIngressErrorCode(rejection.error)).toBe("invalid_slack_data:nearbyMessages.n.text:too_big");
    expect(__slackAgentTesting.slackIngressErrorCode(new Error("Error"))).toBe("slack_ingress_failed");
  });
});
