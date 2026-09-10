import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  demoSeedReceipts,
  recordDemoSeedReceipt,
  demoSeedResourceId,
  demoSeedSidekickId,
  type DemoSeedReceipt,
} from "../src/services/demo-seeder";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The receipts table as the migration actually built it.
 *
 * Two properties the seeder relies on live in the schema rather than in code:
 * a second confirmation of the same action keeps the first row, whose
 * destination ids the barrier may already hold; and a receipt belongs to an
 * operation the register knows, so a stray row cannot describe a demo that was
 * never claimed.
 */

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000e1";
const OPERATION_ID = "00000000-0000-7000-8000-0000000000e2";
const PRESENTER_ID = "00000000-0000-7000-8000-0000000000e3";
const NOW = "2026-09-07T12:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

async function claimed(): Promise<D1Database> {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${PRESENTER_ID}', 'sub-presenter', 'presenter@example.com', 'Presenter', '${NOW}', '${NOW}');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${WORKSPACE_ID}', 'Alto-demo', '${WORKSPACE_ID}', 'global', '${PRESENTER_ID}', '${NOW}', '${NOW}');
  `);
  const db = sqliteD1(database);
  await db.prepare(
    `INSERT INTO demo_operations
       (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id,
        status, attempt, created_at, updated_at)
     VALUES (?, 'Alto', ?, 'test', '{}', ?, 'running', 1, ?, ?)`,
  ).bind(OPERATION_ID, PRESENTER_ID, WORKSPACE_ID, NOW, NOW).run();
  return db;
}

function receipt(overrides: Partial<DemoSeedReceipt> = {}): DemoSeedReceipt {
  return {
    operationId: OPERATION_ID,
    actionId: "memo-open",
    workspaceId: WORKSPACE_ID,
    kind: "create_workstream",
    room: "decision-memo",
    workstreamId: "00000000-0000-7000-8000-0000000000f1",
    substream: null,
    substreamId: "0",
    sidekickId: null,
    sidekickRunId: null,
    turnId: "00000000-0000-7000-8000-0000000000f2",
    harnessRunId: "00000000-0000-7000-8000-0000000000f3",
    runOutcome: "completed",
    elicitationId: null,
    resourceId: null,
    completedAt: NOW,
    ...overrides,
  };
}

describe("demo seed receipts", () => {
  it("keeps the first confirmation of an action and lists an operation's receipts in order", async () => {
    const db = await claimed();
    const first = await recordDemoSeedReceipt(db, receipt());
    const second = await recordDemoSeedReceipt(db, receipt({
      turnId: "00000000-0000-7000-8000-0000000000f9",
      completedAt: "2026-09-07T12:05:00.000Z",
    }));
    expect(second).toEqual(first);
    await recordDemoSeedReceipt(db, receipt({
      actionId: "memo-attach",
      kind: "upload",
      turnId: null,
      harnessRunId: null,
      runOutcome: null,
      resourceId: await demoSeedResourceId(OPERATION_ID, "memo-attach"),
      completedAt: "2026-09-07T12:01:00.000Z",
    }));
    const listed = await demoSeedReceipts(db, OPERATION_ID);
    expect(listed.map((row) => row.actionId)).toEqual(["memo-open", "memo-attach"]);
    expect(listed[0]?.turnId).toBe("00000000-0000-7000-8000-0000000000f2");
    expect(listed[1]?.resourceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("refuses a receipt for an operation the register never claimed", async () => {
    const db = await claimed();
    await expect(recordDemoSeedReceipt(db, receipt({
      operationId: "00000000-0000-7000-8000-00000000dead",
    }))).rejects.toThrow(/FOREIGN KEY/u);
  });

  it("refuses an outcome the seeder cannot have confirmed", async () => {
    const db = await claimed();
    await expect(recordDemoSeedReceipt(db, receipt({
      runOutcome: "failed" as DemoSeedReceipt["runOutcome"],
    }))).rejects.toThrow(/CHECK/u);
  });

  it("records a Sidekick, which has no room, and refuses one that claims a room anyway", async () => {
    const db = await claimed();
    const sidekick = await recordDemoSeedReceipt(db, receipt({
      actionId: "morning-briefing",
      kind: "sidekick",
      room: null,
      workstreamId: null,
      // In no room, so in no conversation either.
      substreamId: null,
      sidekickId: await demoSeedSidekickId(OPERATION_ID, "morning-briefing"),
      sidekickRunId: "00000000-0000-7000-8000-0000000000fa",
      turnId: null,
      harnessRunId: null,
      runOutcome: "completed",
    }));
    expect(sidekick.sidekickId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);

    // A Sidekick belongs to no room, and a row that names one is a receipt the
    // barrier would go looking for a work stream behind.
    await expect(recordDemoSeedReceipt(db, receipt({
      actionId: "misfiled-briefing",
      kind: "sidekick",
      room: "decision-memo",
      sidekickId: "00000000-0000-7000-8000-0000000000fb",
    }))).rejects.toThrow(/CHECK/u);

    // And the other way: a room action that names no work stream.
    await expect(recordDemoSeedReceipt(db, receipt({
      actionId: "roomless-message",
      kind: "message",
      workstreamId: null,
    }))).rejects.toThrow(/CHECK/u);
  });
});
