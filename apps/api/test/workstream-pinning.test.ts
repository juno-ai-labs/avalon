import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { MAX_PINNED_WORKSTREAMS } from "@avalon/contracts";

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

  it("carries a quiet pinned work stream on the first page and never repeats it", async () => {
    const { env } = fixture();
    const [oldest, middle, newest] = WORKSTREAM_IDS;
    await service(env, USER_ONE_ID).pin(oldest);

    // A page of one would hold only the most recent work stream. The pin is
    // rendered in its own section, so losing it there loses it entirely.
    const first = await service(env, USER_ONE_ID).list(1);
    expect(first.items.map((item) => item.id)).toEqual([newest, oldest]);
    // Taken from the paged rows, not from the last item, which is the pin.
    expect(first.nextCursor).toBe("2026-02-03T00:00:00.000Z");

    // Walking the cursor must not hand the pin back a second time: it is out of
    // the recency order entirely, not merely absent from the page it belongs on.
    const second = await service(env, USER_ONE_ID).list(1, first.nextCursor ?? undefined);
    expect(second.items.map((item) => item.id)).toEqual([middle]);
    // The walk ends there. The pinned work stream is older than `middle` and
    // would have been the next page had it stayed in the recency order at all.
    expect(second.nextCursor).toBeNull();

    // The same walk for somebody who has pinned nothing sees all three in the
    // ordinary order, so the exclusion is the viewer's and not the row's.
    const other = await service(env, USER_TWO_ID).list(50);
    expect(other.items.map((item) => item.id)).toEqual([newest, middle, oldest]);
  });

  it("counts the limit against pins that can still be seen, and refuses past it", async () => {
    const { database, env } = fixture();
    const workstreams = service(env, USER_ONE_ID);
    const extraId = (index: number): string => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const extras = Array.from({ length: MAX_PINNED_WORKSTREAMS }, (_, index) => extraId(index));
    for (const [index, id] of extras.entries()) {
      const at = `2026-04-01T00:00:${String(index).padStart(2, "0")}.000Z`;
      database.exec(`
        INSERT INTO workstreams
          (id, workspace_id, title, objective, email_address, email_route_status, origin_type,
           created_by_user_id, harness_status, next_sequence_number, latest_attention_sequence_number,
           last_activity_at, created_at, updated_at)
        VALUES ('${id}', '${WORKSPACE_ID}', 'Extra ${index}', 'Objective', 'extra-${index}@automation.with-avalon.com',
                'active', 'ad_hoc', '${USER_ONE_ID}', 'completed', 1, 0, '${at}', '${at}', '${at}');
      `);
      await workstreams.pin(id);
    }
    // A full list refuses the next one rather than quietly dropping it.
    await expect(workstreams.pin(WORKSTREAM_IDS[0]))
      .rejects.toMatchObject({ status: 422, code: "pin_limit_reached" });

    // Archiving takes a row out of every pinned read, so the pin behind it
    // shows nothing and offers no menu. Counting it would spend a slot its
    // owner has no way to free, and 50 archived pins would wedge the feature
    // shut behind an empty section.
    database.prepare("UPDATE workstreams SET archived_at = ? WHERE id = ?")
      .run("2026-05-01T00:00:00.000Z", extraId(0));
    const pinned = await workstreams.pin(WORKSTREAM_IDS[0]);
    expect(pinned.items).toHaveLength(MAX_PINNED_WORKSTREAMS);
    expect(pinned.items.at(-1)?.id).toBe(WORKSTREAM_IDS[0]);

    // The dead pin survived, so the work stream coming back brings its place
    // back with it rather than arriving unpinned.
    database.prepare("UPDATE workstreams SET archived_at = NULL WHERE id = ?").run(extraId(0));
    const restored = await workstreams.reorderPins([]);
    expect(restored.items).toHaveLength(MAX_PINNED_WORKSTREAMS + 1);
    expect(restored.items[0]?.id).toBe(extraId(0));
  });

  it("gives a pin its own position even when the run has a hole in it", async () => {
    const { database, env } = fixture();
    const [first, second, third] = WORKSTREAM_IDS;
    const workstreams = service(env, USER_ONE_ID);
    await workstreams.pin(first);
    await workstreams.pin(second);

    // A work stream deleted outright takes its pin with it by cascade, which
    // leaves a run whose length is no longer its next free position. Choosing
    // one from the row count would collide with the survivor.
    database.prepare("DELETE FROM workstreams WHERE id = ?").run(first);
    await workstreams.pin(third);

    const positions = database.prepare(
      "SELECT workstream_id, position FROM workstream_pins WHERE user_id = ? ORDER BY position",
    ).all(USER_ONE_ID);
    expect(positions).toEqual([
      { workstream_id: second, position: 1 },
      { workstream_id: third, position: 2 },
    ]);
    expect((await workstreams.reorderPins([third, second])).items.map((item) => item.id))
      .toEqual([third, second]);
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
