import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { loadVisibleWorkstreamRoomResources } from "../src/durable-objects/workstream-room";
import { loadVisibleWorkstreamResources } from "../src/services/workstream-resource-visibility";
import { WorkstreamService } from "../src/services/workstream-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const USER_ONE_ID = "00000000-0000-4000-8000-000000000002";
const USER_TWO_ID = "00000000-0000-4000-8000-000000000003";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000004";

class SqliteStatement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteStatement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    });
  }
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

function fixture(): { database: DatabaseSync; env: Env } {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at)
    VALUES
      ('${USER_ONE_ID}', 'google-one', 'one@example.com', 'One', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ('${USER_TWO_ID}', 'google-two', 'two@example.com', 'Two', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workspaces
      (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Read State', 'read-state', 'global',
            '${USER_ONE_ID}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, email_address, email_route_status, origin_type, created_by_user_id,
       harness_status, next_sequence_number, latest_attention_sequence_number,
       last_activity_at, created_at, updated_at)
    VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Read state', 'Read independently',
            'quiet-bright-ready-otter@automation.with-avalon.com', 'active', 'ad_hoc',
            '${USER_ONE_ID}', 'completed', 6, 5, '2026-02-01T00:00:00.000Z',
            '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${WORKSTREAM_ID}', '${USER_TWO_ID}', '${USER_ONE_ID}', 'explicit', '2026-02-01T00:00:00.000Z');
    INSERT INTO messages
      (id, workspace_id, workstream_id, author_type, author_user_id, message_type,
       text_content, sequence_number, created_at)
    VALUES
      ('message-one', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'human', '${USER_ONE_ID}',
       'text', 'Start', 1, '2026-02-01T00:00:00.000Z'),
      ('message-tool', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'agent', NULL,
       'tool', '', 2, '2026-02-01T00:00:00.000Z'),
      ('message-three', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'agent', NULL,
       'text', 'First result', 3, '2026-02-01T00:00:00.000Z'),
      ('message-four', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'agent', NULL,
       'tool', '', 4, '2026-02-01T00:00:00.000Z'),
      ('message-five', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'agent', NULL,
       'text', 'Latest result', 5, '2026-02-01T00:00:00.000Z');
  `);
  const binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteStatement(database.prepare(sql))),
  });
  return { database, env: createTestEnv({ DB: binding }) };
}

function service(env: Env, userId: string): WorkstreamService {
  return new WorkstreamService(env, { workspaceId: WORKSPACE_ID, userId } as never);
}

describe("per-user work-stream read state", () => {
  it("counts a resource as a message attachment only inside the current work stream", async () => {
    const { database, env } = fixture();
    const resourceId = "00000000-0000-4000-8000-000000000015";
    const otherWorkstreamId = "00000000-0000-4000-8000-000000000016";
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES
        ('${otherWorkstreamId}', '${WORKSPACE_ID}', 'Other', 'Other work', 'ad_hoc',
         '${USER_ONE_ID}', 'completed', '2026-02-01T00:00:00.000Z',
         '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, author_user_id,
         message_type, text_content, sequence_number, created_at)
      VALUES
        ('other-message', '${WORKSPACE_ID}', '${otherWorkstreamId}', 'human',
         '${USER_ONE_ID}', 'text', 'Other attachment', 1,
         '2026-02-01T00:00:00.000Z');
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type,
         metadata_json, created_at, updated_at)
      VALUES
        ('${resourceId}', '${WORKSPACE_ID}', 'file', 'avalon_upload', 'Shared file',
         'text/markdown', '{}', '2026-02-01T00:00:00.000Z',
         '2026-02-01T00:00:00.000Z');
      INSERT INTO workstream_resources
        (workstream_id, resource_id, attached_by_user_id, watch_enabled,
         relationship_type, attached_at)
      VALUES
        ('${WORKSTREAM_ID}', '${resourceId}', '${USER_ONE_ID}', 0, 'context',
         '2026-02-01T00:00:00.000Z');
      INSERT INTO message_attachments (message_id, resource_id, position, attached_at)
      VALUES ('other-message', '${resourceId}', 0, '2026-02-01T00:00:00.000Z');
    `);

    await expect(loadVisibleWorkstreamRoomResources(
      env,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      USER_ONE_ID,
    )).resolves.toEqual([expect.objectContaining({
      id: resourceId,
      message_attachment: 0,
    })]);
    const before = await loadVisibleWorkstreamResources(env.DB, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      principal: { type: "user", userId: USER_ONE_ID },
    });

    database.exec(`
      INSERT INTO message_attachments (message_id, resource_id, position, attached_at)
      VALUES ('message-one', '${resourceId}', 0, '2026-02-01T00:00:00.000Z');
    `);
    await expect(loadVisibleWorkstreamRoomResources(
      env,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      USER_ONE_ID,
    )).resolves.toEqual([expect.objectContaining({
      id: resourceId,
      message_attachment: 1,
    })]);
    const after = await loadVisibleWorkstreamResources(env.DB, {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      principal: { type: "user", userId: USER_ONE_ID },
    });
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  it("hides private note metadata from non-owners in REST and realtime resource snapshots", async () => {
    const { database, env } = fixture();
    const resourceId = "00000000-0000-4000-8000-000000000005";
    const noteId = "00000000-0000-4000-8000-000000000006";
    database.exec(`
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, provider_resource_id, title,
         mime_type, metadata_json, created_at, updated_at)
      VALUES
        ('${resourceId}', '${WORKSPACE_ID}', 'note', 'avalon_note', '${noteId}',
         'Public planning note', 'text/markdown', '{}',
         '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      INSERT INTO notes
        (id, workspace_id, owner_user_id, resource_id, scope, title,
         last_activity_at, created_at, updated_at)
      VALUES
        ('${noteId}', '${WORKSPACE_ID}', '${USER_ONE_ID}', '${resourceId}', 'workspace',
         'Public planning note', '2026-02-01T00:00:00.000Z',
         '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
      INSERT INTO workstream_resources
        (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
      VALUES
        ('${WORKSTREAM_ID}', '${resourceId}', '${USER_ONE_ID}', 0, 'context',
         '2026-02-01T00:00:00.000Z');
    `);
    const owner = service(env, USER_ONE_ID);
    const participant = service(env, USER_TWO_ID);

    await expect(owner.get(WORKSTREAM_ID)).resolves.toMatchObject({
      resources: [{ id: resourceId, title: "Public planning note" }],
    });
    await expect(participant.get(WORKSTREAM_ID)).resolves.toMatchObject({
      resources: [{ id: resourceId, title: "Public planning note" }],
    });

    database.prepare(
      "UPDATE notes SET scope = 'personal', title = 'Renamed private planning note', updated_at = ? WHERE id = ?",
    ).run("2026-02-02T00:00:00.000Z", noteId);
    database.prepare("UPDATE resources SET title = ?, updated_at = ? WHERE id = ?").run(
      "Renamed private planning note",
      "2026-02-02T00:00:00.000Z",
      resourceId,
    );

    await expect(owner.get(WORKSTREAM_ID)).resolves.toMatchObject({
      resources: [{ id: resourceId, title: "Renamed private planning note" }],
    });
    await expect(participant.get(WORKSTREAM_ID)).resolves.toMatchObject({ resources: [] });
    await expect(loadVisibleWorkstreamRoomResources(
      env,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      USER_ONE_ID,
    )).resolves.toEqual([expect.objectContaining({ id: resourceId, title: "Renamed private planning note" })]);
    await expect(loadVisibleWorkstreamRoomResources(
      env,
      WORKSPACE_ID,
      WORKSTREAM_ID,
      USER_TWO_ID,
    )).resolves.toEqual([]);

    const roomFetch = vi.fn(async () => Response.json({ accepted: true }, { status: 202 }));
    Object.assign(env, {
      AVALON_REGION: "global",
      WORKSTREAM_ROOMS: {
        idFromName: () => ({ toString: () => "room-id" }),
        get: () => ({ fetch: roomFetch }),
      },
    });
    database.prepare(
      "DELETE FROM workstream_resources WHERE workstream_id = ? AND resource_id = ?",
    ).run(WORKSTREAM_ID, resourceId);
    await expect(owner.attachResource(WORKSTREAM_ID, resourceId)).resolves.toMatchObject({
      id: resourceId,
      title: "Renamed private planning note",
    });
    expect(roomFetch).not.toHaveBeenCalled();

    database.prepare("UPDATE notes SET scope = 'workspace' WHERE id = ?").run(noteId);
    database.prepare(
      "DELETE FROM workstream_resources WHERE workstream_id = ? AND resource_id = ?",
    ).run(WORKSTREAM_ID, resourceId);
    await owner.attachResource(WORKSTREAM_ID, resourceId);
    expect(roomFetch).toHaveBeenCalledTimes(1);
  });

  it("keeps cursors independent and protects manual unread from stale device acknowledgements", async () => {
    const { env } = fixture();
    const userOne = service(env, USER_ONE_ID);
    const userTwo = service(env, USER_TWO_ID);

    await expect(userOne.acknowledgeRead(WORKSTREAM_ID, {
      readThroughSequenceNumber: 5,
      observedManualUnreadGeneration: 0,
    })).resolves.toMatchObject({ hasUnread: false, readThroughSequenceNumber: 5 });
    await expect(userTwo.get(WORKSTREAM_ID)).resolves.toMatchObject({
      hasUnread: true,
      readThroughSequenceNumber: 0,
      firstUnreadSequenceNumber: 1,
    });

    const manuallyUnread = await userOne.markUnread(WORKSTREAM_ID);
    expect(manuallyUnread).toMatchObject({
      hasUnread: true,
      manualUnreadFromSequenceNumber: 5,
      manualUnreadGeneration: 1,
      firstUnreadSequenceNumber: 5,
    });

    const staleAcknowledgement = await userOne.acknowledgeRead(WORKSTREAM_ID, {
      readThroughSequenceNumber: 5,
      observedManualUnreadGeneration: 0,
    });
    expect(staleAcknowledgement).toMatchObject({
      hasUnread: true,
      manualUnreadFromSequenceNumber: 5,
      manualUnreadGeneration: 1,
    });

    await expect(userOne.acknowledgeRead(WORKSTREAM_ID, {
      readThroughSequenceNumber: 5,
      observedManualUnreadGeneration: 1,
    })).resolves.toMatchObject({
      hasUnread: false,
      manualUnreadFromSequenceNumber: null,
      readThroughSequenceNumber: 5,
    });
  });

  it("rejects a client cursor beyond the latest attention message", async () => {
    const { env } = fixture();
    await expect(service(env, USER_ONE_ID).acknowledgeRead(WORKSTREAM_ID, {
      readThroughSequenceNumber: 6,
      observedManualUnreadGeneration: 0,
    })).rejects.toMatchObject({ status: 422, code: "invalid_read_sequence" });
  });

  it("loads an anchored transcript window and continues toward newer messages", async () => {
    const { env } = fixture();
    const workstreams = service(env, USER_ONE_ID);

    const anchored = await workstreams.messages(WORKSTREAM_ID, 3, undefined, undefined, 3);
    expect(anchored.items.map((message) => message.sequenceNumber)).toEqual([3, 4, 5]);
    expect(anchored.nextCursor).toBe("3");
    expect(anchored.newerCursor).toBeNull();

    const newer = await workstreams.messages(WORKSTREAM_ID, 1, undefined, 3);
    expect(newer.items.map((message) => message.sequenceNumber)).toEqual([4]);
    expect(newer.nextCursor).toBeNull();
    expect(newer.newerCursor).toBe("4");
  });
});
