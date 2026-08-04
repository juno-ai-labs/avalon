import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

function migrateDatabaseThrough(lastMigration?: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  const migrationFiles = readdirSync(migrationsDirectory)
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  for (const fileName of migrationFiles) {
    database.exec(readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"));
    if (fileName === lastMigration) break;
  }
  return database;
}

function migrateFreshDatabase(): DatabaseSync {
  return migrateDatabaseThrough();
}

describe("database migrations", () => {
  it("cuts over active prototype runs and installs immutable Bind durability rails", () => {
    const database = migrateDatabaseThrough("0025_user_workspace_timezones.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-bind', 'google-bind', 'bind@example.com', 'Bind Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-bind', 'Bind Workspace', 'bind-workspace', 'global', 'user-bind', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-bind', 'workspace-bind', 'Bind', 'Cut over safely', 'ad_hoc', 'user-bind',
              'running', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES
        ('run-active', 'workspace-bind', 'workstream-bind', 'test', '{}', 'running', '2026-01-01'),
        ('run-history', 'workspace-bind', 'workstream-bind', 'test', '{}', 'completed', '2026-01-01');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0026_bind_runtime_durability.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT status, terminalized_at, error_json FROM harness_runs WHERE id = 'run-active'",
    ).get()).toMatchObject({
      status: "failed",
      error_json: '{"code":"runtime_cutover","message":"The prototype run ended during the Bind 10 runtime cutover"}',
    });
    expect(database.prepare(
      "SELECT status, terminalized_at FROM harness_runs WHERE id = 'run-history'",
    ).get()).toEqual({ status: "completed", terminalized_at: null });
    expect(database.prepare(
      "SELECT harness_status FROM workstreams WHERE id = 'workstream-bind'",
    ).get()).toEqual({ harness_status: "failed" });

    database.exec(`
      INSERT INTO harness_run_scopes
        (harness_run_id, workspace_id, workstream_id, attempt_id, execution_principal_json,
         routing_policy_version, prompt_version, tool_surface_hash, scope_hash, created_at)
      VALUES ('run-active', 'workspace-bind', 'workstream-bind', 'attempt-1', '{}',
              'routing-v1', 'prompt-v1', 'surface-hash', 'scope-hash', '2026-01-01');
    `);
    expect(() => database.exec(
      "UPDATE harness_run_scopes SET prompt_version = 'changed' WHERE harness_run_id = 'run-active'",
    )).toThrow(/harness_run_scope_immutable/u);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM inference_attempts",
    ).get()).toEqual({ count: 0 });
    expect(database.prepare("PRAGMA table_info(harness_run_scopes)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "eligible_connection_capabilities_json" }),
      ]),
    );
    expect(database.prepare("PRAGMA table_info(messages)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "harness_run_id" }),
        expect.objectContaining({ name: "harness_attempt_id" }),
      ]),
    );
    database.close();
  });

  it("sets fixed timezone defaults with one migration", () => {
    const database = migrateDatabaseThrough("0024_linear_connection_identity_uniqueness.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-global', 'google-global', 'global@example.com', 'Global User', '2026-01-01', '2026-01-01'),
        ('user-eu', 'google-eu', 'eu@example.com', 'EU User', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES
        ('workspace-global', 'Global', 'global', 'global', 'user-global', '2026-01-01', '2026-01-01'),
        ('workspace-eu', 'EU', 'eu', 'eu', 'user-eu', '2026-01-01', '2026-01-01');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0025_user_workspace_timezones.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare("SELECT id, timezone FROM users ORDER BY id").all()).toEqual([
      { id: "user-eu", timezone: "America/Los_Angeles" },
      { id: "user-global", timezone: "America/Los_Angeles" },
    ]);
    expect(database.prepare("SELECT id, timezone FROM workspaces ORDER BY id").all()).toEqual([
      { id: "workspace-eu", timezone: "Europe/London" },
      { id: "workspace-global", timezone: "America/Los_Angeles" },
    ]);
    database.close();
  });

  it("corrects the pre-release plural work-stream email domain without changing its reserved name", () => {
    const database = migrateDatabaseThrough("0020_workstream_email_route_lifecycle.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-domain', 'google-domain', 'domain@example.com', 'Domain Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-domain', 'Domain Workspace', 'domain-workspace', 'global', 'user-domain', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, email_address, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-domain', 'workspace-domain', 'Inbox', 'Email this work stream',
              'bright-steady-clear-otter@automations.with-avalon.com', 'ad_hoc', 'user-domain',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0021_workstream_email_domain_correction.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT email_address FROM workstreams WHERE id = 'workstream-domain'",
    ).get()).toEqual({
      email_address: "bright-steady-clear-otter@automation.with-avalon.com",
    });
    expect(() => database.exec(
      "UPDATE workstreams SET email_address = 'different@automation.with-avalon.com' WHERE id = 'workstream-domain'",
    )).toThrow(/immutable/u);
    database.close();
  });

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

  it("keeps work-stream email addresses immutable and permanently reserves routes", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-email', 'google-email', 'email@example.com', 'Email Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-email', 'Email Workspace', 'email-workspace', 'global', 'user-email', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, email_address, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-email', 'workspace-email', 'Inbox', 'Email this work stream',
              'bright-steady-clear-otter@automation.with-avalon.com', 'ad_hoc', 'user-email',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, status, created_at, updated_at)
      VALUES ('bright-steady-clear-otter', 'global', 'workspace-email', 'workstream-email',
              'active', '2026-01-01', '2026-01-01');
    `);

    expect(() => database.exec(
      "UPDATE workstreams SET email_address = 'different-address@automation.with-avalon.com' WHERE id = 'workstream-email'",
    )).toThrow(/immutable/u);
    expect(() => database.exec(`
      INSERT INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, status, created_at, updated_at)
      VALUES ('bright-steady-clear-otter', 'global', 'workspace-other', 'workstream-other',
              'active', '2026-01-01', '2026-01-01');
    `)).toThrow();
    expect(() => database.exec(
      "UPDATE workstream_email_routes SET local_part = 'different-route' WHERE workstream_id = 'workstream-email'",
    )).toThrow(/immutable/u);
    expect(() => database.exec(
      "DELETE FROM workstream_email_routes WHERE workstream_id = 'workstream-email'",
    )).toThrow(/permanent tombstones/u);

    database.exec("DELETE FROM workstreams WHERE id = 'workstream-email'");
    expect(database.prepare(
      "SELECT local_part, workstream_id FROM workstream_email_routes WHERE local_part = 'bright-steady-clear-otter'",
    ).get()).toEqual({
      local_part: "bright-steady-clear-otter",
      workstream_id: "workstream-email",
    });
    database.close();
  });

  it("shares one permanent route namespace between work streams and automations", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-automation-email', 'google-automation-email', 'automation@example.com',
              'Automation Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-automation-email', 'Automation Email', 'automation-email', 'eu',
              'user-automation-email', '2026-01-01', '2026-01-01');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES ('template-automation-email', 'workspace-automation-email', 'user-automation-email',
              'Email kickoff', 'Start from email', 'private', 1, '2026-01-01', '2026-01-01');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         required_capabilities_json, expected_outputs_json, default_behavior_json,
         created_by_user_id, created_at)
      VALUES ('version-automation-email', 'template-automation-email', 1, 'Process the email',
              '[]', '[]', '[]', '{}', 'user-automation-email', '2026-01-01');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, connector_bindings_json, overrides_json, status,
         email_address, email_route_status, created_at, updated_at)
      VALUES ('subscription-automation-email', 'workspace-automation-email',
              'template-automation-email', 'version-automation-email', 'personal',
              'user-automation-email', '{"type":"user","userId":"user-automation-email"}',
              '{}', '{}', 'active',
              'bright-steady-clear-otter@automation.with-avalon.com', 'active',
              '2026-01-01', '2026-01-01');
      INSERT INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id,
         status, created_at, updated_at)
      VALUES ('bright-steady-clear-otter', 'eu', 'workspace-automation-email', NULL,
              'subscription-automation-email', 'active', '2026-01-01', '2026-01-01');
    `);

    expect(() => database.exec(`
      INSERT INTO workstream_email_routes
        (local_part, region, workspace_id, workstream_id, automation_subscription_id,
         status, created_at, updated_at)
      VALUES ('BRIGHT-STEADY-CLEAR-OTTER', 'global', 'another-workspace',
              'another-workstream', NULL, 'active', '2026-01-01', '2026-01-01');
    `)).toThrow();
    expect(() => database.exec(
      "UPDATE automation_subscriptions SET email_address = 'other@automation.with-avalon.com' WHERE id = 'subscription-automation-email'",
    )).toThrow(/immutable/u);
    expect(() => database.exec(
      "UPDATE workstream_email_routes SET automation_subscription_id = 'other' WHERE automation_subscription_id = 'subscription-automation-email'",
    )).toThrow(/immutable/u);
    expect(() => database.exec(
      "DELETE FROM workstream_email_routes WHERE automation_subscription_id = 'subscription-automation-email'",
    )).toThrow(/permanent tombstones/u);
    database.close();
  });

  it("supports atomic expiry and reclamation of regional email-processing leases", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-lease', 'google-lease', 'lease@example.com', 'Lease Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-lease', 'Lease Workspace', 'lease-workspace', 'eu', 'user-lease', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, email_address, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-lease', 'workspace-lease', 'Inbox', 'Email this work stream',
              'bright-steady-clear-otter@automation.with-avalon.com', 'ad_hoc', 'user-lease',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO workstream_email_receipts
        (resend_email_id, workstream_id, workspace_id, svix_id, received_at,
         lease_token, lease_expires_at)
      VALUES ('email-lease', 'workstream-lease', 'workspace-lease', 'svix-lease',
              '2026-08-02T18:00:00.000Z', 'worker-one', '2026-08-02T18:05:00.000Z');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES ('template-lease', 'workspace-lease', 'user-lease', 'Lease automation',
              'Test email receipt leases', 'private', 1, '2026-01-01', '2026-01-01');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         required_capabilities_json, expected_outputs_json, default_behavior_json,
         created_by_user_id, created_at)
      VALUES ('version-lease', 'template-lease', 1, 'Process the email', '[]', '[]',
              '[]', '{}', 'user-lease', '2026-01-01');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, connector_bindings_json, overrides_json, status,
         email_address, email_route_status, created_at, updated_at)
      VALUES ('subscription-lease', 'workspace-lease', 'template-lease', 'version-lease',
              'personal', 'user-lease', '{"type":"user","userId":"user-lease"}',
              '{}', '{}', 'active', 'calm-bright-gentle-otter@automation.with-avalon.com',
              'active', '2026-01-01', '2026-01-01');
      INSERT INTO automation_email_receipts
        (resend_email_id, automation_subscription_id, workspace_id, svix_id, received_at,
         lease_token, lease_expires_at)
      VALUES ('automation-email-lease', 'subscription-lease', 'workspace-lease',
              'automation-svix-lease', '2026-08-02T18:00:00.000Z', 'worker-one',
              '2026-08-02T18:05:00.000Z');
    `);

    const beforeExpiry = database.prepare(`
      UPDATE workstream_email_receipts
      SET lease_token = ?, lease_expires_at = ?
      WHERE resend_email_id = ? AND workstream_id = ? AND processed_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(
      "worker-two",
      "2026-08-02T18:10:00.000Z",
      "email-lease",
      "workstream-lease",
      "2026-08-02T18:04:59.000Z",
    );
    expect(beforeExpiry.changes).toBe(0);

    const afterExpiry = database.prepare(`
      UPDATE workstream_email_receipts
      SET lease_token = ?, lease_expires_at = ?
      WHERE resend_email_id = ? AND workstream_id = ? AND processed_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(
      "worker-two",
      "2026-08-02T18:10:00.000Z",
      "email-lease",
      "workstream-lease",
      "2026-08-02T18:05:00.000Z",
    );
    expect(afterExpiry.changes).toBe(1);
    expect(database.prepare(`
      SELECT lease_token, lease_expires_at
      FROM workstream_email_receipts
      WHERE resend_email_id = 'email-lease' AND workstream_id = 'workstream-lease'
    `).get()).toEqual({
      lease_token: "worker-two",
      lease_expires_at: "2026-08-02T18:10:00.000Z",
    });

    const automationBeforeExpiry = database.prepare(`
      UPDATE automation_email_receipts
      SET lease_token = ?, lease_expires_at = ?
      WHERE resend_email_id = ? AND automation_subscription_id = ? AND processed_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(
      "worker-two",
      "2026-08-02T18:10:00.000Z",
      "automation-email-lease",
      "subscription-lease",
      "2026-08-02T18:04:59.000Z",
    );
    expect(automationBeforeExpiry.changes).toBe(0);

    const automationAfterExpiry = database.prepare(`
      UPDATE automation_email_receipts
      SET lease_token = ?, lease_expires_at = ?
      WHERE resend_email_id = ? AND automation_subscription_id = ? AND processed_at IS NULL
        AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(
      "worker-two",
      "2026-08-02T18:10:00.000Z",
      "automation-email-lease",
      "subscription-lease",
      "2026-08-02T18:05:00.000Z",
    );
    expect(automationAfterExpiry.changes).toBe(1);
    expect(database.prepare(`
      SELECT lease_token, lease_expires_at
      FROM automation_email_receipts
      WHERE resend_email_id = 'automation-email-lease'
        AND automation_subscription_id = 'subscription-lease'
    `).get()).toEqual({
      lease_token: "worker-two",
      lease_expires_at: "2026-08-02T18:10:00.000Z",
    });

    const claimAutomationEmailBudget = database.prepare(`
      INSERT INTO automation_email_rate_windows
        (automation_subscription_id, workspace_id, window_started_at, accepted_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(automation_subscription_id, window_started_at) DO UPDATE SET
        accepted_count = accepted_count + 1
      WHERE automation_email_rate_windows.accepted_count < ?
      RETURNING accepted_count
    `);
    expect(claimAutomationEmailBudget.get(
      "subscription-lease",
      "workspace-lease",
      "2026-08-02T18:00:00.000Z",
      2,
    )).toEqual({ accepted_count: 1 });
    expect(claimAutomationEmailBudget.get(
      "subscription-lease",
      "workspace-lease",
      "2026-08-02T18:00:00.000Z",
      2,
    )).toEqual({ accepted_count: 2 });
    expect(claimAutomationEmailBudget.get(
      "subscription-lease",
      "workspace-lease",
      "2026-08-02T18:00:00.000Z",
      2,
    )).toBeUndefined();
    database.close();
  });
});
