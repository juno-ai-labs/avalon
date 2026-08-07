import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { ConnectionService } from "../src/services/connection-service";

const userId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000002";
const workspaceId = "00000000-0000-7000-8000-000000000003";
const connectionId = "00000000-0000-7000-8000-000000000004";
const at = "2026-08-07T00:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Slack Agent policy", () => {
  it("returns safe defaults for a legacy install and persists admin updates atomically", async () => {
    const database = migratedDatabase();
    seed(database);
    const service = new ConnectionService(environment(database), auth("owner", userId));

    await expect(service.getSlackAgentPolicy(connectionId)).resolves.toEqual({
      allowUnlinkedWorkspaceTasks: true,
      publicChannelMode: "all_invited",
      privateChannelMode: "disabled",
      allowDirectMessages: true,
      allowCommands: true,
      allowShortcuts: true,
      allowlistedChannels: [],
    });

    const updated = {
      allowUnlinkedWorkspaceTasks: true,
      publicChannelMode: "allowlist" as const,
      privateChannelMode: "allowlist" as const,
      allowDirectMessages: false,
      allowCommands: true,
      allowShortcuts: false,
      allowlistedChannels: [
        { channelId: "CPUBLIC", channelType: "public" as const },
        { channelId: "GPRIVATE", channelType: "private" as const },
      ],
    };
    await expect(service.updateSlackAgentPolicy(connectionId, updated)).resolves.toEqual(updated);
    expect(database.prepare(
      "SELECT public_channel_mode, private_channel_mode, allow_direct_messages, allow_shortcuts FROM slack_agent_policies WHERE connection_id = ?",
    ).get(connectionId)).toEqual({
      public_channel_mode: "allowlist",
      private_channel_mode: "allowlist",
      allow_direct_messages: 0,
      allow_shortcuts: 0,
    });
    expect(database.prepare(
      "SELECT slack_channel_id, channel_type FROM slack_agent_channel_allowlist WHERE connection_id = ? ORDER BY slack_channel_id",
    ).all(connectionId)).toEqual([
      { slack_channel_id: "CPUBLIC", channel_type: "public" },
      { slack_channel_id: "GPRIVATE", channel_type: "private" },
    ]);
  });

  it("requires a workspace administrator", async () => {
    const database = migratedDatabase();
    seed(database);
    await expect(new ConnectionService(environment(database), auth("member", memberId))
      .getSlackAgentPolicy(connectionId)).rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
  });
});

function auth(role: AuthContext["role"], id: string): AuthContext {
  return { sessionId: `session-${id}`, userId: id, workspaceId, region: "global", role };
}

function seed(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${userId}', 'owner-sub', 'owner@example.com', 'Owner', '${at}', '${at}'),
      ('${memberId}', 'member-sub', 'member@example.com', 'Member', '${at}', '${at}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', '${userId}', '${at}', '${at}');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES
      ('${workspaceId}', '${userId}', 'owner', 'active', '${at}'),
      ('${workspaceId}', '${memberId}', 'member', 'active', '${at}');
    INSERT INTO connector_connections
      (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
       display_name, granted_scopes_json, model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
      VALUES ('${connectionId}', '${workspaceId}', 'slack', 'workspace', NULL, 'TACME',
       'Slack · Acme', '["slack.agent"]', 'plugin_slack', 'healthy', '{}', '{}', '${at}', '${at}');
  `);
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
  return { DB: sqliteD1(database), AVALON_REGION: "global" } as Env;
}

function sqliteD1(database: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...next: unknown[]) { values = next; return statement; },
        async first<T>() { return (database.prepare(sql).get(...values as never[]) ?? null) as T | null; },
        async all<T>() { return { results: database.prepare(sql).all(...values as never[]) as T[], success: true, meta: {} } as unknown as D1Result<T>; },
        async run<T>() { return { success: true, meta: database.prepare(sql).run(...values as never[]) } as unknown as D1Result<T>; },
      };
      return statement as unknown as D1PreparedStatement;
    },
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  } as unknown as D1Database;
}
