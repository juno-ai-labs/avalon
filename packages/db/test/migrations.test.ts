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
  it("stores HyperSight configuration as immutable append-only versions", () => {
    const database = migrateFreshDatabase();
    database.exec(`
      INSERT INTO users
        (id, google_subject, email, name, created_at, updated_at)
      VALUES
        ('user-hypersight', 'google-hypersight', 'hypersight@example.com',
         'HyperSight Owner', '2026-01-01', '2026-01-01'),
        ('user-hypersight-two', 'google-hypersight-two', 'hypersight-two@example.com',
         'HyperSight Member', '2026-01-01', '2026-01-01');
      INSERT INTO workspaces
        (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('workspace-hypersight', 'HyperSight', 'hypersight', 'global',
              'user-hypersight', '2026-01-01', '2026-01-01');
      INSERT INTO workstreams
        (id, workspace_id, title, objective, origin_type, created_by_user_id,
         harness_status, last_activity_at, created_at, updated_at)
      VALUES ('workstream-hypersight', 'workspace-hypersight', 'Shared dashboard',
              'Test append-only configuration', 'ad_hoc', 'user-hypersight', 'idle',
              '2026-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO hypersight_configuration_versions
        (id, workspace_id, workstream_id, version_number, blocks_json,
         created_by_user_id, created_at)
      VALUES
        ('hypersight-version-1', 'workspace-hypersight', 'workstream-hypersight', 1,
         '[{"id":"block-1","prompt":"Summarize"}]', 'user-hypersight', '2026-01-01'),
        ('hypersight-version-2', 'workspace-hypersight', 'workstream-hypersight', 2,
         '[{"id":"block-1","prompt":"List five tasks"}]', 'user-hypersight', '2026-01-02');
      INSERT INTO hypersight_user_preferences
        (workspace_id, workstream_id, user_id, visible, updated_at)
      VALUES
        ('workspace-hypersight', 'workstream-hypersight', 'user-hypersight', 1, '2026-01-02'),
        ('workspace-hypersight', 'workstream-hypersight', 'user-hypersight-two', 0, '2026-01-02');
      INSERT INTO harness_runs
        (id, workspace_id, workstream_id, origin, execution_principal_json,
         status, model, created_at)
      VALUES ('hypersight-harness-1', 'workspace-hypersight', 'workstream-hypersight',
              'hypersight_block', '{"type":"workspace","workspaceId":"workspace-hypersight"}',
              'scheduled', 'google/gemini-3.6-flash', '2026-01-02');
      INSERT INTO hypersight_block_runs
        (id, workspace_id, workstream_id, configuration_version_id, block_id, prompt,
         trigger_sequence, harness_run_id, status, created_at)
      VALUES ('hypersight-run-1', 'workspace-hypersight', 'workstream-hypersight',
              'hypersight-version-2', 'block-1', 'List five tasks', 7,
              'hypersight-harness-1', 'queued', '2026-01-02');
    `);

    expect(database.prepare(
      `SELECT version_number, blocks_json FROM hypersight_configuration_versions
       WHERE workstream_id = 'workstream-hypersight' ORDER BY version_number`,
    ).all()).toEqual([
      { version_number: 1, blocks_json: '[{"id":"block-1","prompt":"Summarize"}]' },
      { version_number: 2, blocks_json: '[{"id":"block-1","prompt":"List five tasks"}]' },
    ]);
    expect(() => database.exec(
      "UPDATE hypersight_configuration_versions SET blocks_json = '[]' WHERE id = 'hypersight-version-1'",
    )).toThrow(/hypersight_configuration_version_immutable/u);
    expect(() => database.exec(`
      INSERT INTO hypersight_configuration_versions
        (id, workspace_id, workstream_id, version_number, blocks_json,
         created_by_user_id, created_at)
      VALUES ('hypersight-version-duplicate', 'workspace-hypersight', 'workstream-hypersight',
              2, '[]', 'user-hypersight', '2026-01-03');
    `)).toThrow(/UNIQUE constraint failed/u);
    expect(database.prepare(
      `SELECT user_id, visible FROM hypersight_user_preferences
       WHERE workstream_id = 'workstream-hypersight' ORDER BY user_id`,
    ).all()).toEqual([
      { user_id: 'user-hypersight', visible: 1 },
      { user_id: 'user-hypersight-two', visible: 0 },
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

  it("stores one durable provider-measured compaction checkpoint per work stream", () => {
    const database = migrateFreshDatabase();
    const columns = database.prepare("PRAGMA table_info(workstream_context_compactions)").all();
    expect(columns).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "compacted_through_sequence", notnull: 1 }),
      expect.objectContaining({ name: "messages_json", notnull: 1 }),
      expect.objectContaining({ name: "context_tokens_before_compaction", notnull: 1 }),
      expect.objectContaining({ name: "context_window_tokens", notnull: 1 }),
    ]));
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
});
