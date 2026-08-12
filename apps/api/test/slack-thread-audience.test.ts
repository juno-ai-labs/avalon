import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { encryptString } from "../src/lib/crypto";
import { SlackAgentService } from "../src/services/slack-agent-service";
import { sqliteD1 } from "./helpers/sqlite-d1";

/**
 * Who can talk to a work stream that was started from a Slack thread.
 *
 * The behaviour these cover replaced a per-thread pin: the first Slack member
 * with a linked Avalon account owned the thread, and everyone else in the
 * channel — including the workspace owner — was answered with "this thread is
 * already running with another Avalon member's personal authority". What is
 * asserted here is the rule that took its place, which is the connector-wide
 * one in `connector-workstream-audience.ts`: a work stream inherits the
 * audience of the conversation it was started from, and anybody in that
 * conversation may continue it under their own authority.
 */

const CONNECTION = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const CREDENTIALS_KEY = "test-connector-credentials-key";
// Real UUIDs: an Avalon user id crosses into `SlackOriginContext`, which parses
// it, so a readable placeholder fails before the behaviour under test runs.
const TAYLOR = "019fc4e0-0000-7000-8000-000000000001";
const ADAM = "019fc4e0-0000-7000-8000-000000000002";
const KAT = "019fc4e0-0000-7000-8000-000000000003";
const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations", import.meta.url));

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("who may continue a Slack work stream", () => {
  it("opens a private work stream seated with the private channel's members", async () => {
    // The channel is the room. Without the roster read the work stream is
    // private and empty, which is the same channel unable to find its own work
    // stream in Avalon — worse than the public work stream this replaced.
    const database = await seededDatabase();
    insertEventJob(database, "event:private", appMention("EvPrivate", { channelType: "group" }));
    stubSlack({ privateChannel: true, members: ["U456", "UKAT", "USTRANGER"] });

    await service(database).processQueuedIngress("event:private");

    expect(database.prepare("SELECT visibility FROM workstreams").get())
      .toEqual({ visibility: "private" });
    expect(database.prepare(
      "SELECT user_id FROM workstream_participants ORDER BY user_id",
    ).all()).toEqual([
      // Linked, and the member who summoned Avalon.
      { user_id: TAYLOR },
      // Not linked at all: matched on the email Slack attests to, which is
      // enough to seat somebody and not enough to run as them.
      { user_id: KAT },
    ]);
  });

  it("opens a public work stream from a public channel without reading the roster", async () => {
    const database = await seededDatabase();
    insertEventJob(database, "event:public", appMention("EvPublic"));
    const slack = stubSlack({ privateChannel: false, members: ["U456"] });

    await service(database).processQueuedIngress("event:public");

    expect(database.prepare("SELECT visibility FROM workstreams").get())
      .toEqual({ visibility: "public" });
    // A public channel's work stream is readable by the workspace, so the
    // roster would cost a `users.info` per member and buy nothing.
    expect(slack.methods).not.toContain("conversations.members");
  });

  it("lets a different linked member continue the thread, under their own authority", async () => {
    // The refusal this replaces. Adam is linked, and is not the member who
    // started the thread.
    const database = await seededDatabase();
    insertEventJob(database, "event:open", appMention("EvOpen"));
    stubSlack({ privateChannel: false, members: ["U456"] });
    await service(database).processQueuedIngress("event:open");

    insertEventJob(database, "event:reply", appMention("EvReply", {
      user: "UADAM",
      threadTs: "1.0",
      ts: "1.1",
      text: "<@UBOT> Avalon, do the deep research on every Delta company too",
    }));
    stubSlack({ privateChannel: false, members: ["U456"] });
    await service(database).processQueuedIngress("event:reply");

    const messages = database.prepare(
      "SELECT author_type, author_user_id, text_content FROM messages ORDER BY sequence_number",
    ).all();
    expect(messages).toContainEqual({
      author_type: "human",
      author_user_id: ADAM,
      text_content: "Avalon, do the deep research on every Delta company too",
    });
    // Seated by their own arrival, which is what makes the same reply work when
    // the work stream is private.
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_participants WHERE user_id = ?",
    ).get(ADAM)).toEqual({ count: 1 });
  });

  it("records a reply from a Slack member it cannot map at all", async () => {
    const database = await seededDatabase();
    insertEventJob(database, "event:open", appMention("EvOpen2"));
    stubSlack({ privateChannel: false, members: ["U456"] });
    await service(database).processQueuedIngress("event:open");

    insertEventJob(database, "event:stranger", appMention("EvStranger", {
      user: "USTRANGER",
      threadTs: "1.0",
      ts: "1.2",
      text: "<@UBOT> Avalon, we would get stomped in SEO by Delta Air Lines",
    }));
    stubSlack({ privateChannel: false, members: ["U456"] });
    await service(database).processQueuedIngress("event:stranger");

    // Under their Slack identity, with no Avalon account invented for them:
    // losing what somebody said in the conversation the work stream lives in is
    // the worse failure.
    const stranger = database.prepare(
      "SELECT author_type, author_user_id, external_actor_json FROM messages WHERE text_content = ?",
    ).get("Avalon, we would get stomped in SEO by Delta Air Lines") as {
      author_type: string;
      author_user_id: string | null;
      external_actor_json: string;
    };
    expect(stranger.author_user_id).toBeNull();
    expect(JSON.parse(stranger.external_actor_json)).toMatchObject({
      provider: "slack",
      providerUserId: "USTRANGER",
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_participants",
    ).get()).toEqual({ count: 1 });
  });
});

function service(database: DatabaseSync): SlackAgentService {
  return new SlackAgentService({
    DB: sqliteD1(database),
    ACTIVITY_QUEUE: { send: vi.fn(async () => undefined) } as unknown as Queue,
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: CREDENTIALS_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    OPENROUTER_PRIMARY_MODEL: "test-model",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.test",
    WORKSTREAM_EMAIL_ADDRESS_KEY: "test-workstream-email-address-key",
    WORKSTREAM_LOOP_WORKFLOW: { create: vi.fn(async () => ({ id: "workflow-instance" })) },
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  } as unknown as Env);
}

/** The Slack directory these tests speak to, and how Avalon can map each member. */
const SLACK_PEOPLE: Record<string, { name: string; email: string | null }> = {
  // Linked through `slack_user_links`.
  U456: { name: "Taylor", email: "taylor@example.com" },
  UADAM: { name: "Adam", email: "adam@example.com" },
  // No link; an Avalon member with this verified address exists.
  UKAT: { name: "Kat", email: "kat@example.com" },
  // No link and no Avalon member behind the address.
  USTRANGER: { name: "Sam", email: "sam@elsewhere.example.com" },
};

function stubSlack(options: {
  privateChannel: boolean;
  members: string[];
}): { methods: string[] } {
  const methods: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = url.pathname.split("/").at(-1)!;
    methods.push(method);
    const body = (payload: Record<string, unknown>) => new Response(
      JSON.stringify({ ok: true, ...payload }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
    if (method === "conversations.info") {
      return body({
        channel: {
          id: "C123",
          name: options.privateChannel ? "private-work" : "general",
          is_private: options.privateChannel,
          is_im: false,
          is_mpim: false,
        },
      });
    }
    if (method === "conversations.members") return body({ members: options.members });
    if (method === "users.info") {
      const requested = url.searchParams.get("user") ?? "U456";
      const person = SLACK_PEOPLE[requested] ?? { name: requested, email: null };
      return body({
        user: {
          id: requested,
          team_id: "T123",
          deleted: false,
          is_bot: false,
          name: person.name,
          profile: { display_name: person.name, real_name: person.name, email: person.email },
        },
      });
    }
    if (method === "conversations.history") return body({ messages: [], has_more: false });
    if (method === "chat.startStream") return body({ channel: "C123", ts: "2.0" });
    return body({ channel: { id: "C123" }, ts: "1.1" });
  }));
  return { methods };
}

function appMention(eventId: string, overrides: {
  user?: string;
  channelType?: string;
  threadTs?: string;
  ts?: string;
  text?: string;
} = {}): Record<string, unknown> {
  return {
    type: "event_callback",
    team_id: "T123",
    api_app_id: "A1",
    event_id: eventId,
    authorizations: [{ team_id: "T123", user_id: "UBOT", is_bot: true }],
    event: {
      type: "app_mention",
      user: overrides.user ?? "U456",
      channel: "C123",
      channel_type: overrides.channelType ?? "channel",
      ...(overrides.threadTs ? { thread_ts: overrides.threadTs } : {}),
      ts: overrides.ts ?? "1.0",
      text: overrides.text ?? "<@UBOT> which domains are available",
    },
  };
}

function insertEventJob(database: DatabaseSync, id: string, payload: unknown): void {
  database.prepare(
    `INSERT INTO slack_ingress_jobs
     (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
      status, attempt_count, received_at, updated_at)
     VALUES (?, ?, ?, 'T123', ?, 'event', ?, 'queued', 0, '2026-01-01', '2026-01-01')`,
  ).run(id, WORKSPACE, CONNECTION, id, JSON.stringify(payload));
}

async function seededDatabase(): Promise<DatabaseSync> {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: "xoxb-test", botUserId: "UBOT" }),
    CREDENTIALS_KEY,
    CONNECTION,
  );
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${TAYLOR}', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01'),
      ('${ADAM}', 'google-adam', 'adam@example.com', 'Adam', '2026-01-01', '2026-01-01'),
      ('${KAT}', 'google-kat', 'kat@example.com', 'Kat', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Slack Workspace', 'slack-workspace', 'global', '${TAYLOR}',
            '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE}', '${TAYLOR}', 'member', 'active', '2026-01-01'),
      ('${WORKSPACE}', '${ADAM}', 'owner', 'active', '2026-01-01'),
      ('${WORKSPACE}', '${KAT}', 'member', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
       model_plugin_id)
    VALUES ('${CONNECTION}', '${WORKSPACE}', 'slack', 'workspace', NULL, 'T123', 'Slack',
            '${encrypted.ciphertext}', '${encrypted.iv}', 1, '["slack.agent"]', 'healthy',
            '{}', '{}', '2026-01-01', '2026-01-01', 'plugin_slack_workspace');
    INSERT INTO slack_user_links
      (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status,
       created_at, updated_at)
    VALUES
      ('link-taylor', '${WORKSPACE}', '${CONNECTION}', '${TAYLOR}', 'T123', 'U456', 'active',
       '2026-01-01', '2026-01-01'),
      ('link-adam', '${WORKSPACE}', '${CONNECTION}', '${ADAM}', 'T123', 'UADAM', 'active',
       '2026-01-01', '2026-01-01');
  `);
  return database;
}
