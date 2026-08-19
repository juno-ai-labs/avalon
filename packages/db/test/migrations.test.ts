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
  it("keeps the deployed HyperSight filename and renames its tables forward", () => {
    const migrationFiles = readdirSync(migrationsDirectory)
      .filter((fileName) => fileName.endsWith(".sql"));
    expect(migrationFiles).toContain("0043_hypersight.sql");
    expect(migrationFiles).not.toContain("0043_block_dashboard.sql");

    const database = migrateDatabaseThrough("0043_hypersight.sql");
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hypersight_configuration_versions'",
    ).get()).toEqual({ name: "hypersight_configuration_versions" });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'block_dashboard_configuration_versions'",
    ).get()).toBeUndefined();

    database.exec(readFileSync(
      new URL("../migrations/0078_rename_hypersight_to_block_dashboard.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name LIKE 'block_dashboard_%' ORDER BY name`,
    ).all()).toEqual([
      { name: "block_dashboard_block_runs" },
      { name: "block_dashboard_configuration_versions" },
      { name: "block_dashboard_user_preferences" },
    ]);
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'hypersight_%'",
    ).all()).toEqual([]);
    database.close();
  });

  it("persists region-compatible immutable workspace placement affinity", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('placement-owner', 'placement-subject', 'placement@example.com',
              'Placement Owner', '2026-08-17', '2026-08-17');
      INSERT INTO workspaces
        (id, name, slug, region, placement_affinity, created_by_user_id, created_at, updated_at)
      VALUES ('placement-east', 'Placement East', 'placement-east', 'eu', 'eeur',
              'placement-owner', '2026-08-17', '2026-08-17');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('placement-fallback', 'Placement Fallback', 'placement-fallback', 'eu',
              'placement-owner', '2026-08-17', '2026-08-17');
      INSERT INTO platform_workspace_bindings
        (platform_user_id, region, workspace_id, placement_affinity, status,
         operation_id, created_at, updated_at)
      VALUES ('platform-placement', 'eu', 'placement-east', 'eeur', 'active',
              'placement-operation', '2026-08-17', '2026-08-17');
    `);

    expect(database.prepare(
      "SELECT id, placement_affinity FROM workspaces WHERE id LIKE 'placement-%' ORDER BY id",
    ).all()).toEqual([
      { id: "placement-east", placement_affinity: "eeur" },
      { id: "placement-fallback", placement_affinity: "weur" },
    ]);
    expect(database.prepare(
      "SELECT placement_affinity FROM platform_workspace_bindings WHERE platform_user_id = ?",
    ).get("platform-placement")).toEqual({ placement_affinity: "eeur" });
    expect(() => database.prepare(
      "UPDATE workspaces SET placement_affinity = 'weur' WHERE id = 'placement-east'",
    ).run()).toThrow(/workspace_placement_affinity_immutable/u);
    expect(() => database.prepare(
      `UPDATE platform_workspace_bindings SET placement_affinity = 'weur'
       WHERE platform_user_id = 'platform-placement'`,
    ).run()).toThrow(/workspace_placement_affinity_immutable/u);
    database.close();
  });

  it("backfills and maintains the minimal connector ingress directory", () => {
    const database = migrateDatabaseThrough("0082_workspace_durable_object_placement_affinity.sql");
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('route-owner', 'route-subject', 'route@example.com', 'Route Owner', '2026-08-18', '2026-08-18');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('route-workspace', 'Route Workspace', 'route-workspace', 'global',
                'route-owner', '2026-08-18', '2026-08-18');
        INSERT INTO connector_connections
          (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
           display_name, granted_scopes_json, model_plugin_id, status, config_json,
           created_at, updated_at)
        VALUES
          ('route-provider', 'route-workspace', 'github', 'personal', 'route-owner', 'installation-1',
           'Provider user', '[]', 'plugin_route_provider', 'healthy', '{"providerUserId":"provider-user"}',
           '2026-08-18', '2026-08-18'),
          ('route-github', 'route-workspace', 'github', 'workspace', NULL, 'installation-2',
           'GitHub user', '[]', 'plugin_route_github', 'healthy', '{"githubUserId":"github-user"}',
           '2026-08-18', '2026-08-18'),
          ('route-disabled', 'route-workspace', 'slack', 'workspace', NULL, 'team-disabled',
           'Disabled', '[]', 'plugin_route_disabled', 'disabled', '{}',
           '2026-08-18', '2026-08-18');
      `);
      database.exec(readFileSync(
        new URL("../migrations/0083_workspace_product_do_authority.sql", import.meta.url),
        "utf8",
      ));

      expect(database.prepare(
        `SELECT connection_id, region, provider_user_id, status
           FROM connector_ingress_routes ORDER BY connection_id`,
      ).all()).toEqual([
        { connection_id: "route-disabled", region: "global", provider_user_id: null, status: "disabled" },
        { connection_id: "route-github", region: "global", provider_user_id: "github-user", status: "active" },
        { connection_id: "route-provider", region: "global", provider_user_id: "provider-user", status: "active" },
      ]);

      database.exec(`
        INSERT INTO connector_connections
          (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
           display_name, granted_scopes_json, model_plugin_id, status, config_json,
           created_at, updated_at)
        VALUES ('route-trigger', 'route-workspace', 'github', 'workspace', NULL, 'installation-3',
                'Trigger', '[]', 'plugin_route_trigger', 'healthy',
                '{"providerUserId":"first-user"}', '2026-08-18', '2026-08-18');
        UPDATE connector_connections
           SET config_json = '{"githubUserId":"second-user"}', status = 'disabled',
               updated_at = '2026-08-18T01:00:00.000Z'
         WHERE id = 'route-trigger';
      `);
      expect(database.prepare(
        `SELECT provider_account_id, provider_user_id, status, updated_at
           FROM connector_ingress_routes WHERE connection_id = 'route-trigger'`,
      ).get()).toEqual({
        provider_account_id: "installation-3",
        provider_user_id: "second-user",
        status: "disabled",
        updated_at: "2026-08-18T01:00:00.000Z",
      });
    } finally {
      database.close();
    }
  });

  it("fails closed on illegal cutover phases and requires a new generation after quarantine", () => {
    const database = migrateFreshDatabase();
    try {
      expect(() => database.exec(
        `UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1`,
      )).toThrow(/workstream_authority_invalid_phase_transition/u);
      database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1,
               started_at = '2026-08-18T00:00:00.000Z', updated_at = '2026-08-18T00:00:00.000Z'
         WHERE id = 1;
        UPDATE workstream_authority_control
           SET phase = 'maintenance_importing', updated_at = '2026-08-18T00:01:00.000Z'
         WHERE id = 1;
        UPDATE workstream_authority_control
           SET phase = 'quarantined', updated_at = '2026-08-18T00:02:00.000Z'
         WHERE id = 1;
      `);
      expect(() => database.exec(
        `UPDATE workstream_authority_control SET phase = 'maintenance_draining' WHERE id = 1`,
      )).toThrow(/workstream_authority_invalid_phase_transition/u);
      database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 2,
               updated_at = '2026-08-18T00:03:00.000Z'
         WHERE id = 1;
      `);
      expect(database.prepare(
        `SELECT phase, generation FROM workstream_authority_control WHERE id = 1`,
      ).get()).toEqual({ phase: "maintenance_draining", generation: 2 });
    } finally {
      database.close();
    }
  });

  it("blocks import while any workspace-domain handoff remains drainable", () => {
    const database = migrateFreshDatabase();
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('drain-owner', 'drain-subject', 'drain@example.com', 'Drain Owner', '2026-08-18', '2026-08-18');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('drain-workspace', 'Drain Workspace', 'drain-workspace', 'global',
                'drain-owner', '2026-08-18', '2026-08-18');
        INSERT INTO connector_connections
          (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
           display_name, granted_scopes_json, model_plugin_id, status, config_json,
           created_at, updated_at)
        VALUES ('drain-slack', 'drain-workspace', 'slack', 'workspace', NULL, 'team-drain',
                'Drain Slack', '[]', 'plugin_drain_slack', 'healthy', '{}',
                '2026-08-18', '2026-08-18');
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1,
               started_at = '2026-08-18T00:00:00.000Z', updated_at = '2026-08-18T00:00:00.000Z'
         WHERE id = 1;
      `);
      const assertGuarded = (insert: string, cleanup: string): void => {
        database.exec(insert);
        expect(() => database.exec(
          `UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1`,
        )).toThrow(/workspace_domain_handoffs_not_drained/u);
        database.exec(cleanup);
      };
      assertGuarded(
        `INSERT INTO note_resource_deletion_outbox
           (resource_id, content_ref, model_content_ref, created_at)
         VALUES ('note-resource', 'content', NULL, '2026-08-18')`,
        `DELETE FROM note_resource_deletion_outbox`,
      );
      assertGuarded(
        `INSERT INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
         VALUES ('object-ref', 'drain-workspace', 'resource', 'original', '2026-08-18', '2026-08-18')`,
        `DELETE FROM resource_object_deletion_outbox`,
      );
      for (const status of ["pending", "processing"] as const) {
        assertGuarded(
          `INSERT INTO activities
             (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
              event_type, occurred_at, received_at, title, dedupe_key, processing_status)
           VALUES ('activity-${status}', 'drain-workspace', 'drain-slack', 'workspace', 'slack',
                   'event-${status}', 'message', '2026-08-18', '2026-08-18', 'Activity',
                   'dedupe-${status}', '${status}')`,
          `DELETE FROM activities`,
        );
      }
      for (const [status, payload, attempts] of [
        ["queued", "{}", 0],
        ["processing", "{}", 1],
        ["failed", "{}", 19],
      ] as const) {
        assertGuarded(
          `INSERT INTO slack_ingress_jobs
             (id, workspace_id, connection_id, team_id, body_hash, kind, payload_json,
              status, attempt_count, received_at, updated_at)
           VALUES ('slack-${status}', 'drain-workspace', 'drain-slack', 'team-drain',
                   'hash-${status}', 'event', '${payload}', '${status}', ${attempts},
                   '2026-08-18', '2026-08-18')`,
          `DELETE FROM slack_ingress_jobs`,
        );
      }
      database.exec(
        `UPDATE workstream_authority_control SET phase = 'maintenance_importing' WHERE id = 1`,
      );
      expect(database.prepare(
        `SELECT phase FROM workstream_authority_control WHERE id = 1`,
      ).get()).toEqual({ phase: "maintenance_importing" });
    } finally {
      database.close();
    }
  });

  it("fences the maintenance cutover and leaves the workspace directory out of D1", () => {
    const database = migrateFreshDatabase();
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('authority-user', 'authority-subject', 'authority@example.com', 'Authority User',
                '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('authority-workspace', 'Authority Workspace', 'authority-workspace', 'global',
                'authority-user', '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
        INSERT INTO workstreams
          (id, workspace_id, title, objective, origin_type, created_by_user_id,
           harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
        VALUES ('authority-workstream', 'authority-workspace', 'Before', 'Objective', 'ad_hoc',
                'authority-user', 'completed', 4, '2026-08-16T00:00:00.000Z',
                '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
        INSERT INTO work_opportunities
          (id, workspace_id, audience_scope, display_prompt, execution_prompt,
           admission_reasoning, source_fingerprint, display_prompt_hash,
           execution_prompt_hash, expires_at, created_at, updated_at)
        VALUES ('migrated-opportunity', 'authority-workspace', 'workspace',
                'Imported suggestion', 'Imported private execution prompt',
                'Imported reasoning', 'source-fingerprint', 'display-hash',
                'execution-hash', '2099-01-01T00:00:00.000Z',
                '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z');
        UPDATE workstreams SET created_from_opportunity_id = 'migrated-opportunity'
         WHERE id = 'authority-workstream';
        INSERT INTO activity_events
          (id, workspace_id, event_type, subject_type, actor_type, actor_label,
           title, body, audience_kind, occurred_at, created_at, source_kind,
           dedupe_key, metadata_json, digestible)
        VALUES ('migrated-activity', 'authority-workspace', 'test.created', 'workspace',
                'system', 'Avalon', 'Imported activity', '', 'workspace',
                '2026-08-16T00:00:00.000Z', '2026-08-16T00:00:00.000Z',
                'test', 'migrated-activity', '{}', 0);
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1,
               started_at = '2026-08-16T01:00:00.000Z', updated_at = '2026-08-16T01:00:00.000Z'
         WHERE id = 1;
        INSERT INTO harness_runs
          (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
        VALUES ('authority-run', 'authority-workspace', 'authority-workstream', 'opening_message',
                '{}', 'scheduled', '2026-08-16T01:00:00.000Z');
      `);
      expect(() => database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_importing', updated_at = '2026-08-16T01:01:00.000Z'
         WHERE id = 1;
      `)).toThrow(/workstream_authority_runs_not_drained/u);
      database.exec(`
        UPDATE harness_runs
           SET status = 'completed', completed_at = '2026-08-16T01:01:00.000Z',
               terminalized_at = '2026-08-16T01:01:00.000Z'
         WHERE id = 'authority-run';
        UPDATE workstream_authority_control
           SET phase = 'maintenance_importing', updated_at = '2026-08-16T01:01:00.000Z'
         WHERE id = 1;
      `);
      expect(() => database.exec(
        `UPDATE workstreams SET title = 'Late writer' WHERE id = 'authority-workstream'`,
      )).toThrow(/workstream_do_authoritative/u);
      expect(database.prepare(
        `SELECT object_name, state, source_fence_sequence
           FROM workstream_authority_routes WHERE workstream_id = 'authority-workstream'`,
      ).get()).toEqual({
        object_name: "global:authority-workspace:authority-workstream",
        state: "pending",
        source_fence_sequence: 3,
      });
      expect(database.prepare(
        `SELECT state, stage_index, source_cursor
           FROM workspace_product_authority_routes WHERE workspace_id = 'authority-workspace'`,
      ).get()).toEqual({ state: "pending", stage_index: 0, source_cursor: 0 });
      expect(() => database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_verified', updated_at = '2026-08-16T01:02:00.000Z'
         WHERE id = 1;
      `)).toThrow(/workstream_authority_routes_not_verified/u);
      database.exec(`
        UPDATE workstream_authority_routes SET state = 'verified'
         WHERE workstream_id = 'authority-workstream';
        UPDATE workspace_product_authority_routes SET state = 'verified'
         WHERE workspace_id = 'authority-workspace';
        UPDATE workstream_authority_control
           SET phase = 'maintenance_verified', updated_at = '2026-08-16T01:03:00.000Z'
         WHERE id = 1;
        DELETE FROM activity_events WHERE workspace_id = 'authority-workspace';
        UPDATE work_opportunities
           SET display_prompt = 'Migrated to WorkspaceDO',
               execution_prompt = 'Migrated to WorkspaceDO',
               admission_reasoning = 'Migrated to WorkspaceDO'
         WHERE id = 'migrated-opportunity';
      `);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM activity_events WHERE workspace_id = 'authority-workspace'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT display_prompt, execution_prompt, admission_reasoning
           FROM work_opportunities WHERE id = 'migrated-opportunity'`,
      ).get()).toEqual({
        display_prompt: "Migrated to WorkspaceDO",
        execution_prompt: "Migrated to WorkspaceDO",
        admission_reasoning: "Migrated to WorkspaceDO",
      });
      expect(() => database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'durable_object_open', updated_at = '2026-08-16T01:04:00.000Z'
         WHERE id = 1;
      `)).toThrow(/workstream_authority_not_ready_to_open/u);
      database.exec(`
        UPDATE workstream_authority_routes SET state = 'active'
         WHERE workstream_id = 'authority-workstream';
        UPDATE workspace_product_authority_routes SET state = 'active'
         WHERE workspace_id = 'authority-workspace';
      `);
      expect(() => database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'durable_object_open', updated_at = '2026-08-16T01:04:30.000Z'
         WHERE id = 1;
      `)).toThrow(/workstream_authority_not_ready_to_open/u);
      database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'durable_object_open', serving_contract_version = 1,
               opened_at = '2026-08-16T01:05:00.000Z',
               updated_at = '2026-08-16T01:05:00.000Z'
         WHERE id = 1;
      `);

      expect(() => database.exec(
        `UPDATE workstreams SET title = 'Forbidden' WHERE id = 'authority-workstream'`,
      )).toThrow(/workstream_do_authoritative/u);
      expect(() => database.exec(
        `UPDATE work_opportunities SET display_prompt = 'Forbidden' WHERE id = 'migrated-opportunity'`,
      )).toThrow(/workspace_do_authoritative/u);
      expect(() => database.exec(`
        INSERT INTO messages
          (id, workspace_id, workstream_id, author_type, message_type, text_content,
           sequence_number, created_at)
        VALUES ('forbidden-message', 'authority-workspace', 'authority-workstream', 'system',
                'text', 'forbidden', 4, '2026-08-16T01:06:00.000Z');
      `)).toThrow(/workstream_do_authoritative/u);
      expect(() => database.exec(`
        INSERT INTO activity_events
          (id, workspace_id, event_type, subject_type, actor_type, actor_label,
           title, body, audience_kind, occurred_at, created_at, source_kind,
           dedupe_key, metadata_json, digestible)
        VALUES ('forbidden-activity', 'authority-workspace', 'test.created', 'workspace',
                'system', 'Avalon', 'Forbidden activity', '', 'workspace',
                '2026-08-16T01:06:00.000Z', '2026-08-16T01:06:00.000Z',
                'test', 'forbidden-activity', '{}', 0);
      `)).toThrow(/workspace_do_authoritative/u);
      const productProjectionTables = database.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN (
            'workstream_directory_projections',
            'workstream_directory_user_projections',
            'workstream_resource_link_projections',
            'workstream_suggestion_feedback_projections',
            'workstream_regional_effect_receipts',
            'workstream_authority_commands',
            'workspace_opportunity_versions',
            'web_usage_log'
          )`,
      ).all();
      expect(productProjectionTables).toEqual([]);
      expect(() => database.exec(`
        INSERT INTO attachment_tool_receipts
          (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
        VALUES ('authority-workspace', 'forbidden-resource', 'forbidden-invocation',
                'hash', '2026-08-16T01:06:00.000Z');
      `)).toThrow(/workstream_do_authoritative/u);
      expect(() => database.exec(`
        INSERT INTO workstream_email_receipts
          (resend_email_id, workstream_id, workspace_id, svix_id, received_at)
        VALUES ('forbidden-email', 'authority-workstream', 'authority-workspace',
                'forbidden-svix', '2026-08-16T01:06:00.000Z');
      `)).toThrow(/workspace_do_authoritative/u);
      expect(() => database.exec(`
        INSERT INTO realtime_transcription_ticket_receipts
          (ticket_id, workspace_id, user_id, consumed_at, expires_at)
        VALUES ('forbidden-ticket', 'authority-workspace', 'authority-user', 1, 2);
      `)).toThrow(/workspace_do_authoritative/u);
      expect(() => database.exec(`
        INSERT INTO realtime_transcription_sessions
          (id, ticket_id, workspace_id, user_id, started_at, expires_at)
        VALUES ('forbidden-session', 'forbidden-ticket', 'authority-workspace',
                'authority-user', 1, 2);
      `)).toThrow(/workspace_do_authoritative/u);
    } finally {
      database.close();
    }
  });

  it("carries deployed data through the cutover migrations and drops only dead tables", () => {
    // The deployed boundary is 0077; everything after it ships with this
    // branch and must apply over a database that already holds rows shaped by
    // the old Worker — including rows in the tables 0085 drops.
    const database = migrateDatabaseThrough("0077_connector_oauth_telemetry_shape.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('carried-user', 'google-carried', 'carried@example.com', 'Carried', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('carried-workspace', 'Carried', 'carried', 'global', 'carried-user', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('carried-workstream', 'carried-workspace', 'Carried', '', 'ad_hoc', 'carried-user',
              'idle', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('carried-run', 'carried-workspace', 'carried-workstream', 'opening_message',
              '{}', 'completed', '2026-01-01');
      INSERT INTO web_usage_log
        (id, workspace_id, workstream_id, harness_run_id, tool_name, url_count,
         credits_used, estimated, status, duration_ms, created_at)
      VALUES ('carried-usage', 'carried-workspace', 'carried-workstream', 'carried-run',
              'avalon.web_search', 1, 0.5, 0, 'completed', 1200, '2026-01-01');
      INSERT INTO workspace_opportunity_versions (workspace_id, version, updated_at)
      VALUES ('carried-workspace', 4, '2026-01-01');
      INSERT INTO workstream_email_receipts
        (resend_email_id, workstream_id, workspace_id, svix_id, received_at,
         lease_token, lease_expires_at)
      VALUES ('carried-email', 'carried-workstream', 'carried-workspace', 'carried-svix',
              '2026-01-01T00:00:00.000Z', NULL, NULL);
      INSERT INTO realtime_transcription_ticket_receipts
        (ticket_id, workspace_id, user_id, consumed_at, expires_at)
      VALUES ('carried-ticket', 'carried-workspace', 'carried-user', 100, 200);
      INSERT INTO realtime_transcription_sessions
        (id, ticket_id, workspace_id, user_id, started_at, expires_at)
      VALUES ('carried-session', 'carried-ticket', 'carried-workspace', 'carried-user', 100, 220);
    `);
    const remaining = readdirSync(migrationsDirectory)
      .filter((fileName) => fileName.endsWith(".sql") && fileName.slice(0, 4) > "0077")
      .sort();
    expect(remaining[0]).toBe("0078_rename_hypersight_to_block_dashboard.sql");
    for (const fileName of remaining) {
      database.exec(readFileSync(new URL(`../migrations/${fileName}`, import.meta.url), "utf8"));
    }
    try {
      expect(database.prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('web_usage_log', 'workspace_opportunity_versions')`,
      ).all()).toEqual([]);
      // Maintenance-import input survives the forward migrations untouched.
      expect(database.prepare(
        `SELECT svix_id FROM workstream_email_receipts WHERE resend_email_id = 'carried-email'`,
      ).get()).toEqual({ svix_id: "carried-svix" });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM realtime_transcription_sessions`,
      ).get()).toEqual({ count: 1 });
      // The old Worker keeps writing in legacy_open; fences arm only when the
      // maintenance campaign advances the phase.
      database.exec(`
        INSERT INTO workstream_email_receipts
          (resend_email_id, workstream_id, workspace_id, svix_id, received_at)
        VALUES ('carried-email-2', 'carried-workstream', 'carried-workspace',
                'carried-svix-2', '2026-01-02T00:00:00.000Z');
      `);
    } finally {
      database.close();
    }
  });

  it("anchors regional telemetry identity, preference, delivery, and retention in D1", () => {
    const database = migrateFreshDatabase();
    const userColumns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    const workspaceColumns = database.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
    expect(userColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "analytics_person_id",
      "product_analytics_enabled",
      "product_analytics_preference_version",
      "preference_subject_handle",
    ]));
    expect(workspaceColumns.map((column) => column.name)).toContain("analytics_workspace_id");
    const oauthColumns = database.prepare("PRAGMA table_info(connector_oauth_attempts)")
      .all() as Array<{ name: string }>;
    expect(oauthColumns.map((column) => column.name)).toContain("telemetry_operation_id");
    const crashColumns = database.prepare("PRAGMA table_info(telemetry_crash_reports)")
      .all() as Array<{ name: string }>;
    expect(crashColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "processing_attempt_count",
      "processing_next_attempt_at",
      "processing_started_at",
      "launch_id",
      "channel",
    ]));
    const contributionColumns = database.prepare("PRAGMA table_info(telemetry_eu_crash_contributions)")
      .all() as Array<{ name: string }>;
    expect(contributionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "build_id", "platform", "architecture", "process_role", "channel", "launch_id",
    ]));
    const journeyColumns = database.prepare("PRAGMA table_info(telemetry_onboarding_journeys)")
      .all() as Array<{ name: string }>;
    expect(journeyColumns.map((column) => column.name)).toContain("closed_at");
    const euEventColumns = database.prepare("PRAGMA table_info(telemetry_eu_events)")
      .all() as Array<{ name: string }>;
    expect(euEventColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "environment", "release", "build_id", "platform", "architecture", "channel",
      "launch_id", "session_id", "operation_id",
    ]));

    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'telemetry_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map(({ name }) => name)).toEqual([
      "telemetry_accepted_events",
      "telemetry_crash_access_audit",
      "telemetry_crash_reports",
      "telemetry_delivery_receipts",
      "telemetry_destination_state",
      "telemetry_eu_crash_contributions",
      "telemetry_eu_events",
      "telemetry_identity_links",
      "telemetry_ingest_rate_buckets",
      "telemetry_maintenance_state",
      "telemetry_onboarding_journeys",
      "telemetry_profile_jobs",
      "telemetry_rejection_buckets",
      "telemetry_replay_audit",
    ]);

    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('telemetry-user', 'telemetry-subject', 'telemetry@example.com', 'Telemetry User', '2026-08-12', '2026-08-12');
      INSERT INTO telemetry_accepted_events
        (event_id, payload_hash, envelope_json, route, routing_basis, analytics_subject_id, subject_user_id,
         accepted_at, normalized_timestamp, delete_at, delivery_state)
      VALUES
        ('018f22f2-4c22-7abc-8def-0123456789ab', 'hash', '{}', 'global', 'explicit_binding',
         'analytics-subject', 'telemetry-user', '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z',
         '2026-11-10T00:00:00.000Z', 'pending');
    `);
    expect(() => database.exec(`
      UPDATE telemetry_accepted_events SET delete_at = '2027-01-01T00:00:00.000Z'
      WHERE event_id = '018f22f2-4c22-7abc-8def-0123456789ab';
    `)).toThrow(/telemetry_deadline_immutable/u);
    database.exec(`
      INSERT INTO telemetry_ingest_rate_buckets
        (surface, subject_hash, bucket_start, count, delete_at)
      VALUES ('telemetry_bootstrap', '${'a'.repeat(43)}', '2026-08-12T00:00:00.000Z', 1,
              '2026-08-13T00:00:00.000Z');
      INSERT INTO telemetry_maintenance_state (task, cursor, updated_at)
      VALUES ('crash_object_retention', 'opaque-cursor', '2026-08-12T00:00:00.000Z');
    `);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  }, 15_000);

  it("moves legacy Notion bot grants to workspace scope without widening personal MCP rows", () => {
    const database = migrateDatabaseThrough("0071_notion_webhook_setup_nonces.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('notion-owner', 'notion-owner-subject', 'notion@example.com', 'Notion Owner', '2026-08-12', '2026-08-12');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('notion-workspace', 'Notion Workspace', 'notion-workspace', 'global', 'notion-owner', '2026-08-12', '2026-08-12');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, model_plugin_id, status, created_at, updated_at)
      VALUES
        ('legacy-notion-bot', 'notion-workspace', 'notion', 'personal', 'notion-owner', 'bot-id',
         'Legacy bot', '["notion.read","notion.update"]', 'plugin_notion', 'healthy', '2026-08-12', '2026-08-12'),
        ('personal-notion-mcp', 'notion-workspace', 'notion', 'personal', 'notion-owner', 'workspace:user',
         'Personal MCP', '["notion.personal.mcp"]', 'plugin_notion_2', 'healthy', '2026-08-12', '2026-08-12');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0072_notion_connection_scope_split.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT id, scope, owner_user_id FROM connector_connections WHERE connector_type = 'notion' ORDER BY id",
    ).all()).toEqual([
      { id: "legacy-notion-bot", scope: "workspace", owner_user_id: null },
      { id: "personal-notion-mcp", scope: "personal", owner_user_id: "notion-owner" },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("tracks current attachment derivatives without a duplicate object catalog", () => {
    const database = migrateFreshDatabase();
    const resourceColumns = database.prepare("PRAGMA table_info(resources)").all() as Array<{ name: string }>;
    expect(resourceColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "content_sha256",
      "model_content_status",
      "model_content_extractor_version",
      "model_content_character_count",
      "model_content_extracted_at",
      "model_content_error_code",
      "model_content_claimed_at",
      "model_content_claim_id",
    ]));
    const compactionColumns = database.prepare("PRAGMA table_info(workstream_context_compactions)").all() as Array<{ name: string }>;
    expect(compactionColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "checkpoint_template_version",
      "execution_principal_key",
      "resource_visibility_fingerprint",
    ]));

    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('attachment-owner', 'attachment-subject', 'attachment@example.com', 'Attachment Owner', '2026-08-12', '2026-08-12');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('attachment-workspace', 'Attachment Workspace', 'attachment-workspace', 'global', 'attachment-owner', '2026-08-12', '2026-08-12');
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         content_sha256, model_content_ref, model_content_status,
         model_content_extractor_version, model_content_character_count,
         model_content_extracted_at, created_at, updated_at)
      VALUES
        ('attachment-resource', 'attachment-workspace', 'uploaded_file', 'avalon_upload',
         'brief.md', 'text/markdown', 'original-ref', '${"a".repeat(64)}',
         'active-model-ref', 'ready', 'markdown-v1', 120,
         '2026-08-12', '2026-08-12', '2026-08-12');
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
      VALUES ('next-model-ref', 'attachment-workspace', 'attachment-resource', 'derivative', '2026-08-12', '2026-08-12');
      UPDATE resources
         SET model_content_ref = 'next-model-ref'
       WHERE id = 'attachment-resource';
    `);

    expect(database.prepare(
      `SELECT object_ref, object_kind FROM resource_object_deletion_outbox
        WHERE resource_id = 'attachment-resource' ORDER BY object_ref`,
    ).all()).toEqual([
      { object_ref: "active-model-ref", object_kind: "derivative" },
    ]);

    database.exec(`
      DELETE FROM resources WHERE id = 'attachment-resource';
    `);

    expect(database.prepare(
      `SELECT object_ref, object_kind FROM resource_object_deletion_outbox
       WHERE resource_id = 'attachment-resource' ORDER BY object_ref`,
    ).all()).toEqual([
      { object_ref: "active-model-ref", object_kind: "derivative" },
      { object_ref: "next-model-ref", object_kind: "derivative" },
      { object_ref: "original-ref", object_kind: "original" },
    ]);
    expect(() => database.exec(
      "INSERT INTO resources (id, workspace_id, resource_type, provider, title, model_content_status, created_at, updated_at) VALUES ('bad-status', 'attachment-workspace', 'file', 'test', 'bad', 'empty', '2026-08-12', '2026-08-12')",
    )).toThrow(/CHECK constraint failed/iu);
    database.close();
  });

  it("advances the bounded resource-inventory revision for every visibility-changing relationship", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('inventory-owner', 'inventory-subject', 'inventory@example.com', 'Inventory Owner', '2026-08-12', '2026-08-12');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('inventory-workspace', 'Inventory Workspace', 'inventory-workspace', 'global', 'inventory-owner', '2026-08-12', '2026-08-12');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status, last_activity_at, created_at, updated_at)
      VALUES ('inventory-workstream', 'inventory-workspace', 'Inventory', 'Test revision fencing', 'ad_hoc', 'inventory-owner', 'idle', '2026-08-12', '2026-08-12', '2026-08-12');
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, created_at, updated_at)
      VALUES
        ('inventory-upload', 'inventory-workspace', 'file', 'avalon_upload', 'brief.md', '2026-08-12', '2026-08-12'),
        ('inventory-note-resource', 'inventory-workspace', 'note', 'avalon_note', 'Private note', '2026-08-12', '2026-08-12');
      INSERT INTO workstream_resources (workstream_id, resource_id, relationship_type, attached_at)
      VALUES
        ('inventory-workstream', 'inventory-upload', 'explicit', '2026-08-12'),
        ('inventory-workstream', 'inventory-note-resource', 'explicit', '2026-08-12');
    `);
    const revision = () => database.prepare(
      "SELECT revision FROM workstream_resource_inventory_revisions WHERE workspace_id = 'inventory-workspace' AND workstream_id = 'inventory-workstream'",
    ).get() as { revision: number };
    expect(revision()).toEqual({ revision: 2 });

    database.exec(`
      UPDATE resources
         SET updated_at = '2026-08-12T00:00:30Z', model_content_status = 'processing'
       WHERE id = 'inventory-upload';
    `);
    expect(revision()).toEqual({ revision: 2 });

    database.exec(`
      UPDATE resources SET title = 'updated.md' WHERE id = 'inventory-upload';
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, author_user_id, message_type, text_content, sequence_number, created_at)
      VALUES ('inventory-message', 'inventory-workspace', 'inventory-workstream', 'human', 'inventory-owner', 'text', 'Attached', 1, '2026-08-12');
      INSERT INTO message_attachments (message_id, resource_id, position, attached_at)
      VALUES ('inventory-message', 'inventory-upload', 0, '2026-08-12');
      INSERT INTO notes
        (id, workspace_id, owner_user_id, resource_id, scope, title, last_activity_at, created_at, updated_at)
      VALUES ('inventory-note', 'inventory-workspace', 'inventory-owner', 'inventory-note-resource', 'personal', 'Private note', '2026-08-12', '2026-08-12', '2026-08-12');
      UPDATE notes SET scope = 'workspace', updated_at = '2026-08-12T00:01:00Z' WHERE id = 'inventory-note';
      DELETE FROM message_attachments WHERE message_id = 'inventory-message' AND resource_id = 'inventory-upload';
      DELETE FROM workstream_resources WHERE workstream_id = 'inventory-workstream' AND resource_id = 'inventory-upload';
    `);
    expect(revision()).toEqual({ revision: 8 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("invalidates attachment receipts when their derivative changes or resource is deleted", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('receipt-owner', 'receipt-subject', 'receipt@example.com', 'Receipt Owner', '2026-08-12', '2026-08-12');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('receipt-workspace', 'Receipt Workspace', 'receipt-workspace', 'global', 'receipt-owner', '2026-08-12', '2026-08-12');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status, last_activity_at, created_at, updated_at)
      VALUES ('receipt-workstream', 'receipt-workspace', 'Receipts', 'Test receipt lifecycle', 'ad_hoc', 'receipt-owner', 'idle', '2026-08-12', '2026-08-12', '2026-08-12');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('receipt-run', 'receipt-workspace', 'receipt-workstream', 'manual', '{"type":"user","userId":"receipt-owner"}', 'completed', '2026-08-12');
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, model_content_sha256, created_at, updated_at)
      VALUES ('receipt-resource', 'receipt-workspace', 'file', 'avalon_upload', 'brief.md', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-08-12', '2026-08-12');
      INSERT INTO tool_invocations
        (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name, input_hash, input_json, output_ref, output_summary, status)
      VALUES ('receipt-invocation-one', 'receipt-workspace', 'receipt-workstream', 'receipt-run', 'call-one', 'read_resource', 'hash-one', '{}', 'receipt/object-one', 'Read', 'completed');
      INSERT INTO attachment_tool_receipts
        (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
      VALUES ('receipt-workspace', 'receipt-resource', 'receipt-invocation-one', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '2026-08-12');
      UPDATE resources SET model_content_sha256 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE id = 'receipt-resource';
    `);
    expect(database.prepare("SELECT COUNT(*) AS count FROM tool_invocations WHERE id = 'receipt-invocation-one'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT object_ref, object_kind FROM resource_object_deletion_outbox WHERE object_ref = 'receipt/object-one'").get())
      .toEqual({ object_ref: "receipt/object-one", object_kind: "receipt" });

    database.exec(`
      INSERT INTO tool_invocations
        (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name, input_hash, input_json, output_ref, output_summary, status)
      VALUES ('receipt-invocation-two', 'receipt-workspace', 'receipt-workstream', 'receipt-run', 'call-two', 'view_resource', 'hash-two', '{}', 'receipt/object-two', 'Viewed', 'completed');
      INSERT INTO attachment_tool_receipts
        (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
      VALUES ('receipt-workspace', 'receipt-resource', 'receipt-invocation-two', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '2026-08-12');
      DELETE FROM resources WHERE id = 'receipt-resource';
    `);
    expect(database.prepare("SELECT COUNT(*) AS count FROM tool_invocations WHERE id = 'receipt-invocation-two'").get())
      .toEqual({ count: 0 });
    expect(database.prepare("SELECT object_ref, object_kind FROM resource_object_deletion_outbox WHERE object_ref = 'receipt/object-two'").get())
      .toEqual({ object_ref: "receipt/object-two", object_kind: "receipt" });
    database.close();
  });

  it("persists normalized activity targets independently from provider visibility metadata", () => {
    const database = migrateFreshDatabase();
    const columns = database.prepare("PRAGMA table_info(activities)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("target_user_ids_json");
    database.close();
  });

  it("freezes legacy activity-automation visibility into exact connector bindings", () => {
    const database = migrateDatabaseThrough("0051_generic_webhook_idempotency.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
        ('binding-owner', 'binding-owner-subject', 'owner@example.com', 'Binding Owner', '2026-08-10', '2026-08-10'),
        ('binding-other', 'binding-other-subject', 'other@example.com', 'Binding Other', '2026-08-10', '2026-08-10');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('binding-workspace', 'Binding Workspace', 'binding-workspace', 'global', 'binding-owner', '2026-08-10', '2026-08-10');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, status, created_at, updated_at)
      VALUES
        ('binding-github', 'binding-workspace', 'github', 'workspace', NULL, 'GitHub',
         '[]', 'plugin_binding_github', 'healthy', '2026-08-10', '2026-08-10'),
        ('binding-google-owner', 'binding-workspace', 'google', 'personal', 'binding-owner', 'Owner Google',
         '[]', 'plugin_binding_google_owner', 'error', '2026-08-10', '2026-08-10'),
        ('binding-notion-other', 'binding-workspace', 'notion', 'personal', 'binding-other', 'Other Notion',
         '[]', 'plugin_binding_notion_other', 'healthy', '2026-08-10', '2026-08-10'),
        ('binding-linear-disabled', 'binding-workspace', 'linear', 'workspace', NULL, 'Disabled Linear',
         '[]', 'plugin_binding_linear_disabled', 'disabled', '2026-08-10', '2026-08-10');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state,
         latest_version_number, created_at, updated_at)
      VALUES
        ('binding-template-activity', 'binding-workspace', 'binding-owner', 'Activity', 'Activity trigger', 'private', 1, '2026-08-10', '2026-08-10'),
        ('binding-template-schedule', 'binding-workspace', 'binding-owner', 'Schedule', 'Schedule trigger', 'private', 1, '2026-08-10', '2026-08-10');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         created_by_user_id, created_at)
      VALUES
        ('binding-version-activity', 'binding-template-activity', 1, 'Handle activity',
         '[{"type":"connector_activity","connectorType":"github","eventTypes":["changed"],"deterministicFilters":{}}]',
         'binding-owner', '2026-08-10'),
        ('binding-version-schedule', 'binding-template-schedule', 1, 'Run hourly',
         '[{"type":"interval","intervalSeconds":3600,"summary":"Hourly"}]',
         'binding-owner', '2026-08-10');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, connector_bindings_json, status, created_at, updated_at)
      VALUES
        ('binding-subscription-personal', 'binding-workspace', 'binding-template-activity', 'binding-version-activity',
         'personal', 'binding-owner', '{"type":"user","userId":"binding-owner"}', '{}', 'active', '2026-08-10', '2026-08-10'),
        ('binding-subscription-workspace', 'binding-workspace', 'binding-template-activity', 'binding-version-activity',
         'workspace', NULL, '{"type":"workspace","workspaceId":"binding-workspace"}', '{}', 'active', '2026-08-10', '2026-08-10'),
        ('binding-subscription-schedule', 'binding-workspace', 'binding-template-schedule', 'binding-version-schedule',
         'personal', 'binding-owner', '{"type":"user","userId":"binding-owner"}', '{}', 'active', '2026-08-10', '2026-08-10');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0052_automation_connector_bindings.sql", import.meta.url),
      "utf8",
    ));

    const personal = database.prepare(
      "SELECT connector_bindings_json FROM automation_subscriptions WHERE id = 'binding-subscription-personal'",
    ).get() as { connector_bindings_json: string };
    const workspace = database.prepare(
      "SELECT connector_bindings_json FROM automation_subscriptions WHERE id = 'binding-subscription-workspace'",
    ).get() as { connector_bindings_json: string };
    expect(JSON.parse(personal.connector_bindings_json)).toEqual({
      plugin_binding_github: "binding-github",
      plugin_binding_google_owner: "binding-google-owner",
    });
    expect(JSON.parse(workspace.connector_bindings_json)).toEqual({
      plugin_binding_github: "binding-github",
    });
    expect(database.prepare(
      "SELECT connector_bindings_json FROM automation_subscriptions WHERE id = 'binding-subscription-schedule'",
    ).get()).toEqual({ connector_bindings_json: "{}" });
    database.close();
  });

  it("deduplicates active generic-webhook creation requests", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('webhook-owner', 'webhook-subject', 'webhook@example.com', 'Webhook Owner', '2026-08-10', '2026-08-10');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('webhook-workspace', 'Webhook Workspace', 'webhook-workspace', 'global', 'webhook-owner', '2026-08-10', '2026-08-10');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, config_json, created_at, updated_at)
      VALUES
        ('webhook-one', 'webhook-workspace', 'generic_webhook', 'workspace', NULL, 'Webhook one',
         '[]', 'plugin_generic_webhook', '{"creationIdempotencyKey":"request-one"}', '2026-08-10', '2026-08-10');
    `);
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, config_json, created_at, updated_at)
      VALUES
        ('webhook-two', 'webhook-workspace', 'generic_webhook', 'workspace', NULL, 'Webhook two',
         '[]', 'plugin_generic_webhook_2', '{"creationIdempotencyKey":"request-one"}', '2026-08-10', '2026-08-10');
    `)).toThrow(/UNIQUE constraint failed/iu);
    database.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = 'webhook-one'");
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, config_json, created_at, updated_at)
      VALUES
        ('webhook-two', 'webhook-workspace', 'generic_webhook', 'workspace', NULL, 'Webhook two',
         '[]', 'plugin_generic_webhook_2', '{"creationIdempotencyKey":"request-one"}', '2026-08-10', '2026-08-10');
    `)).not.toThrow();
    database.close();
  });

  it("scopes verified external identities by provider tenant", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
        ('identity-user-one', 'identity-subject-one', 'identity-one@example.com', 'Identity One', '2026-08-07', '2026-08-07'),
        ('identity-user-two', 'identity-subject-two', 'identity-two@example.com', 'Identity Two', '2026-08-07', '2026-08-07');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('identity-workspace', 'Identity Workspace', 'identity-workspace', 'global', 'identity-user-one', '2026-08-07', '2026-08-07');
      INSERT INTO external_user_identities
        (id, workspace_id, user_id, provider, provider_tenant_id, provider_user_id,
         handle, verification_source, created_at, updated_at)
        VALUES
        ('identity-one', 'identity-workspace', 'identity-user-one', 'github', 'tenant-one', '42', 'same-handle', 'oauth', '2026-08-07', '2026-08-07'),
        ('identity-two', 'identity-workspace', 'identity-user-two', 'github', 'tenant-two', '42', 'same-handle', 'oauth', '2026-08-07', '2026-08-07');
    `);
    expect(database.prepare(
      "SELECT provider_tenant_id, user_id FROM external_user_identities ORDER BY provider_tenant_id",
    ).all()).toEqual([
      { provider_tenant_id: "tenant-one", user_id: "identity-user-one" },
      { provider_tenant_id: "tenant-two", user_id: "identity-user-two" },
    ]);
    expect(() => database.exec(`
      INSERT INTO external_user_identities
        (id, workspace_id, user_id, provider, provider_tenant_id, provider_user_id,
         verification_source, created_at, updated_at)
        VALUES ('identity-duplicate', 'identity-workspace', 'identity-user-two', 'github', 'tenant-one', '42', 'oauth', '2026-08-07', '2026-08-07');
    `)).toThrow(/UNIQUE constraint failed/);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("stores HyperSight configuration as immutable append-only versions", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-block-dashboard', 'google-block-dashboard', 'block-dashboard@example.com',
         'HyperSight Owner', '2026-01-01', '2026-01-01'),
        ('user-block-dashboard-two', 'google-block-dashboard-two', 'block-dashboard-two@example.com',
         'HyperSight Member', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-block-dashboard', 'HyperSight', 'block-dashboard', 'global',
              'user-block-dashboard', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-block-dashboard', 'workspace-block-dashboard', 'Shared dashboard',
              'Test append-only configuration', 'ad_hoc', 'user-block-dashboard', 'idle',
              '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO block_dashboard_configuration_versions
        (id, workspace_id, workstream_id, version_number, blocks_json,
         created_by_user_id, created_at)
      VALUES
        ('block-dashboard-version-1', 'workspace-block-dashboard', 'workstream-block-dashboard', 1,
         '[{"id":"block-1","prompt":"Summarize"}]', 'user-block-dashboard', '2026-01-01'),
        ('block-dashboard-version-2', 'workspace-block-dashboard', 'workstream-block-dashboard', 2,
         '[{"id":"block-1","prompt":"List five tasks"}]', 'user-block-dashboard', '2026-01-02');
      INSERT INTO block_dashboard_user_preferences
        (workspace_id, workstream_id, user_id, visible, updated_at)
      VALUES
        ('workspace-block-dashboard', 'workstream-block-dashboard', 'user-block-dashboard', 1, '2026-01-02'),
        ('workspace-block-dashboard', 'workstream-block-dashboard', 'user-block-dashboard-two', 0, '2026-01-02');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json,
         status, model, created_at)
      VALUES ('block-dashboard-harness-1', 'workspace-block-dashboard', 'workstream-block-dashboard',
              'block_dashboard_block', '{"type":"workspace","workspaceId":"workspace-block-dashboard"}',
              'scheduled', 'x-ai/grok-4.3', '2026-01-02');
      INSERT INTO block_dashboard_block_runs
        (id, workspace_id, workstream_id, configuration_version_id, block_id, prompt,
         trigger_sequence, harness_run_id, status, created_at)
      VALUES ('block-dashboard-run-1', 'workspace-block-dashboard', 'workstream-block-dashboard',
              'block-dashboard-version-2', 'block-1', 'List five tasks', 7,
              'block-dashboard-harness-1', 'queued', '2026-01-02');
    `);

    expect(database.prepare(
      `SELECT version_number, blocks_json FROM block_dashboard_configuration_versions
       WHERE workstream_id = 'workstream-block-dashboard' ORDER BY version_number`,
    ).all()).toEqual([
      { version_number: 1, blocks_json: '[{"id":"block-1","prompt":"Summarize"}]' },
      { version_number: 2, blocks_json: '[{"id":"block-1","prompt":"List five tasks"}]' },
    ]);
    expect(() => database.exec(
      "UPDATE block_dashboard_configuration_versions SET blocks_json = '[]' WHERE id = 'block-dashboard-version-1'",
    )).toThrow(/block_dashboard_configuration_version_immutable/u);
    expect(() => database.exec(`
      INSERT INTO block_dashboard_configuration_versions
        (id, workspace_id, workstream_id, version_number, blocks_json,
         created_by_user_id, created_at)
      VALUES ('block-dashboard-version-duplicate', 'workspace-block-dashboard', 'workstream-block-dashboard',
              2, '[]', 'user-block-dashboard', '2026-01-03');
    `)).toThrow(/UNIQUE constraint failed/u);
    expect(database.prepare(
      `SELECT user_id, visible FROM block_dashboard_user_preferences
       WHERE workstream_id = 'workstream-block-dashboard' ORDER BY user_id`,
    ).all()).toEqual([
      { user_id: 'user-block-dashboard', visible: 1 },
      { user_id: 'user-block-dashboard-two', visible: 0 },
    ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("accepts X connections after the connector constraint migration", () => {
    const database = migrateDatabaseThrough("0040_realtime_transcription_admission.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-x', 'google-x', 'x@example.com', 'X User', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-x', 'X Workspace', 'x-workspace', 'global',
              'user-x', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-before-x', 'workspace-x', 'slack', 'personal', 'user-x', 'Slack',
              '[]', 'plugin_slack', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_contexts
        (connection_id, slack_user_id, context_json, updated_at)
      VALUES ('connection-before-x', 'slack-user-x', '{"retained":true}', '2026-01-01');
    `);

    database.exec("BEGIN");
    database.exec(readFileSync(new URL("../migrations/0041_x_connector.sql", import.meta.url), "utf8"));
    database.exec("COMMIT");

    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x', 'workspace-x', 'x', 'personal', 'user-x', 'X',
              '["x.read"]', 'plugin_x', '2026-01-01', '2026-01-01');
    `);
    expect(database.prepare(
      "SELECT connector_type, model_plugin_id FROM connector_connections WHERE id = 'connection-x'",
    ).get()).toEqual({ connector_type: "x", model_plugin_id: "plugin_x" });
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x-personal-duplicate', 'workspace-x', 'x', 'personal', 'user-x', 'X',
              '["x.read"]', 'plugin_x_personal_duplicate', '2026-01-01', '2026-01-01');
    `)).toThrow(/UNIQUE constraint failed/);
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x-workspace', 'workspace-x', 'x', 'workspace', NULL, 'X',
              '["x.read"]', 'plugin_x_workspace', '2026-01-01', '2026-01-01');
    `);
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x-workspace-duplicate', 'workspace-x', 'x', 'workspace', NULL, 'X',
              '["x.read"]', 'plugin_x_workspace_duplicate', '2026-01-01', '2026-01-01');
    `)).toThrow(/UNIQUE constraint failed/);
    expect(database.prepare(
      "SELECT context_json FROM slack_agent_contexts WHERE connection_id = 'connection-before-x'",
    ).get()).toEqual({ context_json: '{"retained":true}' });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("retires personal X connections and enforces workspace-only scope", () => {
    const database = migrateDatabaseThrough("0045_notes.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-x-workspace-only', 'google-x-workspace-only',
              'x-workspace-only@example.com', 'X Workspace Owner',
              '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-x-workspace-only', 'X Workspace Only',
              'x-workspace-only', 'global', 'user-x-workspace-only',
              '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         encrypted_credentials, credential_iv, credential_key_version,
         granted_scopes_json, model_plugin_id, status, next_poll_at,
         created_at, updated_at)
      VALUES ('connection-x-personal-legacy', 'workspace-x-workspace-only', 'x',
              'personal', 'user-x-workspace-only', 'X', 'encrypted', 'iv', 1,
              '["x.read"]', 'plugin_x', 'healthy', '2026-01-02',
              '2026-01-01', '2026-01-01');
    `);

    database.exec("BEGIN");
    database.exec(readFileSync(new URL("../migrations/0046_x_workspace_only.sql", import.meta.url), "utf8"));
    database.exec("COMMIT");

    expect(database.prepare(
      `SELECT status, encrypted_credentials, credential_iv, next_poll_at
       FROM connector_connections WHERE id = 'connection-x-personal-legacy'`,
    ).get()).toEqual({
      status: "disabled",
      encrypted_credentials: null,
      credential_iv: null,
      next_poll_at: null,
    });
    expect(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'connector_connections_x_personal_active_user_uq'`,
    ).get()).toBeUndefined();

    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x-workspace-only', 'workspace-x-workspace-only', 'x',
              'workspace', NULL, 'X', '["x.read"]', 'plugin_x',
              '2026-01-02', '2026-01-02');
    `);
    expect(database.prepare(
      `SELECT scope, owner_user_id, status FROM connector_connections
       WHERE id = 'connection-x-workspace-only'`,
    ).get()).toEqual({ scope: "workspace", owner_user_id: null, status: "healthy" });

    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x-personal-rejected', 'workspace-x-workspace-only', 'x',
              'personal', 'user-x-workspace-only', 'X', '["x.read"]',
              'plugin_x_personal_rejected', '2026-01-02', '2026-01-02');
    `)).toThrow(/X connections must use workspace scope/u);
    expect(() => database.exec(`
      UPDATE connector_connections
      SET scope = 'personal', owner_user_id = 'user-x-workspace-only'
      WHERE id = 'connection-x-workspace-only';
    `)).toThrow(/X connections must use workspace scope/u);
    expect(() => database.exec(`
      UPDATE connector_connections SET status = 'healthy'
      WHERE id = 'connection-x-personal-legacy';
    `)).toThrow(/X connections must use workspace scope/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("stores one Granola API key connection per workspace and one MCP connection per user", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-granola', 'google-granola', 'granola@example.com', 'Granola User',
              '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-granola', 'Granola Workspace', 'granola-workspace', 'global',
              'user-granola', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES
        ('connection-granola-workspace', 'workspace-granola', 'granola', 'workspace', NULL,
         'Granola workspace', '["granola.workspace.read"]', 'plugin_granola',
         '2026-01-01', '2026-01-01'),
        ('connection-granola-personal', 'workspace-granola', 'granola', 'personal', 'user-granola',
         'Granola personal', '["granola.personal.read"]', 'plugin_granola_2',
         '2026-01-01', '2026-01-01');
      INSERT INTO connector_oauth_attempts
        (id, region, provider, user_id, workspace_id, status, expires_at, created_at, updated_at)
      VALUES ('granola-attempt', 'global', 'granola', 'user-granola', 'workspace-granola',
              'pending', '2026-01-02', '2026-01-01', '2026-01-01');
    `);
    expect(database.prepare(
      "SELECT connector_type, scope FROM connector_connections WHERE connector_type = 'granola' ORDER BY scope",
    ).all()).toEqual([
      { connector_type: "granola", scope: "personal" },
      { connector_type: "granola", scope: "workspace" },
    ]);
    expect(database.prepare(
      "SELECT provider FROM connector_oauth_attempts WHERE id = 'granola-attempt'",
    ).get()).toEqual({ provider: "granola" });
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-granola-workspace-two', 'workspace-granola', 'granola', 'workspace', NULL,
              'Duplicate', '[]', 'plugin_granola_3', '2026-01-01', '2026-01-01');
    `)).toThrow(/UNIQUE constraint failed/u);
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-granola-personal-two', 'workspace-granola', 'granola', 'personal',
              'user-granola', 'Duplicate', '[]', 'plugin_granola_4',
              '2026-01-01', '2026-01-01');
    `)).toThrow(/UNIQUE constraint failed/u);
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-x-personal-after-granola', 'workspace-granola', 'x', 'personal',
              'user-granola', 'X', '["x.read"]', 'plugin_x_after_granola',
              '2026-01-01', '2026-01-01');
    `)).toThrow(/X connections must use workspace scope/u);
    expect(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'connector_connections_x_personal_active_user_uq'`,
    ).get()).toBeUndefined();
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("preserves Slack pending prompts while adding Granola", () => {
    const database = migrateDatabaseThrough("0047_slack_thread_followups.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-granola-migrate', 'google-granola-migrate',
              'granola-migrate@example.com', 'Granola Migration User',
              '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-granola-migrate', 'Granola Migration', 'granola-migrate', 'global',
              'user-granola-migrate', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, model_plugin_id, created_at, updated_at)
      VALUES ('connection-slack-before-granola', 'workspace-granola-migrate', 'slack',
              'workspace', NULL, 'T_GRANOLA', 'Slack', '["slack.agent"]',
              'plugin_slack_before_granola', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_pending_prompts
        (connection_id, slack_channel_id, slack_thread_ts, slack_user_id, prompt,
         denial_reason, expires_at, created_at, updated_at)
      VALUES ('connection-slack-before-granola', 'C_GRANOLA', '1000.0001', 'U_GRANOLA',
              'Retry this prompt', 'connection', '2026-01-02', '2026-01-01', '2026-01-01');
    `);

    database.exec("BEGIN");
    database.exec(readFileSync(new URL("../migrations/0048_granola_connector.sql", import.meta.url), "utf8"));
    database.exec("COMMIT");

    expect(database.prepare(
      `SELECT prompt, denial_reason FROM slack_agent_pending_prompts
       WHERE connection_id = 'connection-slack-before-granola'`,
    ).get()).toEqual({ prompt: "Retry this prompt", denial_reason: "connection" });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("establishes a rollout baseline and stores independent per-user read cursors", () => {
    const database = migrateDatabaseThrough("0038_remove_web_monitor.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-read-one', 'google-read-one', 'read-one@example.com', 'Reader One', '2026-01-01', '2026-01-01'),
        ('user-read-two', 'google-read-two', 'read-two@example.com', 'Reader Two', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-read', 'Read State', 'read-state', 'global',
              'user-read-one', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-legacy', 'workspace-read', 'Legacy', 'Read state', 'ad_hoc',
              'user-read-one', 'completed', 4, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, author_user_id, message_type,
         text_content, sequence_number, created_at)
      VALUES
        ('message-human', 'workspace-read', 'workstream-legacy', 'human', 'user-read-one',
         'text', 'Start', 1, '2026-01-01'),
        ('message-tool', 'workspace-read', 'workstream-legacy', 'agent', NULL,
         'tool', '', 2, '2026-01-01'),
        ('message-agent', 'workspace-read', 'workstream-legacy', 'agent', NULL,
         'text', 'Done', 3, '2026-01-01');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0039_workstream_read_state.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      `SELECT latest_attention_sequence_number, unread_tracking_start_sequence_number
       FROM workstreams WHERE id = 'workstream-legacy'`,
    ).get()).toEqual({
      latest_attention_sequence_number: 3,
      unread_tracking_start_sequence_number: 3,
    });

    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-new', 'workspace-read', 'New', 'Read state', 'ad_hoc',
              'user-read-one', 'idle', '2026-02-01', '2026-02-01', '2026-02-01');
      INSERT INTO workstream_read_states
        (workspace_id, workstream_id, user_id, read_through_sequence_number,
         manual_unread_from_sequence_number, manual_unread_generation, updated_at)
      VALUES
        ('workspace-read', 'workstream-legacy', 'user-read-one', 3, NULL, 0, '2026-02-01'),
        ('workspace-read', 'workstream-legacy', 'user-read-two', 1, 3, 2, '2026-02-01');
    `);

    expect(database.prepare(
      `SELECT latest_attention_sequence_number, unread_tracking_start_sequence_number
       FROM workstreams WHERE id = 'workstream-new'`,
    ).get()).toEqual({
      latest_attention_sequence_number: 0,
      unread_tracking_start_sequence_number: 0,
    });
    expect(database.prepare(
      `SELECT user_id, read_through_sequence_number, manual_unread_from_sequence_number,
              manual_unread_generation
       FROM workstream_read_states ORDER BY user_id`,
    ).all()).toEqual([
      {
        user_id: 'user-read-one',
        read_through_sequence_number: 3,
        manual_unread_from_sequence_number: null,
        manual_unread_generation: 0,
      },
      {
        user_id: 'user-read-two',
        read_through_sequence_number: 1,
        manual_unread_from_sequence_number: 3,
        manual_unread_generation: 2,
      },
    ]);
    database.close();
  });

  it("creates scoped memory, hybrid-search projections, and immutable run snapshots", () => {
    const database = migrateFreshDatabase();
    const scopeColumns = database.prepare("PRAGMA table_info(memory_scopes)").all();
    expect(scopeColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "memory_scope_id", pk: 1 }),
      expect.objectContaining({ name: "workspace_id", notnull: 1 }),
      expect.objectContaining({ name: "kind", notnull: 1 }),
      expect.objectContaining({ name: "owner_id", notnull: 1 }),
    ]));
    const itemColumns = database.prepare("PRAGMA table_info(memory_items)").all();
    expect(itemColumns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "revision", notnull: 1 }),
      expect.objectContaining({ name: "provenance_json", notnull: 1 }),
      expect.objectContaining({ name: "access_count", notnull: 1 }),
      expect.objectContaining({ name: "invalidated_at" }),
    ]));
    expect(itemColumns).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "confidence" }),
    ]));
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_items_fts'",
    ).get()).toEqual({ name: "memory_items_fts" });
    expect(database.prepare("PRAGMA table_info(harness_run_memory_contexts)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "memory_context_hash", notnull: 1 }),
        expect.objectContaining({ name: "results_json", notnull: 1 }),
      ]));
    expect(database.prepare("PRAGMA table_info(harness_run_scopes)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "memory_context_hash" }),
      ]));
    database.close();
  });

  it("creates typed scoped-memory tables and stores automation table declarations", () => {
    const database = migrateFreshDatabase();
    expect(database.prepare("PRAGMA table_info(automation_template_versions)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "memory_tables_json", notnull: 1 }),
      ]));
    expect(database.prepare("PRAGMA table_info(memory_tables)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "memory_table_id", pk: 1 }),
        expect.objectContaining({ name: "memory_scope_id", notnull: 1 }),
        expect.objectContaining({ name: "key_column_ids_json", notnull: 1 }),
        expect.objectContaining({ name: "data_revision", notnull: 1 }),
      ]));
    expect(database.prepare("PRAGMA table_info(memory_table_rows)").all())
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "natural_key_hash", notnull: 1 }),
        expect.objectContaining({ name: "data_json", notnull: 1 }),
        expect.objectContaining({ name: "revision", notnull: 1 }),
        expect.objectContaining({ name: "invalidated_at" }),
      ]));
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_table_rows_fts'",
    ).get()).toEqual({ name: "memory_table_rows_fts" });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_table_cells'",
    ).get()).toEqual({ name: "memory_table_cells" });
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_table_mutations'",
    ).get()).toEqual({ name: "memory_table_mutations" });
    database.close();
  });

  it("keeps full agent inference logging opt-in and creates its regional payload index", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-inference', 'google-inference', 'inference@example.com',
              'Inference Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-inference', 'Inference', 'inference', 'global',
              'user-inference', '2026-01-01', '2026-01-01');
    `);

    expect(database.prepare(
      "SELECT log_agent_inference FROM workspaces WHERE id = 'workspace-inference'",
    ).get()).toEqual({ log_agent_inference: 0 });
    expect(database.prepare("PRAGMA table_info(agent_inference_payload_logs)").all()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "object_key" }),
        expect.objectContaining({ name: "input_tokens" }),
        expect.objectContaining({ name: "output_tokens" }),
        expect.objectContaining({ name: "context_tokens" }),
      ]),
    );
    database.close();
  });

  it("stores independent provider-measured compaction checkpoints per execution principal", () => {
    const database = migrateFreshDatabase();
    const columns = database.prepare("PRAGMA table_info(workstream_context_compactions)").all();
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "compacted_through_sequence", notnull: 1 }),
      expect.objectContaining({ name: "messages_json", notnull: 1 }),
      expect.objectContaining({ name: "context_tokens_before_compaction", notnull: 1 }),
      expect.objectContaining({ name: "context_window_tokens", notnull: 1 }),
      expect.objectContaining({ name: "execution_principal_key", notnull: 1 }),
      expect.objectContaining({ name: "resource_visibility_fingerprint", notnull: 1 }),
    ]));
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('checkpoint-owner', 'checkpoint-subject', 'checkpoint@example.com', 'Checkpoint Owner', '2026-08-12', '2026-08-12');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('checkpoint-workspace', 'Checkpoint Workspace', 'checkpoint-workspace', 'global', 'checkpoint-owner', '2026-08-12', '2026-08-12');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status, last_activity_at, created_at, updated_at)
      VALUES ('checkpoint-workstream', 'checkpoint-workspace', 'Checkpoints', 'Test scoped compaction', 'ad_hoc', 'checkpoint-owner', 'idle', '2026-08-12', '2026-08-12', '2026-08-12');
      INSERT INTO workstream_context_compactions
        (workspace_id, workstream_id, execution_principal_key, resource_visibility_fingerprint,
         checkpoint_template_version, harness_run_id, compacted_through_sequence, messages_json,
         summary, model, context_tokens_before_compaction, context_window_tokens, input_tokens,
         output_tokens, cost_microusd, created_at, updated_at)
      VALUES
        ('checkpoint-workspace', 'checkpoint-workstream', 'user:checkpoint-owner', 'owner-fingerprint',
         1, 'run-owner', 3, '[]', 'Owner summary', 'model', 80, 100, 10, 4, 2, '2026-08-12', '2026-08-12'),
        ('checkpoint-workspace', 'checkpoint-workstream', 'workspace:checkpoint-workspace', 'automation-fingerprint',
         1, 'run-automation', 4, '[]', 'Automation summary', 'model', 85, 100, 11, 5, 3, '2026-08-12', '2026-08-12');
    `);
    expect(database.prepare(
      "SELECT execution_principal_key, summary FROM workstream_context_compactions ORDER BY execution_principal_key",
    ).all()).toEqual([
      { execution_principal_key: "user:checkpoint-owner", summary: "Owner summary" },
      { execution_principal_key: "workspace:checkpoint-workspace", summary: "Automation summary" },
    ]);
    database.close();
  });

  it("promotes only descriptions a person wrote and holds one refresh claim per work stream", () => {
    const database = migrateDatabaseThrough("0057_slack_unfurled_link_render_hash.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('description-owner', 'description-subject', 'owner@example.com', 'Owner', '2026-08-11', '2026-08-11');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('description-workspace', 'Descriptions', 'descriptions', 'global', 'description-owner', '2026-08-11', '2026-08-11');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES
        ('description-authored', 'description-workspace', 'Checkout', 'Resolve EU checkout authorization failures.',
         'ad_hoc', 'description-owner', 'idle', 2, '2026-08-11', '2026-08-11', '2026-08-11'),
        ('description-derived', 'description-workspace', 'Checkout', 'EU cards are failing again.',
         'ad_hoc', 'description-owner', 'idle', 2, '2026-08-11', '2026-08-11', '2026-08-11'),
        ('description-automation', 'description-workspace', 'Weekly brief', 'Produce the weekly brief.',
         'automation', 'description-owner', 'idle', 2, '2026-08-11', '2026-08-11', '2026-08-11'),
        -- Attachment-only: the description is the literal creation fallback
        -- against an empty opening message, so it differs without being written.
        ('description-attachment', 'description-workspace', 'Files', 'Review the attached files',
         'ad_hoc', 'description-owner', 'idle', 2, '2026-08-11', '2026-08-11', '2026-08-11'),
        -- A Slack mention past the objective's 4,000-character limit: the
        -- description is the opening message truncated, not a different text.
        ('description-truncated', 'description-workspace', 'Slack task', ${"'" + "s".repeat(4000) + "'"},
         'ad_hoc', 'description-owner', 'idle', 2, '2026-08-11', '2026-08-11', '2026-08-11');
      INSERT INTO messages
        (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
         message_type, text_content, sequence_number, created_at)
      VALUES
        ('description-message-a', 'client-a', 'description-workspace', 'description-authored', 'human',
         'description-owner', 'text', 'EU cards are failing again.', 1, '2026-08-11'),
        ('description-message-b', 'client-b', 'description-workspace', 'description-derived', 'human',
         'description-owner', 'text', 'EU cards are failing again.', 1, '2026-08-11'),
        ('description-message-c', 'client-c', 'description-workspace', 'description-attachment', 'human',
         'description-owner', 'text', '', 1, '2026-08-11'),
        ('description-message-d', 'client-d', 'description-workspace', 'description-truncated', 'human',
         'description-owner', 'text', ${"'" + "s".repeat(4200) + "'"}, 1, '2026-08-11');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0058_workstream_description_refresh.sql", import.meta.url),
      "utf8",
    ));

    const sources = database.prepare(
      "SELECT id, description_source FROM workstreams ORDER BY id",
    ).all() as Array<{ id: string; description_source: string }>;
    // Only the row a person can still be shown to have written is promoted.
    // The backfill is not re-runnable, so a wrong promotion is permanent.
    expect(sources).toEqual([
      { id: "description-attachment", description_source: "derived" },
      { id: "description-authored", description_source: "authored" },
      { id: "description-automation", description_source: "derived" },
      { id: "description-derived", description_source: "derived" },
      { id: "description-truncated", description_source: "derived" },
    ]);

    // One row per work stream is what makes the claim a claim: a second
    // evaluation has to take the same row rather than start beside it.
    const claim = `INSERT INTO workstream_description_refreshes
      (workstream_id, workspace_id, evaluated_at, rest_until, evaluated_through_sequence, decision, created_at, updated_at)
      VALUES ('description-authored', 'description-workspace', '2026-08-11T12:00:00.000Z',
              '2026-08-11T18:00:00.000Z', 1, 'pending', '2026-08-11', '2026-08-11')`;
    database.exec(claim);
    expect(() => database.exec(claim)).toThrow(/UNIQUE|PRIMARY KEY/u);
    expect(() => database.exec(
      `UPDATE workstream_description_refreshes SET decision = 'rejected' WHERE workstream_id = 'description-authored'`,
    )).toThrow(/CHECK/u);
    expect(() => database.exec(
      `UPDATE workstream_description_refreshes SET consecutive_keeps = -1 WHERE workstream_id = 'description-authored'`,
    )).toThrow(/CHECK/u);
    database.close();
  });

  it("migrates Slack sessions and permits workspace-owned externally attributed work streams", () => {
    const database = migrateDatabaseThrough("0040_realtime_transcription_admission.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-slack', 'google-slack', 'slack@example.com', 'Slack Member', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-slack', 'Slack', 'slack-workspace', 'global',
              'user-slack', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, status, cursor_json, config_json,
         created_at, updated_at, model_plugin_id)
      VALUES ('connection-slack', 'workspace-slack', 'slack', 'workspace', NULL, 'T123',
              'Slack workspace', '[]', 'healthy', '{}', '{}',
              '2026-01-01', '2026-01-01', 'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-linked', 'workspace-slack', 'Linked', 'Existing linked task',
              'ad_hoc', 'user-slack', 'completed', 2,
              '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, user_id, slack_team_id, slack_user_id,
         slack_channel_id, slack_thread_ts, workstream_id, context_json, created_at, updated_at)
      VALUES ('session-linked', 'workspace-slack', 'connection-slack', 'user-slack',
              'T123', 'U123', 'D123', '1.0', 'workstream-linked', '{}',
              '2026-01-01', '2026-01-01');
    `);
    database.exec(readFileSync(
      new URL("../migrations/0041_slack_workspace_workstreams.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      `SELECT linked_user_id, execution_scope, assigned_user_id, assignment_method
       FROM slack_agent_sessions WHERE id = 'session-linked'`,
    ).get()).toEqual({
      linked_user_id: "user-slack",
      execution_scope: "user",
      assigned_user_id: "user-slack",
      assignment_method: "explicit_link",
    });
    expect(database.prepare(
      "SELECT public_channel_mode, private_channel_mode FROM slack_agent_policies WHERE connection_id = 'connection-slack'",
    ).get()).toEqual({ public_channel_mode: "all_invited", private_channel_mode: "disabled" });

    database.exec(`
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-ownerless', 'workspace-slack', 'Ownerless', 'Workspace task',
              'ad_hoc', NULL, 'running', 2,
              '2026-02-01', '2026-02-01', '2026-02-01');
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, author_user_id, message_type,
         text_content, sequence_number, external_actor_json, created_at)
      VALUES ('message-external', 'workspace-slack', 'workstream-ownerless', 'system', NULL,
              'text', 'Investigate this', 1,
              '{"provider":"slack","providerAccountId":"T123","providerUserId":"U999","displayName":"External Member","avatarUrl":null}',
              '2026-02-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         context_json, created_at, updated_at)
      VALUES ('session-ownerless', 'workspace-slack', 'connection-slack', NULL, 'workspace',
              'T123', 'U999', 'C123', '2.0', 'event:ownerless', 'workstream-ownerless',
              'app_mention', 'public', '{}', '2026-02-01', '2026-02-01');
    `);
    expect(database.prepare(
      "SELECT created_by_user_id FROM workstreams WHERE id = 'workstream-ownerless'",
    ).get()).toEqual({ created_by_user_id: null });
    database.close();
  });

  it("applies the development seed after every migration", () => {
    const database = migrateFreshDatabase();
    database.exec(readFileSync(new URL("../seed.sql", import.meta.url), "utf8"));
    expect(database.prepare(
      "SELECT provider, connection_id FROM resources WHERE id = '00000000-0000-7000-8000-000000000041'",
    ).get()).toEqual({ provider: "fixture", connection_id: null });
    expect(database.prepare(
      `SELECT connector_type, scope, status, model_plugin_id FROM connector_connections
       WHERE id = '00000000-0000-7000-8000-000000000061'`,
    ).get()).toEqual({
      connector_type: "generic_webhook",
      scope: "workspace",
      status: "healthy",
      model_plugin_id: "plugin_webhook",
    });
    database.close();
  });

  it("removes legacy web-monitor data and prevents the retired connector from returning", () => {
    const database = migrateDatabaseThrough("0037_scoped_memory_tables.sql");
    database.exec(`
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-monitor', 'google-monitor', 'monitor@example.com', 'Monitor Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-monitor', 'Monitor', 'monitor', 'global', 'user-monitor', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
      VALUES ('connection-monitor', 'workspace-monitor', 'web_monitor', 'personal', 'user-monitor',
              'Legacy monitor', '["web.read"]', 'plugin_web_monitor', 'healthy', '{}', '{}',
              '2026-01-01', '2026-01-01');
      INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
         title, metadata_json, created_at, updated_at)
      VALUES ('resource-monitor', 'workspace-monitor', 'connection-monitor', 'web_page',
              'web_monitor', 'legacy-page', 'Legacy page', '{}', '2026-01-01', '2026-01-01');
      CREATE TABLE web_monitor_snapshots (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connector_connections(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
      INSERT INTO web_monitor_snapshots (id, connection_id, content_hash, fetched_at)
      VALUES ('snapshot-monitor', 'connection-monitor', 'hash', '2026-01-01');
      PRAGMA ignore_check_constraints = OFF;
    `);

    database.exec(readFileSync(
      new URL("../migrations/0038_remove_web_monitor.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'web_monitor_snapshots'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT id FROM connector_connections WHERE id = 'connection-monitor'",
    ).get()).toBeUndefined();
    expect(database.prepare(
      "SELECT id FROM resources WHERE id = 'resource-monitor'",
    ).get()).toBeUndefined();
    expect(() => database.exec(`
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, status, cursor_json, config_json, created_at, updated_at)
      VALUES ('connection-monitor-new', 'workspace-monitor', 'web_monitor', 'personal', 'user-monitor',
              'Monitor', '[]', 'plugin_web_monitor', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01');
    `)).toThrow(/has been removed/u);
    database.close();
  });

  it("preserves every connector foreign-key branch while adding Slack inside a transaction", () => {
    const database = migrateDatabaseThrough("0038_remove_web_monitor.sql");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-slack-migration', 'google-slack-migration', 'migration@example.com', 'Migration Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-slack-migration', 'Migration', 'slack-migration', 'global', 'user-slack-migration', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, granted_scopes_json,
         status, cursor_json, config_json, created_at, updated_at, model_plugin_id)
      VALUES ('connection-slack-migration', 'workspace-slack-migration', 'google', 'workspace',
              'Existing connector', '[]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01', 'plugin_google');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-slack-migration', 'workspace-slack-migration', 'Migration', 'Preserve data',
              'ad_hoc', 'user-slack-migration', 'completed', '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('harness-slack-migration', 'workspace-slack-migration', 'workstream-slack-migration',
              'test', '{}', 'completed', '2026-01-01');
      INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
         title, metadata_json, created_at, updated_at)
      VALUES ('resource-slack-migration', 'workspace-slack-migration', 'connection-slack-migration',
              'fixture', 'google', 'resource-1', 'Resource', '{}', '2026-01-01', '2026-01-01');
      INSERT INTO activities
        (id, workspace_id, connection_id, connection_scope, provider, provider_event_id,
         event_type, occurred_at, received_at, title, dedupe_key)
      VALUES ('activity-slack-migration', 'workspace-slack-migration', 'connection-slack-migration',
              'workspace', 'google', 'event-1', 'updated', '2026-01-01', '2026-01-01', 'Activity', 'dedupe-1');
      INSERT INTO activity_suggestions
        (id, workspace_id, activity_id, workstream_id, confidence, reason, created_at)
      VALUES ('suggestion-slack-migration', 'workspace-slack-migration', 'activity-slack-migration',
              'workstream-slack-migration', 1, 'Preserve me', '2026-01-01');
      INSERT INTO resource_watches
        (id, workspace_id, workstream_id, resource_id, connection_id, watch_type, created_at, updated_at)
      VALUES ('watch-slack-migration', 'workspace-slack-migration', 'workstream-slack-migration',
              'resource-slack-migration', 'connection-slack-migration', 'changes', '2026-01-01', '2026-01-01');
      INSERT INTO tool_invocations
        (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
         connection_id, input_hash, input_json, status)
      VALUES ('tool-slack-migration', 'workspace-slack-migration', 'workstream-slack-migration',
              'harness-slack-migration', 'call-1', 'fixture', 'connection-slack-migration', 'hash', '{}', 'completed');
      INSERT INTO schedules
        (id, workspace_id, connector_connection_id, schedule_type, interval_seconds,
         timezone, next_run_at, created_at, updated_at)
      VALUES ('schedule-slack-migration', 'workspace-slack-migration', 'connection-slack-migration',
              'interval', 3600, 'UTC', '2026-01-02', '2026-01-01', '2026-01-01');
      INSERT INTO webhook_receipts (id, connection_id, signature_hash, received_at, expires_at)
      VALUES ('receipt-slack-migration', 'connection-slack-migration', 'signature', '2026-01-01', '2026-02-01');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state, created_at, updated_at)
      VALUES ('template-slack-migration', 'workspace-slack-migration', 'user-slack-migration',
              'Template', 'Template', 'private', '2026-01-01', '2026-01-01');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json,
         created_by_user_id, created_at)
      VALUES ('version-slack-migration', 'template-slack-migration', 1, 'Run', '[]',
              'user-slack-migration', '2026-01-01');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, status, created_at, updated_at)
      VALUES ('subscription-slack-migration', 'workspace-slack-migration', 'template-slack-migration',
              'version-slack-migration', 'personal', 'user-slack-migration', '{}', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO schedules
        (id, workspace_id, automation_subscription_id, schedule_type, interval_seconds,
         timezone, next_run_at, created_at, updated_at)
      VALUES ('schedule-slack-retained', 'workspace-slack-migration', 'subscription-slack-migration',
              'interval', 3600, 'UTC', '2026-01-02', '2026-01-01', '2026-01-01');
      INSERT INTO automation_runs
        (id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
         trigger_activity_id, status, created_at)
      VALUES ('run-slack-migration', 'workspace-slack-migration', 'subscription-slack-migration',
              'workstream-slack-migration', 'activity', 'activity-slack-migration', 'completed', '2026-01-01');
    `);

    database.exec("BEGIN");
    database.exec(readFileSync(new URL("../migrations/0039_slack_connector.sql", import.meta.url), "utf8"));
    database.exec("COMMIT");

    expect(database.prepare("SELECT connection_id FROM resources WHERE id = 'resource-slack-migration'").get())
      .toEqual({ connection_id: "connection-slack-migration" });
    expect(database.prepare("SELECT trigger_activity_id FROM automation_runs WHERE id = 'run-slack-migration'").get())
      .toEqual({ trigger_activity_id: "activity-slack-migration" });
    expect(database.prepare("SELECT connection_id FROM tool_invocations WHERE id = 'tool-slack-migration'").get())
      .toEqual({ connection_id: "connection-slack-migration" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM schedules").get()).toEqual({ count: 2 });
    for (const table of ["activities", "activity_suggestions", "resource_watches", "webhook_receipts"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
    }
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

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

  it("assigns readable plugin ids uniquely among active workspace connections", () => {
    const database = migrateDatabaseThrough("0027_inline_child_runs.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-plugin', 'google-plugin', 'plugin@example.com', 'Plugin Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-plugin', 'Plugin Workspace', 'plugin-workspace', 'global', 'user-plugin', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, status, created_at, updated_at)
      VALUES
        ('google-first', 'workspace-plugin', 'google', 'workspace', 'Google one', 'healthy', '2026-01-01', '2026-01-01'),
        ('google-second', 'workspace-plugin', 'google', 'workspace', 'Google two', 'error', '2026-01-02', '2026-01-02'),
        ('google-disabled', 'workspace-plugin', 'google', 'workspace', 'Google removed', 'disabled', '2025-01-01', '2025-01-01'),
        ('webhook-first', 'workspace-plugin', 'generic_webhook', 'workspace', 'Webhook', 'healthy', '2026-01-03', '2026-01-03');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0028_connector_model_plugin_ids.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT id, model_plugin_id FROM connector_connections ORDER BY id",
    ).all()).toEqual([
      { id: "google-disabled", model_plugin_id: null },
      { id: "google-first", model_plugin_id: "plugin_google" },
      { id: "google-second", model_plugin_id: "plugin_google_2" },
      { id: "webhook-first", model_plugin_id: "plugin_webhook" },
    ]);

    database.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = 'google-first'");
    database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, model_plugin_id, status, created_at, updated_at)
      VALUES ('google-readded', 'workspace-plugin', 'google', 'workspace', 'Google three',
              'plugin_google', 'healthy', '2026-01-04', '2026-01-04');
    `);
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, model_plugin_id, status, created_at, updated_at)
      VALUES ('google-duplicate', 'workspace-plugin', 'google', 'workspace', 'Google duplicate',
              'plugin_google', 'healthy', '2026-01-05', '2026-01-05');
    `)).toThrow(/UNIQUE constraint failed/u);
    database.close();
  });

  it("requires every connection row to retain a valid model-facing plugin id", () => {
    const database = migrateDatabaseThrough("0032_automation_plugin_defaults.sql");
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-plugin-invariant', 'google-plugin-invariant', 'plugin-invariant@example.com',
              'Plugin Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-plugin-invariant', 'Plugin Workspace', 'plugin-invariant', 'global',
              'user-plugin-invariant', '2026-01-01', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, status, created_at, updated_at)
      VALUES ('legacy-disabled', 'workspace-plugin-invariant', 'google', 'workspace',
              'Removed Google', 'disabled', '2026-01-01', '2026-01-01');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0033_connection_model_plugin_id_invariant.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT model_plugin_id FROM connector_connections WHERE id = 'legacy-disabled'",
    ).get()).toEqual({ model_plugin_id: "plugin_google" });
    expect(() => database.exec(`
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, display_name, model_plugin_id, status, created_at, updated_at)
      VALUES ('missing-plugin-id', 'workspace-plugin-invariant', 'google', 'workspace',
              'Missing', NULL, 'disabled', '2026-01-02', '2026-01-02');
    `)).toThrow(/model_plugin_id must match the API contract/u);
    expect(() => database.exec(
      "UPDATE connector_connections SET model_plugin_id = 'Plugin_Google' WHERE id = 'legacy-disabled'",
    )).toThrow(/model_plugin_id must match the API contract/u);
    expect(() => database.exec(
      "UPDATE connector_connections SET model_plugin_id = NULL WHERE id = 'legacy-disabled'",
    )).toThrow(/model_plugin_id must match the API contract/u);
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
        (id, workspace_id, connector_type, scope, display_name, model_plugin_id, created_at, updated_at)
      VALUES ('connection-1', 'workspace-1', 'github', 'workspace', 'GitHub', 'plugin_github', '2026-01-01', '2026-01-01');
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
        (id, workspace_id, connector_type, scope, display_name, model_plugin_id, created_at, updated_at)
      VALUES
        ('connection-github', 'workspace-watch', 'github', 'workspace', 'GitHub', 'plugin_github', '2026-01-01', '2026-01-01'),
        ('connection-google', 'workspace-watch', 'google', 'workspace', 'Google', 'plugin_google', '2026-01-01', '2026-01-01');
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

  it("credits the assigned Slack member as the creator of work streams stored as ownerless", () => {
    const database = migrateDatabaseThrough("0052_automation_connector_bindings.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-owner', 'google-owner', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01'),
        ('user-taylor', 'google-taylor', 'taylor@example.com', 'Taylor', '2026-01-01', '2026-01-01'),
        ('user-jordan', 'google-jordan', 'jordan@example.com', 'Jordan', '2026-01-01', '2026-01-01'),
        ('user-former', 'google-former', 'former@example.com', 'Former', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-slack', 'Slack', 'slack-workspace', 'global', 'user-owner',
              '2026-01-01', '2026-01-01');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
      VALUES
        ('workspace-slack', 'user-owner', 'owner', 'active', '2026-01-01'),
        ('workspace-slack', 'user-taylor', 'member', 'active', '2026-01-01'),
        ('workspace-slack', 'user-jordan', 'member', 'active', '2026-01-01'),
        ('workspace-slack', 'user-former', 'member', 'suspended', '2026-01-01');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
         display_name, granted_scopes_json, status, cursor_json, config_json,
         created_at, updated_at, model_plugin_id)
      VALUES ('connection-slack', 'workspace-slack', 'slack', 'workspace', NULL, 'T123',
              'Slack workspace', '[]', 'healthy', '{}', '{}', '2026-01-01', '2026-01-01',
              'plugin_slack_workspace');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES
        ('workstream-assigned', 'workspace-slack', 'Assigned', 'Slack task', 'ad_hoc', NULL,
         'completed', 2, '2026-02-01', '2026-02-01', '2026-02-01'),
        ('workstream-unassigned', 'workspace-slack', 'Unassigned', 'Slack task', 'ad_hoc', NULL,
         'completed', 2, '2026-02-01', '2026-02-01', '2026-02-01'),
        ('workstream-suspended', 'workspace-slack', 'Suspended', 'Slack task', 'ad_hoc', NULL,
         'completed', 2, '2026-02-01', '2026-02-01', '2026-02-01'),
        ('workstream-owned', 'workspace-slack', 'Owned', 'Slack task', 'ad_hoc', 'user-jordan',
         'completed', 2, '2026-02-01', '2026-02-01', '2026-02-01'),
        ('workstream-claimed-by-other', 'workspace-slack', 'Claimed', 'Slack task', 'ad_hoc', NULL,
         'completed', 2, '2026-02-01', '2026-02-01', '2026-02-01'),
        ('workstream-claimed-by-author', 'workspace-slack', 'Claimed', 'Slack task', 'ad_hoc', NULL,
         'completed', 2, '2026-02-01', '2026-02-01', '2026-02-01');
      INSERT INTO slack_agent_sessions
        (id, workspace_id, connection_id, linked_user_id, execution_scope,
         slack_team_id, slack_user_id, slack_channel_id, slack_thread_ts,
         opening_client_message_id, workstream_id, invocation_kind, channel_type,
         assigned_user_id, assigned_at, assignment_method, context_json, created_at, updated_at)
      VALUES
        ('session-assigned', 'workspace-slack', 'connection-slack', NULL, 'workspace',
         'T123', 'U456', 'C123', '1.0', 'event:assigned', 'workstream-assigned',
         'app_mention', 'public', 'user-taylor', '2026-02-02', 'verified_email', '{}',
         '2026-02-01', '2026-02-02'),
        ('session-unassigned', 'workspace-slack', 'connection-slack', NULL, 'workspace',
         'T123', 'U789', 'C123', '2.0', 'event:unassigned', 'workstream-unassigned',
         'app_mention', 'public', NULL, NULL, NULL, '{}', '2026-02-01', '2026-02-01'),
        ('session-suspended', 'workspace-slack', 'connection-slack', NULL, 'workspace',
         'T123', 'U999', 'C123', '3.0', 'event:suspended', 'workstream-suspended',
         'app_mention', 'public', 'user-former', '2026-02-02', 'verified_email', '{}',
         '2026-02-01', '2026-02-02'),
        ('session-claimed-by-other', 'workspace-slack', 'connection-slack', NULL, 'workspace',
         'T123', 'U456', 'C123', '5.0', 'event:claimed-other', 'workstream-claimed-by-other',
         'app_mention', 'public', 'user-taylor', '2026-02-03', 'verified_email', '{}',
         '2026-02-01', '2026-02-03'),
        ('session-claimed-by-author', 'workspace-slack', 'connection-slack', NULL, 'workspace',
         'T123', 'U456', 'C123', '6.0', 'event:claimed-author', 'workstream-claimed-by-author',
         'app_mention', 'public', 'user-taylor', '2026-02-03', 'verified_email', '{}',
         '2026-02-01', '2026-02-03'),
        ('session-owned', 'workspace-slack', 'connection-slack', NULL, 'workspace',
         'T123', 'U456', 'C123', '4.0', 'event:owned', 'workstream-owned',
         'app_mention', 'public', 'user-taylor', '2026-02-02', 'verified_email', '{}',
         '2026-02-01', '2026-02-02');
      -- An earlier assignment already added the member with the reason that
      -- assignment used; crediting them as creator has to update it.
      INSERT INTO workstream_participants
        (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
      VALUES ('workstream-claimed-by-author', 'user-taylor', 'user-taylor', 'explicit',
              '2026-02-03');
      -- A claim writes assigned_user_id too, so it must be told apart from a
      -- verified-email or account-link assignment by who did the claiming.
      UPDATE slack_agent_sessions SET
        claimed_by_slack_user_id = 'UOTHER', claimed_at = '2026-02-03',
        assignment_method = 'explicit_link', execution_scope = 'user',
        linked_user_id = 'user-taylor'
      WHERE id = 'session-claimed-by-other';
      UPDATE slack_agent_sessions SET
        claimed_by_slack_user_id = 'U456', claimed_at = '2026-02-03',
        assignment_method = 'explicit_link', execution_scope = 'user',
        linked_user_id = 'user-taylor'
      WHERE id = 'session-claimed-by-author';
    `);

    database.exec(readFileSync(
      new URL("../migrations/0053_slack_workstream_creator_backfill.sql", import.meta.url),
      "utf8",
    ));

    expect(database.prepare(
      "SELECT id, created_by_user_id FROM workstreams ORDER BY id",
    ).all()).toEqual([
      { id: "workstream-assigned", created_by_user_id: "user-taylor" },
      { id: "workstream-claimed-by-author", created_by_user_id: "user-taylor" },
      { id: "workstream-claimed-by-other", created_by_user_id: null },
      { id: "workstream-owned", created_by_user_id: "user-jordan" },
      { id: "workstream-suspended", created_by_user_id: null },
      { id: "workstream-unassigned", created_by_user_id: null },
    ]);
    expect(database.prepare(
      `SELECT workstream_id, user_id, participation_reason FROM workstream_participants
       ORDER BY workstream_id`,
    ).all()).toEqual([
      {
        workstream_id: "workstream-assigned",
        user_id: "user-taylor",
        participation_reason: "creator",
      },
      {
        workstream_id: "workstream-claimed-by-author",
        user_id: "user-taylor",
        participation_reason: "creator",
      },
    ]);
    database.close();
  });

  it("keeps Slack delivery targets and admits email targets when delivery gains email", () => {
    const database = migrateDatabaseThrough("0053_slack_workstream_creator_backfill.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-delivery', 'user-delivery-subject', 'owner@example.com', 'Owner', '2026-08-10', '2026-08-10');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-delivery', 'Delivery', 'delivery', 'global', 'user-delivery', '2026-08-10', '2026-08-10');
      INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name,
         granted_scopes_json, model_plugin_id, status, created_at, updated_at)
      VALUES ('connection-delivery', 'workspace-delivery', 'slack', 'workspace', NULL, 'Slack',
              '[]', 'plugin_delivery_slack', 'healthy', '2026-08-10', '2026-08-10');
      INSERT INTO automation_templates
        (id, workspace_id, owner_user_id, name, description, sharing_state, created_at, updated_at)
      VALUES ('template-delivery', 'workspace-delivery', 'user-delivery', 'Template', 'Template', 'private', '2026-08-10', '2026-08-10');
      INSERT INTO automation_template_versions
        (id, template_id, version_number, instructions, trigger_definitions_json, created_by_user_id, created_at)
      VALUES ('version-delivery', 'template-delivery', 1, 'Run', '[]', 'user-delivery', '2026-08-10');
      INSERT INTO automation_subscriptions
        (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
         execution_principal_json, status, created_at, updated_at)
      VALUES ('subscription-delivery', 'workspace-delivery', 'template-delivery', 'version-delivery',
              'personal', 'user-delivery', '{}', 'active', '2026-08-10', '2026-08-10');
      INSERT INTO automation_delivery_targets
        (id, workspace_id, automation_subscription_id, target_type, connection_id, user_id,
         slack_team_id, slack_user_id, status, created_at, updated_at)
      VALUES ('target-slack', 'workspace-delivery', 'subscription-delivery', 'slack_agent_dm',
              'connection-delivery', 'user-delivery', 'T123', 'U123', 'active', '2026-08-10', '2026-08-10');
    `);

    database.exec(readFileSync(new URL("../migrations/0054_automation_email_delivery.sql", import.meta.url), "utf8"));

    expect(database.prepare(
      "SELECT connection_id, slack_team_id, email_address FROM automation_delivery_targets WHERE id = 'target-slack'",
    ).get()).toEqual({ connection_id: "connection-delivery", slack_team_id: "T123", email_address: null });

    database.exec(`
      INSERT INTO automation_delivery_targets
        (id, workspace_id, automation_subscription_id, target_type, user_id, email_address,
         status, created_at, updated_at)
      VALUES ('target-email', 'workspace-delivery', 'subscription-delivery', 'email',
              'user-delivery', 'owner@example.com', 'active', '2026-08-10', '2026-08-10');
    `);
    expect(database.prepare(
      "SELECT email_address FROM automation_delivery_targets WHERE id = 'target-email'",
    ).get()).toEqual({ email_address: "owner@example.com" });

    expect(() => database.exec(`
      INSERT INTO automation_delivery_targets
        (id, workspace_id, automation_subscription_id, target_type, connection_id, user_id,
         email_address, status, created_at, updated_at)
      VALUES ('target-mixed', 'workspace-delivery', 'subscription-delivery', 'email',
              'connection-delivery', 'user-delivery', 'owner@example.com', 'active', '2026-08-10', '2026-08-10');
    `)).toThrow();
    expect(() => database.exec(`
      INSERT INTO automation_delivery_targets
        (id, workspace_id, automation_subscription_id, target_type, user_id,
         status, created_at, updated_at)
      VALUES ('target-empty', 'workspace-delivery', 'subscription-delivery', 'email',
              'user-delivery', 'active', '2026-08-10', '2026-08-10');
    `)).toThrow();
    database.close();
  });

  it("records where each past digest ran, then drops the old column once no Worker reads it", () => {
    const database = migrateDatabaseThrough("0067_harness_run_trigger_message.sql");
    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-digest', 'google-digest', 'digest@example.com', 'Digest User', '2026-08-10', '2026-08-10');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-digest', 'Digest Workspace', 'digest-workspace', 'global',
              'user-digest', '2026-08-10', '2026-08-10');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status,
         last_activity_at, created_at, updated_at, system_kind, scope)
      VALUES ('workstream-digest-shared', 'workspace-digest', 'Digest · Digest User', '',
              'ad_hoc', 'user-digest', 'idle', '2026-08-10', '2026-08-10', '2026-08-10',
              'digest', 'personal');
      INSERT INTO digest_schedules
        (id, workspace_id, user_id, day_mask, enabled, system_workstream_id,
         execution_principal_json, version, created_at, updated_at)
      VALUES ('schedule-digest', 'workspace-digest', 'user-digest', 62, 1, 'workstream-digest-shared',
              '{"type":"user","userId":"user-digest"}', 1, '2026-08-10', '2026-08-10');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
      VALUES ('run-digest', 'workspace-digest', 'workstream-digest-shared', 'scheduled_digest',
              '{"type":"user","userId":"user-digest"}', 'completed', '2026-08-10');
      INSERT INTO digest_deliveries
        (id, workspace_id, digest_schedule_id, user_id, planned_for, cursor_from, cursor_through,
         event_count, highlight_count, harness_run_id, status, created_at, updated_at)
      VALUES
        ('delivery-ran', 'workspace-digest', 'schedule-digest', 'user-digest', '2026-08-10T08:00:00.000Z',
         NULL, 12, 4, 1, 'run-digest', 'delivered', '2026-08-10', '2026-08-10'),
        ('delivery-empty', 'workspace-digest', 'schedule-digest', 'user-digest', '2026-08-11T08:00:00.000Z',
         12, 12, 0, 0, NULL, 'empty', '2026-08-11', '2026-08-11');
    `);

    database.exec(readFileSync(
      new URL("../migrations/0068_digest_workstream_per_occurrence.sql", import.meta.url),
      "utf8",
    ));

    // Where each one actually ran, which for everything before this migration
    // is the shared work stream. An occurrence that never reached a harness has
    // no work stream, and NULL is the accurate answer rather than a gap.
    expect(database.prepare(
      "SELECT id, workstream_id FROM digest_deliveries ORDER BY planned_for",
    ).all()).toEqual([
      { id: "delivery-ran", workstream_id: "workstream-digest-shared" },
      { id: "delivery-empty", workstream_id: null },
    ]);
    // The old column survives this migration on purpose. Migrations land before
    // either Worker deploys, so the previous Worker is still selecting and
    // writing it while this schema is live; dropping it here would make digest
    // firing, the reconciler and the settings read fail with `no such column`
    // for the length of a deployment — hours if that deployment fails. A later
    // migration drops it once nothing reads it.
    const scheduleColumns = database.prepare("PRAGMA table_info(digest_schedules)")
      .all() as Array<{ name: string }>;
    expect(scheduleColumns.map((column) => column.name)).toContain("system_workstream_id");
    // The two writes the previous Worker still performs against it.
    expect(() => database.exec(
      "UPDATE digest_schedules SET system_workstream_id = 'workstream-digest-shared' WHERE id = 'schedule-digest'",
    )).not.toThrow();
    expect(database.prepare(
      "SELECT system_workstream_id FROM digest_schedules WHERE id = 'schedule-digest'",
    ).get()).toEqual({ system_workstream_id: "workstream-digest-shared" });
    // The transcripts themselves stay: their owners can still open them, and
    // dropping a pointer is not a reason to delete somebody's history.
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstreams WHERE id = 'workstream-digest-shared'",
    ).get()).toEqual({ count: 1 });
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // And the phase that was waiting on the deployment window: once every live
    // Worker ignores the column, it goes, taking nothing with it. The delivery
    // link, the transcripts, and the delivery rows that carry the cursor all
    // survive — a schedule losing a pointer must not lose a person's history or
    // let a window be digested twice.
    database.exec(readFileSync(
      new URL("../migrations/0070_drop_digest_schedule_workstream.sql", import.meta.url),
      "utf8",
    ));

    expect((database.prepare("PRAGMA table_info(digest_schedules)").all() as Array<{ name: string }>)
      .map((column) => column.name)).not.toContain("system_workstream_id");
    expect(database.prepare(
      "SELECT id, workstream_id FROM digest_deliveries ORDER BY planned_for",
    ).all()).toEqual([
      { id: "delivery-ran", workstream_id: "workstream-digest-shared" },
      { id: "delivery-empty", workstream_id: null },
    ]);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM workstreams WHERE id = 'workstream-digest-shared'",
    ).get()).toEqual({ count: 1 });
    // The schedule itself is intact and still usable — the drop is a column, not
    // a rebuild, so nothing around it was restated and nothing could be lost.
    expect(database.prepare(
      "SELECT id, day_mask, enabled FROM digest_schedules WHERE id = 'schedule-digest'",
    ).get()).toEqual({ id: "schedule-digest", day_mask: 62, enabled: 1 });
    // The dropped column took its foreign key with it and left the other two
    // alone. This is what makes the drop legal without a table rebuild — SQLite
    // refuses `DROP COLUMN` for a column named in a constraint it cannot remove
    // — so it is asserted rather than assumed: a future column added here with a
    // reference that outlives it would fail this rather than fail a deployment.
    expect((database.prepare("PRAGMA foreign_key_list(digest_schedules)")
      .all() as Array<{ table: string; from: string }>)
      .map((key) => `${key.from} -> ${key.table}`).sort()).toEqual([
        "user_id -> users",
        "workspace_id -> workspaces",
      ]);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });

  it("gives the ordinary sidebar list a recency index it can seek rather than filter", () => {
    const database = migrateFreshDatabase();
    // The list seeks `(workspace_id, last_activity_at DESC)` and then walks, so
    // on the shared index every ordinary listing steps over each digest row
    // newer than the last row it returns — and those accumulate one per
    // occurrence. A partial index is only usable when the query's WHERE implies
    // its predicate, so this asserts the exact clause the query states.
    const planFor = (predicate: string): string =>
      (database.prepare(
        `EXPLAIN QUERY PLAN
         SELECT w.id FROM workstreams w
          WHERE w.workspace_id = 'ws' AND w.archived_at IS NULL AND ${predicate}
          ORDER BY w.last_activity_at DESC LIMIT 25`,
      ).all() as Array<{ detail: string }>).map((row) => row.detail).join("\n");

    expect(planFor("w.system_kind IS NULL")).toContain("workstreams_sidebar_recency_ordinary_idx");
    expect(planFor("w.system_kind IS NULL")).not.toContain("SCAN");
    // A listing that asks for machinery has no `system_kind` predicate at all —
    // it asks for everything and pages — so it keeps the general index rather
    // than reaching one it could never imply.
    expect(planFor("1 = 1")).toContain("workstreams_sidebar_recency_idx");
    expect(planFor("1 = 1")).not.toContain("SCAN");
    database.close();
  });

  it("retires the artifact message type while leaving the table for the old Worker", () => {
    const database = migrateDatabaseThrough("0068_digest_workstream_per_occurrence.sql");
    database.exec(`
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES ('user-artifact', 'google-artifact', 'artifact@example.com', 'Artifact Owner', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-artifact', 'Artifact', 'artifact', 'global', 'user-artifact', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
      VALUES ('workstream-artifact', 'workspace-artifact', 'Launch', 'Ship it', 'ad_hoc',
              'user-artifact', 'idle', 3, '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO artifacts
        (id, workspace_id, workstream_id, artifact_type, title, content_ref, preview_text,
         status, metadata_json, created_at, updated_at)
      VALUES ('artifact-legacy', 'workspace-artifact', 'workstream-artifact', 'markdown',
              'Launch brief', 'global/workspace-artifact/artifacts/artifact-legacy.txt',
              'A summary.', 'complete', '{}', '2026-01-01', '2026-01-01');
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, message_type, text_content,
         sequence_number, created_at)
      VALUES ('message-artifact', 'workspace-artifact', 'workstream-artifact', 'agent',
              'artifact', 'Launch brief', 1, '2026-01-01');
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, message_type, text_content,
         sequence_number, created_at)
      VALUES ('message-text', 'workspace-artifact', 'workstream-artifact', 'agent',
              'text', 'Here is the brief.', 2, '2026-01-01');
      PRAGMA ignore_check_constraints = OFF;
    `);

    database.exec(readFileSync(
      new URL("../migrations/0069_retire_artifact_messages.sql", import.meta.url),
      "utf8",
    ));

    // The table stays until a later release. The deploy job migrates both
    // regions before it deploys either Worker, and the Worker still live at
    // that moment reads `artifacts` on every `GET /workstreams/:id/context`.
    expect(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'artifacts'",
    ).get()).toEqual({ name: "artifacts" });
    expect(database.prepare(
      "SELECT id FROM artifacts WHERE id = 'artifact-legacy'",
    ).get()).toEqual({ id: "artifact-legacy" });
    expect(database.prepare(
      "SELECT id FROM messages WHERE id = 'message-artifact'",
    ).get()).toBeUndefined();
    // Only the retired type goes. A gap in `sequence_number` is expected, and
    // the surrounding transcript has to survive it.
    expect(database.prepare(
      "SELECT id, sequence_number FROM messages WHERE workstream_id = 'workstream-artifact'",
    ).all()).toEqual([{ id: "message-text", sequence_number: 2 }]);

    expect(() => database.exec(`
      PRAGMA ignore_check_constraints = ON;
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, message_type, text_content,
         sequence_number, created_at)
      VALUES ('message-artifact-new', 'workspace-artifact', 'workstream-artifact', 'agent',
              'artifact', 'Back again', 3, '2026-01-01');
    `)).toThrow(/have been removed/u);
    expect(() => database.exec(`
      PRAGMA ignore_check_constraints = ON;
      UPDATE messages SET message_type = 'artifact' WHERE id = 'message-text';
    `)).toThrow(/have been removed/u);
    // The abort is the type, not the write: an ordinary row still lands.
    database.exec(`
      INSERT INTO messages
        (id, workspace_id, workstream_id, author_type, message_type, text_content,
         sequence_number, created_at)
      VALUES ('message-after', 'workspace-artifact', 'workstream-artifact', 'agent',
              'text', 'Still writing.', 4, '2026-01-01');
    `);
    expect(database.prepare(
      "SELECT message_type FROM messages WHERE id = 'message-after'",
    ).get()).toEqual({ message_type: "text" });
    database.close();
  });

  it("serializes Notion webhook setup to one current generation", () => {
    const database = migrateFreshDatabase();
    const insert = database.prepare(
      `INSERT INTO notion_webhook_setup_nonces
       (nonce_hash, verification_token_hash, created_at, expires_at, consumed_at, is_current)
       VALUES (?, NULL, '2026-08-12T20:00:00.000Z', '2026-08-12T20:30:00.000Z', NULL, 1)`,
    );
    const firstHash = "a".repeat(43);
    const secondHash = "b".repeat(43);

    insert.run(firstHash);
    expect(() => insert.run(secondHash)).toThrow(/UNIQUE constraint failed/u);

    database.prepare(
      "UPDATE notion_webhook_setup_nonces SET is_current = 0 WHERE nonce_hash = ?",
    ).run(firstHash);
    insert.run(secondHash);
    expect(database.prepare(
      "SELECT nonce_hash FROM notion_webhook_setup_nonces WHERE is_current = 1",
    ).all()).toEqual([{ nonce_hash: secondHash }]);
    database.close();
  });

  it("owns Terminal sandbox, policy, task, grant, and publication state inside a workspace", () => {
    const database = migrateFreshDatabase();
    const terminalTables = [
      "workstream_sandboxes",
      "workspace_sandbox_network_policies",
      "workspace_sandbox_network_domains",
      "workspace_sandbox_network_policy_mutations",
      "sandbox_tasks",
      "sandbox_imported_resources",
      "terminal_publication_grants",
      "workstream_terminal_repositories",
      "repository_publications",
    ];
    expect(database.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%sandbox%'
       OR type = 'table' AND name IN ('terminal_publication_grants', 'workstream_terminal_repositories', 'repository_publications')
       ORDER BY name`,
    ).all()).toEqual(terminalTables.slice().sort().map((name) => ({ name })));

    for (const table of terminalTables) {
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name), `${table} must carry workspace_id`).toContain("workspace_id");
      const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>;
      const indexedColumns = indexes.flatMap((index) => (
        database.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>
      ).map((column) => column.name));
      expect(indexedColumns[0], `${table} must lead an index with workspace_id`).toBe("workspace_id");
    }

    database.exec(`
      INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
      VALUES ('terminal-owner', 'terminal-owner-subject', 'terminal@example.com', 'Terminal Owner', '2026-08-13', '2026-08-13');
      INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('terminal-workspace', 'Terminal Workspace', 'terminal-workspace', 'global', 'terminal-owner', '2026-08-13', '2026-08-13');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('terminal-workstream', 'terminal-workspace', 'Terminal', 'Run code', 'ad_hoc',
              'terminal-owner', 'idle', '2026-08-13', '2026-08-13', '2026-08-13');
      INSERT INTO workspace_sandbox_network_policies
        (workspace_id, mode, revision, verification_state, baseline_manifest_version,
         effective_domains_json, created_at, updated_at)
      VALUES ('terminal-workspace', 'trusted_only', 1, 'verified', 'terminal-network-v1', '[]',
              '2026-08-13', '2026-08-13');
      INSERT INTO workstream_sandboxes
        (workspace_id, workstream_id, state, stable_name, generation,
         authority_fingerprint, applied_network_revision, version, last_activity_at,
         warm_stop_due_at, archive_due_at, expire_due_at, created_at, updated_at)
      VALUES ('terminal-workspace', 'terminal-workstream', 'absent', 'avalon-terminal-workstream', 1,
              'authority-one', 1, 1, '2026-08-13', '2026-08-13', '2026-08-13', '2026-09-12',
              '2026-08-13', '2026-08-13');
    `);
    expect(() => database.exec(`
      INSERT INTO workstream_sandboxes
        (workspace_id, workstream_id, state, stable_name, generation,
         authority_fingerprint, applied_network_revision, version, last_activity_at,
         warm_stop_due_at, archive_due_at, expire_due_at, created_at, updated_at)
      VALUES ('terminal-workspace', 'terminal-workstream', 'absent', 'duplicate', 2,
              'authority-one', 1, 1, '2026-08-13', '2026-08-13', '2026-08-13', '2026-09-12',
              '2026-08-13', '2026-08-13');
    `)).toThrow(/UNIQUE constraint failed/u);
    expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    database.close();
  });
});
