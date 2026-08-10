import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SlackWorkspaceBotScopes } from "@avalon/connectors";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { encryptString } from "../src/lib/crypto";
import { refreshSlackWorkstreamUnfurls } from "../src/services/slack-unfurl-refresh";

const connectionId = "00000000-0000-7000-8000-000000000041";
const workspaceId = "00000000-0000-7000-8000-000000000042";
const userId = "00000000-0000-7000-8000-000000000043";
const workstreamId = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";
const credentialsKey = "slack-unfurl-refresh-test-key";
const url = `https://with-avalon.com/app/workstreams/${workstreamId}`;
const databases: DatabaseSync[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

interface SlackCall { method: string; body: Record<string, unknown> }

function slackFixture(
  calls: SlackCall[],
  overrides: { external?: boolean; unfurlError?: string } = {},
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

    await refreshSlackWorkstreamUnfurls(environment(database));

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

    await refreshSlackWorkstreamUnfurls(environment(database));

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
  });

  it("redacts a card whose channel became externally shared after it was posted", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls, { external: true }));

    await refreshSlackWorkstreamUnfurls(environment(database));

    const body = unfurlBody(calls);
    expect(body).toContain("*Avalon*");
    expect(body).not.toContain("Quarterly planning");
    expect(body).not.toContain("Completed");
  });

  it("ignores links shared too long ago to still be read", async () => {
    const database = await seed({
      harnessStatus: "completed",
      renderedStatus: "running",
      sharedAt: "2020-01-01T00:00:00.000Z",
    });
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database));

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(0);
  });

  it("drops a row whose message is gone rather than retrying it forever", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    vi.stubGlobal("fetch", slackFixture([], { unfurlError: "cannot_find_message" }));

    await refreshSlackWorkstreamUnfurls(environment(database));

    expect(rowCount(database)).toBe(0);
  });

  it("keeps a row after a transient failure so the next sweep retries it", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    vi.stubGlobal("fetch", slackFixture([], { unfurlError: "ratelimited" }));

    await refreshSlackWorkstreamUnfurls(environment(database));

    expect(rowCount(database)).toBe(1);
    // Unchanged, so the work stream still reads as drifted on the next pass.
    expect(renderedStatus(database)).toBe("running");
  });

  it("checks the channel audience once per channel, not once per card", async () => {
    const database = await seed({ harnessStatus: "completed", renderedStatus: "running" });
    database.prepare(
      `INSERT INTO slack_unfurled_links
       (connection_id, slack_channel_id, slack_message_ts, url, workspace_id, workstream_id,
        rendered_status, shared_at, refreshed_at)
       VALUES (?, 'CGENERAL', '1700000009.000000', ?, ?, ?, 'running', ?, ?)`,
    ).run(connectionId, url, workspaceId, workstreamId, nowish(), nowish());
    const calls: SlackCall[] = [];
    vi.stubGlobal("fetch", slackFixture(calls));

    await refreshSlackWorkstreamUnfurls(environment(database));

    expect(calls.filter((call) => call.method === "chat.unfurl")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "conversations.info")).toHaveLength(1);
  });
});

function nowish(): string {
  return new Date(Date.now() - 60_000).toISOString();
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

async function seed(input: {
  harnessStatus: string;
  renderedStatus: string;
  sharedAt?: string;
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
      rendered_status, shared_at, refreshed_at)
     VALUES (?, 'CGENERAL', '1700000000.000000', ?, ?, ?, ?, ?, ?)`,
  ).run(
    connectionId,
    url,
    workspaceId,
    workstreamId,
    input.renderedStatus,
    input.sharedAt ?? nowish(),
    input.sharedAt ?? nowish(),
  );
  return database;
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = new URL("../../../packages/db/migrations/", import.meta.url);
  for (const fileName of readdirSync(migrations).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(fileName, migrations), "utf8"));
  }
  return database;
}

function environment(database: DatabaseSync): Env {
  return {
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
  } as unknown as Env;
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
        return {
          success: true,
          results: database.prepare(sql).all(...values as SQLInputValue[]) as T[],
          meta: { changes: 0 },
        } as unknown as D1Result<T>;
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as SQLInputValue[]);
        return {
          success: true,
          results: [],
          meta: { changes: Number(result.changes) },
        } as unknown as D1Result<T>;
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
