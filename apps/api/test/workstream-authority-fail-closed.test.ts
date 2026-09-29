import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { readWorkstreamAuthorityControl } from "../src/services/workstream-authority";
import { createTestD1Database, createTestD1PreparedStatement } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function migrated(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  return database;
}

// The fence fails closed to `quarantined` generation 0 for a missing row and a
// failed read alike, which is the value a real quarantine at generation 0 also
// has. The queue refusal read `workstream_maintenance:quarantined:0` for a D1
// outage; the reason is what tells the three apart.
describe("the work-stream authority fence failing closed", () => {
  it("names a missing control row, and says nothing for a row it read", async () => {
    const database = migrated();
    expect((await readWorkstreamAuthorityControl({ DB: sqliteD1(database) })).failedClosedReason).toBeUndefined();

    database.exec("DELETE FROM workstream_authority_control");
    await expect(readWorkstreamAuthorityControl({ DB: sqliteD1(database) })).resolves.toMatchObject({
      phase: "quarantined",
      generation: 0,
      failedClosedReason: "authority_control_row_missing",
    });
  });

  it("names the D1 failure behind a read that threw", async () => {
    // A D1 overload cannot be produced here; the double stands in for the
    // platform, and only its sentence matters.
    const overloaded = createTestD1Database({
      prepare: () => createTestD1PreparedStatement({
        first: async () => {
          throw new Error("D1_ERROR: D1 DB is overloaded. Too many requests queued.");
        },
      }),
    });
    await expect(readWorkstreamAuthorityControl({ DB: overloaded })).resolves.toMatchObject({
      phase: "quarantined",
      failedClosedReason: "authority_control_read_failed:d1_overloaded",
    });
  });
});
