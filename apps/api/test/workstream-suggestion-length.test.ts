import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { WorkstreamService } from "../src/services/workstream-service";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const authorId = "00000000-0000-7000-8000-000000000002";
const workstreamId = "00000000-0000-7000-8000-000000000003";
const connectionId = "00000000-0000-7000-8000-000000000004";
const activityId = "00000000-0000-7000-8000-000000000005";
const at = "2026-08-10T16:10:55.531Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("work-stream suggestions with oversized source fields", () => {
  it("truncates an activity title that exceeds the suggestion schema before returning it", async () => {
    const database = migratedDatabase();
    seed(database);
    // GitHub's push webhook can carry a full multi-line commit message as the
    // activity title, truncated only to the connector's own 500-character
    // cap — well past ActivitySuggestionSchema's 300-character max.
    const oversizedTitle = "juno-ai-labs/avalon: push — ".padEnd(408, "x");
    seedSuggestion(database, { activityTitle: oversizedTitle });
    const service = new WorkstreamService(environment(database), auth());

    const detail = await service.get(workstreamId);

    expect(detail.suggestions).toHaveLength(1);
    const [suggestion] = detail.suggestions;
    expect(suggestion?.title.length).toBeLessThanOrEqual(300);
    expect(suggestion?.title).toBe(oversizedTitle.slice(0, 300));
  });

  it("truncates a suggestion summary that exceeds the schema before returning it", async () => {
    const database = migratedDatabase();
    seed(database);
    const oversizedSummary = "x".repeat(2_500);
    seedSuggestion(database, { activityTitle: "Normal-length title", activitySummary: oversizedSummary });
    const service = new WorkstreamService(environment(database), auth());

    const detail = await service.get(workstreamId);

    const [suggestion] = detail.suggestions;
    expect(suggestion?.summary.length).toBeLessThanOrEqual(2_000);
    expect(suggestion?.summary).toBe(oversizedSummary.slice(0, 2_000));
  });

  it("does not shorten a title, summary, or reason that already fit the schema", async () => {
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database, { activityTitle: "Normal-length title", activitySummary: "Normal-length summary" });
    const service = new WorkstreamService(environment(database), auth());

    const detail = await service.get(workstreamId);

    const [suggestion] = detail.suggestions;
    expect(suggestion?.title).toBe("Normal-length title");
    expect(suggestion?.summary).toBe("Normal-length summary");
    expect(suggestion?.reason).toBe("Matches the workstream objective");
  });

  it("truncates an oversized activity title before it is stored as an accepted resource", async () => {
    const database = migratedDatabase();
    seed(database);
    // The activity/suggestion feed can render an oversized title once the
    // read path truncates it; accepting the suggestion must not then write
    // that same oversized title into `resources`, where ResourceSchema's
    // 300-character max would 500 every future read of this work stream.
    const oversizedTitle = "juno-ai-labs/avalon: push — ".padEnd(408, "x");
    const suggestionId = seedSuggestion(database, {
      activityTitle: oversizedTitle,
      providerResourceId: "commit-sha-1",
    });
    const service = new WorkstreamService(environment(database), auth());

    await service.resolveSuggestion(workstreamId, suggestionId, "accepted");
    const detail = await service.get(workstreamId);

    expect(detail.resources).toHaveLength(1);
    const [resource] = detail.resources;
    expect(resource?.title.length).toBeLessThanOrEqual(300);
    expect(resource?.title).toBe(oversizedTitle.slice(0, 300));
  });
});

function auth(): AuthContext {
  return {
    sessionId: "session-1",
    userId: authorId,
    workspaceId,
    region: "global",
    role: "owner",
  };
}

function environment(database: DatabaseSync): Env {
  return {
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
  } as unknown as Env;
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

function seed(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(authorId, "google-author", "author@example.com", "Author Person", null, at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, authorId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(workspaceId, authorId, at);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
      created_by_user_id, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'Avalon UX/quality of life', 'Ship a delightful Avalon experience', ?, 'active', 'ad_hoc', ?, 'idle', 1, ?, ?, ?)`,
  ).run(
    workstreamId,
    workspaceId,
    "granular-misty-oceanic-fermat@automation.with-avalon.com",
    authorId,
    at,
    at,
    at,
  );
  database.prepare(
    `INSERT INTO workstream_participants
     (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
     VALUES (?, ?, ?, 'creator', ?, NULL)`,
  ).run(workstreamId, authorId, authorId, at);
}

function seedSuggestion(database: DatabaseSync, options: {
  activityTitle: string;
  activitySummary?: string;
  providerResourceId?: string | null;
}): string {
  const suggestionId = "00000000-0000-7000-8000-000000000006";
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, display_name,
      model_plugin_id, status, created_at, updated_at)
     VALUES (?, ?, 'github', 'workspace', NULL, 'juno-ai-labs/avalon', 'plugin_github', 'healthy', ?, ?)`,
  ).run(connectionId, workspaceId, at, at);
  database.prepare(
    `INSERT INTO activities
     (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
      event_type, provider_resource_id, occurred_at, received_at, title, summary, dedupe_key)
     VALUES (?, ?, ?, 'workspace', 'github', 'delivery-1', 'github.push', ?, ?, ?, ?, ?, 'github:delivery-1')`,
  ).run(
    activityId,
    workspaceId,
    connectionId,
    options.providerResourceId ?? null,
    at,
    at,
    options.activityTitle,
    options.activitySummary ?? "push summary",
  );
  database.prepare(
    `INSERT INTO activity_suggestions
     (id, workspace_id, activity_id, workstream_id, confidence, reason, status, created_at)
     VALUES (?, ?, ?, ?, 0.8, 'Matches the workstream objective', 'pending', ?)`,
  ).run(suggestionId, workspaceId, activityId, workstreamId, at);
  return suggestionId;
}

function sqliteD1(database: DatabaseSync): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
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
        return {
          results: database.prepare(sql).all(...values as never[]) as T[],
          success: true,
          meta: {},
        } as unknown as D1Result<T>;
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as never[]);
        return {
          results: [],
          success: true,
          meta: { changes: Number(result.changes) },
        } as unknown as D1Result<T>;
      },
    };
    return statement as unknown as D1PreparedStatement;
  };
  return {
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  } as unknown as D1Database;
}
