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

describe("agent inference payload ledger retirement", () => {
  it("drops the D1 index and workspace preference without losing the workspace", () => {
    const database = new DatabaseSync(":memory:");
    try {
      applyThrough(database, "0093_expand_agent_inference_log_sources.sql");
      database.prepare(
        `INSERT INTO users
         (id, google_subject, email, name, created_at, updated_at)
         VALUES ('user-1', 'google-1', 'one@example.com', 'One',
                 '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
      ).run();
      database.prepare(
        `INSERT INTO workspaces
         (id, name, slug, region, created_by_user_id, log_agent_inference, created_at, updated_at)
         VALUES ('workspace-1', 'One', 'one', 'global', 'user-1', 1,
                 '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
      ).run();
      database.prepare(
        `INSERT INTO agent_inference_payload_logs
         (id, workspace_id, request_id, turn_id, source, provider, model,
          provider_model, metadata_json, object_key, payload_sha256, payload_bytes, created_at)
         VALUES ('inference-1', 'workspace-1', 'run-1', 'turn-1', 'workstream',
                 'openrouter', 'x-ai/grok-4.3', 'x-ai/grok-4.3', '{}',
                 'agent-inference/workspace-1/inference-1.json', 'sha256', 2,
                 '2026-08-24T00:00:00.000Z')`,
      ).run();

      database.exec(readFileSync(
        `${migrationsDirectory}0094_retire_agent_inference_payload_ledger.sql`,
        "utf8",
      ));

      expect(database.prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'agent_inference_payload_logs'",
      ).get()).toBeUndefined();
      const workspaceColumns = database.prepare("PRAGMA table_info(workspaces)").all()
        .map((column) => column.name);
      expect(workspaceColumns).not.toContain("log_agent_inference");
      expect(database.prepare(
        "SELECT id, name, timezone FROM workspaces WHERE id = 'workspace-1'",
      ).get()).toEqual({
        id: "workspace-1",
        name: "One",
        timezone: "America/Los_Angeles",
      });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
