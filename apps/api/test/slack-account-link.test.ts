import { asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { encryptString, sha256 } from "../src/lib/crypto";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { SlackAgentService } from "../src/services/slack-agent-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  SLACK_WORKSPACE_OBJECT_METHODS,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

const credentialsKey = "slack-account-link-test-key";
const workspaceId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
const connectionId = "00000000-0000-7000-8000-000000000003";
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("Slack account linking", () => {
  it("publishes App Home for an unlinked member without minting a link challenge", async () => {
    const database = await seededDatabase();
    // The event travels the durable ingress: the enqueue and the claim are
    // typed methods on a real WorkspaceDO, so this test carries the object and
    // the route the router resolves it through.
    const { instance, objectDatabase } = await seededWorkspaceObject(database);
    const slack = stubSlack();
    const service = new SlackAgentService(environment(database, {
      WORKSPACE_DOS: testWorkspaceObjectBinding(instance, [
        ...SLACK_WORKSPACE_OBJECT_METHODS,
        "recentWorkstreamDirectory",
        "listAutomationDirectory",
      ]),
    }));

    await expect(service.processEvent(appHomeOpened(), "home-hash")).resolves.toEqual({ ok: true });
    await service.processQueuedIngress(workspaceId, "event:EvHome");

    const published = slack.calls.find((call) => call.method === "views.publish");
    const connect = connectButton(published?.body.view as Record<string, unknown>);
    expect(connect).toMatchObject({ action_id: "rally_connect", style: "primary" });
    // The whole point: App Home is published once and stays on screen
    // indefinitely, so it must not carry anything that can expire on it.
    expect(connect).not.toHaveProperty("url");
    expect(challengeCount(objectDatabase)).toBe(0);
    expect(challengeCount(database)).toBe(0);
  });

  it("mints the challenge when Connect Avalon is clicked, and redeems it", async () => {
    const database = await seededDatabase();
    const slack = stubSlack();
    const service = new SlackAgentService(environment(database));

    await expect(service.processInteraction(connectClick(), "connect-hash")).resolves.toEqual({});

    const opened = slack.calls.find((call) => call.method === "views.open");
    expect(opened?.body.trigger_id).toBe("trigger-1");
    const view = opened?.body.view as Record<string, unknown>;
    expect(view.callback_id).toBe("rally_connect_link");
    const button = connectButton(view) as { url: string; action_id: string };
    expect(button.action_id).toBe("rally_open_connect");
    expect(challengeCount(database)).toBe(1);

    const handoff = new URL(button.url);
    expect(handoff.origin + handoff.pathname).toBe("https://with-avalon.com/slack/link");
    const handoffParameters = new URLSearchParams(handoff.hash.slice(1));
    expect(handoffParameters.get("region")).toBe("global");
    expect(handoffParameters.get("workspace")).toBe(workspaceId);
    const token = handoffParameters.get("token") ?? "";
    await expect(new SlackAgentService(environment(database)).previewLink(auth(), token))
      .resolves.toMatchObject({ teamId: "T123", slackUserId: "U456" });
  });

  it("acknowledges the modal's own handoff button without opening a second modal", async () => {
    const database = await seededDatabase();
    const slack = stubSlack();

    await expect(new SlackAgentService(environment(database)).processInteraction({
      ...connectClick(),
      // Slack reports the modal a block action came from. Its callback id must
      // not be read as the interaction's own, or this ack falls through to the
      // shortcut path and opens a task modal on top of the handoff.
      view: { callback_id: "rally_connect_link", hash: "view-hash" },
      callback_id: "rally_connect_link",
      actions: [{ action_id: "rally_open_connect", type: "button" }],
    }, "handoff-hash")).resolves.toEqual({});

    expect(slack.calls).toEqual([]);
    expect(challengeCount(database)).toBe(0);
  });

  it("recognizes a connect button raised from inside a view", async () => {
    const database = await seededDatabase();
    const slack = stubSlack();

    // The docs tell future surfaces to reuse `connectPromptBlocks`; one placed
    // in a modal reports that view's callback id, which must not shadow the
    // button's own and drop the click into the shortcut fallback.
    await new SlackAgentService(environment(database)).processInteraction({
      ...connectClick(),
      view: { callback_id: "rally_some_modal", hash: "view-hash" },
      callback_id: "rally_some_modal",
    }, "embedded-hash");

    const view = slack.calls.find((call) => call.method === "views.open")?.body.view as Record<string, unknown>;
    expect(view.callback_id).toBe("rally_connect_link");
    expect(challengeCount(database)).toBe(1);
  });

  it("leaves the previous link redeemable when the new modal fails to open", async () => {
    const database = await seededDatabase();
    await seedChallenge(database, "earlier-token", { expiresAt: "2099-01-01T00:00:00.000Z" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error: "expired_trigger_id" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(new SlackAgentService(environment(database)).processInteraction(connectClick(), "failed-open-hash"))
      .rejects.toThrow();

    // The member is still holding the modal this click failed to replace. It
    // was the mint that used to retire it, before the replacement existed.
    await expect(new SlackAgentService(environment(database)).previewLink(auth(), "earlier-token"))
      .resolves.toMatchObject({ slackUserId: "U456" });
  });

  it("leaves a working link when two clicks open their modals concurrently", async () => {
    const database = await seededDatabase();
    // Hold both `views.open` calls until each has arrived, so both challenges
    // are minted and both modals are on screen before either click retires
    // anything. Retiring every token but its own leaves the member two modals
    // and no redeemable link; retiring by mint time cannot.
    let opened = 0;
    let bothOpened: () => void = () => {};
    const barrier = new Promise<void>((resolve) => { bothOpened = resolve; });
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
      if (url.pathname.endsWith("views.open")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { view: { blocks: Record<string, unknown>[] } };
        urls.push(String((connectButton(body.view) as { url: string }).url));
        opened += 1;
        if (opened === 2) bothOpened();
        await barrier;
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const service = new SlackAgentService(environment(database));

    await Promise.all([
      service.processInteraction(connectClick(), "click-one"),
      service.processInteraction(connectClick(), "click-two"),
    ]);

    expect(urls).toHaveLength(2);
    const redeemable = await Promise.all(urls.map(async (url) => {
      const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token") ?? "";
      return service.previewLink(auth(), token).then(() => true, () => false);
    }));
    // Whichever click landed last, the member is left holding a link that
    // works. Two mints in the same millisecond retire neither, which is the
    // harmless direction, so this asserts the floor rather than an exact count.
    expect(redeemable).toContain(true);
  });

  it("retires the previous link once the new modal has opened", async () => {
    const database = await seededDatabase();
    await seedChallenge(database, "earlier-token", { expiresAt: "2099-01-01T00:00:00.000Z" });
    stubSlack();
    const service = new SlackAgentService(environment(database));

    await service.processInteraction(connectClick(), "supersede-hash");

    await expect(service.previewLink(auth(), "earlier-token"))
      .rejects.toMatchObject({ code: "slack_link_consumed" });
    expect(challengeCount(database)).toBe(2);
  });

  it("routes every Avalon button by its action id, not a view's callback id", async () => {
    // The connect button is not a special case: the handler matches all of
    // Avalon's buttons this way, and none of these four branches had coverage
    // before they were converted. Each payload carries a top-level `callback_id`
    // that would shadow the action id under the old matching.
    const cases = [
      { actionId: "rally_preferences", expect: "views.open", view: "rally_preferences_submit" },
      { actionId: "rally_feedback", expect: "views.open", view: "rally_feedback_submit" },
      { actionId: "rally_create_automation", expect: null, view: null },
      { actionId: "rally_open_task", expect: null, view: null },
    ];
    for (const testCase of cases) {
      const database = await seededDatabase();
      const slack = stubSlack();
      await expect(new SlackAgentService(environment(database)).processInteraction({
        ...connectClick(),
        callback_id: "rally_some_modal",
        actions: [{ action_id: testCase.actionId, type: "button", value: "workstream-1" }],
      }, `route-${testCase.actionId}`)).resolves.toEqual({});
      const opened = slack.calls.find((call) => call.method === "views.open");
      expect(opened?.method ?? null).toBe(testCase.expect);
      expect((opened?.body.view as { callback_id?: string } | undefined)?.callback_id ?? null).toBe(testCase.view);
    }
  });

  it("matches a button on its action id, not the view it was raised from", async () => {
    // The rule this protects outlived the button that first needed it. A block
    // action raised inside a view carries that view's `callback_id`, and
    // matching on it would send a connect button placed in a modal down the
    // shortcut path — opening a task modal on top of the link the member came
    // for. Every one of Avalon's buttons is matched on the action id instead.
    const database = await seededDatabase();
    const slack = stubSlack();

    await expect(new SlackAgentService(environment(database)).processInteraction({
      ...connectClick(),
      callback_id: "rally_some_modal",
    }, "foreign-callback-hash")).resolves.toEqual({});

    const view = slack.calls.find((call) => call.method === "views.open")?.body.view as Record<string, unknown>;
    expect(view.callback_id).toBe("rally_connect_link");
    expect(challengeCount(database)).toBe(1);
  });

  it("refuses to mint a link for an installation a person disabled", async () => {
    // `disabled` is a decision, not an observation. It is also not merely a
    // consistency point: disabling clears the credentials and drops the row
    // from `connectionForTeam`, so redeeming would commit the identity link and
    // then fail publishing App Home — an error shown for a mutation that landed.
    const database = await seededDatabase();
    await seedChallenge(database, "disabled-token", { expiresAt: "2099-01-01T00:00:00.000Z" });
    database.exec("UPDATE connector_connections SET status = 'disabled'");
    const service = new SlackAgentService(environment(database));

    await expect(service.previewLink(auth(), "disabled-token")).rejects.toMatchObject({
      code: "slack_installation_disabled",
      status: 409,
    });
  });

  it("mints a link even when the row believes the installation is broken", async () => {
    // Reaching this click means Slack signed the payload and the bot token is
    // opening a view, so the installation demonstrably works. Refusing on a
    // stored belief sent a member to find an admin to repair something that was
    // not broken — and linking an identity spends no provider credential.
    const database = await seededDatabase();
    database.exec("UPDATE connector_connections SET status = 'needs_reconnect'");
    const slack = stubSlack();

    await new SlackAgentService(environment(database)).processInteraction(connectClick(), "unhealthy-hash");

    const view = slack.calls.find((call) => call.method === "views.open")?.body.view as Record<string, unknown>;
    expect(view.callback_id).toBe("rally_connect_link");
    expect(challengeCount(database)).toBe(1);
  });

  it("distinguishes an unknown, used, expired, and unredeemable link", async () => {
    const database = await seededDatabase();
    await seedChallenge(database, "fresh-token", { expiresAt: "2099-01-01T00:00:00.000Z" });
    await seedChallenge(database, "used-token", { expiresAt: "2099-01-01T00:00:00.000Z", consumedAt: "2026-01-01T00:00:00.000Z" });
    await seedChallenge(database, "old-token", { expiresAt: "2020-01-01T00:00:00.000Z" });
    const service = new SlackAgentService(environment(database));

    await expect(service.previewLink(auth(), "never-minted")).rejects.toMatchObject({ code: "slack_link_unknown", status: 404 });
    await expect(service.previewLink(auth(), "used-token")).rejects.toMatchObject({ code: "slack_link_consumed", status: 409 });
    await expect(service.previewLink(auth(), "old-token")).rejects.toMatchObject({ code: "slack_link_expired", status: 404 });
    // A live challenge whose installation the row believes went unhealthy after
    // it was minted still redeems. The challenge is the authority — signed by
    // Slack, single-use, fifteen minutes — and the belief is a record of one
    // past moment that nothing re-checks.
    database.exec("UPDATE connector_connections SET status = 'needs_reconnect'");
    await expect(service.previewLink(auth(), "fresh-token")).resolves.toMatchObject({
      teamId: "T123",
      slackUserId: "U456",
    });
  });

  it("tells a caller from another workspace nothing about the challenge's state", async () => {
    const database = await seededDatabase();
    await seedChallenge(database, "used-token", { expiresAt: "2099-01-01T00:00:00.000Z", consumedAt: "2026-01-01T00:00:00.000Z" });

    await expect(new SlackAgentService(environment(database)).previewLink(
      { ...auth(), workspaceId: asWorkspaceId("46211570-12bb-4b6d-844d-d6bf36d06f4f") },
      "used-token",
    )).rejects.toMatchObject({ code: "slack_link_workspace_mismatch", status: 409 });
  });

  it("consumes the challenge exactly once", async () => {
    const database = await seededDatabase();
    // Linking does three things that reach the workspace object: it consumes
    // the challenge, it seats the member's Slack sessions through a typed
    // method, and it republishes App Home from the member's task list. None of
    // them is what this test is about, but all three have to work or the
    // challenge is never consumed — so this runs against the real object, and
    // the challenge is seeded where the routed read finds it rather than in the
    // regional fixture the facade used to answer from.
    const { instance, objectDatabase } = await seededWorkspaceObject(database);
    await seedChallenge(objectDatabase, "fresh-token", { expiresAt: "2099-01-01T00:00:00.000Z" });
    stubSlack();
    const service = new SlackAgentService(environment(database, {
      WORKSPACE_DOS: testWorkspaceObjectBinding(instance, [
        ...SLACK_WORKSPACE_OBJECT_METHODS,
        "recentWorkstreamDirectory",
        "listAutomationDirectory",
      ]),
    }));

    await expect(service.linkUser(auth(), "fresh-token")).resolves.toMatchObject({ linked: true, slackUserId: "U456" });
    await expect(service.linkUser(auth(), "fresh-token")).rejects.toMatchObject({ code: "slack_link_consumed" });
  });
});

function appHomeOpened() {
  return {
    type: "event_callback",
    api_app_id: "A1",
    team_id: "T123",
    event_id: "EvHome",
    event: { type: "app_home_opened", user: "U456", tab: "home", view: { hash: "view-hash" } },
  };
}

function connectClick() {
  return {
    type: "block_actions",
    team: { id: "T123" },
    user: { id: "U456" },
    trigger_id: "trigger-1",
    actions: [{ action_id: "rally_connect", type: "button" }],
  };
}

/** The primary button in the first `actions` block of a view or block list. */
function connectButton(view: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const blocks = Array.isArray(view?.blocks) ? view.blocks as Record<string, unknown>[] : [];
  const actions = blocks.find((block) => block.type === "actions");
  const elements = Array.isArray(actions?.elements) ? actions.elements as Record<string, unknown>[] : [];
  return elements[0];
}

function challengeCount(database: DatabaseSync): number {
  return Number((database.prepare(
    "SELECT COUNT(*) AS count FROM slack_link_challenges",
  ).get() as { count: number }).count);
}

function auth(): AuthContext {
  return {
    sessionId: "session-taylor",
    userId,
    workspaceId,
    region: "global",
    role: "member",
  } as AuthContext;
}

interface SlackCall { method: string; body: Record<string, unknown> }

/** Records every Slack Web API call and answers each one `ok`. */
function stubSlack(): { calls: SlackCall[] } {
  const calls: SlackCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    calls.push({
      method: url.pathname.split("/").pop() ?? "",
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }));
  return { calls };
}

async function seedChallenge(
  database: DatabaseSync,
  token: string,
  options: { expiresAt: string; consumedAt?: string },
): Promise<void> {
  database.prepare(
    `INSERT INTO slack_link_challenges
     (token_hash, connection_id, slack_team_id, slack_user_id, expires_at, consumed_at, created_at)
     VALUES (?, '${connectionId}', 'T123', 'U456', ?, ?, '2026-01-01')`,
  ).run(await sha256(token), options.expiresAt, options.consumedAt ?? null);
}

/**
 * The real workspace object the durable ingress test runs against, seeded
 * with the same installation the regional fixture carries — the connection is
 * a WorkspaceDO table, so the object is where the routed reads find it.
 */
async function seededWorkspaceObject(database: DatabaseSync): Promise<{
  instance: ReturnType<typeof createTestWorkspaceDO>["instance"];
  objectDatabase: DatabaseSync;
}> {
  database.prepare(
    `INSERT INTO slack_installation_routes
       (team_id, region, workspace_id, connection_id, status, created_at, updated_at)
     VALUES ('T123', 'global', ?, ?, 'active', '2026-01-01', '2026-01-01')`,
  ).run(workspaceId, connectionId);
  const { instance, objectDatabase } = createTestWorkspaceDO({
    workspaceId,
    regionalDatabase: database,
    register: (created) => { databases.push(created); },
  });
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: "xoxb-test" }),
    credentialsKey,
    connectionId,
  );
  objectDatabase.exec(`
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
       model_plugin_id)
    VALUES ('${connectionId}', '${workspaceId}', 'slack', 'workspace', NULL, 'T123',
            'Juno Labs', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
            '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
            'plugin_slack_workspace');
  `);
  return { instance, objectDatabase };
}

async function seededDatabase(): Promise<DatabaseSync> {
  const database = preRetirementProductSqliteDatabase();
  database.exec("ALTER TABLE workspaces ADD COLUMN abandoned_at TEXT");
  database.exec(readFileSync(new URL("../../../packages/db/migrations/0109_workspace_guest_relationships.sql", import.meta.url), "utf8"));
  databases.push(database);
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: "xoxb-test" }),
    credentialsKey,
    connectionId,
  );
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Slack Workspace', 'slack-workspace', 'global',
            '${userId}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '2026-01-01');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, encrypted_credentials, credential_iv, credential_key_version,
       granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
       model_plugin_id)
    VALUES ('${connectionId}', '${workspaceId}', 'slack', 'workspace', NULL, 'T123',
            'Juno Labs', '${encrypted.ciphertext}', '${encrypted.iv}', 1,
            '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
            'plugin_slack_workspace');
  `);
  return database;
}

function environment(
  database: DatabaseSync,
  overrides: { WORKSPACE_DOS?: Env["WORKSPACE_DOS"] } = {},
): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    ACTIVITY_QUEUE: { send: async () => {} },
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: credentialsKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
    LOG_LEVEL: "error",
    ...overrides,
  });
}
