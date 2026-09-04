import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { SlackWorkspaceBotScopes } from "@rally/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { encryptString } from "../src/lib/crypto";
import { refreshSlackWorkstreamUnfurls } from "../src/services/slack-unfurl-refresh";
import { workstreamUnfurlBlocks, workstreamUnfurlCardHash } from "../src/services/slack-workstream-card";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestD1Results, createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest, testSubstreamAgentsBinding } from "./helpers/durable-authority";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

const connectionId = "00000000-0000-7000-8000-000000000041";
const workspaceId = "00000000-0000-7000-8000-000000000042";
const userId = "00000000-0000-7000-8000-000000000043";
const workstreamId = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";
const credentialsKey = "slack-unfurl-refresh-test-key";
const url = `https://with-avalon.com/app/workspaces/global/${workspaceId}/workstreams/${workstreamId}`;
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

interface SlackCall { method: string; body: Record<string, unknown> }

function slackFixture(
  calls: SlackCall[],
  overrides: { external?: boolean; unfurlError?: string; infoError?: string } = {},
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    // Slack reads some methods over GET, so the arguments arrive as query
    // parameters and the method name carries a query string.
    const requested = new URL(String(input));
    const method = requested.pathname.split("/").pop() ?? "";
    const body = init?.body
      ? JSON.parse(String(init.body)) as Record<string, unknown>
      : Object.fromEntries(requested.searchParams) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "conversations.info") {
      if (overrides.infoError) return json({ ok: false, error: overrides.infoError });
      return json({ ok: true, channel: { id: body.channel, is_private: false, is_ext_shared: overrides.external === true } });
    }
    if (method === "chat.unfurl" && overrides.unfurlError) {
      return json({ ok: false, error: overrides.unfurlError });
    }
    return json({ ok: true });
  }) as unknown as typeof fetch;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function unfurlBody(calls: SlackCall[]): string {
  const call = calls.find((entry) => entry.method === "chat.unfurl");
  return JSON.stringify(call?.body ?? {});
}

describe("Slack work-stream unfurl refresh", () => {
  it("rewrites a posted card when the work stream changes status", async () => {
    const database = await seed({ harnessStatus: "needs_input", renderedStatus: "running" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    const body = unfurlBody(calls);
    expect(body).toContain("Needs input");
    expect(body).toContain("Quarterly planning");
    expect(body).not.toContain("Running");
    // The row now claims what the card claims, so the next sweep does nothing.
    expect(renderedStatus(database)).toBe("needs_input");
  });

  it("leaves a card alone when its status still matches", async () => {
    const database = await seed({ harnessStatus: "running", renderedStatus: "running" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
  });

  it("does not rewrite a card when the status moved but the badge did not", async () => {
    // completed -> idle drifts the row, but both render without a badge, so
    // posting would spend a chat.unfurl rewriting the card into itself. The
    // row still has to advance or it re-matches on every sweep for 30 days.
    const database = await seed({ harnessStatus: "idle", renderedStatus: "completed" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
    expect(renderedStatus(database)).toBe("idle");
  });

  it("rewrites a card when the work stream settles out of a badged state", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "needs_input" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    const body = unfurlBody(calls);
    expect(body).toContain("Quarterly planning");
    expect(body).not.toContain("Needs input");
    expect(body).not.toContain("warning");
  });

  it("redacts a card whose channel became externally shared after it was posted", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls, { external: true }));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    const body = unfurlBody(calls);
    expect(body).toContain("*Rally*");
    expect(body).not.toContain("Quarterly planning");
    expect(body).not.toContain("Completed");
  });

  it("rewrites a card recorded before hashing shipped, even if nothing moved", async () => {
    // The upgrade case. A card posted by an older build carries the old layout,
    // and its status matches, so nothing about the work stream marks it stale.
    // A null hash never matches a fresh one, so it is rewritten exactly once.
    const database = await seed({
      harnessStatus: "completed",
      renderedStatus: "completed",
      renderedHash: null,
    });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(1);
    // And it settles: the row now carries a hash, so a second pass posts nothing.
    const second: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(second));
    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);
    expect(second.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
  });

  it("rewrites a card on the next sweep when the work stream is renamed", async () => {
    // A rename changes the card without touching its status, so `updated_at`
    // moving past `refreshed_at` is what selects the row; the hash then
    // confirms the card really would differ. Inline rename from the header
    // (#60) makes this an ordinary gesture rather than a rare one.
    const database = await seed({ harnessStatus: "running", renderedStatus: "running" });
    database.prepare("UPDATE workstreams SET title = ?, updated_at = ? WHERE id = ?")
      .run("Quarterly planning (revised)", justEdited(), workstreamId);
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(unfurlBody(calls)).toContain("Quarterly planning (revised)");
  });

  it("does not repost an identical anonymous card when the status moves beneath it", async () => {
    // An anonymous card renders the same whatever the status does, so a badge
    // change under a still-external channel must not spend a rewrite on it.
    const database = await seed({
      harnessStatus: "needs_input",
      renderedStatus: "completed",
      renderedAnonymous: 1,
    });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls, { external: true }));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
    expect(renderedStatus(database)).toBe("needs_input");
  });

  it("settles a work-stream edit that never reaches the card", async () => {
    // The objective is not rendered, so bumping `updated_at` selects the row
    // but the hash matches and nothing is posted. Every field the selection
    // query reads has to advance anyway, or this row is re-selected on every
    // sweep for the next 30 days.
    const database = await seed({ harnessStatus: "running", renderedStatus: "running" });
    database.prepare("UPDATE workstreams SET objective = ?, updated_at = ? WHERE id = ?")
      .run("A revised objective the card never shows", justEdited(), workstreamId);
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);
    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);

    // The row must no longer select, or the sweep spins on it forever.
    const row = database.prepare(
      "SELECT refreshed_at, updated_at FROM slack_unfurled_links l JOIN workstreams w ON w.id = l.workstream_id",
    ).get() as { refreshed_at: string; updated_at: string };
    expect(row.refreshed_at >= row.updated_at).toBe(true);
  });

  it("ignores links shared too long ago to still be read", async () => {
    const database = await seed({
      harnessStatus: "completed",
      renderedStatus: "running",
      sharedAt: "2020-01-01T00:00:00.000Z",
    });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
  });

  it("drops a row whose message is gone rather than retrying it forever", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    vi.stubGlobal("fetch", slackFixture([], { unfurlError: "cannot_find_message" }));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(rowCount(database)).toBe(0);
  });

  it("keeps a row after a transient failure so the next sweep retries it", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    vi.stubGlobal("fetch", slackFixture([], { unfurlError: "ratelimited" }));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(rowCount(database)).toBe(1);
    // Unchanged, so the work stream still reads as drifted on the next pass.
    expect(renderedStatus(database)).toBe("running");
  });

  it("redacts a card when its channel goes externally shared, with no status change", async () => {
    // The status is untouched, so only the audience clock selects this row.
    // Without that clock the card would keep showing the work stream to Slack
    // Connect participants until some unrelated status change happened to fire.
    const database = await seed({
      harnessStatus: "running",
      renderedStatus: "running",
      audienceCheckedAt: "2020-01-01T00:00:00.000Z",
    });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls, { external: true }));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    const body = unfurlBody(calls);
    expect(body).toContain("*Rally*");
    expect(body).not.toContain("Quarterly planning");
    expect(renderedAnonymous(database)).toBe(1);
  });

  it("revalidates a due card without rewriting it when nothing actually changed", async () => {
    const database = await seed({
      harnessStatus: "running",
      renderedStatus: "running",
      audienceCheckedAt: "2020-01-01T00:00:00.000Z",
    });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    // Checked, found unchanged, and left alone — rewriting an identical card
    // would spend the workspace's chat.unfurl budget for no visible change.
    expect(calls.filter((call) => call.method === "conversations.info")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
    expect(audienceCheckedAt(database) > "2021-01-01T00:00:00.000Z").toBe(true);
  });

  it("leaves a card untouched when the audience lookup itself fails", async () => {
    // Fail-closed is right when posting a new card and wrong when rewriting
    // one: a five-second timeout must not trade a correct summary card for the
    // anonymous form and then persist that as the truth.
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls, { infoError: "ratelimited" }));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
    // Still drifted, so the next sweep retries rather than believing it is current.
    expect(renderedStatus(database)).toBe("running");
    expect(renderedAnonymous(database)).toBe(0);
  });

  it("ignores a card whose work stream has been archived", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    database.prepare("UPDATE workstreams SET archived_at = ? WHERE id = ?")
      .run("2026-08-10T13:00:00.000Z", workstreamId);
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
  });

  it("advances an archived work stream's link so the sweep stops coming back for it", async () => {
    // Post-cutover, the card's work stream is read from WorkspaceDO and an
    // archived one is skipped — correctly, there is no card to refresh. But
    // the sweep's due time is the oldest `refreshed_at` in the table, and a
    // skipped row that never advanced pinned every other card in the
    // workspace: the sweep came straight back, and since the stall gate would
    // have been held and reported for a link nobody will ever refresh.
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    openWorkstreamAuthorityForTest(database);
    const before = database.prepare("SELECT refreshed_at FROM slack_unfurled_links").get() as { refreshed_at: string };
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));
    const env = environment(database, {
      APP_ENV: "test",
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: {
          lookupWorkstreamDirectory: async () => ({
            items: [{
              workstreamId,
              title: "Quarterly planning",
              description: "",
              scope: "workspace",
              state: "completed",
              systemKind: null,
              lastActivityAt: "2026-08-10T12:00:00.000Z",
              archivedAt: "2026-08-10T13:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              originType: "ad_hoc",
              originLabel: null,
              createdByUserId: userId,
              automationRunId: null,
              plannedFor: null,
            }],
          }),
        },
      }),
    });

    await refreshSlackWorkstreamUnfurls(env, workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
    const after = database.prepare("SELECT refreshed_at FROM slack_unfurled_links").get() as { refreshed_at: string };
    expect(after.refreshed_at > before.refreshed_at).toBe(true);
  });

  it("still refreshes rows on a connection the database believes is broken", async () => {
    // A `needs_reconnect` row records one past moment and nothing re-checks it.
    // Skipping the sweep on that belief left cards permanently stale on
    // installations that had already been repaired, and Slack is the only
    // thing that can say whether the token still works.
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    database.prepare("UPDATE connector_connections SET status = 'needs_reconnect' WHERE id = ?")
      .run(connectionId);
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.length).toBeGreaterThan(0);
  });

  it("skips rows on a connection a person disabled", async () => {
    // The one status that is a decision rather than a belief.
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    database.prepare("UPDATE connector_connections SET status = 'disabled' WHERE id = ?")
      .run(connectionId);
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls).toHaveLength(0);
  });

  it("does not let one busy connection starve every other workspace", async () => {
    // The per-connection cap has to be applied before the global one. Taking
    // the global 100 first and trimming per connection afterwards lets the
    // busiest workspace fill every slot, and a workspace that keeps producing
    // stale cards would then starve the rest indefinitely.
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    for (let index = 0; index < 110; index += 1) {
      database.prepare(
        `INSERT INTO slack_unfurled_links
         (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
          rendered_status, rendered_anonymous, rendered_hash, audience_checked_at,
          shared_at, refreshed_at)
         VALUES (?, 'CBUSY', ?, ?, ?, ?, 'running', 0, NULL, ?, ?, ?)`,
      ).run(connectionId, `1700000${String(index).padStart(3, "0")}.000000`, url,
        workspaceId, workstreamId, nowish(), nowish(), nowish());
    }
    const quiet = await addQuietWorkspace(database);
    database.prepare(
      `INSERT INTO slack_unfurled_links
       (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
        rendered_status, rendered_anonymous, rendered_hash, audience_checked_at,
        shared_at, refreshed_at)
       VALUES (?, 'CQUIET', '1700000500.000000', ?, ?, ?, 'running', 0, NULL, ?, ?, ?)`,
    ).run(quiet.connectionId, url, quiet.workspaceId, quiet.workstreamId,
      nowish(), nowish(), nowish());
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    const unfurled = calls.filter((call) => call.method === "chat.unfurl");
    const quietCalls = unfurled.filter((call) => call.body.channel === "CQUIET");
    const busyCalls = unfurled.filter((call) => call.body.channel !== "CQUIET");
    expect(quietCalls).toHaveLength(1);
    expect(busyCalls.length).toBeLessThanOrEqual(20);
  });

  it("checks the channel audience once per channel, not once per card", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    database.prepare(
      `INSERT INTO slack_unfurled_links
       (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
        rendered_status, rendered_anonymous, rendered_hash, audience_checked_at,
        shared_at, refreshed_at)
       VALUES (?, 'CGENERAL', '1700000009.000000', ?, ?, ?, 'running', 0, NULL, ?, ?, ?)`,
    ).run(connectionId, url, workspaceId, workstreamId, nowish(), nowish(), nowish());
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database), workspaceId);

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "conversations.info")).toHaveLength(1);
  });
});

function nowish(): string {
  return new Date(Date.now() - 60_000).toISOString();
}

/** Strictly after `nowish()`, so an edit really does outrun `refreshed_at`. */
function justEdited(): string {
  return new Date().toISOString();
}

function renderedAnonymous(database: DatabaseSync): number {
  return Number((database.prepare(
    "SELECT rendered_anonymous FROM slack_unfurled_links LIMIT 1",
  ).get() as { rendered_anonymous: number }).rendered_anonymous);
}

function audienceCheckedAt(database: DatabaseSync): string {
  return String((database.prepare(
    "SELECT audience_checked_at FROM slack_unfurled_links LIMIT 1",
  ).get() as { audience_checked_at: string }).audience_checked_at);
}

function renderedStatus(database: DatabaseSync): string {
  return String((database.prepare(
    "SELECT rendered_status FROM slack_unfurled_links LIMIT 1",
  ).get() as { rendered_status: string }).rendered_status);
}

function rowCount(database: DatabaseSync): number {
  return Number((database.prepare(
    "SELECT COUNT(*) AS count FROM slack_unfurled_links",
  ).get() as { count: number }).count);
}

/** A second Rally workspace with its own Slack installation and work stream. */
async function addQuietWorkspace(database: DatabaseSync): Promise<{
  connectionId: string;
  workspaceId: string;
  workstreamId: string;
}> {
  const quiet = {
    connectionId: "00000000-0000-7000-8000-000000000044",
    workspaceId: "00000000-0000-7000-8000-000000000045",
    workstreamId: "019fec70-fba0-7b0e-9f7a-3dd1ef565210",
  };
  const encrypted = await encryptString(JSON.stringify({
    botAccessToken: "xoxb-refresh-test",
    oauthScopes: [...SlackWorkspaceBotScopes],
  }), credentialsKey, quiet.connectionId);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Quiet', 'quiet', 'global', ?, '2026-01-01', '2026-01-01')`,
  ).run(quiet.workspaceId, userId);
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
      model_plugin_id)
     VALUES (?, ?, 'slack', 'workspace', NULL, 'TQUIET', 'Slack', ?, ?, 1,
             '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
             'plugin_slack_workspace')`,
  ).run(quiet.connectionId, quiet.workspaceId, encrypted.ciphertext, encrypted.iv);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, objective, origin_type, created_by_user_id,
      harness_status, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'Quiet planning', '', 'ad_hoc', ?, 'completed',
             '2026-08-10T11:00:00.000Z', '2026-01-01', '2026-01-01')`,
  ).run(quiet.workstreamId, quiet.workspaceId, userId);
  return quiet;
}

/** The hash of the card the sweep would render for this work stream now. */
async function currentCardHash(input: {
  harnessStatus: string;
  anonymous?: boolean;
}): Promise<string> {
  return workstreamUnfurlCardHash(workstreamUnfurlBlocks(
    input.anonymous
      ? null
      : {
          title: "Quarterly planning",
          harnessStatus: input.harnessStatus,
          lastActivityAt: "2026-08-10T12:00:00.000Z",
        },
    url,
  ));
}

async function seed(input: {
  harnessStatus: string;
  renderedStatus: string;
  sharedAt?: string;
  renderedAnonymous?: number;
  audienceCheckedAt?: string;
  /** Omit for a row recorded before hashing shipped, which forces one rewrite. */
  renderedHash?: string | null;
}): Promise<DatabaseSync> {
  const database = migratedDatabase();
  const encrypted = await encryptString(JSON.stringify({
    botAccessToken: "xoxb-refresh-test",
    oauthScopes: [...SlackWorkspaceBotScopes],
  }), credentialsKey, connectionId);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'owner-subject', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', '${userId}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${workspaceId}', '${userId}', 'owner', 'active', '2026-01-01');
  `);
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      granted_scopes_json, status, cursor_json, config_json, created_at, updated_at,
      model_plugin_id)
     VALUES (?, ?, 'slack', 'workspace', NULL, 'TACME', 'Slack · Acme', ?, ?, 1,
             '["slack.agent"]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
             'plugin_slack_workspace')`,
  ).run(connectionId, workspaceId, encrypted.ciphertext, encrypted.iv);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, objective, origin_type, created_by_user_id,
      harness_status, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'Quarterly planning', '', 'ad_hoc', ?, ?, '2026-08-10T12:00:00.000Z',
             '2026-01-01', '2026-01-01')`,
  ).run(workstreamId, workspaceId, userId, input.harnessStatus);
  database.prepare(
    `INSERT INTO slack_unfurled_links
     (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
      rendered_status, rendered_anonymous, rendered_hash, audience_checked_at,
      shared_at, refreshed_at)
     VALUES (?, 'CGENERAL', '1700000000.000000', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    connectionId,
    url,
    workspaceId,
    workstreamId,
    input.renderedStatus,
    input.renderedAnonymous ?? 0,
    input.renderedHash === undefined
      ? await currentCardHash({
          harnessStatus: input.renderedStatus,
          anonymous: input.renderedAnonymous === 1,
        })
      : input.renderedHash,
    input.audienceCheckedAt ?? nowish(),
    input.sharedAt ?? nowish(),
    input.sharedAt ?? nowish(),
  );
  return database;
}

function migratedDatabase(): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  return database;
}

/**
 * The workspace directory the sweep reads, over the same seeded rows.
 *
 * The sweep asks WorkspaceDO which of the linked work streams changed; a test
 * that binds nothing here used to fall through to a D1 query that migration
 * 0090 made unreachable, so its selection, hash-gate and bound assertions were
 * proving a path production does not run. The stub answers the lookup and
 * nothing else — the object's own directory SQL is
 * `test-workers/durable-object-runtime.test.ts`'s.
 */
function directoryNamespace(database: DatabaseSync): DurableObjectNamespace {
  return testSubstreamAgentsBinding(database, {
    extra: {
      lookupWorkstreamDirectory: async (input: { workstreamIds: string[] }) => ({
        items: database.prepare(
          `SELECT id, title, harness_status, last_activity_at, origin_type,
                  archived_at, updated_at
             FROM workstreams
            WHERE id IN (${input.workstreamIds.map(() => "?").join(", ")})`,
        ).all(...input.workstreamIds as SQLInputValue[]).map((row) => {
          const item = row as Record<string, unknown>;
          return {
            workstreamId: String(item.id),
            title: String(item.title),
            description: "",
            scope: "workspace",
            state: String(item.harness_status),
            systemKind: null,
            originType: String(item.origin_type),
            originLabel: null,
            lastActivityAt: String(item.last_activity_at),
            archivedAt: item.archived_at == null ? null : String(item.archived_at),
            updatedAt: String(item.updated_at),
          };
        }),
      }),
    },
  });
}

function environment(
  database: DatabaseSync,
  overrides: { APP_ENV?: Env["APP_ENV"]; WORKSPACE_DOS?: DurableObjectNamespace } = {},
): Env {
  return createTestEnv({
    WORKSPACE_DOS: directoryNamespace(database),
    ...overrides,
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    CONNECTOR_CREDENTIALS_KEY: credentialsKey,
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.test",
    SLACK_APP_ID: "A1",
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    SLACK_SIGNING_SECRET: "signing",
  });
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { values = next; return statement; },
      async first<T>() {
        return (database.prepare(sql).get(...values as SQLInputValue[]) as T | undefined) ?? null;
      },
      async all<T>() {
        return createTestD1Result<T>({
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        });
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
        return createTestD1Result<T>({
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<unknown>[] = [];
      for (const statement of statements) results.push(await statement.run());
      return createTestD1Results<T>(results);
    },
  });
}
