import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEMO_TEMPLATE_WORKSPACE_ID,
  demoWorkspaceAdmission,
  withheldDemoWorkspaceIds,
} from "../src/services/demo-workspace-visibility";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * What a member is offered, and the two things they are not.
 *
 * The template is withheld forever and a candidate only until it is published,
 * and the difference matters in both directions: a candidate that stayed hidden
 * after Ready would never be openable, and a template that appeared once would
 * put the demo cast's real connections in somebody's switcher.
 *
 * The last case is the one worth keeping. A *retired* demo is not withheld —
 * it is closed by its tombstone, and hiding it as well would leave the presenter
 * looking at a switcher a workspace silently vanished from while its rooms were
 * still answering.
 */

const CANDIDATE_ID = "00000000-0000-7000-8000-0000000000d1";
const PUBLISHED_ID = "00000000-0000-7000-8000-0000000000d2";
const RETIRED_ID = "00000000-0000-7000-8000-0000000000d3";
const ABANDONED_ID = "00000000-0000-7000-8000-0000000000d4";
const CUSTOMER_ID = "00000000-0000-7000-8000-0000000000c1";
const PRESENTER_ID = "00000000-0000-7000-8000-0000000000a1";
const NOW = "2026-09-05T12:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function seed(): Promise<D1Database> {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${PRESENTER_ID}', 'sub-presenter', 'presenter@example.com', 'Presenter',
            '${NOW}', '${NOW}');
  `);
  for (const [id, name] of [
    [DEMO_TEMPLATE_WORKSPACE_ID, "demo-template"],
    [CANDIDATE_ID, "Alto Capital-demo"],
    [PUBLISHED_ID, "Phoenix-demo"],
    [RETIRED_ID, "Cardinal-demo"],
    [ABANDONED_ID, "Birch-demo"],
    [CUSTOMER_ID, "Acme-demo"],
  ] as const) {
    database.exec(`
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${id}', '${name}', '${id}', 'global', '${PRESENTER_ID}', '${NOW}', '${NOW}');
    `);
  }
  const db = sqliteD1(database);
  for (const [index, workspaceId] of [CANDIDATE_ID, PUBLISHED_ID, RETIRED_ID].entries()) {
    await db.prepare(
      `INSERT INTO demo_operations
         (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
          status, attempt, created_at, updated_at)
       VALUES (?, 'Demo', ?, 'v1', '{}', ?, 'running', 1, ?, ?)`,
    ).bind(`00000000-0000-7000-8000-0000000000f${index}`, PRESENTER_ID, workspaceId, NOW, NOW).run();
  }
  // Published the way the wait phase publishes: `ready_at` and `status` together.
  for (const operationId of ["00000000-0000-7000-8000-0000000000f1", "00000000-0000-7000-8000-0000000000f2"]) {
    await db.prepare("UPDATE demo_operations SET ready_at = ?, status = 'ready' WHERE operation_id = ?").bind(NOW, operationId).run();
  }
  await db.prepare("UPDATE demo_operations SET retired_at = ? WHERE workspace_id = ?")
    .bind("2026-09-05T13:00:00.000Z", RETIRED_ID).run();
  // Abandoned before it was ever published: retired, and never `ready_at`.
  await db.prepare(
    `INSERT INTO demo_operations
       (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
        status, attempt, retired_at, created_at, updated_at)
     VALUES (?, 'Demo', ?, 'v1', '{}', ?, 'abandoned', 1, ?, ?, ?)`,
  ).bind("00000000-0000-7000-8000-0000000000f3", PRESENTER_ID, ABANDONED_ID, "2026-09-05T13:00:00.000Z", NOW, NOW).run();
  return db;
}

describe("demo workspace visibility", () => {
  it("classifies the template, a candidate, and everything else", async () => {
    const db = await seed();

    // By id, not by name: renaming the template does not defeat this, and
    // naming another workspace `demo-template` does not acquire it.
    expect(await demoWorkspaceAdmission(db, DEMO_TEMPLATE_WORKSPACE_ID)).toBe("template");
    expect(await demoWorkspaceAdmission(db, CANDIDATE_ID)).toBe("preparing");
    expect(await demoWorkspaceAdmission(db, PUBLISHED_ID)).toBe("open");
    // Published, so ordinary from then on: a retired demo is closed the way
    // any closed workspace is (`abandoned_at`), not by being hidden here.
    expect(await demoWorkspaceAdmission(db, RETIRED_ID)).toBe("open");
    // Never published: abandoned and retired, and withheld for good. Offering
    // it would put a half-seeded, tombstoned workspace in the presenter's menu.
    expect(await demoWorkspaceAdmission(db, ABANDONED_ID)).toBe("preparing");
    // Named like a demo and never published, so this feature has no opinion.
    expect(await demoWorkspaceAdmission(db, CUSTOMER_ID)).toBe("open");
  });

  it("withholds the template and every unpublished candidate from a member's list", async () => {
    const db = await seed();

    const withheld = await withheldDemoWorkspaceIds(db, [
      DEMO_TEMPLATE_WORKSPACE_ID,
      CANDIDATE_ID,
      PUBLISHED_ID,
      RETIRED_ID,
      ABANDONED_ID,
      CUSTOMER_ID,
    ]);

    expect([...withheld].sort()).toEqual([ABANDONED_ID, CANDIDATE_ID, DEMO_TEMPLATE_WORKSPACE_ID].sort());
  });

  it("withholds nothing from a member who is in no demo, however many workspaces they hold", async () => {
    const db = await seed();
    expect([...await withheldDemoWorkspaceIds(db, [CUSTOMER_ID])]).toEqual([]);
    expect([...await withheldDemoWorkspaceIds(db, [])]).toEqual([]);
    // Past D1's bound-parameter ceiling in one statement: the read runs in
    // chunks rather than failing the member's whole discovery.
    const many = Array.from({ length: 205 }, (_, index) => `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`);
    expect([...await withheldDemoWorkspaceIds(db, [...many, CANDIDATE_ID])]).toEqual([CANDIDATE_ID]);
  });
});
