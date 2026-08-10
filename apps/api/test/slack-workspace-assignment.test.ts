import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { encryptString } from "../src/lib/crypto";
import { __slackAgentTesting, SlackAgentService } from "../src/services/slack-agent-service";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { WorkstreamService } from "../src/services/workstream-service";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("Slack workspace workstream assignment", () => {
  it("assigns ownerless Slack workstreams when a verified-email member joins", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const encrypted = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-test" }),
      credentialsKey,
      "connection-slack",
    );
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-slack', 'Slack Workspace', 'slack-workspace', 'global',
              'user-owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('workspace-slack', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('workspace-slack', 'user-taylor', 'member', 'active', '2026-02-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', 'workspace-slack', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-ownerless', 'workspace-slack', 'Investigate', 'Investigate',
              'ad_hoc', NULL, 'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-ownerless', 'workspace-slack', 'connection-slack', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:ownerless', 'workstream-ownerless',
              'app_mention', 'public', '{}', '2026-01-01', '2026-01-01');
    `);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toContain("users.lookupByEmail");
      return new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U456",
          team_id: "T123",
          deleted: false,
          is_bot: false,
          profile: { email: "taylor@example.com" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const env = {
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      CONNECTOR_CREDENTIALS_KEY: credentialsKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    } as unknown as Env;

    await expect(new SlackAgentService(env).assignWorkspaceWorkstreamsForMember(
      "workspace-slack",
      "user-taylor",
      "taylor@example.com",
    )).resolves.toBe(1);

    expect(database.prepare(
      `SELECT assigned_user_id, assignment_method, execution_scope, linked_user_id
       FROM slack_agent_sessions WHERE id = 'session-ownerless'`,
    ).get()).toEqual({
      assigned_user_id: "user-taylor",
      assignment_method: "verified_email",
      execution_scope: "workspace",
      linked_user_id: null,
    });
    expect(database.prepare(
      `SELECT user_id, participation_reason FROM workstream_participants
       WHERE workstream_id = 'workstream-ownerless'`,
    ).get()).toEqual({ user_id: "user-taylor", participation_reason: "explicit" });
    expect(database.prepare(
      "SELECT created_by_user_id FROM workstreams WHERE id = 'workstream-ownerless'",
    ).get()).toEqual({ created_by_user_id: "user-taylor" });
  });

  it("keeps an existing creator when a later Slack assignment resolves the same session", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    const encrypted = await encryptString(
      JSON.stringify({ botAccessToken: "xoxb-test" }),
      credentialsKey,
      "connection-slack",
    );
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-slack', 'Slack Workspace', 'slack-workspace', 'global',
              'user-owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('workspace-slack', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('workspace-slack', 'user-taylor', 'member', 'active', '2026-02-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', 'workspace-slack', 'slack', 'workspace', NULL, 'T123',
              'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
              '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-owned', 'workspace-slack', 'Investigate', 'Investigate',
              'ad_hoc', 'user-owner', 'completed', 2, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-owned', 'workspace-slack', 'connection-slack', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:owned', 'workstream-owned',
              'app_mention', 'public', '{}', '2026-01-01', '2026-01-01');
    `);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      user: {
        id: "U456",
        team_id: "T123",
        deleted: false,
        is_bot: false,
        profile: { email: "taylor@example.com" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    const env = {
      DB: sqliteD1(database),
      AVALON_REGION: "global",
      CONNECTOR_CREDENTIALS_KEY: credentialsKey,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
      PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
      SLACK_CLIENT_ID: "client",
      SLACK_CLIENT_SECRET: "secret",
      SLACK_SIGNING_SECRET: "signing",
    } as unknown as Env;

    await expect(new SlackAgentService(env).assignWorkspaceWorkstreamsForMember(
      "workspace-slack",
      "user-taylor",
      "taylor@example.com",
    )).resolves.toBe(1);

    expect(database.prepare(
      "SELECT created_by_user_id FROM workstreams WHERE id = 'workstream-owned'",
    ).get()).toEqual({ created_by_user_id: "user-owner" });
  });

  it("does not answer the next external elicitation when a Slack event is retried", async () => {
    const database = migratedDatabase();
    seedElicitationRetry(database, "system", null, JSON.stringify({
      provider: "slack",
      providerAccountId: "T123",
      providerUserId: "U456",
      displayName: "Taylor",
      avatarUrl: null,
    }));
    const env = { DB: sqliteD1(database), AVALON_REGION: "global" } as unknown as Env;

    await expect(new SlackWorkspaceWorkstreamService(env, "workspace-slack").answerOpenElicitation(
      "workstream-retry",
      {
        actor: {
          provider: "slack",
          providerAccountId: "T123",
          providerUserId: "U456",
          displayName: "Taylor",
          avatarUrl: null,
        },
        text: "stale answer",
        clientMessageId: "event:retry",
        slackOrigin: {
          teamId: "T123",
          channelId: "C123",
          channelName: "general",
          threadTs: "123.456",
          invocationType: "app_mention",
          channelType: "public",
          matchedAvalonUserId: null,
          nearbyMessagesStatus: "available",
          nearbyMessages: [],
          attachments: [],
        },
      },
    )).resolves.toEqual({ elicitation: null, harnessRunId: null });

    expect(database.prepare(
      "SELECT id, status, answer_json FROM elicitations ORDER BY created_at",
    ).all()).toEqual([
      { id: "elicitation-a", status: "open", answer_json: null },
      { id: "elicitation-b", status: "open", answer_json: null },
    ]);
  });

  it("does not answer another user elicitation when a client response is retried", async () => {
    const database = migratedDatabase();
    seedElicitationRetry(database, "human", "user-taylor", null);
    const env = { DB: sqliteD1(database), AVALON_REGION: "global" } as unknown as Env;
    const service = new WorkstreamService(env, {
      sessionId: "slack:T123:U456",
      userId: "user-taylor",
      workspaceId: "workspace-slack",
      region: "global",
      role: "member",
    });

    await expect(service.answerElicitation(
      "workstream-retry",
      "elicitation-b",
      { answer: "stale answer" },
      "event:retry",
    )).resolves.toEqual({ elicitation: undefined, harnessRunId: null });

    expect(database.prepare(
      "SELECT id, status, answer_json FROM elicitations ORDER BY created_at",
    ).all()).toEqual([
      { id: "elicitation-a", status: "open", answer_json: null },
      { id: "elicitation-b", status: "open", answer_json: null },
    ]);
  });

  it("changes authority only after an explicit eligible claim", async () => {
    const database = migratedDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-slack', 'Slack Workspace', 'slack-workspace', 'global',
              'user-owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('workspace-slack', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('workspace-slack', 'user-taylor', 'member', 'active', '2026-02-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
         model_plugin_id)
      VALUES ('connection-slack', 'workspace-slack', 'slack', 'workspace', NULL, 'T123',
              'Slack', 'encrypted', 'iv', 1, '["slack.agent"]', 'healthy', '{}', '{}',
              '2026-01-01', '2026-01-01', 'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-claim', 'workspace-slack', 'Investigate', 'Investigate',
              'ad_hoc', NULL, 'needs_input', 1, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-claim', 'workspace-slack', 'connection-slack', NULL, 'workspace',
              'T123', 'U456', 'C123', '1.0', 'event:opening', 'workstream-claim',
              'app_mention', 'public', '{}', '2026-01-01', '2026-01-01');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('run-claim', 'workspace-slack', 'workstream-claim', 'test', '{}',
              'needs_input', '2026-01-01');
      INSERT INTO elicitations
        (id, workspace_id, workstream_id, harness_run_id, prompt, response_type,
         options_json, minimum_selections, maximum_selections, target_user_id, status, created_at)
      VALUES ('elicitation-claim', 'workspace-slack', 'workstream-claim', 'run-claim',
              'Taylor must approve', 'text', '[]', 0, NULL, 'user-taylor', 'open', '2026-01-01');
    `);
    const env = { DB: sqliteD1(database), AVALON_REGION: "global" } as unknown as Env;
    const session = database.prepare(
      "SELECT * FROM slack_agent_sessions WHERE id = 'session-claim'",
    ).get();
    const identity = {
      auth: {
        sessionId: "slack:T123:U456",
        userId: "user-taylor",
        workspaceId: "workspace-slack",
        region: "global" as const,
        role: "member" as const,
      },
      connection: {
        id: "connection-slack",
        workspace_id: "workspace-slack",
        provider_account_id: "T123",
        encrypted_credentials: "encrypted",
        credential_iv: "iv",
        granted_scopes_json: '["slack.agent"]',
        status: "healthy",
      },
      slackUserId: "U456",
      teamId: "T123",
      token: "xoxb-test",
    };
    const wrongIdentity = {
      ...identity,
      auth: { ...identity.auth, userId: "user-owner", role: "owner" as const },
      slackUserId: "UOWNER",
    };

    await expect(__slackAgentTesting.claimWorkspaceSession(
      env,
      wrongIdentity,
      session as never,
    )).rejects.toMatchObject({ code: "slack_claim_target_mismatch" });
    expect(database.prepare(
      "SELECT execution_scope FROM slack_agent_sessions WHERE id = 'session-claim'",
    ).get()).toEqual({ execution_scope: "workspace" });

    await expect(__slackAgentTesting.claimWorkspaceSession(
      env,
      identity,
      session as never,
    )).resolves.toBe("claimed");
    await expect(__slackAgentTesting.claimWorkspaceSession(
      env,
      identity,
      session as never,
    )).resolves.toBe("already_claimed");

    expect(database.prepare(
      `SELECT execution_scope, linked_user_id, assigned_user_id, assignment_method,
              claimed_by_slack_user_id
       FROM slack_agent_sessions WHERE id = 'session-claim'`,
    ).get()).toEqual({
      execution_scope: "user",
      linked_user_id: "user-taylor",
      assigned_user_id: "user-taylor",
      assignment_method: "explicit_link",
      claimed_by_slack_user_id: "U456",
    });
    expect(database.prepare(
      "SELECT user_id, participation_reason FROM workstream_participants WHERE workstream_id = 'workstream-claim'",
    ).get()).toEqual({ user_id: "user-taylor", participation_reason: "explicit" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'slack.workspace_workstream.claimed'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT created_by_user_id FROM workstreams WHERE id = 'workstream-claim'",
    ).get()).toEqual({ created_by_user_id: "user-taylor" });
  });
});

describe("Slack public channel membership", () => {
  it("durably schedules a full public-channel sync after workspace authorization", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const send = vi.fn(async () => { throw new Error("queue unavailable"); });
    const env = slackMembershipEnvironment(database, credentialsKey, send);

    await new SlackAgentService(env).schedulePublicChannelSync("11111111-1111-4111-8111-111111111111");

    const job = database.prepare(
      "SELECT id, team_id, kind, payload_json, status FROM slack_ingress_jobs",
    ).get() as Record<string, unknown>;
    expect(job).toMatchObject({ team_id: "T123", kind: "event", status: "queued" });
    expect(JSON.parse(String(job.payload_json))).toMatchObject({
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event: { type: "avalon_public_channel_sync" },
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      kind: "slack_ingress",
      region: "global",
      workspaceId: "22222222-2222-4222-8222-222222222222",
      jobId: job.id,
    }));
  });

  it("continues a rate-limited full sync with Slack's requested queue delay", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const send = vi.fn(async () => undefined);
    const service = new SlackAgentService(slackMembershipEnvironment(database, credentialsKey, send));
    await service.schedulePublicChannelSync("11111111-1111-4111-8111-111111111111");
    const initial = database.prepare("SELECT id FROM slack_ingress_jobs").get() as { id: string };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.list")) return new Response(JSON.stringify({
        ok: true,
        channels: [{ id: "CNEW", is_private: false, is_archived: false, is_member: false }],
        response_metadata: { next_cursor: "" },
      }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ error: "ratelimited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "9" },
      });
    }));

    await service.processQueuedIngress(initial.id);

    const jobs = database.prepare(
      "SELECT id, status FROM slack_ingress_jobs ORDER BY received_at, id",
    ).all() as Array<{ id: string; status: string }>;
    expect(jobs).toHaveLength(2);
    expect(jobs).toContainEqual({ id: initial.id, status: "completed" });
    const continuation = jobs.find((job) => job.id !== initial.id)!;
    expect(continuation.status).toBe("queued");
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      jobId: continuation.id,
    }), { delaySeconds: 9 });
  });

  it("joins a newly created public channel from its durable Slack event", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      `INSERT INTO slack_ingress_jobs
       (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
        status, attempt_count, received_at, updated_at)
       VALUES (?, '22222222-2222-4222-8222-222222222222',
               '11111111-1111-4111-8111-111111111111', 'T123', 'hash', 'event', ?,
               'queued', 0, '2026-01-01', '2026-01-01')`,
    ).run("event:EvChannelCreated", JSON.stringify({
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvChannelCreated",
      event: { type: "channel_created", channel: { id: "CNEW", name: "new-channel" } },
    }));
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      expect(url.pathname).toBe("/api/conversations.join");
      expect(JSON.parse(String(init?.body))).toEqual({ channel: "CNEW" });
      return new Response(JSON.stringify({ ok: true, channel: { id: "CNEW" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:EvChannelCreated");

    expect(fetcher).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT status, payload_json, completed_at FROM slack_ingress_jobs WHERE id = 'event:EvChannelCreated'",
    ).get()).toMatchObject({ status: "completed", payload_json: null });
  });

  it("adds eyes to the triggering message before starting Slack task processing", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:acknowledge", appMention("EvAcknowledge"));
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      const method = url.pathname.split("/").at(-1)!;
      methods.push(method);
      if (method === "conversations.info") return new Response(JSON.stringify({
        ok: true,
        channel: { id: "C123", is_private: false, is_im: false, is_mpim: false },
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "users.info") return new Response(JSON.stringify({
        ok: true,
        user: {
          id: "U456",
          team_id: "T123",
          deleted: false,
          is_bot: false,
          profile: { display_name: "Taylor", email: "taylor@example.com" },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
      if (method === "reactions.add") {
        expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
        expect(JSON.parse(String(init?.body))).toEqual({
          channel: "C123",
          name: "eyes",
          timestamp: "1.0",
        });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "assistant.threads.setStatus" || method === "assistant.threads.setTitle") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "chat.startStream") return new Response(JSON.stringify({
        ok: true,
        channel: "C123",
        ts: "2.0",
      }), { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected Slack request ${url}`);
    }));
    const env = {
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
      WORKSTREAM_LOOP_WORKFLOW: { create: vi.fn(async () => ({ id: "workflow" })) },
    } as unknown as Env;

    await new SlackAgentService(env).processQueuedIngress("event:acknowledge");

    expect(methods.indexOf("reactions.add")).toBeGreaterThan(methods.indexOf("users.info"));
    expect(methods.indexOf("reactions.add")).toBeLessThan(methods.indexOf("assistant.threads.setStatus"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:acknowledge'",
    ).get()).toEqual({ status: "completed", payload_json: null });
  });

  it.each([
    ["too_many_reactions", "healthy"],
    ["missing_scope", "needs_reconnect"],
  ] as const)("continues an admitted task when reactions.add returns %s", async (reactionError, expectedStatus) => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, `event:${reactionError}`, appMention(`Ev${reactionError}`));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: false, error: reactionError });
    vi.stubGlobal("fetch", fetcher);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = {
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
      WORKSTREAM_LOOP_WORKFLOW: { create: vi.fn(async () => ({ id: "workflow" })) },
    } as unknown as Env;

    await new SlackAgentService(env).processQueuedIngress(`event:${reactionError}`);

    expect(methods.indexOf("reactions.add")).toBeLessThan(methods.indexOf("assistant.threads.setStatus"));
    expect(warning).toHaveBeenCalledWith("Slack activation acknowledgement failed", expect.objectContaining({
      reason: reactionError,
    }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: expectedStatus });
    expect(database.prepare(
      `SELECT status, payload_json FROM slack_ingress_jobs WHERE id = 'event:${reactionError}'`,
    ).get()).toEqual({ status: "completed", payload_json: null });
  });

  it("uses the installed Slack capability grants for activation", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET granted_scopes_json = '[]' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:missing-capability", appMention("EvMissingCapability"));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:missing-capability")).rejects.toThrow(/has not granted slack\.agent/iu);

    expect(methods).not.toContain("reactions.add");
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:missing-capability'",
    ).get()).toEqual({
      status: "failed",
      attempt_count: 20,
      error_code: "unsupported_capability",
    });
  });

  it("acknowledges linked-user activation without external actor lookup", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('44444444-4444-4444-8444-444444444444', 'google-linked',
              'linked@example.com', 'Linked User', '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES ('22222222-2222-4222-8222-222222222222',
              '44444444-4444-4444-8444-444444444444', 'member', 'active', '2026-01-01');
      INSERT INTO slack_user_links
        (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
         status, created_at, updated_at)
      VALUES ('33333333-3333-4333-8333-333333333333',
              '22222222-2222-4222-8222-222222222222',
              '11111111-1111-4111-8111-111111111111',
              '44444444-4444-4444-8444-444444444444', 'T123', 'U456',
              'active', '2026-01-01', '2026-01-01');
    `);
    insertSlackEventJob(database, "event:linked", appMention("EvLinked"));
    const { fetcher, methods } = slackTaskApiFetcher(database, { ok: true });
    vi.stubGlobal("fetch", fetcher);
    const env = {
      ...slackMembershipEnvironment(database, credentialsKey, vi.fn(async () => undefined)),
      APP_ENV: "test",
      OPENROUTER_PRIMARY_MODEL: "test-model",
      SESSION_SIGNING_KEY: "test-session-signing-key-with-32-characters",
      WORKSTREAM_LOOP_WORKFLOW: { create: vi.fn(async () => ({ id: "workflow" })) },
    } as unknown as Env;

    await new SlackAgentService(env).processQueuedIngress("event:linked");

    expect(methods).toContain("reactions.add");
    expect(methods).not.toContain("users.info");
    expect(database.prepare(
      "SELECT created_by_user_id FROM workstreams",
    ).get()).toEqual({ created_by_user_id: "44444444-4444-4444-8444-444444444444" });
  });

  it("makes deterministic ingress failures terminal in the durable job row", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:invalid", { type: 42 });

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:invalid")).rejects.toBeDefined();

    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:invalid'",
    ).get()).toMatchObject({ status: "failed", attempt_count: 20 });
  });

  it("retries an access-token expiration without poisoning the Slack connection", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:expired", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvExpired",
      event: { type: "channel_created", channel: { id: "CNEW", name: "new-channel" } },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: "token_expired",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:expired")).rejects.toMatchObject({ message: "token_expired" });

    expect(database.prepare(
      "SELECT status, attempt_count, error_code FROM slack_ingress_jobs WHERE id = 'event:expired'",
    ).get()).toEqual({ status: "failed", attempt_count: 1, error_code: "token_expired" });
    expect(database.prepare(
      "SELECT status FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toEqual({ status: "healthy" });
  });

  it("accepts an unlinked private-channel task regardless of legacy policy rows", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      `INSERT INTO slack_agent_policies
       (connection_id, allow_unlinked_workspace_tasks, public_channel_mode, private_channel_mode,
        allow_direct_messages, allow_commands, allow_shortcuts, created_at, updated_at)
       VALUES (?, 0, 'disabled', 'disabled', 0, 0, 0, '2026-01-01', '2026-01-01')`,
    ).run("11111111-1111-4111-8111-111111111111");
    const payload = appMention("EvWideLatitude");
    (payload.event as Record<string, unknown>).channel_type = "group";
    insertSlackEventJob(database, "event:wide-latitude", payload);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: "C123", name: "private-work", is_private: true, is_im: false, is_mpim: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("users.info")) {
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U456",
            team_id: "T123",
            deleted: false,
            is_bot: false,
            name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus")
        || url.pathname.endsWith("assistant.threads.setTitle")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("chat.startStream")) {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:wide-latitude");

    expect(database.prepare("SELECT title, objective FROM workstreams").get()).toEqual({
      title: "investigate this",
      objective: "investigate this",
    });
    expect(database.prepare("SELECT execution_scope, channel_type FROM slack_agent_sessions").get()).toEqual({
      execution_scope: "workspace",
      channel_type: "private",
    });
  });

  it("marks a missing channel-lookup scope for reconnect before unlinked dispatch", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:missing-scope", appMention("EvMissingScope"));
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({ ok: false, error: "missing_scope" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:missing-scope");

    expect(database.prepare(
      "SELECT status, error_json FROM connector_connections WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).get()).toMatchObject({ status: "needs_reconnect" });
    expect(database.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:missing-scope'",
    ).get()).toEqual({ status: "completed" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("asks for the request again when a legacy retry has no recoverable prompt", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    insertSlackEventJob(database, "event:legacy-retry-missing", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvLegacyRetryMissing",
      authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
      event: {
        type: "app_mention",
        user: "U456",
        channel: "C123",
        channel_type: "channel",
        thread_ts: "1.0",
        ts: "1.3",
        text: "<@UBOT> try again",
      },
    });
    const postedMessages: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.replies")) {
        return new Response(JSON.stringify({
          ok: true,
          messages: [
            { type: "message", user: "U456", text: "<@UBOT> old request", ts: "1.0" },
            { type: "message", user: "UBOT", text: "A different reply", ts: "1.1", thread_ts: "1.0" },
          ],
          response_metadata: { next_cursor: "more" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        postedMessages.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).text));
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.4" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:legacy-retry-missing");

    expect(postedMessages).toEqual([expect.stringContaining("couldn’t find the original request")]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT status FROM slack_ingress_jobs WHERE id = 'event:legacy-retry-missing'",
    ).get()).toEqual({ status: "completed" });
  });

  it("retains a denied prompt and executes the original request after recovery", async () => {
    const database = migratedDatabase();
    const credentialsKey = "test-connector-credentials-key";
    await seedSlackInstallation(database, credentialsKey);
    database.prepare(
      "UPDATE connector_connections SET status = 'needs_reconnect' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:unhealthy", appMention("EvUnhealthy"));
    const postedMessages: string[] = [];
    const threadTitles: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("conversations.info")) {
        return new Response(JSON.stringify({
          ok: true,
          channel: { id: "C123", is_private: false, is_im: false, is_mpim: false },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("chat.postMessage")) {
        postedMessages.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).text));
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("users.info")) {
        return new Response(JSON.stringify({
          ok: true,
          user: {
            id: "U456",
            team_id: "T123",
            deleted: false,
            is_bot: false,
            name: "adam",
            profile: { display_name: "Adam", real_name: "Adam" },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.pathname.endsWith("assistant.threads.setStatus")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("assistant.threads.setTitle")) {
        threadTitles.push(String((JSON.parse(String(init?.body)) as Record<string, unknown>).title));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname.endsWith("chat.startStream")) {
        return new Response(JSON.stringify({ ok: true, channel: "C123", ts: "1.3" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected Slack request ${url}`);
    }));

    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:unhealthy");

    expect(postedMessages).toEqual([expect.stringContaining("connection needs attention")]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
    expect(database.prepare(
      `SELECT prompt, denial_reason FROM slack_agent_pending_prompts
       WHERE connection_id = '11111111-1111-4111-8111-111111111111'
         AND slack_channel_id = 'C123' AND slack_thread_ts = '1.0' AND slack_user_id = 'U456'`,
    ).get()).toEqual({ prompt: "investigate this", denial_reason: "connection" });

    insertSlackEventJob(database, "event:retry-unhealthy", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvRetryUnhealthy",
      event: {
        type: "message",
        user: "U456",
        channel: "C123",
        channel_type: "channel",
        thread_ts: "1.0",
        ts: "1.2",
        text: "try again",
      },
    });
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:retry-unhealthy");

    expect(postedMessages).toHaveLength(2);
    expect(database.prepare(
      `SELECT prompt, denial_reason FROM slack_agent_pending_prompts
       WHERE connection_id = '11111111-1111-4111-8111-111111111111'
         AND slack_channel_id = 'C123' AND slack_thread_ts = '1.0' AND slack_user_id = 'U456'`,
    ).get()).toEqual({ prompt: "investigate this", denial_reason: "connection" });

    database.prepare(
      "UPDATE connector_connections SET status = 'healthy' WHERE id = '11111111-1111-4111-8111-111111111111'",
    ).run();
    insertSlackEventJob(database, "event:retry-recovered", {
      type: "event_callback",
      team_id: "T123",
      api_app_id: "A1",
      event_id: "EvRetryRecovered",
      event: {
        type: "message",
        user: "U456",
        channel: "C123",
        channel_type: "channel",
        thread_ts: "1.0",
        ts: "1.3",
        text: "try again",
      },
    });
    await new SlackAgentService(slackMembershipEnvironment(
      database,
      credentialsKey,
      vi.fn(async () => undefined),
    )).processQueuedIngress("event:retry-recovered");

    expect(database.prepare("SELECT title, objective FROM workstreams").get()).toEqual({
      title: "investigate this",
      objective: "investigate this",
    });
    expect(database.prepare(
      "SELECT text_content FROM messages WHERE message_type = 'text'",
    ).get()).toEqual({ text_content: "investigate this" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM slack_agent_pending_prompts").get())
      .toEqual({ count: 0 });
    expect(threadTitles).toEqual(["investigate this"]);
  });
});

function seedElicitationRetry(
  database: DatabaseSync,
  authorType: "human" | "system",
  authorUserId: string | null,
  externalActorJson: string | null,
): void {
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('workspace-slack', 'Slack Workspace', 'slack-workspace', 'global',
            'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('workspace-slack', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('workspace-slack', 'user-taylor', 'member', 'active', '2026-01-01');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, next_sequence_number, email_address, email_route_status,
       last_activity_at, created_at, updated_at)
    VALUES ('workstream-retry', 'workspace-slack', 'Retry', 'Retry', 'ad_hoc', NULL,
            'needs_input', 2, 'retry@automation.with-avalon.com', 'active',
            '2026-01-01', '2026-01-01', '2026-01-01');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES
      ('run-a', 'workspace-slack', 'workstream-retry', 'test', '{}', 'needs_input', '2026-01-01'),
      ('run-b', 'workspace-slack', 'workstream-retry', 'test', '{}', 'needs_input', '2026-01-02');
    INSERT INTO elicitations
      (id, workspace_id, workstream_id, harness_run_id, prompt, response_type,
       options_json, minimum_selections, maximum_selections, status, created_at)
    VALUES
      ('elicitation-a', 'workspace-slack', 'workstream-retry', 'run-a', 'First?', 'text',
       '[]', 0, NULL, 'open', '2026-01-01'),
      ('elicitation-b', 'workspace-slack', 'workstream-retry', 'run-b', 'Second?', 'text',
       '[]', 0, NULL, 'open', '2026-01-02');
  `);
  database.prepare(
    `INSERT INTO messages
     (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
      message_type, text_content, structured_content_json, sequence_number, created_at,
      external_actor_json)
     VALUES ('message-retry', 'event:retry', 'workspace-slack', 'workstream-retry', ?, ?,
             'elicitation', '', NULL, 1, '2026-01-01', ?)`,
  ).run(authorType, authorUserId, externalActorJson);
}

async function seedSlackInstallation(database: DatabaseSync, credentialsKey: string): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: "xoxb-test", botUserId: "UBOT" }),
    credentialsKey,
    "11111111-1111-4111-8111-111111111111",
  );
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 'Slack Workspace', 'slack-workspace', 'global',
            'user-owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('22222222-2222-4222-8222-222222222222', 'user-owner', 'owner', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
       model_plugin_id)
    VALUES ('11111111-1111-4111-8111-111111111111',
            '22222222-2222-4222-8222-222222222222', 'slack', 'workspace', NULL, 'T123',
            'Slack', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
            '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
            'plugin_slack_workspace');
  `);
}

function insertSlackEventJob(database: DatabaseSync, id: string, payload: unknown): void {
  database.prepare(
    `INSERT INTO slack_ingress_jobs
     (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
      status, attempt_count, received_at, updated_at)
     VALUES (?, '22222222-2222-4222-8222-222222222222',
             '11111111-1111-4111-8111-111111111111', 'T123', 'hash', 'event', ?,
             'queued', 0, '2026-01-01', '2026-01-01')`,
  ).run(id, JSON.stringify(payload));
}

function appMention(eventId: string): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A1",
    event_id: eventId,
    authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
    event: {
      type: "app_mention",
      user: "U456",
      channel: "C123",
      channel_type: "channel",
      ts: "1.0",
      text: "<@UBOT> investigate this",
    },
  };
}

function slackTaskApiFetcher(
  database: DatabaseSync,
  reactionResponse: Record<string, unknown>,
): { fetcher: ReturnType<typeof vi.fn>; methods: string[] } {
  const methods: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = url.pathname.split("/").at(-1)!;
    methods.push(method);
    if (method === "conversations.info") return new Response(JSON.stringify({
      ok: true,
      channel: { id: "C123", is_private: false, is_im: false, is_mpim: false },
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "users.info") return new Response(JSON.stringify({
      ok: true,
      user: {
        id: "U456",
        team_id: "T123",
        deleted: false,
        is_bot: false,
        profile: { display_name: "Taylor", email: "taylor@example.com" },
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "conversations.history") return new Response(JSON.stringify({
      ok: true,
      messages: [],
      has_more: false,
    }), { status: 200, headers: { "content-type": "application/json" } });
    if (method === "reactions.add") {
      expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get()).toEqual({ count: 0 });
      expect(JSON.parse(String(init?.body))).toEqual({
        channel: "C123",
        name: "eyes",
        timestamp: "1.0",
      });
      return new Response(JSON.stringify(reactionResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "assistant.threads.setStatus" || method === "assistant.threads.setTitle") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "chat.startStream") return new Response(JSON.stringify({
      ok: true,
      channel: "C123",
      ts: "2.0",
    }), { status: 200, headers: { "content-type": "application/json" } });
    throw new Error(`Unexpected Slack request ${url}`);
  });
  return { fetcher, methods };
}

function slackMembershipEnvironment(
  database: DatabaseSync,
  credentialsKey: string,
  send: (body: unknown) => Promise<void>,
): Env {
  return {
    DB: sqliteD1(database),
    ACTIVITY_QUEUE: { send } as unknown as Queue,
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: credentialsKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    OPENROUTER_PRIMARY_MODEL: "test-model",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    WORKSTREAM_EMAIL_ADDRESS_KEY: "test-workstream-email-address-key",
    WORKSTREAM_LOOP_WORKFLOW: {
      create: vi.fn(async () => ({ id: "workflow-instance" })),
    },
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  } as unknown as Env;
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  return database;
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) {
        values = next;
        return statement;
      },
      async first<T>() {
        return (database.prepare(sql).get(...values as SQLInputValue[]) as T | undefined) ?? null;
      },
      async all<T>() {
        return {
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        } as unknown as D1Result<T>;
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
        return { success: true, results: [], meta: { changes: Number(result.changes) } } as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results as D1Result<T>[];
    },
  } as unknown as D1Database;
}
