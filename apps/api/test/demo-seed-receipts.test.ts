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
    kind: "create_canvas",
    canvas: "decision-memo",
    canvasId: "00000000-0000-7000-8000-0000000000f1",
    sidekick: null,
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

  it("refuses an outcome the seeder cannot have confirmed, and a kind the pack no longer has", async () => {
    const db = await claimed();
    await expect(recordDemoSeedReceipt(db, receipt({
      runOutcome: "failed" as DemoSeedReceipt["runOutcome"],
    }))).rejects.toThrow(/CHECK/u);
    await expect(recordDemoSeedReceipt(db, receipt({
      actionId: "thread-open",
      kind: "create_workstream" as DemoSeedReceipt["kind"],
    }))).rejects.toThrow(/CHECK/u);
  });

  it("records a Sidekick with the Canvas its run wrote, and refuses each mode's action naming the other's destination", async () => {
    const db = await claimed();
    const sidekickId = await demoSeedSidekickId(OPERATION_ID, "morning-briefing");
    const sidekick = await recordDemoSeedReceipt(db, receipt({
      actionId: "morning-briefing",
      kind: "sidekick",
      canvas: null,
      // The Canvas its run wrote.
      canvasId: "00000000-0000-7000-8000-0000000000fc",
      sidekick: "briefing",
      sidekickId,
      sidekickRunId: "00000000-0000-7000-8000-0000000000fa",
      turnId: null,
      runOutcome: "completed",
    }));
    expect(sidekick.canvasId).toBe("00000000-0000-7000-8000-0000000000fc");
    const message = await recordDemoSeedReceipt(db, receipt({
      actionId: "briefing-reply",
      kind: "sidekick_message",
      canvas: null,
      canvasId: null,
      sidekick: "briefing",
      sidekickId,
      harnessRunId: null,
      runOutcome: null,
    }));
    expect(message.sidekick).toBe("briefing");

    // A Sidekick named by a Canvas key would be found by a later Canvas step.
    await expect(recordDemoSeedReceipt(db, receipt({
      actionId: "misfiled-briefing",
      kind: "sidekick",
      sidekick: "other",
      sidekickId: "00000000-0000-7000-8000-0000000000fb",
    }))).rejects.toThrow(/CHECK/u);
    // A message in a Sidekick's conversation is in no Canvas.
    await expect(recordDemoSeedReceipt(db, receipt({
      actionId: "misfiled-reply",
      kind: "sidekick_message",
      canvas: null,
      sidekick: "briefing",
      sidekickId,
    }))).rejects.toThrow(/CHECK/u);
    // And a Canvas action that names no Canvas.
    await expect(recordDemoSeedReceipt(db, receipt({
      actionId: "canvasless-message",
      kind: "canvas_message",
      canvasId: null,
    }))).rejects.toThrow(/CHECK/u);
  });
});
