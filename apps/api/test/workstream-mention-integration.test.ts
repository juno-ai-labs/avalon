import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";

vi.mock("../src/services/integrations", () => ({
  classifyWorkstreamMessage: vi.fn(async () => ({
    classification: "human_only",
    confidence: 1,
    rationaleCode: "test",
  })),
  publishWorkstreamEvent: vi.fn(async () => undefined),
  startWorkstreamWorkflow: vi.fn(async () => "unused"),
}));

vi.mock("../src/services/mention-email-service", () => ({
  sendWorkstreamMentionEmail: vi.fn(async () => "sent"),
}));

import { WorkstreamService } from "../src/services/workstream-service";
import { sendWorkstreamMentionEmail } from "../src/services/mention-email-service";
import { classifyWorkstreamMessage, startWorkstreamWorkflow } from "../src/services/integrations";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const authorId = "00000000-0000-7000-8000-000000000002";
const personId = "00000000-0000-7000-8000-000000000003";
const workstreamId = "00000000-0000-7000-8000-000000000004";
const at = "2026-08-02T20:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("work-stream addressing", () => {
  it("invokes Avalon without classifying when only one participant is active", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.createMessage(workstreamId, {
      text: "Tell me more",
      clientMessageId: "single-participant-message",
      mentions: [],
      confirmedParticipantUserIds: [],
    });

    expect(result.agentInvoked).toBe(true);
    expect(result.harnessRunId).toEqual(expect.any(String));
    expect(classifyWorkstreamMessage).not.toHaveBeenCalled();
    expect(startWorkstreamWorkflow).toHaveBeenCalledOnce();
  });

  it("keeps multiplayer classification when more than one participant is active", async () => {
    const database = migratedDatabase();
    seed(database);
    const service = new WorkstreamService(environment(database), auth());

    const result = await service.createMessage(workstreamId, {
      text: "This is for Ada",
      clientMessageId: "multi-participant-message",
      mentions: [],
      confirmedParticipantUserIds: [],
    });

    expect(result.agentInvoked).toBe(false);
    expect(result.harnessRunId).toBeNull();
    expect(classifyWorkstreamMessage).toHaveBeenCalledOnce();
    expect(startWorkstreamWorkflow).not.toHaveBeenCalled();
  });

  it("persists static member-safe copy while logging workflow launch diagnostics", async () => {
    const database = migratedDatabase();
    seed(database, false);
    const diagnostic = "provider response included a private upstream detail";
    vi.mocked(startWorkstreamWorkflow).mockRejectedValueOnce(new Error(diagnostic));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const service = new WorkstreamService(environment(database), auth());

    await expect(service.createMessage(workstreamId, {
      text: "Start a safe run",
      clientMessageId: "launch-failure-message",
      mentions: [],
      confirmedParticipantUserIds: [],
    })).rejects.toMatchObject({
      status: 503,
      code: "workflow_unavailable",
      message: "The Avalon harness could not be started",
    });

    const row = database.prepare(
      "SELECT id, error_json FROM harness_runs WHERE workstream_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(workstreamId) as { id: string; error_json: string };
    expect(JSON.parse(row.error_json)).toEqual({
      code: "workflow_unavailable",
      message: "Avalon could not start this run",
    });
    expect(row.error_json).not.toContain(diagnostic);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "workstream_harness_launch_failed",
      request_id: row.id,
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      error_name: "Error",
      error_message: diagnostic,
    }));
  });
});

describe("work-stream person mention persistence", () => {
  it("stores canonical person Markdown, hydrates the chip identity, and never repeats side effects on replay", async () => {
    const database = migratedDatabase();
    seed(database);
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(environment(database), auth(), (promise) => deferred.push(promise));

    const first = await service.createMessage(workstreamId, {
      text: "Please ask @Ada Lovelace.",
      clientMessageId: "mention-message-1",
      mentions: [{
        type: "person",
        userId: personId,
        connectorType: null,
        startOffset: 11,
        endOffset: 24,
      }],
      confirmedParticipantUserIds: [],
    });
    await Promise.all(deferred);

    const token = `[@Ada Lovelace](person:${personId})`;
    expect(first.message.textContent).toBe(`Please ask ${token}.`);
    expect(first.message.mentions).toEqual([expect.objectContaining({
      type: "person",
      userId: personId,
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
      startOffset: 11,
      endOffset: 11 + token.length,
    })]);
    expect(deferred).toHaveLength(1);
    expect(sendWorkstreamMentionEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        recipientUserId: personId,
        workstreamEmailAddress: "calm-bright-ready-otter@automation.with-avalon.com",
      }),
    );

    const page = await service.messages(workstreamId, 20);
    const stored = page.items.find((message) => message.clientMessageId === "mention-message-1");
    expect(stored?.textContent).toBe(`Please ask ${token}.`);
    expect(stored?.mentions).toEqual([expect.objectContaining({
      userId: personId,
      displayName: "Ada Lovelace",
      avatarUrl: "https://example.com/ada.png",
    })]);

    const replay = await service.createMessage(workstreamId, {
      text: "Please ask @Ada Lovelace.",
      clientMessageId: "mention-message-1",
      mentions: [{
        type: "person",
        userId: personId,
        connectorType: null,
        startOffset: 11,
        endOffset: 24,
      }],
      confirmedParticipantUserIds: [],
    });
    expect(replay.agentInvoked).toBe(false);
    expect(deferred).toHaveLength(1);
    expect(sendWorkstreamMentionEmail).toHaveBeenCalledTimes(1);
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
    OPENROUTER_PRIMARY_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    OPENROUTER_FALLBACK_MODELS: "",
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

function seed(database: DatabaseSync, includeSecondParticipant = true): void {
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    authorId, "google-author", "author@example.com", "Author Person", null, at, at,
    personId, "google-ada", "ada@example.com", "Ada Lovelace", "https://example.com/ada.png", at, at,
  );
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon Studio', 'avalon-studio', 'global', ?, ?, ?)`,
  ).run(workspaceId, authorId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?), (?, ?, 'member', 'active', ?)`,
  ).run(workspaceId, authorId, at, workspaceId, personId, at);
  database.prepare(
    `INSERT INTO workstreams
     (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
      created_by_user_id, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
     VALUES (?, ?, 'Mention review', 'Review the draft', ?, 'active', 'ad_hoc', ?, 'idle', 1, ?, ?, ?)`,
  ).run(
    workstreamId,
    workspaceId,
    "calm-bright-ready-otter@automation.with-avalon.com",
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
  if (includeSecondParticipant) {
    database.prepare(
      `INSERT INTO workstream_participants
       (workstream_id, user_id, added_by_user_id, participation_reason, joined_at, removed_at)
       VALUES (?, ?, ?, 'explicit', ?, NULL)`,
    ).run(workstreamId, personId, authorId, at);
  }
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
