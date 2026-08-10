import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";

vi.mock("../src/services/workstream-email-routing-service", () => ({
  WorkstreamEmailRoutingService: class {
    async reserve() {
      return { emailAddress: "calm-bright-gentle-otter@automation.with-avalon.com" };
    }
    async activateWorkstreamRoute() {
      return undefined;
    }
  },
}));
vi.mock("../src/services/integrations", () => ({
  publishWorkstreamEvent: vi.fn(async () => undefined),
}));
vi.mock("../src/services/workstream-service", () => ({
  launchWorkstreamHarness: vi.fn(async () => "harness-run"),
}));

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Slack work stream creator attribution", () => {
  const slackOrigin = {
    teamId: "T123",
    channelId: "C123",
    channelName: "general",
    threadTs: "123.456",
    invocationType: "app_mention" as const,
    channelType: "public" as const,
    matchedAvalonUserId: "user-taylor",
    nearbyMessagesStatus: "available" as const,
    nearbyMessages: [],
    attachments: [],
  };
  const actor = {
    provider: "slack" as const,
    providerAccountId: "T123",
    providerUserId: "U456",
    displayName: "Taylor",
    avatarUrl: null,
  };

  it("credits the mapped Avalon member who started the task from Slack", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database), AVALON_REGION: "global" } as unknown as Env;

    const created = await new SlackWorkspaceWorkstreamService(env, "workspace-slack").create({
      actor,
      title: "Investigate the alert",
      objective: "Investigate the alert",
      text: "Investigate the alert",
      clientMessageId: "event:opening",
      creatorUserId: "user-taylor",
      slackOrigin,
    });

    expect(created.workstream.createdByUserId).toBe("user-taylor");
    expect(database.prepare(
      "SELECT created_by_user_id FROM workstreams WHERE id = ?",
    ).get(created.workstream.id)).toEqual({ created_by_user_id: "user-taylor" });
    expect(database.prepare(
      "SELECT user_id, participation_reason FROM workstream_participants WHERE workstream_id = ?",
    ).get(created.workstream.id)).toEqual({
      user_id: "user-taylor",
      participation_reason: "creator",
    });
    // Attribution never rewrites authorship: the opening message stays the
    // external Slack member's, so the audit trail keeps the provider identity.
    expect(database.prepare(
      "SELECT author_type, author_user_id, external_actor_json FROM messages WHERE workstream_id = ?",
    ).get(created.workstream.id)).toMatchObject({
      author_type: "system",
      author_user_id: null,
      external_actor_json: JSON.stringify(actor),
    });
  });

  it("leaves the task ownerless when Slack cannot map the member to Avalon", async () => {
    const database = seededDatabase();
    const env = { DB: sqliteD1(database), AVALON_REGION: "global" } as unknown as Env;

    const created = await new SlackWorkspaceWorkstreamService(env, "workspace-slack").create({
      actor,
      title: "Investigate the alert",
      objective: "Investigate the alert",
      text: "Investigate the alert",
      clientMessageId: "event:opening",
      slackOrigin: { ...slackOrigin, matchedAvalonUserId: null },
    });

    expect(created.workstream.createdByUserId).toBeNull();
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstream_participants WHERE workstream_id = ?",
    ).get(created.workstream.id)).toEqual({ count: 0 });
  });
});

function seededDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
      ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('workspace-slack', 'Slack Workspace', 'slack-workspace', 'global', 'user-owner',
            '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('workspace-slack', 'user-owner', 'owner', 'active', '2026-01-01'),
      ('workspace-slack', 'user-taylor', 'member', 'active', '2026-01-01');
  `);
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
