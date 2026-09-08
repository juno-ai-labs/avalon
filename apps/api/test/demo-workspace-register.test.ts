import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  demoWorkspaceByOperation,
  markDemoWorkspaceReady,
  markDemoWorkspaceRetired,
} from "../src/services/demo-workspace-register";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The register, read from the operation rows: which workspaces this feature
 * made, which are still being prepared, and which are closed.
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
    VALUES ('${OPERATION_ID}', 'Alto Capital', '${PRESENTER_ID}', 'v1', '{}', NULL,
            'running', 1, '${NOW}', '${NOW}');
  `);
  return sqliteD1(database);
}

describe("demo workspace register", () => {
  it("knows a workspace only once the operation has allocated one", async () => {
    const db = seed();
    expect(await demoWorkspaceByOperation(db, OPERATION_ID)).toBeNull();

    // The creating phase writes the id before the workspace row exists; the
    // register answers from that moment.
    await db.prepare("UPDATE demo_operations SET workspace_id = ? WHERE operation_id = ?").bind(DEMO_ID, OPERATION_ID).run();
    expect(await demoWorkspaceByOperation(db, OPERATION_ID)).toMatchObject({
      workspaceId: DEMO_ID,
      operationId: OPERATION_ID,
      companyName: "Alto Capital",
      readyAt: null,
      retiredAt: null,
    });
  });

  it("publishes once, and closes a demo without touching a workspace it never made", async () => {
    const db = seed();
    await db.prepare("UPDATE demo_operations SET workspace_id = ? WHERE operation_id = ?").bind(DEMO_ID, OPERATION_ID).run();

    const ready = await markDemoWorkspaceReady(db, OPERATION_ID, "2026-09-05T12:10:00.000Z");
    expect(ready?.readyAt).toBe("2026-09-05T12:10:00.000Z");

    // Publishing is terminal; a resumed pass does not move the instant.
    await markDemoWorkspaceReady(db, OPERATION_ID, "2026-09-05T12:20:00.000Z");
    expect((await demoWorkspaceByOperation(db, OPERATION_ID))?.readyAt)
      .toBe("2026-09-05T12:10:00.000Z");

    await markDemoWorkspaceRetired(db, DEMO_ID, "2026-09-05T13:00:00.000Z");
    expect((await demoWorkspaceByOperation(db, OPERATION_ID))?.retiredAt).toBe("2026-09-05T13:00:00.000Z");
    // Closing is terminal too.
    await markDemoWorkspaceRetired(db, DEMO_ID, "2026-09-05T14:00:00.000Z");
    expect((await demoWorkspaceByOperation(db, OPERATION_ID))?.retiredAt).toBe("2026-09-05T13:00:00.000Z");

    // A workspace this feature never made has no row, and retiring it through
    // the same call is a no-op rather than an error.
    await markDemoWorkspaceRetired(db, CUSTOMER_ID, "2026-09-05T13:00:00.000Z");
    expect(await db.prepare("SELECT COUNT(*) AS count FROM demo_operations").first()).toEqual({ count: 1 });
  });
});
