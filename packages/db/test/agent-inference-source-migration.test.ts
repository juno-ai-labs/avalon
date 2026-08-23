import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort((left, right) => {
    const numberDifference = Number.parseInt(left, 10) - Number.parseInt(right, 10);
    if (numberDifference !== 0) return numberDifference;
    return left < right ? -1 : left > right ? 1 : 0;
  });

function applyThrough(database: DatabaseSync, lastName: string): void {
  for (const name of migrationNames) {
    database.exec(readFileSync(`${migrationsDirectory}${name}`, "utf8"));
    if (name === lastName) return;
  }
  throw new Error(`Migration ${lastName} was not found`);
}

function insertPayloadLog(database: DatabaseSync, id: string, source: string): void {
  database.prepare(
    `INSERT INTO agent_inference_payload_logs
     (id, workspace_id, request_id, workstream_id, turn_id, source, provider,
      model, provider_model, metadata_json, object_key, payload_sha256,
      payload_bytes, created_at)
     VALUES (?, 'workspace-1', ?, 'workstream-1', ?, ?, 'openrouter',
             'x-ai/grok-4.3', 'x-ai/grok-4.3', '{}', ?, 'sha256', 2,
             '2026-08-23T00:00:00.000Z')`,
  ).run(id, `request-${id}`, `turn-${id}`, source, `payload-${id}.json`);
}

describe("agent inference payload log source migration", () => {
  it("preserves existing rows and admits every runtime source without widening the vocabulary", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyThrough(database, "0092_email_routes_hold_only_the_claim.sql");
      database.prepare(
        `INSERT INTO users
         (id, google_subject, email, name, created_at, updated_at)
         VALUES ('user-1', 'google-1', 'one@example.com', 'One',
                 '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
      ).run();
      database.prepare(
        `INSERT INTO workspaces
         (id, name, slug, region, created_by_user_id, created_at, updated_at)
         VALUES ('workspace-1', 'One', 'one', 'global', 'user-1',
                 '2026-08-23T00:00:00.000Z', '2026-08-23T00:00:00.000Z')`,
      ).run();
      insertPayloadLog(database, "existing-workstream", "workstream");
      insertPayloadLog(database, "existing-automation", "automation_compiler");
      insertPayloadLog(database, "existing-inline", "inline_child");

      database.exec(readFileSync(
        `${migrationsDirectory}0093_expand_agent_inference_log_sources.sql`,
        "utf8",
      ));

      insertPayloadLog(database, "block", "block_dashboard");
      insertPayloadLog(database, "meeting", "meeting_notes");
      expect(database.prepare(
        "SELECT id, source FROM agent_inference_payload_logs ORDER BY id",
      ).all()).toEqual([
        { id: "block", source: "block_dashboard" },
        { id: "existing-automation", source: "automation_compiler" },
        { id: "existing-inline", source: "inline_child" },
        { id: "existing-workstream", source: "workstream" },
        { id: "meeting", source: "meeting_notes" },
      ]);
      expect(() => insertPayloadLog(database, "unknown", "unknown")).toThrow(
        /CHECK constraint failed/u,
      );
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
