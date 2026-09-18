import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { databaseThroughMigration } from "./helpers/migrated-schema";

it("drops only the legacy observability tables and can safely run again", () => {
  const database = databaseThroughMigration("0112_browser_sessions.sql");
  try {
    database.prepare(`INSERT INTO users
      (id, google_subject, email, name, created_at, updated_at)
      VALUES ('kept-user', 'kept-subject', 'person@example.com', 'Person', '2026-09-18', '2026-09-18')`).run();
    database.prepare(`INSERT INTO telemetry_delivery_receipts
      (event_id, payload_hash, route, result_code, created_at, delete_at)
      VALUES ('discarded-event', 'hash', 'global', 'accepted', '2026-09-18', '2026-12-18')`).run();
    const migration = readFileSync(new URL("../../../packages/db/migrations/0113_drop_legacy_observability_tables.sql", import.meta.url), "utf8");
    const retired = new Set(["telemetry_accepted_events", "telemetry_delivery_receipts", "telemetry_replay_audit", "audit_events"]);
    const schema = () => database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    const retainedSchema = schema().filter((row) => !retired.has(String(row.tbl_name)));
    database.exec(migration);
    database.exec(migration);
    expect(schema()).toEqual(retainedSchema);
    expect(database.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN
      ('telemetry_accepted_events', 'telemetry_delivery_receipts', 'telemetry_replay_audit', 'audit_events')`).all()).toEqual([]);
    expect(database.prepare("SELECT id FROM users").all()).toEqual([{ id: "kept-user" }]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
