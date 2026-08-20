import { asUserId, asWorkspaceId } from "@avalon/contracts";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { ApiError } from "../src/lib/api-error";
import type { AuthContext, Env } from "../src/env";
import { WorkstreamService } from "../src/services/workstream-service";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const authorId = asUserId("00000000-0000-7000-8000-000000000002");
const workstreamId = "00000000-0000-7000-8000-000000000003";
const connectionId = "00000000-0000-7000-8000-000000000004";
const activityId = "00000000-0000-7000-8000-000000000005";
const suggestionId = "00000000-0000-7000-8000-000000000006";
const at = "2026-08-10T22:19:29.657Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("resolving an activity suggestion twice", () => {
  it("replays an accept instead of reporting the suggestion as missing", async () => {
    // A suggestion card that survives its own resolution — a transcript rebuilt
    // from a work-stream detail fetched before the accept — still offers its
    // buttons, and the second click must not tell someone that the context they
    // just added cannot be found.
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());

    const first = await service.resolveSuggestion(workstreamId, suggestionId, "accepted");
    const second = await service.resolveSuggestion(workstreamId, suggestionId, "accepted");

    expect(second.resourceId).toBe(first.resourceId);
    expect(second.suggestion?.status).toBe("accepted");
    const detail = await service.get(workstreamId);
    expect(detail.resources).toHaveLength(1);
    expect(detail.suggestions).toHaveLength(0);
  });

  it("announces the resolution once, so a replay cannot move the card", async () => {
    // The transcript upsert prefers the incoming copy of a suggestion message
    // and orders it by the room sequence that copy arrives with, so a second
    // broadcast of an unchanged resolution would shift the card.
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const published: unknown[] = [];
    const service = new WorkstreamService(environment(database, published), auth());

    await service.resolveSuggestion(workstreamId, suggestionId, "accepted");
    const afterFirst = [...published];
    await service.resolveSuggestion(workstreamId, suggestionId, "accepted");

    expect(afterFirst).toContain("activity_suggestion_resolved");
    // The replayed attachment is an upsert the client applies by resource ID,
    // so re-announcing it changes nothing; the suggestion must not repeat.
    expect(published.slice(afterFirst.length)).not.toContain("activity_suggestion_resolved");
    expect(published.filter((event) => event === "activity_suggestion_resolved")).toHaveLength(1);
  });

  it("replays a dismissal without reporting the suggestion as missing", async () => {
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());

    await service.resolveSuggestion(workstreamId, suggestionId, "dismissed");
    const second = await service.resolveSuggestion(workstreamId, suggestionId, "dismissed");

    expect(second.suggestion?.status).toBe("dismissed");
    expect(second.resourceId).toBeNull();
    const detail = await service.get(workstreamId);
    expect(detail.resources).toHaveLength(0);
  });

  it("leaves a detached resource detached when the accept is replayed", async () => {
    // Detaching is a decision. `accepted` records that the attachment happened
    // once, so a replayed click must not quietly put the resource back.
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());

    const first = await service.resolveSuggestion(workstreamId, suggestionId, "accepted");
    await service.detachResource(workstreamId, first.resourceId!);
    const replay = await service.resolveSuggestion(workstreamId, suggestionId, "accepted");

    expect(replay.resourceId).toBeNull();
    const detail = await service.get(workstreamId);
    expect(detail.resources).toHaveLength(0);
  });

  it("reports the attached resource when an accept is replayed without a detach", async () => {
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());

    const first = await service.resolveSuggestion(workstreamId, suggestionId, "accepted");
    const replay = await service.resolveSuggestion(workstreamId, suggestionId, "accepted");

    expect(replay.resourceId).toBe(first.resourceId);
    const detail = await service.get(workstreamId);
    expect(detail.resources).toHaveLength(1);
  });

  it("does not describe a still-pending suggestion as one somebody resolved", async () => {
    // Unreachable on a serialized D1, but the status CHECK permits `pending`,
    // and telling someone an open suggestion was dismissed is worse than the
    // 404 this path replaces.
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());
    const replay = (service as unknown as {
      resolvedSuggestionReplay: (id: string, suggestionId: string, action: "accepted" | "dismissed") => Promise<unknown>;
    }).resolvedSuggestionReplay.bind(service);

    await expect(replay(workstreamId, suggestionId, "dismissed"))
      .rejects.toMatchObject({ status: 409, code: "suggestion_resolution_conflict" });
  });

  it("keeps the first resolution when the second one contradicts it", async () => {
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());

    await service.resolveSuggestion(workstreamId, suggestionId, "accepted");

    await expect(service.resolveSuggestion(workstreamId, suggestionId, "dismissed"))
      .rejects.toMatchObject({ status: 409, code: "suggestion_already_resolved" });
    const status = database
      .prepare("SELECT status FROM activity_suggestions WHERE id = ?")
      .get(suggestionId) as { status: string };
    expect(status.status).toBe("accepted");
  });

  it("still reports a suggestion that does not belong to the work stream as missing", async () => {
    const database = migratedDatabase();
    seed(database);
    seedSuggestion(database);
    const service = new WorkstreamService(environment(database), auth());

    const rejected = await service
      .resolveSuggestion(workstreamId, "00000000-0000-7000-8000-00000000ffff", "accepted")
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(ApiError);
    expect(rejected).toMatchObject({ status: 404, code: "suggestion_not_found" });
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

function environment(database: DatabaseSync, published?: unknown[]): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    ...(published ? { SUBSTREAM_AGENTS: recordingRooms(published) } : {}),
  });
}

/** Records the `type` of every event the service broadcasts to the room. */
function recordingRooms(published: unknown[]): DurableObjectNamespace {
  return createCloudflareTestBinding<DurableObjectNamespace>({
    jurisdiction: () => recordingRooms(published),
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => ({
      publishEvent: (input: { event: unknown }) => {
        const payload: unknown = input.event;
        published.push(
          payload && typeof payload === "object" && "type" in payload
            ? (payload as { type: unknown }).type
            : null,
        );
        return Promise.resolve({ status: 204, bodyJson: "null" });
      },
    }),
  });
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
     VALUES (?, ?, 'Create Linear issues for comments', 'File the review comments as Linear issues', ?, 'active', 'ad_hoc', ?, 'idle', 1, ?, ?, ?)`,
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

function seedSuggestion(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, display_name,
      model_plugin_id, status, created_at, updated_at)
     VALUES (?, ?, 'linear', 'workspace', NULL, 'juno-ai-labs', 'plugin_linear', 'healthy', ?, ?)`,
  ).run(connectionId, workspaceId, at, at);
  database.prepare(
    `INSERT INTO activities
     (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
      event_type, resource_type, provider_resource_id, occurred_at, received_at, title, summary, dedupe_key)
     VALUES (?, ?, ?, 'workspace', 'linear', 'delivery-1', 'linear.issue.update', 'linear_issue', 'issue-ava-10', ?, ?, ?, ?, 'linear:delivery-1')`,
  ).run(
    activityId,
    workspaceId,
    connectionId,
    at,
    at,
    "Linear issue update: AVA-10",
    "The @mention control should search resources rather than connectors.",
  );
  database.prepare(
    `INSERT INTO activity_suggestions
     (id, workspace_id, activity_id, workstream_id, confidence, reason, status, created_at)
     VALUES (?, ?, ?, ?, 0.9, 'Matches the work stream objective', 'pending', ?)`,
  ).run(suggestionId, workspaceId, activityId, workstreamId, at);
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
        return createTestD1Result<T>({
          results: database.prepare(sql).all(...values as never[]) as T[],
          success: true,
          meta: {},
        });
      },
      async run<T>() {
        const result = database.prepare(sql).run(...values as never[]);
        return createTestD1Result<T>({
          results: [],
          success: true,
          meta: { changes: Number(result.changes) },
        });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({
    prepare,
    async batch<T>(statements: D1PreparedStatement[]) {
      const results: D1Result<T>[] = [];
      for (const statement of statements) results.push(await statement.run<T>());
      return results;
    },
  });
}
