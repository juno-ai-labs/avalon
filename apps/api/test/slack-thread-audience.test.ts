import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptString } from "../src/lib/crypto";
import {
  connectorWorkstreamScope,
} from "../src/services/connector-workstream-audience";
import { SlackAgentService } from "../src/services/slack-agent-service";
import {
  createCloudflareTestBinding,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import {
  createTestWorkspaceDO,
  SLACK_WORKSPACE_OBJECT_METHODS,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";

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

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("the scope a connector conversation maps to", () => {
  const threshold = 50;

  it("reads a conversation at or below the threshold as the room it is", () => {
    expect(connectorWorkstreamScope({
      audience: "private", memberCount: threshold, workspaceScopeThreshold: threshold,
    })).toBe("personal");
    expect(connectorWorkstreamScope({
      audience: "public", memberCount: 4, workspaceScopeThreshold: threshold,
    })).toBe("workspace");
    // A conversation the connector could not classify is treated as private.
    expect(connectorWorkstreamScope({
      audience: "unknown", memberCount: 4, workspaceScopeThreshold: threshold,
    })).toBe("personal");
  });

  it("opens a conversation past the threshold to the workspace whatever its privacy says", () => {
    // The deliberate widening: this is readable by workspace members who are
    // not in the channel, which the participant model would not have done. At
    // this size a participant list is a large stale copy of a membership Slack
    // already keeps, and a work stream nobody can find is the worse failure.
    expect(connectorWorkstreamScope({
      audience: "private", memberCount: threshold + 1, workspaceScopeThreshold: threshold,
    })).toBe("workspace");
    expect(connectorWorkstreamScope({
      audience: "unknown", memberCount: threshold + 1, workspaceScopeThreshold: threshold,
    })).toBe("workspace");
  });

  it("leaves a failed listing to the conversation's own privacy", () => {
    // A zero count is what a failed `conversations.members` reports, and it must
    // not read as a small conversation *or* a large one.
    expect(connectorWorkstreamScope({
      audience: "private", memberCount: 0, workspaceScopeThreshold: threshold,
    })).toBe("personal");
  });
});

describe("who may continue a Slack work stream", () => {
  // The pre-cutover D1 execution arms are gone: on the one unsupported stack
  // that never opened the Durable-Object authority, Slack ingress must fail
  // loudly instead of running legacy code. The seating, scope, and actor rules
  // themselves are exercised against the durable path — in the object test
  // below and in the Workers-runtime suites.
  it("refuses to open a work stream while the authority is not durable_object_open", async () => {
    const { database, instance, objectDatabase } = await seededDatabase();
    insertEventJob(objectDatabase, "event:refused", appMention("EvRefused"));
    stubSlack({ privateChannel: false, members: ["U456"] });

    await expect(service(database, instance).processQueuedIngress(WORKSPACE, "event:refused"))
      .rejects.toMatchObject({ status: 503, code: "workstream_maintenance" });

    // The refusal reached the job ledger, and no legacy product row appeared.
    expect(objectDatabase.prepare("SELECT status FROM slack_ingress_jobs WHERE id = 'event:refused'").get())
      .toEqual({ status: "failed" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstreams").get())
      .toEqual({ count: 0 });
  });

  it("reads the conversation roster for a public channel, not only a private one", async () => {
    // Who can see this work in Slack is the connector's fact; Avalon's scope is
    // a separate question and must not be read as an answer to it. A public
    // channel's thread is workspace-readable *and* its members belong in the
    // room — so the roster is read either way, where it used to be skipped
    // whenever the channel was public and the work stream came out with an
    // empty participant list.
    const { database, instance, objectDatabase } = await seededDatabase();
    insertEventJob(objectDatabase, "event:public-roster", appMention("EvPublicRoster"));
    const slack = stubSlack({ privateChannel: false, members: ["U456", "UKAT"] });

    // The authority is deliberately still closed here: this asserts what the
    // ingress resolves on the way to the create, which happens before the
    // refusal, without standing up the whole create pipeline to do it.
    await expect(service(database, instance).processQueuedIngress(WORKSPACE, "event:public-roster"))
      .rejects.toMatchObject({ status: 503, code: "workstream_maintenance" });

    expect(slack.methods).toContain("conversations.members");
    expect(slack.calls.find((call) => call.method === "conversations.members")?.body)
      .toMatchObject({ channel: "C123" });
  });

  it("stops resolving identities for a conversation too large to be a room", async () => {
    // Past the Slack threshold the work stream is workspace-scoped and seats
    // nobody, so the `users.info` fan-out behind the roster is skipped outright
    // — it is the expensive half, and there is no room left to seat.
    const { database, instance, objectDatabase } = await seededDatabase();
    insertEventJob(objectDatabase, "event:big-room", appMention("EvBigRoom"));
    const members = Array.from({ length: 51 }, (_, index) => `UBULK${index}`);
    const slack = stubSlack({ privateChannel: true, members });

    await expect(service(database, instance).processQueuedIngress(WORKSPACE, "event:big-room"))
      .rejects.toMatchObject({ status: 503, code: "workstream_maintenance" });

    // The listing still happens — the count is what decides the scope.
    expect(slack.methods).toContain("conversations.members");
    expect(slack.methods).not.toContain("users.info");
  });

  // Canonical connector admission is exercised on real workerd in
  // participant-notification.test.ts; it no longer writes a local legacy roster.

});

function service(
  database: DatabaseSync,
  instance: WorkspaceDO,
  roomEvents?: Record<string, unknown>[],
): SlackAgentService {
  return new SlackAgentService(createTestEnv({
    DB: sqliteD1(database),
    // The ingress spine is typed WorkspaceDO methods now, and the remaining
    // facade statements route to the same real object, so one workspace's
    // Slack state lives in one store.
    WORKSPACE_DOS: testWorkspaceObjectBinding(instance, SLACK_WORKSPACE_OBJECT_METHODS),
    ACTIVITY_QUEUE: createCloudflareTestBinding<Queue>({
      send: vi.fn(async () => undefined),
    }),
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: CREDENTIALS_KEY,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    OPENROUTER_PRIMARY_MODEL: "test-model",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.test",
    WORKSTREAM_EMAIL_ADDRESS_KEY: "test-workstream-email-address-key",
    ...(roomEvents ? {
      SUBSTREAM_AGENTS: createCloudflareTestBinding<DurableObjectNamespace>({
        jurisdiction: () => createCloudflareTestBinding<DurableObjectNamespace>({
          idFromName: vi.fn(() => createTestDurableObjectId("room-id")),
          get: vi.fn(() => ({
            publishEvent: vi.fn(async (input: { event: Record<string, unknown> }) => {
              roomEvents.push(input.event);
              return { status: 204, bodyJson: "null" };
            }),
          })),
        }),
        idFromName: vi.fn(() => createTestDurableObjectId("room-id")),
        get: vi.fn(() => ({
          publishEvent: vi.fn(async (input: { event: Record<string, unknown> }) => {
            roomEvents.push(input.event);
            return { status: 204, bodyJson: "null" };
          }),
        })),
      }),
    } : {}),
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  }));
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
  profileDelayMs?: number;
}): {
  methods: string[];
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  readonly maxProfilesInFlight: number;
} {
  const methods: string[] = [];
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let profilesInFlight = 0;
  let maxProfilesInFlight = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = url.pathname.split("/").at(-1)!;
    methods.push(method);
    calls.push({
      method,
      body: init?.body
        ? JSON.parse(String(init.body)) as Record<string, unknown>
        : Object.fromEntries(url.searchParams),
    });
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
    if (method === "conversations.open") return body({ channel: { id: "D123" } });
    if (method === "users.info") {
      profilesInFlight += 1;
      maxProfilesInFlight = Math.max(maxProfilesInFlight, profilesInFlight);
      try {
        if (options.profileDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.profileDelayMs));
        }
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
      } finally {
        profilesInFlight -= 1;
      }
    }
    if (method === "conversations.history") return body({ messages: [], has_more: false });
    if (method === "chat.stopStream" || method === "chat.postMessage") {
      return body({ channel: "C123", ts: "2.0" });
    }
    return body({ channel: { id: "C123" }, ts: "1.1" });
  }));
  return {
    methods,
    calls,
    get maxProfilesInFlight() {
      return maxProfilesInFlight;
    },
  };
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

function insertEventJob(objectDatabase: DatabaseSync, id: string, payload: unknown): void {
  objectDatabase.prepare(
    `INSERT INTO slack_ingress_jobs
     (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
      status, attempt_count, received_at, updated_at)
     VALUES (?, ?, ?, 'T123', ?, 'event', ?, 'queued', 0, '2026-01-01', '2026-01-01')`,
  ).run(id, WORKSPACE, CONNECTION, id, JSON.stringify(payload));
}

async function seededDatabase(): Promise<{
  database: DatabaseSync;
  instance: WorkspaceDO;
  objectDatabase: DatabaseSync;
}> {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: "xoxb-test", botUserId: "UBOT" }),
    CREDENTIALS_KEY,
    CONNECTION,
  );
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${TAYLOR}', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('${ADAM}', 'google-adam', 'adam@example.com', 'Adam', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('${KAT}', 'google-kat', 'kat@example.com', 'Kat', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE}', 'Slack Workspace', 'slack-workspace', 'global', '${TAYLOR}',
            '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${WORKSPACE}', '${TAYLOR}', 'member', 'active', '2026-01-01'),
      ('${WORKSPACE}', '${ADAM}', 'owner', 'active', '2026-01-01'),
      ('${WORKSPACE}', '${KAT}', 'member', 'active', '2026-01-01');
    INSERT INTO slack_installation_routes
      (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
    VALUES ('T123', 'global', '${WORKSPACE}', '${CONNECTION}', 'active', '2026-01-01', '2026-01-01');
  `);
  // The connection and the user links are WorkspaceDO tables: they live in the
  // real object's own database, where the facade and the typed methods both
  // find them.
  const { instance, objectDatabase } = createTestWorkspaceDO({
    workspaceId: WORKSPACE,
    regionalDatabase: database,
    register: (created) => { databases.push(created); },
  });
  objectDatabase.exec(`
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
  return { database, instance, objectDatabase };
}
