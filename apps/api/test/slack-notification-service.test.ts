import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { encryptString } from "../src/lib/crypto";
import { sendWorkstreamMentionSlack } from "../src/services/slack-notification-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import { legacyProductSqliteDatabase } from "./helpers/sqlite-d1";

vi.mock("../src/services/workstream-link-service", async () => {
  const { workstreamCanonicalUrl } = await import("@rally/contracts");
  return { canonicalWorkstreamUrl: async (env: Env, target: { region: "global"; workspaceId: string; workstreamId: string; substreamId?: string }) =>
    workstreamCanonicalUrl(env.PUBLIC_WEB_BASE_URL, { ...target, spaceId: "00000000-0000-7000-8000-000000000002" }) };
});

const workspaceId = "00000000-0000-7000-8000-000000000001";
const authorId = "00000000-0000-7000-8000-000000000002";
const recipientId = "00000000-0000-7000-8000-000000000003";
const workstreamId = "00000000-0000-7000-8000-000000000004";
const connectionId = "00000000-0000-7000-8000-000000000005";
const secondConnectionId = "00000000-0000-7000-8000-000000000007";
const at = "2026-08-06T20:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
});

describe("workspace Slack mention delivery", () => {
  it("matches an unlinked active Slack member by exact email and sends a bot DM without creating a link", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const request = slackApiFixture(calls);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("sent");

    expect(calls.map((call) => call.method)).toEqual([
      "users.lookupByEmail",
      "conversations.open",
      "chat.postMessage",
    ]);
    expect(calls[0]?.body).toEqual({ email: "ada@example.com" });
    expect(calls[1]?.body).toEqual({ users: "UADA" });
    expect(calls[2]?.body).toMatchObject({ channel: "DADA" });
    expect(String(calls[2]?.body.text)).toContain("Author Person mentioned you");
    expect(String(calls[2]?.body.text)).toContain("@Ada Lovelace");
    expect(String(calls[2]?.body.text)).not.toContain(`person:${recipientId}`);
    expect(String(calls[2]?.body.text)).not.toContain(`person://${recipientId}`);
    expect(String(calls[2]?.body.text)).toContain("Open in Rally");
    // Slack can only unfurl a link on the app's registered domain, and the id
    // must sit in the path rather than a fragment for the unfurl handler to
    // read it back off the shared URL.
    expect(String(calls[2]?.body.text)).toContain(
      "https://with-avalon.com/app/global/1111117Hxt1fAWDjN7TW/s/1111117Hxt1fAWDjN7TX/c/",
    );
    expect(String(calls[2]?.body.text)).not.toContain("avalon://");
    expect(String(calls[2]?.body.text)).not.toContain("/open#");
    expect(calls[2]?.body.client_msg_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(database.prepare("SELECT COUNT(*) AS count FROM slack_user_links").get()).toEqual({ count: 0 });
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_destination_resolved",
      connection_id: connectionId,
      provider_account_id: "TACME",
      slack_user_id: "UADA",
      resolution_mode: "email_lookup",
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_chunk_terminal",
      channel_id: "DADA",
      slack_user_id: "UADA",
      slack_message_ts: "1786060000.001",
      thread_ts: "1786060000.001",
      chunk_index: 0,
      outcome: "sent",
    }));
  });

  it("prefers a confirmed Slack identity and does not perform email lookup", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, true);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const request = slackApiFixture(calls);

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("sent");

    expect(calls.map((call) => call.method)).toEqual(["conversations.open", "chat.postMessage"]);
    expect(calls[0]?.body).toEqual({ users: "ULINKED" });
  });

  it("accepts an active human who authorized the app when deleted is omitted", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const request = slackApiFixture(calls, {
      user: { id: "UAPPUSER", team_id: "TACME", is_bot: false, is_app_user: true },
    });

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("sent");

    expect(calls.map((call) => call.method)).toEqual([
      "users.lookupByEmail",
      "conversations.open",
      "chat.postMessage",
    ]);
  });

  it("selects the only exact-email match across multiple workspace installs", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    await seedConnection(database, env, secondConnectionId, "TOTHER", "2026-08-06T20:01:00.000Z");
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];

    await expect(sendWorkstreamMentionSlack(env, mention(), slackApiFixture(calls, undefined, {
      lookupResponseByToken: {
        "Bearer xoxb-TACME": { ok: true, user: { id: "UACME", team_id: "TACME", deleted: false, is_bot: false } },
        "Bearer xoxb-TOTHER": { ok: false, error: "users_not_found" },
      },
    }))).resolves.toBe("sent");

    expect(calls.map((call) => call.method)).toEqual([
      "users.lookupByEmail",
      "users.lookupByEmail",
      "conversations.open",
      "chat.postMessage",
    ]);
  });

  it("finds a unique match after an earlier installed team returns users_not_found", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    await seedConnection(database, env, secondConnectionId, "TOTHER", "2026-08-06T20:01:00.000Z");
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];

    await expect(sendWorkstreamMentionSlack(env, mention(), slackApiFixture(calls, undefined, {
      lookupResponseByToken: {
        "Bearer xoxb-TACME": { ok: false, error: "users_not_found" },
        "Bearer xoxb-TOTHER": { ok: true, user: { id: "UOTHER", team_id: "TOTHER", deleted: false, is_bot: false } },
      },
    }))).resolves.toBe("sent");

    expect(calls.map((call) => call.method)).toEqual([
      "users.lookupByEmail",
      "users.lookupByEmail",
      "conversations.open",
      "chat.postMessage",
    ]);
  });

  it("skips Slack when exact-email matches in multiple installed Slack teams", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    await seedConnection(database, env, secondConnectionId, "TOTHER", "2026-08-06T20:01:00.000Z");
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(sendWorkstreamMentionSlack(env, mention(), slackApiFixture(calls, undefined, {
      lookupResponseByToken: {
        "Bearer xoxb-TACME": { ok: true, user: { id: "UACME", team_id: "TACME", deleted: false, is_bot: false } },
        "Bearer xoxb-TOTHER": { ok: true, user: { id: "UOTHER", team_id: "TOTHER", deleted: false, is_bot: false } },
      },
    }))).resolves.toBe("skipped");

    expect(calls.map((call) => call.method)).toEqual(["users.lookupByEmail", "users.lookupByEmail"]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_terminal",
      outcome: "skipped",
      reason: "ambiguous_email_lookup",
      active_connection_count: 2,
      lookup_match_count: 2,
    }));
  });

  it("logs every linked identity when multiple confirmed Slack links make the destination ambiguous", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, true);
    await seedConnection(database, env, secondConnectionId, "TOTHER", "2026-08-06T20:01:00.000Z");
    database.prepare(
      `INSERT INTO slack_user_links
       (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status, created_at, updated_at)
       VALUES ('00000000-0000-7000-8000-000000000008', ?, ?, ?, 'TOTHER', 'UOTHER', 'active', ?, ?)`,
    ).run(workspaceId, secondConnectionId, recipientId, at, at);
    const request: typeof fetch = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("skipped");

    expect(request).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_terminal",
      outcome: "skipped",
      reason: "multiple_confirmed_links",
      active_connection_count: 2,
      linked_connection_count: 2,
    }));
  });

  it("uses Slack-sized threaded chunks without truncating the Rally message", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const messageText = "§".repeat(80_001);

    await expect(sendWorkstreamMentionSlack(
      env,
      { ...mention(), messageText },
      slackApiFixture(calls),
      async () => undefined,
    )).resolves.toBe("sent");

    const posts = calls.filter((call) => call.method === "chat.postMessage");
    expect(posts).toHaveLength(3);
    expect(posts.every((post) => String(post.body.text).length <= 40_000)).toBe(true);
    expect(posts.map((post) => String(post.body.text)).join("").match(/§/gu)).toHaveLength(messageText.length);
    expect(posts[0]?.body).not.toHaveProperty("thread_ts");
    expect(posts[1]?.body).toMatchObject({ thread_ts: "1786060000.001" });
    expect(posts[2]?.body).toMatchObject({ thread_ts: "1786060000.001" });
  });

  it("reduces a citation, which Slack shows verbatim just like a mention's UUID", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    // An external source, deliberately: this text is Slack mrkdwn, which has no
    // `[label](url)` and no `**bold**`, so the Markdown source list the digest
    // gets would arrive here as literal syntax. A fixture whose only source is
    // internal reduces to a bare title and never exercises that.
    const messageText = "Revenue grew 40%.[^1] See [the deck](resource://board-deck).\n\n[^1]: [The memo](https://example.com/memo)";

    await expect(sendWorkstreamMentionSlack(
      env,
      { ...mention(), messageText },
      slackApiFixture(calls),
      async () => undefined,
    )).resolves.toBe("sent");

    const posted = calls.filter((call) => call.method === "chat.postMessage")
      .map((call) => String(call.body.text)).join("");
    expect(posted).not.toContain("resource:");
    expect(posted).not.toContain("[^1]");
    expect(posted).toContain("See the deck.");
    // The source reaches the channel as words and a bare URL, not as markup a
    // reader has to decode.
    expect(posted).not.toContain("**Sources**");
    expect(posted).not.toContain("](https://example.com/memo)");
    expect(posted).not.toContain("\n  1. The memo");
    expect(posted).toContain("\n1. The memo");
    expect(posted).toContain("The memo — https://example.com/memo");
  });

  it("paces and retries a rate-limited Slack chunk using Retry-After", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const sleep = vi.fn(async () => undefined);

    await expect(sendWorkstreamMentionSlack(
      env,
      mention(),
      slackApiFixture(calls, undefined, { rateLimitPostAt: 1 }),
      sleep,
    )).resolves.toBe("sent");

    expect(calls.filter((call) => call.method === "chat.postMessage")).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });

  it("records a partial Slack delivery and hands a server error back for a retry", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    // Slack answered 500 for the second chunk: a retry can finish it, and the
    // first chunk's stable client_msg_id keeps it from posting twice.
    await expect(sendWorkstreamMentionSlack(
      env,
      { ...mention(), messageText: "x".repeat(40_001) },
      slackApiFixture(calls, undefined, { failPostFrom: 2 }),
      async () => undefined,
    )).rejects.toMatchObject({ code: "provider_error" });

    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_delivery_incomplete",
      outcome: "partial",
      posted_chunks: 1,
    }));
  });

  it("rejects an email result from another Slack team and skips Slack", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    const request = slackApiFixture(calls, {
      user: { id: "UOTHER", team_id: "TOTHER", deleted: false, is_bot: false },
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("skipped");

    expect(calls.map((call) => call.method)).toEqual(["users.lookupByEmail"]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_lookup_candidate",
      connection_id: connectionId,
      provider_account_id: "TACME",
      slack_user_id: "UOTHER",
      observed_team_id: "TOTHER",
      outcome: "rejected",
      reason: "team_mismatch",
    }));
  });

  it.each(["healthy", "error"])("marks a %s installation for reconnect when Slack refuses the lookup scope", async (status) => {
    const database = migratedDatabase();
    const env = environment(database);
    await seed(database, env, false);
    database.prepare("UPDATE connector_connections SET status = ? WHERE id = ?").run(status, connectionId);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request: typeof fetch = vi.fn(async () => response({ ok: false, error: "missing_scope" }));

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("skipped");

    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_delivery_incomplete",
      outcome: "skipped",
      kind: "mention",
      source_id: "message-1",
      recipient_user_id: recipientId,
      reason: "missing_scope",
      posted_chunks: 0,
    }));
    expect(database.prepare("SELECT status FROM connector_connections WHERE id = ?").get(connectionId))
      .toEqual({ status: "needs_reconnect" });
  });

  it("skips Slack without making a request when no healthy workspace installation exists", async () => {
    const database = migratedDatabase();
    const env = environment(database);
    seedWorkspace(database);
    const request: typeof fetch = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await expect(sendWorkstreamMentionSlack(env, mention(), request)).resolves.toBe("skipped");
    expect(request).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "slack_notification_terminal",
      outcome: "skipped",
      reason: "no_active_workspace_installation",
      active_connection_count: 0,
    }));
  });
});

function mention() {
  return {
    messageId: "message-1",
    recipientUserId: recipientId,
    recipientEmail: "ada@example.com",
    authorName: "Author Person",
    workspaceId,
    workspaceName: "Avalon Studio",
    workstreamId,
    workstreamTitle: "Mention review",
    messageText: `Please ask [@Ada Lovelace](person:${recipientId}).`,
  };
}

function slackApiFixture(
  calls: Array<{ method: string; body: Record<string, unknown> }>,
  lookup: Record<string, unknown> = { user: { id: "UADA", team_id: "TACME", deleted: false, is_bot: false } },
  behavior: {
    failPostFrom?: number;
    rateLimitPostAt?: number;
    lookupResponseByToken?: Record<string, Record<string, unknown>>;
  } = {},
): typeof fetch {
  return vi.fn(async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const method = url.pathname.split("/").pop()!;
    const body = init?.method === "GET"
      ? Object.fromEntries(url.searchParams)
      : JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body });
    if (method === "users.lookupByEmail") {
      expect(init?.method).toBe("GET");
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      return response(behavior.lookupResponseByToken?.[authorization] ?? { ok: true, ...lookup });
    }
    if (method === "conversations.open") return response({ ok: true, channel: { id: "DADA" } });
    if (method === "chat.postMessage") {
      const postAttempt = calls.filter((call) => call.method === "chat.postMessage").length;
      if (postAttempt === behavior.rateLimitPostAt) {
        return response({ ok: false, error: "ratelimited" }, 429, { "retry-after": "0" });
      }
      if (behavior.failPostFrom !== undefined && postAttempt >= behavior.failPostFrom) {
        return response({ ok: false, error: "internal_error" }, 500);
      }
      return response({ ok: true, channel: "DADA", ts: "1786060000.001" });
    }
    throw new Error(`Unexpected Slack method ${method}`);
  }) as typeof fetch;
}

function response(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) } });
}

function environment(database: DatabaseSync): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    CONNECTOR_CREDENTIALS_KEY: "test-connector-credentials-key",
    CONNECTOR_CREDENTIALS_KEY_VERSION: "1",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    SLACK_APP_ID: "AAVALON",
    SLACK_CLIENT_ID: "client-id",
    SLACK_CLIENT_SECRET: "client-secret",
    SLACK_SIGNING_SECRET: "signing-secret",
  });
}

async function seed(database: DatabaseSync, env: Env, linked: boolean): Promise<void> {
  seedWorkspace(database);
  await seedConnection(database, env, connectionId, "TACME", at);
  if (linked) {
    database.prepare(
      `INSERT INTO slack_user_links
       (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id, status, created_at, updated_at)
       VALUES ('00000000-0000-7000-8000-000000000006', ?, ?, ?, 'TACME', 'ULINKED', 'active', ?, ?)`,
    ).run(workspaceId, connectionId, recipientId, at, at);
  }
}

async function seedConnection(
  database: DatabaseSync,
  env: Env,
  id: string,
  teamId: string,
  updatedAt: string,
): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify({ botAccessToken: `xoxb-${teamId}` }),
    env.CONNECTOR_CREDENTIALS_KEY,
    id,
  );
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, encrypted_credentials, credential_iv, credential_key_version,
      granted_scopes_json, model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
     VALUES (?, ?, 'slack', 'workspace', NULL, ?, ?, ?, ?, 1,
       '["slack.agent","slack.notifications.write"]', ?, 'healthy', '{}', '{}', ?, ?)`,
  ).run(
    id,
    workspaceId,
    teamId,
    `Slack · ${teamId}`,
    encrypted.ciphertext,
    encrypted.iv,
    `plugin_slack_${teamId.toLowerCase()}`,
    at,
    updatedAt,
  );
}

function seedWorkspace(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-author', 'author@example.com', 'Author Person', ?, ?),
       (?, 'google-ada', 'ada@example.com', 'Ada Lovelace', ?, ?)`,
  ).run(authorId, at, at, recipientId, at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, authorId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?), (?, ?, 'member', 'active', ?)`,
  ).run(workspaceId, authorId, at, workspaceId, recipientId, at);
}

function migratedDatabase(): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  return database;
}

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) {
          values = next;
          return statement;
        },
        async first<T>() {
          return (database.prepare(sql).get(...values as never[]) ?? null) as T | null;
        },
        async all<T>() {
          return createTestD1Result<T>({ results: database.prepare(sql).all(...values as never[]) as T[], success: true, meta: {} });
        },
        async run<T>() {
          return createTestD1Result<T>({ success: true, meta: database.prepare(sql).run(...values as never[]) });
        },
      };
      return createTestD1PreparedStatement(statement);
    },
  });
}
