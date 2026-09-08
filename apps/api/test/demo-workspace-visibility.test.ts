import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { markDemoWorkspaceReady } from "../src/services/demo-workspace-register";
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
  await markDemoWorkspaceReady(db, "00000000-0000-7000-8000-0000000000f1", NOW);
  await markDemoWorkspaceReady(db, "00000000-0000-7000-8000-0000000000f2", NOW);
  await db.prepare("UPDATE demo_operations SET retired_at = ? WHERE workspace_id = ?")
    .bind("2026-09-05T13:00:00.000Z", RETIRED_ID).run();
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
    // Closed by its tombstone, not by being hidden.
    expect(await demoWorkspaceAdmission(db, RETIRED_ID)).toBe("open");
    // Named like a demo and never published, so this feature has no opinion.
    expect(await demoWorkspaceAdmission(db, CUSTOMER_ID)).toBe("open");
  });

  it("withholds only the template and the unpublished candidate from a member's list", async () => {
    const db = await seed();

    const withheld = await withheldDemoWorkspaceIds(db, [
      DEMO_TEMPLATE_WORKSPACE_ID,
      CANDIDATE_ID,
      PUBLISHED_ID,
      RETIRED_ID,
      CUSTOMER_ID,
    ]);

    expect([...withheld].sort()).toEqual([CANDIDATE_ID, DEMO_TEMPLATE_WORKSPACE_ID].sort());
  });

  it("asks nothing of the register for a member who is in no demo", async () => {
    const db = await seed();
    // The common case by a wide margin, and the one that must not pay for this
    // feature: no candidate ids means no query at all.
    expect([...await withheldDemoWorkspaceIds(db, [CUSTOMER_ID])]).toEqual([]);
    expect([...await withheldDemoWorkspaceIds(db, [])]).toEqual([]);
  });
});
