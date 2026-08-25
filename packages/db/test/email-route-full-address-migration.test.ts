import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../migrations/0097_email_routes_use_full_address.sql", import.meta.url),
  "utf8",
);

const databases: DatabaseSync[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function beforeMigration(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT,
      automation_subscription_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (workstream_id IS NOT NULL AND automation_subscription_id IS NULL)
        OR (workstream_id IS NULL AND automation_subscription_id IS NOT NULL)
      ),
      UNIQUE (region, workspace_id, workstream_id),
      UNIQUE (region, workspace_id, automation_subscription_id)
    );
    CREATE INDEX workstream_email_routes_destination_idx
      ON workstream_email_routes(region, workspace_id, workstream_id, automation_subscription_id);
    CREATE TRIGGER workstream_email_routes_identity_immutable
    BEFORE UPDATE OF local_part, region, workspace_id, workstream_id, automation_subscription_id
    ON workstream_email_routes
    BEGIN
      SELECT RAISE(ABORT, 'email route identities are immutable');
    END;
    CREATE TRIGGER workstream_email_routes_no_delete
    BEFORE DELETE ON workstream_email_routes
    BEGIN
      SELECT RAISE(ABORT, 'email routes are permanent tombstones');
    END;
  `);
  return database;
}

describe("0097 full-address email routes", () => {
  it("backfills both domain generations and permits only one owner verification", () => {
    const database = beforeMigration();
    database.exec(`
      INSERT INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, created_at, updated_at)
      VALUES
        ('crisp-calibrated-arctic-kuiper', 'global', 'workspace-old', 'workstream-old',
         '2026-08-06T04:46:44.006Z', '2026-08-06T04:46:44.006Z'),
        ('steady-modern-starlit-kovalevsky', 'global', 'workspace-new', 'workstream-new',
         '2026-08-25T19:11:44.007Z', '2026-08-25T19:11:44.007Z');
    `);

    database.exec(migration);

    expect(database.prepare(
      "SELECT email_address, address_source FROM workstream_email_routes ORDER BY workspace_id",
    ).all()).toEqual([
      {
        email_address: "steady-modern-starlit-kovalevsky@automation.rallywith.ai",
        address_source: "migration",
      },
      {
        email_address: "crisp-calibrated-arctic-kuiper@automation.with-avalon.com",
        address_source: "migration",
      },
    ]);

    database.exec(`
      UPDATE workstream_email_routes
      SET email_address = 'crisp-calibrated-arctic-kuiper@customer.example',
          address_source = 'owner'
      WHERE workspace_id = 'workspace-old';
    `);
    expect(() => database.exec(`
      UPDATE workstream_email_routes
      SET email_address = 'crisp-calibrated-arctic-kuiper@second.example'
      WHERE workspace_id = 'workspace-old';
    `)).toThrow(/immutable/u);
  });
});
