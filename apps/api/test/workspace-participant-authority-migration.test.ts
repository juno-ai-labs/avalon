import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

it("schedules historical conversations for grant authority without reimporting completed or unpublished scopes", () => {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((entry) => entry.version < 127)) {
      for (const statement of migration.statements) database.exec(statement);
    }
    database.exec(`INSERT INTO parent_metadata
      (parent_id, parent_kind, workspace_id, region, authority_generation, created_at, updated_at)
      VALUES ('channel', 'workstream', 'organization', 'global', 1, 0, 0),
             ('space', 'space', 'organization', 'global', 1, 0, 0),
             ('implicit', 'workstream', 'organization', 'global', 1, 0, 0)`);
    for (const [parentId, substreamId, status] of [
      ["channel", "0", "ready"], ["channel", "breakout", "ready"], ["channel", "done", "ready"],
      ["channel", "reserved", "reserved"], ["space", "0", "ready"],
    ]) {
      database.prepare("INSERT INTO parent_children(parent_id, substream_id, kind, status, created_at) VALUES (?, ?, ?, ?, 0)")
        .run(parentId!, substreamId!, substreamId === "0" ? "main" : "child", status!);
      database.prepare("INSERT INTO parent_child_projections VALUES (?, ?, 1, 'hash', '{}', 0)").run(parentId!, substreamId!);
    }
    database.exec("INSERT INTO parent_child_projections VALUES ('implicit', '0', 1, 'hash', '{}', 0)");
    database.exec(`INSERT INTO parent_participant_migrations
      (parent_id, substream_id, transfer_id, phase) VALUES ('channel', 'done', 'transfer', 'complete')`);
    for (const statement of WORKSPACE_DO_SCHEMA_MIGRATIONS.find((entry) => entry.version === 127)!.statements) database.exec(statement);
    expect(database.prepare("SELECT kind, alarm_key FROM _internal_durable_alarms WHERE kind = 'parent_participant_migration' ORDER BY alarm_key").all())
      .toEqual([
        { kind: "parent_participant_migration", alarm_key: "channel:0" },
        { kind: "parent_participant_migration", alarm_key: "channel:breakout" },
        { kind: "parent_participant_migration", alarm_key: "implicit:0" },
      ]);
    expect(database.prepare("SELECT import_roster FROM parent_participant_migrations WHERE substream_id = 'done'").get())
      .toEqual({ import_roster: 1 });
  } finally {
    database.close();
  }
});
