import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function migrateFreshDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  for (const fileName of migrationFiles) {
    database.exec(readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"));
  }
  return database;
}

describe("database migrations", () => {
  it("leaves every connector foreign key on the live connector table", () => {
    const database = migrateFreshDatabase();
    const staleReference = database.prepare(
      "SELECT COUNT(*) AS count FROM sqlite_schema WHERE sql LIKE '%connector_connections_before_provider_apps%'",
    ).get() as { count: number };
    expect(staleReference.count).toBe(0);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-1', 'google-1', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-1', 'Workspace', 'workspace', 'global', 'user-1', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, created_at, updated_at)
      VALUES ('connection-1', 'workspace-1', 'github', 'workspace', 'GitHub', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-1', 'workspace-1', 'Smoke', 'Smoke', 'ad_hoc', 'user-1',
              'running', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('run-1', 'workspace-1', 'workstream-1', 'test', '{}', 'running', '2026-01-01');
      INSERT INTO activities
        (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
         event_type, occurred_at, received_at, title, dedupe_key)
      VALUES ('activity-1', 'workspace-1', 'connection-1', 'workspace', 'github', 'event-1',
              'push', '2026-01-01', '2026-01-01', 'Push', 'push:event-1');
      INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
         title, created_at, updated_at)
      VALUES ('resource-1', 'workspace-1', 'connection-1', 'repository', 'github', 'repo-1',
              'Repo', '2026-01-01', '2026-01-01');
      INSERT INTO tool_invocations
        (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
         connection_id, input_hash, input_json, status)
      VALUES ('tool-1', 'workspace-1', 'workstream-1', 'run-1', 'call-1',
              'github.repository.get', 'connection-1', 'hash-1', '{}', 'pending');
    `);

    database.exec("DELETE FROM connector_connections WHERE id = 'connection-1'");
    expect(database.prepare("SELECT COUNT(*) AS count FROM activities").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT connection_id FROM resources WHERE id = 'resource-1'").get())
      .toEqual({ connection_id: null });
    expect(database.prepare("SELECT connection_id FROM tool_invocations WHERE id = 'tool-1'").get())
      .toEqual({ connection_id: null });
    database.close();
  });

  it("removes poll deadlines from webhook-native resource watches without disabling routing", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-watch', 'google-watch', 'watch@example.com', 'Watcher', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-watch', 'Watch Workspace', 'watch-workspace', 'global', 'user-watch', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, created_at, updated_at)
      VALUES
        ('connection-github', 'workspace-watch', 'github', 'workspace', 'GitHub', '2026-01-01', '2026-01-01'),
        ('connection-google', 'workspace-watch', 'google', 'workspace', 'Google', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-watch', 'workspace-watch', 'Watch', 'Watch resources', 'ad_hoc', 'user-watch',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
         title, created_at, updated_at)
      VALUES
        ('resource-github', 'workspace-watch', 'connection-github', 'github_pull_request', 'github', 'pr-1',
         'Pull request', '2026-01-01', '2026-01-01'),
        ('resource-google', 'workspace-watch', 'connection-google', 'drive_file', 'google', 'file-1',
         'Drive file', '2026-01-01', '2026-01-01');
      INSERT INTO workstream_resources
        (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
      VALUES
        ('workstream-watch', 'resource-github', 'user-watch', 0, 'attachment', '2026-01-01'),
        ('workstream-watch', 'resource-google', 'user-watch', 0, 'attachment', '2026-01-01');
      INSERT INTO resource_watches
        (id, workspace_id, workstream_id, resource_id, connection_id, watch_type,
         cursor_json, next_poll_at, enabled, created_at, updated_at)
      VALUES
        ('watch-github', 'workspace-watch', 'workstream-watch', 'resource-github', 'connection-github',
         'incremental', '{}', '2026-08-01T12:00:00.000Z', 1, '2026-01-01', '2026-01-01'),
        ('watch-google', 'workspace-watch', 'workstream-watch', 'resource-google', 'connection-google',
         'incremental', '{}', '2026-08-01T12:00:00.000Z', 1, '2026-01-01', '2026-01-01');
    `);

    database.exec(readFileSync(new URL("../migrations/0016_webhook_resource_watches.sql", import.meta.url), "utf8"));

    expect(database.prepare("SELECT watch_type, next_poll_at FROM resource_watches WHERE id = 'watch-github'").get())
      .toEqual({ watch_type: "webhook", next_poll_at: null });
    expect(database.prepare("SELECT watch_type, next_poll_at FROM resource_watches WHERE id = 'watch-google'").get())
      .toEqual({ watch_type: "incremental", next_poll_at: "2026-08-01T12:00:00.000Z" });
    expect(database.prepare("SELECT resource_id, watch_enabled FROM workstream_resources ORDER BY resource_id").all())
      .toEqual([
        { resource_id: "resource-github", watch_enabled: 1 },
        { resource_id: "resource-google", watch_enabled: 1 },
      ]);
    expect(database.prepare(
      "SELECT id FROM resource_watches WHERE enabled = 1 AND next_poll_at IS NOT NULL ORDER BY id",
    ).all()).toEqual([{ id: "watch-google" }]);
    database.close();
  });
});
