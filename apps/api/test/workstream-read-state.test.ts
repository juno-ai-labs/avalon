import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { WorkstreamService } from "../src/services/workstream-service";

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
    return { success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    return {
      success: true,
      results: this.statement.all(...this.values as SQLInputValue[]) as T[],
      meta: { changes: 0 },
    } as unknown as D1Result<T>;
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
  const binding = {
    prepare: (sql: string) => new SqliteStatement(database.prepare(sql)) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
  return { database, env: { DB: binding } as unknown as Env };
}

function service(env: Env, userId: string): WorkstreamService {
  return new WorkstreamService(env, { workspaceId: WORKSPACE_ID, userId } as never);
}

describe("per-user work-stream read state", () => {
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
