import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { markDemoWorkspaceRetired } from "../src/services/demo-workspace-register";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The register's one write from outside the operation: the retirement walk's
 * `retired_at`, on the row of the workspace it closed.
 */

const DEMO_ID = "00000000-0000-7000-8000-0000000000d1";
const CUSTOMER_ID = "00000000-0000-7000-8000-0000000000c1";
const PRESENTER_ID = "00000000-0000-7000-8000-0000000000a1";
const OPERATION_ID = "00000000-0000-7000-8000-0000000000f1";
const NOW = "2026-09-05T12:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seed(): D1Database {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${PRESENTER_ID}', 'sub-presenter', 'presenter@example.com', 'Presenter',
            '${NOW}', '${NOW}');
  `);
  for (const [id, name, slug] of [
    [DEMO_ID, "Alto Capital-demo", "alto-capital-demo"],
    // Named like a demo, and deliberately not one. This is the row that makes
    // a name check unsafe rather than merely inelegant.
    [CUSTOMER_ID, "Acme-demo", "acme-demo"],
  ] as const) {
    database.exec(`
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${id}', '${name}', '${slug}', 'global', '${PRESENTER_ID}', '${NOW}', '${NOW}');
    `);
  }
  database.exec(`
    INSERT INTO demo_operations
      (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
       status, attempt, created_at, updated_at)
    VALUES ('${OPERATION_ID}', 'Alto Capital', '${PRESENTER_ID}', 'v1', '{}', '${DEMO_ID}',
            'ready', 1, '${NOW}', '${NOW}');
  `);
  return sqliteD1(database);
}

async function retiredAt(db: D1Database): Promise<string | null> {
  return (await db.prepare("SELECT retired_at FROM demo_operations WHERE operation_id = ?").bind(OPERATION_ID)
    .first<{ retired_at: string | null }>())!.retired_at;
}

describe("demo workspace register", () => {
  it("closes a demo once, and never touches a workspace it did not make", async () => {
    const db = seed();
    expect(await retiredAt(db)).toBeNull();

    await markDemoWorkspaceRetired(db, DEMO_ID, "2026-09-05T13:00:00.000Z");
    expect(await retiredAt(db)).toBe("2026-09-05T13:00:00.000Z");
    // Closing is terminal: a resumed walk does not move the instant.
    await markDemoWorkspaceRetired(db, DEMO_ID, "2026-09-05T14:00:00.000Z");
    expect(await retiredAt(db)).toBe("2026-09-05T13:00:00.000Z");

    // A workspace this feature never made has no row, and retiring it through
    // the same call is a no-op rather than an error.
    await markDemoWorkspaceRetired(db, CUSTOMER_ID, "2026-09-05T13:00:00.000Z");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 1 });
  });
});
