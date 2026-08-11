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
const WORKSTREAM_IDS = [
  "00000000-0000-4000-8000-00000000000a",
  "00000000-0000-4000-8000-00000000000b",
  "00000000-0000-4000-8000-00000000000c",
] as const;

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

/**
 * Three work streams a day apart, so "most recent first" and "the order this
 * person arranged" are visibly different answers rather than the same one.
 */
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
    VALUES ('${WORKSPACE_ID}', 'Pinning', 'pinning', 'global',
            '${USER_ONE_ID}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  `);
  WORKSTREAM_IDS.forEach((id, index) => {
    const at = `2026-02-0${index + 1}T00:00:00.000Z`;
    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
         created_by_user_id, harness_status, next_sequence_number, latest_attention_sequence_number,
         last_activity_at, created_at, updated_at)
      VALUES ('${id}', '${WORKSPACE_ID}', 'Work stream ${index + 1}', 'Objective ${index + 1}',
              'pinned-${index + 1}@automation.with-avalon.com', 'active', 'ad_hoc',
              '${USER_ONE_ID}', 'completed', 1, 0, '${at}', '${at}', '${at}');
    `);
  });
  const binding = {
    batch: async (statements: SqliteStatement[]) => {
      for (const statement of statements) await statement.run();
      return [];
    },
    prepare: (sql: string) => new SqliteStatement(database.prepare(sql)) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
  return { database, env: { DB: binding, AVALON_REGION: "global" } as unknown as Env };
}

function service(env: Env, userId: string): WorkstreamService {
  return new WorkstreamService(env, { workspaceId: WORKSPACE_ID, userId } as never);
}

async function pinPositions(env: Env, userId: string): Promise<(number | null)[]> {
  const page = await service(env, userId).list(50);
  return WORKSTREAM_IDS.map((id) => page.items.find((item) => item.id === id)?.pinPosition ?? null);
}

describe("per-user work-stream pinning", () => {
  it("appends each new pin and keeps one person's list out of another's", async () => {
    const { env } = fixture();
    const [first, second, third] = WORKSTREAM_IDS;

    await service(env, USER_ONE_ID).pin(third);
    await service(env, USER_ONE_ID).pin(first);
    // Pinning twice is the same list, not a second row that would take a
    // position away from something already arranged.
    const repeated = await service(env, USER_ONE_ID).pin(third);
    expect(repeated.items.map((item) => item.id)).toEqual([third, first]);

    expect(await pinPositions(env, USER_ONE_ID)).toEqual([1, null, 0]);
    expect(await pinPositions(env, USER_TWO_ID)).toEqual([null, null, null]);

    await service(env, USER_TWO_ID).pin(second);
    expect(await pinPositions(env, USER_TWO_ID)).toEqual([null, 0, null]);
    expect(await pinPositions(env, USER_ONE_ID)).toEqual([1, null, 0]);
  });

  it("rewrites the list into the order it is given, ignoring ids that are no longer pinned", async () => {
    const { env } = fixture();
    const [first, second, third] = WORKSTREAM_IDS;
    const workstreams = service(env, USER_ONE_ID);
    await workstreams.pin(first);
    await workstreams.pin(second);

    const reordered = await workstreams.reorderPins([second, first]);
    expect(reordered.items.map((item) => item.id)).toEqual([second, first]);
    expect(await pinPositions(env, USER_ONE_ID)).toEqual([1, 0, null]);

    // `third` was never pinned, and a pin the caller did not name keeps its
    // place behind the ones it did — a stale arrangement rearranges what it
    // knows about rather than failing outright.
    const partial = await workstreams.reorderPins([third, second]);
    expect(partial.items.map((item) => item.id)).toEqual([second, first]);
  });

  it("closes the gap an unpin leaves so positions stay a dense run", async () => {
    const { env } = fixture();
    const [first, second, third] = WORKSTREAM_IDS;
    const workstreams = service(env, USER_ONE_ID);
    await workstreams.pin(first);
    await workstreams.pin(second);
    await workstreams.pin(third);

    const remaining = await workstreams.unpin(second);
    expect(remaining.items.map((item) => item.id)).toEqual([first, third]);
    expect(await pinPositions(env, USER_ONE_ID)).toEqual([0, null, 1]);

    // Unpinning something that is not pinned is not an error, so a second
    // window acting on a menu it painted a moment ago is a no-op.
    expect((await workstreams.unpin(second)).items.map((item) => item.id)).toEqual([first, third]);
  });

  it("keeps a quiet pinned work stream on the first page it would otherwise fall off", async () => {
    const { env } = fixture();
    const [oldest] = WORKSTREAM_IDS;
    await service(env, USER_ONE_ID).pin(oldest);

    // A page of one would hold only the most recent work stream. The pin is
    // rendered in its own section, so losing it there loses it entirely.
    const page = await service(env, USER_ONE_ID).list(1);
    expect(page.items.map((item) => item.id)).toEqual([WORKSTREAM_IDS[2], oldest]);
    expect(page.nextCursor).toBe("2026-02-03T00:00:00.000Z");

    // A cursor page continues the recency order and does not repeat the pin.
    const second = await service(env, USER_ONE_ID).list(1, "2026-02-03T00:00:00.000Z");
    expect(second.items.map((item) => item.id)).toEqual([WORKSTREAM_IDS[1]]);
  });

  it("refuses to pin a work stream the caller cannot read, and still lets them unpin one that closed", async () => {
    const { database, env } = fixture();
    const [first, second] = WORKSTREAM_IDS;

    // `second` is private and user two is not in it, so it is not theirs to pin.
    database.prepare("UPDATE workstreams SET scope = 'personal' WHERE id = ?").run(second);
    await expect(service(env, USER_TWO_ID).pin(second))
      .rejects.toMatchObject({ status: 404, code: "workstream_not_found" });

    // A work stream pinned while it was readable and narrowed afterwards drops
    // out of the pinned list, and the reader must still be able to clear the
    // row it left behind — the menu that would do it is gone otherwise.
    await expect(service(env, USER_TWO_ID).pin(first)).resolves.toMatchObject({ items: [{ id: first }] });
    database.prepare("UPDATE workstreams SET scope = 'personal' WHERE id = ?").run(first);
    await expect(service(env, USER_TWO_ID).pin(first))
      .rejects.toMatchObject({ status: 404, code: "workstream_not_found" });
    await expect(service(env, USER_TWO_ID).unpin(first)).resolves.toMatchObject({ items: [] });
    expect(database.prepare(
      "SELECT COUNT(*) AS pins FROM workstream_pins WHERE user_id = ?",
    ).get(USER_TWO_ID)).toMatchObject({ pins: 0 });
  });
});
