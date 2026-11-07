/**
 * The WorkspaceDO migration ledger, one version at a time.
 *
 * A Durable Object's ledger is append-only and hashed: a released version's
 * statements can never change, and a version that inserts a row has to insert
 * it exactly once, for exactly the objects that need it. Both are claims about
 * SQL, so they are proved here against the checked-in statements rather than in
 * the workers suite. `docs/durable-object-alarms.md` is the module document.
 */
import { asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");

const SCHEDULE_ALARM_VERSION = 4;
const BOOTSTRAP_VERSION = 5;
const RESOURCE_VERSIONING_VERSION = 13;
const VERSION_PROVENANCE_VERSION = 18;
const RESOURCE_SLUG_VERSION = 19;
const DRAFT_RESERVATION_VERSION = 20;
const RESOURCE_PUBLICATION_FENCE_VERSION = 21;
const OPENROUTER_MEMORY_EMBEDDING_VERSION = 23;
const ARTIFACT_REGISTRY_VERSION = 28;
const ARTIFACT_HOSTNAME_VERSION = 29;
const RANKING_PENDING_DUE_VERSION = 30;
/** The Thread-owned (`workstream`) Sidekick scope is retired. */
const SIDEKICK_SCOPE_RETIREMENT_VERSION = 137;

/** Apply the ledger's versions in `(after, through]`, the way a deploy does. */
function apply(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function seedIdentity(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
}

function bootstrapEntries(database: DatabaseSync): { alarm_key: string; due_at: number }[] {
  return database.prepare(
    `SELECT alarm_key, due_at FROM _internal_durable_alarms WHERE kind = 'schedule_bootstrap'`,
  ).all() as { alarm_key: string; due_at: number }[];
}

describe("the WorkspaceDO alarm migrations", () => {
  it("wakes only existing active configured Sidekicks when delegated source reconciliation is installed", () => {
    const database = new DatabaseSync(":memory:");
    try {
      apply(database, 129);
      seedIdentity(database);
      for (const [id, lifecycle] of [["00000000-0000-7000-8000-000000001301", "active"],
        ["00000000-0000-7000-8000-000000001302", "paused"], ["00000000-0000-7000-8000-000000001303", "active"]]) {
        database.prepare(`INSERT INTO automation_directory
          (automation_id,workspace_id,author_user_id,source_version,payload_hash,lifecycle,scope,title,description,projected_at)
          VALUES (?,?,'00000000-0000-7000-8000-000000001304',1,'source-fixture',?,'workspace','Source','Source',1)`).run(id!, WORKSPACE_ID, lifecycle!);
      }
      database.prepare("UPDATE automation_directory SET region='global',evaluator_projection_json=?").run(JSON.stringify([{
        evaluatorId: "00000000-0000-7000-8000-000000001305", source: { connectorType: "google",
          connectionId: "00000000-0000-7000-8000-000000001306", eventType: "sheets.spreadsheet_changed" }, when: { kind: "always" },
      }]));
      database.exec("UPDATE automation_directory SET evaluator_projection_json='[]' WHERE automation_id='00000000-0000-7000-8000-000000001303'");
      apply(database, 130, 129);
      const wakes = database.prepare(`SELECT substr(alarm_key,1,instr(alarm_key,':')-1) AS sidekick
        FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources'`).all();
      expect(wakes).toEqual([{ sidekick: "00000000-0000-7000-8000-000000001301" }]);
      expect(database.prepare("SELECT count(*) AS count FROM automation_directory").get()).toEqual({ count: 3 });
    } finally { database.close(); }
  });

  it("reconciles a workspace that already existed when the scheduler was deleted", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    const before = Date.now();
    // The order a deployed object actually sees: version 4 shipped in its own
    // release, so this object holds that release's identity row before the
    // bootstrap version exists at all.
    apply(database, SCHEDULE_ALARM_VERSION);
    seedIdentity(database);

    apply(database, BOOTSTRAP_VERSION, SCHEDULE_ALARM_VERSION);

    const entries = bootstrapEntries(database);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.alarm_key).toBe("workspace");
    // Immediate: the object it belongs to may have no other reason to wake.
    expect(entries[0]!.due_at).toBeGreaterThanOrEqual(before - 1_000);
    expect(entries[0]!.due_at).toBeLessThanOrEqual(Date.now() + 1_000);
  });

  it("leaves a workspace created after the deletion nothing to reconcile", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");

    // A new object runs its whole ledger before it has an identity, so there is
    // nothing for a reconcile to find and no wake-up to pay for.
    apply(database, BOOTSTRAP_VERSION);

    expect(bootstrapEntries(database)).toEqual([]);
  });

  it("keeps the bootstrap out of the version that shipped without it", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, SCHEDULE_ALARM_VERSION - 1);
    seedIdentity(database);

    apply(database, SCHEDULE_ALARM_VERSION, SCHEDULE_ALARM_VERSION - 1);

    // Version 4 is released. Adding a statement to it changes the hash every
    // deployed object recorded and emits `workspace_do_schema_hash_mismatch:4`;
    // it still cannot make an old schema gain the new statement.
    expect(bootstrapEntries(database)).toEqual([]);
  });
});

describe("the WorkspaceDO context-suggestion retirement", () => {
  it("drops the feedback projection when version 25 applies", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 24);
    expect(database.prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'workspace_workstream_suggestion_feedback'`,
    ).get()).toEqual({ name: "workspace_workstream_suggestion_feedback" });

    apply(database, 25, 24);

    expect(database.prepare(
      `SELECT name FROM sqlite_schema
        WHERE type = 'table' AND name = 'workspace_workstream_suggestion_feedback'`,
    ).get()).toBeUndefined();
  });
});

describe("the WorkspaceDO automation-ownership migration", () => {
  /** A directory row and its viewer overlay, as version 25 leaves them. */
  function seedProjectedAutomation(database: DatabaseSync): void {
    // The workspace-identity triggers refuse a row for another workspace, so
    // the object has to know which one it is before anything is written.
    seedIdentity(database);
    database.exec(`INSERT INTO automation_directory
      (automation_id, workspace_id, author_user_id, authority_generation, projection_version,
       payload_hash, lifecycle, scope, title, description, next_run_at, attention_code, projected_at)
     VALUES ('automation-1', '${WORKSPACE_ID}', 'user-1', 1, 1, 'sha256:one', 'active',
             'workspace', 'Weekly changelog', 'Posts the changelog.', NULL, NULL, 1)`);
    database.exec(`INSERT INTO workspace_workstream_directory
      (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title,
       description, preview, scope, exact_state, last_activity_at, origin_type, title_status,
       latest_attention_ordinal, unread_tracking_start_ordinal,
       source_created_at, source_updated_at, projected_at)
     VALUES ('workstream-1', 1, 1, 'event-1', 'sha256:two', 'A run', '', '', 'personal',
             'idle', 1, 'automation', 'settled', 0, 0, 1, 1, 1)`);
  }

  it("carries every projected automation across the rebuild, owning nothing", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 25);
    seedProjectedAutomation(database);

    apply(database, 27, 25);

    // The rebuild is create-copy-drop-rename. What matters is that the rows
    // survive it and that the scratch name does not: a rebuild that left the
    // temporary table behind would pass a fresh-schema test and leave every
    // upgraded object with two directories.
    expect(database.prepare(
      `SELECT automation_id, scope, owning_workstream_id, title FROM automation_directory`,
    ).all()).toEqual([{
      automation_id: "automation-1",
      scope: "workspace",
      owning_workstream_id: null,
      title: "Weekly changelog",
    }]);
    expect(database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'automation_directory_v27'`,
    ).get()).toBeUndefined();
    // Recreated after the rename: the sidebar reads this table on every open,
    // and a rebuild that dropped its index would be a silent full scan.
    expect(database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'automation_directory'
         AND sql IS NOT NULL
        ORDER BY name`,
    ).all().map((row) => (row as { name: string }).name)).toEqual([
      "automation_directory_sidebar_idx",
      "automation_directory_workstream_idx",
    ]);
    // SQLite drops a table's triggers with the table. A rebuild that restored
    // only the indexes left every upgraded object without the one guard that
    // refuses a row from another workspace, while a fresh object kept it —
    // asserted here because the index assertion above passed throughout.
    expect(database.prepare(
      `SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'automation_directory'
        ORDER BY name`,
    ).all().map((row) => (row as { name: string }).name)).toEqual([
      "automation_directory_workspace_identity_insert",
      "automation_directory_workspace_identity_update",
    ]);
  });

  it("admits a room's automation and refuses one that owns a room without saying so", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 27);
    // The rebuild recreates the workspace-identity guard, so a directory row
    // needs an identity to belong to.
    seedIdentity(database);

    database.exec(`INSERT INTO automation_directory
      (automation_id, workspace_id, author_user_id, authority_generation, projection_version,
       payload_hash, lifecycle, scope, owning_workstream_id, title, description,
       next_run_at, attention_code, projected_at)
     VALUES ('automation-2', '${WORKSPACE_ID}', 'user-1', 1, 1, 'sha256:three', 'active',
             'workstream', 'workstream-1', 'Monday agenda', 'Builds the agenda.', NULL, NULL, 1)`);

    // The scope names the room, so the two cannot disagree: a `workstream`
    // automation without one, or any other scope with one, is not a row this
    // table will hold.
    expect(() => database.exec(`INSERT INTO automation_directory
      (automation_id, workspace_id, author_user_id, authority_generation, projection_version,
       payload_hash, lifecycle, scope, owning_workstream_id, title, description,
       next_run_at, attention_code, projected_at)
     VALUES ('automation-3', '${WORKSPACE_ID}', 'user-1', 1, 1, 'sha256:four', 'active',
             'workstream', NULL, 'Nameless', '', NULL, NULL, 1)`)).toThrow();
    expect(() => database.exec(`INSERT INTO automation_directory
      (automation_id, workspace_id, author_user_id, authority_generation, projection_version,
       payload_hash, lifecycle, scope, owning_workstream_id, title, description,
       next_run_at, attention_code, projected_at)
     VALUES ('automation-4', '${WORKSPACE_ID}', 'user-1', 1, 1, 'sha256:five', 'active',
             'personal', 'workstream-1', 'Mine', '', NULL, NULL, 1)`)).toThrow();
  });

  it("starts every existing run's work stream hidden", () => {
    const database = new DatabaseSync(":memory:");
    apply(database, 25);
    seedProjectedAutomation(database);

    apply(database, 27, 25);

    // The column exists so a run can be *made* visible; nothing that already
    // ran becomes visible because the column arrived.
    expect(database.prepare(
      `SELECT automation_exposed FROM workspace_workstream_directory WHERE workstream_id = 'workstream-1'`,
    ).get()).toEqual({ automation_exposed: 0 });
  });
});

describe("the WorkspaceDO resource-version migration", () => {
  it("backfills history, increments semantic writes, and retains every R2 reference until deletion", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, RESOURCE_VERSIONING_VERSION - 1);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          metadata_json, last_hydrated_at, model_content_ref, model_content_status,
          created_at, updated_at)
       VALUES ('resource-1', ?, 'document', 'fixture', 'First', 'text/plain',
               'r2/original-1', '{"size":5}', '2026-08-27T01:00:00.000Z',
               'r2/model-1', 'ready', '2026-08-27T01:00:00.000Z', '2026-08-27T01:00:00.000Z')`,
    ).run(WORKSPACE_ID);

    apply(database, RESOURCE_VERSIONING_VERSION, RESOURCE_VERSIONING_VERSION - 1);
    expect(database.prepare(
      "SELECT current_version FROM resources WHERE id = 'resource-1'",
    ).get()).toEqual({ current_version: 1 });
    expect(database.prepare(
      "SELECT version, content_ref, model_content_ref FROM resource_versions WHERE resource_id = 'resource-1'",
    ).all()).toEqual([{ version: 1, content_ref: "r2/original-1", model_content_ref: "r2/model-1" }]);

    database.exec(
      `UPDATE resources
          SET title = 'Second', content_ref = 'r2/original-2', model_content_ref = NULL,
              model_content_status = 'pending', metadata_json = '{"size":6}',
              last_hydrated_at = '2026-08-27T02:00:00.000Z', updated_at = '2026-08-27T02:00:00.000Z'
        WHERE id = 'resource-1'`,
    );
    database.exec(
      `UPDATE resources
          SET model_content_ref = 'r2/model-2', model_content_status = 'ready',
              updated_at = '2026-08-27T02:01:00.000Z'
        WHERE id = 'resource-1'`,
    );
    expect(database.prepare(
      "SELECT current_version FROM resources WHERE id = 'resource-1'",
    ).get()).toEqual({ current_version: 2 });
    expect(database.prepare(
      `SELECT version, title, content_ref, model_content_ref
         FROM resource_versions WHERE resource_id = 'resource-1' ORDER BY version`,
    ).all()).toEqual([
      { version: 1, title: "First", content_ref: "r2/original-1", model_content_ref: "r2/model-1" },
      { version: 2, title: "Second", content_ref: "r2/original-2", model_content_ref: "r2/model-2" },
    ]);

    // A successful external refresh is a new observation even if it resolves
    // to the same bytes, so last_hydrated_at deliberately advances history.
    database.exec(
      `UPDATE resources
          SET last_hydrated_at = '2026-08-27T03:00:00.000Z',
              model_content_ref = 'r2/model-3', model_content_status = 'ready',
              updated_at = '2026-08-27T03:00:00.000Z'
        WHERE id = 'resource-1'`,
    );
    expect(database.prepare(
      "SELECT current_version FROM resources WHERE id = 'resource-1'",
    ).get()).toEqual({ current_version: 3 });
    expect(database.prepare(
      `SELECT version, model_content_ref
         FROM resource_versions WHERE resource_id = 'resource-1' ORDER BY version`,
    ).all()).toEqual([
      { version: 1, model_content_ref: "r2/model-1" },
      { version: 2, model_content_ref: "r2/model-2" },
      { version: 3, model_content_ref: "r2/model-3" },
    ]);

    database.exec("DELETE FROM resources WHERE id = 'resource-1'");
    expect(database.prepare(
      "SELECT object_ref FROM resource_object_deletion_outbox ORDER BY object_ref",
    ).all()).toEqual([
      { object_ref: "r2/model-1" },
      { object_ref: "r2/model-2" },
      { object_ref: "r2/model-3" },
      { object_ref: "r2/original-1" },
      { object_ref: "r2/original-2" },
    ]);
  });
});

describe("the WorkspaceDO resource-publication fence migration", () => {
  it("keeps existing cleanup rows eligible and permits an in-flight staged row", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, RESOURCE_PUBLICATION_FENCE_VERSION - 1);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
       VALUES ('r2/existing', ?, 'resource-old', 'original', '2026-08-28', '2026-08-28')`,
    ).run(WORKSPACE_ID);

    apply(
      database,
      RESOURCE_PUBLICATION_FENCE_VERSION,
      RESOURCE_PUBLICATION_FENCE_VERSION - 1,
    );
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_ref = 'r2/existing'",
    ).get()).toEqual({ cleanup_eligible: 1 });

    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES ('r2/staged', ?, 'resource-new', 'original', 0, '2026-08-28', '2026-08-28')`,
    ).run(WORKSPACE_ID);
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_ref = 'r2/staged'",
    ).get()).toEqual({ cleanup_eligible: 0 });

    expect(() => database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES ('r2/invalid', ?, 'resource-invalid', 'original', 2, '2026-08-28', '2026-08-28')`,
    ).run(WORKSPACE_ID)).toThrow(/CHECK constraint failed/u);

    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          metadata_json, attachment_status, created_at, updated_at)
       VALUES ('resource-new', ?, 'generated_file', 'avalon_generated', 'Staged',
               'text/plain', 'r2/staged', '{}', 'attached', '2026-08-28', '2026-08-28')`,
    ).run(WORKSPACE_ID);
    // A resource can be deleted before maintenance observes that its staged
    // pointer committed. The older enqueue trigger uses INSERT OR IGNORE, so
    // migration 21's promotion trigger must transfer the existing row to the
    // reaper instead of leaving it fenced forever.
    database.exec("DELETE FROM resources WHERE id = 'resource-new'");
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_ref = 'r2/staged'",
    ).get()).toEqual({ cleanup_eligible: 1 });
  });

  it("promotes staged ownership when pointers are replaced or history is deleted", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, RESOURCE_PUBLICATION_FENCE_VERSION);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          model_content_ref, metadata_json, attachment_status, created_at, updated_at)
       VALUES ('resource-replaced', ?, 'generated_file', 'avalon_generated', 'Replaced',
               'text/plain', 'r2/original-old', 'r2/model-old', '{}', 'attached',
               '2026-08-28', '2026-08-28')`,
    ).run(WORKSPACE_ID);
    const stage = database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES (?, ?, 'resource-replaced', ?, 0, '2026-08-28', '2026-08-28')`,
    );
    stage.run("r2/original-old", WORKSPACE_ID, "original");
    stage.run("r2/model-old", WORKSPACE_ID, "derivative");

    database.exec(
      `UPDATE resources
          SET content_ref = 'r2/original-new', model_content_ref = 'r2/model-new',
              updated_at = '2026-08-29'
        WHERE id = 'resource-replaced'`,
    );
    expect(database.prepare(
      `SELECT object_ref, cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref IN ('r2/original-old', 'r2/model-old') ORDER BY object_ref`,
    ).all()).toEqual([
      { object_ref: "r2/model-old", cleanup_eligible: 1 },
      { object_ref: "r2/original-old", cleanup_eligible: 1 },
    ]);

    database.prepare(
      `INSERT INTO resource_object_deletion_outbox
         (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
       VALUES ('r2/history-only', ?, 'resource-replaced', 'original', 0,
               '2026-08-28', '2026-08-28')`,
    ).run(WORKSPACE_ID);
    database.exec(
      `UPDATE resource_versions SET content_ref = 'r2/history-only'
        WHERE resource_id = 'resource-replaced' AND version = 1`,
    );
    database.exec(
      "DELETE FROM resource_versions WHERE resource_id = 'resource-replaced' AND version = 1",
    );
    expect(database.prepare(
      `SELECT cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref = 'r2/history-only'`,
    ).get()).toEqual({ cleanup_eligible: 1 });
    database.close();
  });
});

describe("the WorkspaceDO version-provenance migration", () => {
  it("leaves pre-provenance history unattributed and attributes every capture after it", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, VERSION_PROVENANCE_VERSION - 1);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          metadata_json, created_at, updated_at)
       VALUES ('resource-1', ?, 'generated_file', 'avalon_generated', 'Draft', 'text/markdown',
               'r2/original-1', '{}', '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z')`,
    ).run(WORKSPACE_ID);
    database.exec(
      `UPDATE resources SET content_ref = 'r2/original-2', updated_at = '2026-08-28T02:00:00.000Z'
        WHERE id = 'resource-1'`,
    );

    apply(database, VERSION_PROVENANCE_VERSION, VERSION_PROVENANCE_VERSION - 1);
    // History captured before provenance existed says so rather than claiming
    // an author the migration would have to invent. Its objects are ordinary
    // bucket objects, which the migration does know.
    expect(database.prepare(
      `SELECT version, author_kind, author_run_id, cause, storage_kind
         FROM resource_versions WHERE resource_id = 'resource-1' ORDER BY version`,
    ).all()).toEqual([
      { version: 1, author_kind: null, author_run_id: null, cause: null, storage_kind: "object" },
      { version: 2, author_kind: null, author_run_id: null, cause: null, storage_kind: "object" },
    ]);

    database.exec(
      `UPDATE resources
          SET content_ref = 'r2/original-3', updated_at = '2026-08-28T03:00:00.000Z',
              revision_author_kind = 'agent', revision_author_run_id = 'run-7',
              revision_cause = 'published'
        WHERE id = 'resource-1'`,
    );
    expect(database.prepare(
      `SELECT version, author_kind, author_run_id, author_user_id, author_connection_id,
              cause, storage_kind
         FROM resource_versions WHERE resource_id = 'resource-1' AND version = 3`,
    ).get()).toEqual({
      version: 3,
      author_kind: "agent",
      author_run_id: "run-7",
      author_user_id: null,
      author_connection_id: null,
      cause: "published",
      storage_kind: "object",
    });

    // The seam is staged, not assumed: a producer whose refs are a different
    // shape says so on the swap, and capture records what it said rather than
    // the only value that exists today.
    database.exec(
      `UPDATE resources
          SET content_ref = 'editor/snapshot-1', updated_at = '2026-08-28T04:00:00.000Z',
              revision_storage_kind = 'editor_snapshot'
        WHERE id = 'resource-1'`,
    );
    expect(database.prepare(
      "SELECT storage_kind FROM resource_versions WHERE resource_id = 'resource-1' AND version = 4",
    ).get()).toEqual({ storage_kind: "editor_snapshot" });
    // And it is released with the rest, so the next capture is an object again
    // rather than inheriting a shape nobody claimed.
    database.exec(
      `UPDATE resources SET content_ref = 'r2/original-5',
              updated_at = '2026-08-28T05:00:00.000Z' WHERE id = 'resource-1'`,
    );
    expect(database.prepare(
      "SELECT storage_kind FROM resource_versions WHERE resource_id = 'resource-1' AND version = 5",
    ).get()).toEqual({ storage_kind: "object" });
  });

  it("attributes a resource's first version from the row that created it", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, VERSION_PROVENANCE_VERSION);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, title, content_ref,
          metadata_json, created_at, updated_at,
          revision_author_kind, revision_author_connection_id, revision_cause)
       VALUES ('resource-2', ?, 'connection-1', 'document', 'notion', 'Spec', 'r2/original-1',
               '{}', '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z',
               'connector', 'connection-1', 'created')`,
    ).run(WORKSPACE_ID);
    expect(database.prepare(
      `SELECT version, author_kind, author_connection_id, cause
         FROM resource_versions WHERE resource_id = 'resource-2'`,
    ).all()).toEqual([
      { version: 1, author_kind: "connector", author_connection_id: "connection-1", cause: "created" },
    ]);
  });

  it("attributes only the swap that staged an author, never the writes after it", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, VERSION_PROVENANCE_VERSION);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, connection_id, resource_type, provider, title, content_ref,
          metadata_json, created_at, updated_at,
          revision_author_kind, revision_author_connection_id, revision_cause)
       VALUES ('resource-4', ?, 'connection-1', 'document', 'notion', 'Spec', 'r2/original-1',
               '{}', '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z',
               'connector', 'connection-1', 'created')`,
    ).run(WORKSPACE_ID);

    // A writer that stages nothing: the derivative service healing a hash, a
    // provider webhook renaming a page, the origin backfill. Each of these
    // captures a version, and none of them knows an author.
    database.exec(
      `UPDATE resources SET canonical_url = 'https://notion.test/spec',
              updated_at = '2026-08-28T02:00:00.000Z'
        WHERE id = 'resource-4'`,
    );

    expect(database.prepare(
      `SELECT version, author_kind, author_connection_id, cause
         FROM resource_versions WHERE resource_id = 'resource-4' ORDER BY version`,
    ).all()).toEqual([
      { version: 1, author_kind: "connector", author_connection_id: "connection-1", cause: "created" },
      // Not the connector, and not "created": nothing recorded who did this,
      // and saying so is the whole point of recording provenance at all.
      { version: 2, author_kind: null, author_connection_id: null, cause: null },
    ]);
    // The row itself stops claiming an author once its capture has read one.
    expect(database.prepare(
      "SELECT revision_author_kind, revision_cause FROM resources WHERE id = 'resource-4'",
    ).get()).toEqual({ revision_author_kind: null, revision_cause: null });
  });

  it("refuses a capture whose author identity does not match its kind", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, VERSION_PROVENANCE_VERSION);
    seedIdentity(database);
    const insert = (kind: string, column: string, value: string): void => {
      database.prepare(
        `INSERT INTO resources
           (id, workspace_id, resource_type, provider, title, metadata_json,
            created_at, updated_at, revision_author_kind, ${column}, revision_cause)
         VALUES ('resource-3', ?, 'document', 'notion', 'Spec', '{}',
                 '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z', ?, ?, 'created')`,
      ).run(WORKSPACE_ID, kind, value);
    };
    // An agent author identified by a user, a connector author identified by a
    // run: each names an identity its kind cannot have, and attribution the
    // rail would render as fact is not somewhere to discover that later.
    expect(() => insert("agent", "revision_author_user_id", "user-1"))
      .toThrow(/resource_version_provenance_mismatch/u);
    expect(() => insert("connector", "revision_author_run_id", "run-1"))
      .toThrow(/resource_version_provenance_mismatch/u);
    expect(() => insert("system", "revision_author_user_id", "user-1"))
      .toThrow(/resource_version_provenance_mismatch/u);
  });
});

describe("the WorkspaceDO resource-slug migration", () => {
  it("holds one slug per resource without making an alias a new version", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, RESOURCE_SLUG_VERSION - 1);
    seedIdentity(database);
    const insert = database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, content_ref, metadata_json,
          created_at, updated_at)
       VALUES (?, ?, 'document', 'notion', 'Spec', 'r2/original-1', '{}',
               '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z')`,
    );
    insert.run("resource-1", WORKSPACE_ID);
    insert.run("resource-2", WORKSPACE_ID);

    apply(database, RESOURCE_SLUG_VERSION, RESOURCE_SLUG_VERSION - 1);
    // Rows that predate the alias have none; nothing in SQL can mint one,
    // so the column says so and a bounded pass fills them in.
    expect(database.prepare("SELECT id, slug FROM resources ORDER BY id").all()).toEqual([
      { id: "resource-1", slug: null },
      { id: "resource-2", slug: null },
    ]);

    database.exec("UPDATE resources SET slug = 'amber-crisp-lucid-lantern' WHERE id = 'resource-1'");
    // Two resources without an alias are not two resources with the same one:
    // the partial index leaves the nulls alone and still refuses a duplicate.
    expect(() => database.exec(
      "UPDATE resources SET slug = 'amber-crisp-lucid-lantern' WHERE id = 'resource-2'",
    )).toThrow(/UNIQUE constraint failed/u);

    // Naming a resource is not a new state of its content, so allocating one
    // must not push a version into the history the rail lists.
    expect(database.prepare(
      "SELECT current_version FROM resources WHERE id = 'resource-1'",
    ).get()).toEqual({ current_version: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resource_versions WHERE resource_id = 'resource-1'",
    ).get()).toEqual({ count: 1 });
  });
});

describe("the WorkspaceDO pending attachment reservation migration", () => {
  it("makes a pending reservation a database-level deletion fence", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, DRAFT_RESERVATION_VERSION);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, metadata_json,
          uploaded_by_user_id, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'document', 'avalon_upload', 'Pending', '{}', ?, 'draft', ?, ?)`,
    ).run(
      "00000000-0000-7000-8000-0000000000b1",
      WORKSPACE_ID,
      "00000000-0000-7000-8000-0000000000b2",
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
    );
    database.prepare(
      `INSERT INTO pending_attachment_reservations
         (workspace_id, workstream_id, input_id, resource_id, user_id, created_at)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(
      WORKSPACE_ID,
      "00000000-0000-7000-8000-0000000000b3",
      "00000000-0000-7000-8000-0000000000b4",
      "00000000-0000-7000-8000-0000000000b1",
      "00000000-0000-7000-8000-0000000000b2",
    );

    expect(() => database.exec(
      "DELETE FROM resources WHERE id = '00000000-0000-7000-8000-0000000000b1'",
    )).toThrow();
    expect(database.prepare(
      `SELECT id FROM resources
        WHERE attachment_status = 'draft'
          AND NOT EXISTS (
            SELECT 1 FROM pending_attachment_reservations reservation
             WHERE reservation.resource_id = resources.id
          )`,
    ).all()).toEqual([]);

    database.exec(
      "DELETE FROM pending_attachment_reservations WHERE input_id = '00000000-0000-7000-8000-0000000000b4'",
    );
    database.exec("DELETE FROM resources WHERE id = '00000000-0000-7000-8000-0000000000b1'");
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 0 });
    database.close();
  });
});

describe("the WorkspaceDO memory-embedding migration", () => {
  it("requeues only current active memories and wakes an existing workspace", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, OPENROUTER_MEMORY_EMBEDDING_VERSION - 1);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO memory_scopes
         (memory_scope_id, workspace_id, kind, owner_id, created_at)
       VALUES ('scope-1', ?, 'workspace', ?, '2026-08-27T00:00:00.000Z')`,
    ).run(WORKSPACE_ID, WORKSPACE_ID);
    database.exec(
      `INSERT INTO memory_items
         (memory_item_id, memory_scope_id, workspace_id, text, revision, expires_at,
          provenance_json, invalidated_at, invalidated_by_principal_json,
          invalidation_reason, last_mutation_id, created_at, updated_at)
       VALUES
         ('active', 'scope-1', '${WORKSPACE_ID}', 'active memory', 2, NULL,
          '{}', NULL, NULL, NULL, 'mutation-active', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
         ('invalidated', 'scope-1', '${WORKSPACE_ID}', 'invalidated memory', 1, NULL,
          '{}', '2026-08-27T00:00:00.000Z', '{}', 'retired', 'mutation-invalid',
          '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z'),
         ('expired', 'scope-1', '${WORKSPACE_ID}', 'expired memory', 1, '2020-01-01T00:00:00.000Z',
          '{}', NULL, NULL, NULL, 'mutation-expired', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')`,
    );
    database.exec(
      `INSERT INTO memory_index_outbox
         (outbox_id, memory_item_id, memory_scope_id, workspace_id, revision,
          operation, status, attempt_count, available_at, completed_at, created_at, updated_at)
       VALUES
         ('outbox-active', 'active', 'scope-1', '${WORKSPACE_ID}', 2, 'upsert',
          'completed', 3, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z',
          '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z'),
         ('outbox-invalid', 'invalidated', 'scope-1', '${WORKSPACE_ID}', 1, 'upsert',
          'completed', 1, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z',
          '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z'),
         ('outbox-expired', 'expired', 'scope-1', '${WORKSPACE_ID}', 1, 'upsert',
          'completed', 1, '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z',
          '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:01.000Z')`,
    );

    apply(database, OPENROUTER_MEMORY_EMBEDDING_VERSION, OPENROUTER_MEMORY_EMBEDDING_VERSION - 1);

    expect(database.prepare(
      `SELECT memory_item_id, status, attempt_count, completed_at
         FROM memory_index_outbox ORDER BY memory_item_id`,
    ).all()).toEqual([
      { memory_item_id: "active", status: "pending", attempt_count: 0, completed_at: null },
      { memory_item_id: "expired", status: "completed", attempt_count: 1, completed_at: "2026-08-27T00:00:01.000Z" },
      { memory_item_id: "invalidated", status: "completed", attempt_count: 1, completed_at: "2026-08-27T00:00:01.000Z" },
    ]);
    expect(bootstrapEntries(database)).toHaveLength(1);
  });
});

describe("the WorkspaceDO artifact-hostname migration", () => {
  it("keeps old artifacts nullable, then freezes a valid four-word stub", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, ARTIFACT_REGISTRY_VERSION);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
       VALUES ('resource-1', ?, 'generated_site', 'avalon_generated', 'Site', '{}',
               '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    ).run(WORKSPACE_ID);
    database.prepare(
      `INSERT INTO artifact_registry
         (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful,
          current_version, manifest_ref, created_at, updated_at)
       VALUES ('artifact-1', ?, 'workstream-1', 'resource-1', 'static', 0,
               1, 'artifact/artifact-1/v1/manifest.json', 1, 1)`,
    ).run(WORKSPACE_ID);

    apply(database, ARTIFACT_HOSTNAME_VERSION, ARTIFACT_REGISTRY_VERSION);
    expect(database.prepare(
      "SELECT hostname_stub FROM artifact_registry WHERE artifact_id = 'artifact-1'",
    ).get()).toEqual({ hostname_stub: null });

    database.exec(
      "UPDATE artifact_registry SET hostname_stub = 'level-luminous-sequential-schrodinger' WHERE artifact_id = 'artifact-1'",
    );
    expect(() => database.exec(
      "UPDATE artifact_registry SET hostname_stub = 'another-readable-origin-stub' WHERE artifact_id = 'artifact-1'",
    )).toThrow(/immutable/iu);
    // SQLite's `IS NOT` is deliberately null-safe: unlike `!=`, this also
    // rejects clearing a value that has already become the public origin.
    expect(() => database.exec(
      "UPDATE artifact_registry SET hostname_stub = NULL WHERE artifact_id = 'artifact-1'",
    )).toThrow(/immutable/iu);
    expect(() => database.exec(
      "INSERT INTO artifact_registry (artifact_id, workspace_id, workstream_id, resource_id, mode, stateful, current_version, manifest_ref, hostname_stub, created_at, updated_at) VALUES ('artifact-2', 'wrong', 'workstream-2', 'resource-1', 'static', 0, 1, 'x', 'only-three-words', 1, 1)",
    )).toThrow();
    database.close();
  });
});

describe("the WorkspaceDO ranking-request parking column", () => {
  it("adds `pending_due_at` to a set that already exists, unset", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, RANKING_PENDING_DUE_VERSION - 1);
    database.prepare(
      `INSERT INTO suggested_work_sets (
        user_id, candidate_fingerprint, opportunity_ids_json, ranking_reasoning,
        model, status, due_at, request_seq, lease_id, lease_expires_at,
        last_ranked_at, created_at, updated_at
      ) VALUES (?, 'f', '[]', '', NULL, 'stale', 100, 3, NULL, NULL, NULL, 0, 0)`,
    ).run("00000000-0000-7000-8000-0000000000b1");

    apply(database, RANKING_PENDING_DUE_VERSION, RANKING_PENDING_DUE_VERSION - 1);

    // A deployed object upgrades with its rows and their scheduling state
    // intact; the new column is only ever written while a pass holds a lease.
    expect(database.prepare(
      `SELECT user_id, due_at, request_seq, pending_due_at FROM suggested_work_sets`,
    ).all()).toEqual([{
      user_id: "00000000-0000-7000-8000-0000000000b1",
      due_at: 100,
      request_seq: 3,
      pending_due_at: null,
    }]);
  });
});

describe("the WorkspaceDO hosted-Sidekick migration", () => {
  const HOSTED_SIDEKICK_VERSION = 91;

  it("keeps every directory row and enrols each one for import", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, HOSTED_SIDEKICK_VERSION - 1);
    seedIdentity(database);
    const insert = database.prepare(
      `INSERT INTO automation_directory
         (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
          owning_workstream_id, title, description, next_run_at, projected_at)
       VALUES (?, ?, ?, 3, 'h', ?, ?, ?, ?, '', ?, 7)`,
    );
    insert.run("00000000-0000-7000-8000-0000000000c1", WORKSPACE_ID, "00000000-0000-7000-8000-0000000000c3",
      "active", "workspace", null, "Morning briefing", 1_000);
    insert.run("00000000-0000-7000-8000-0000000000c2", WORKSPACE_ID, "00000000-0000-7000-8000-0000000000c3",
      "paused", "workstream", "00000000-0000-7000-8000-0000000000c4", "Call prep", null);

    apply(database, HOSTED_SIDEKICK_VERSION, HOSTED_SIDEKICK_VERSION - 1);

    // What the legacy object published survives as it was; the definition
    // columns stay empty until the import writes them, and `region` unset is
    // what lets a late legacy copy still land.
    expect(database.prepare(
      `SELECT automation_id, lifecycle, scope, owning_workstream_id, title, next_run_at, source_version,
              region, paused_by, accepted_definition_revision, authority_generation
         FROM automation_directory ORDER BY automation_id`,
    ).all()).toEqual([
      { automation_id: "00000000-0000-7000-8000-0000000000c1", lifecycle: "active", scope: "workspace",
        owning_workstream_id: null, title: "Morning briefing", next_run_at: 1_000, source_version: 3,
        region: null, paused_by: null, accepted_definition_revision: null, authority_generation: null },
      { automation_id: "00000000-0000-7000-8000-0000000000c2", lifecycle: "paused", scope: "workstream",
        owning_workstream_id: "00000000-0000-7000-8000-0000000000c4", title: "Call prep", next_run_at: null,
        source_version: 3, region: null, paused_by: null, accepted_definition_revision: null,
        authority_generation: null },
    ]);
    expect(database.prepare(
      `SELECT sidekick_id, state, attempts, not_before, imported_at FROM sidekick_imports ORDER BY sidekick_id`,
    ).all()).toEqual([
      { sidekick_id: "00000000-0000-7000-8000-0000000000c1", state: "pending", attempts: 0, not_before: 0, imported_at: null },
      { sidekick_id: "00000000-0000-7000-8000-0000000000c2", state: "pending", attempts: 0, not_before: 0, imported_at: null },
    ]);
    // The tables a hosted Sidekick writes exist, empty.
    for (const table of ["sidekick_revisions", "sidekick_schedules", "sidekick_runs", "sidekick_children"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("drops the import ledger once the legacy class is gone, and keeps every Sidekick", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, HOSTED_SIDEKICK_VERSION);
    seedIdentity(database);
    database.prepare(
      `INSERT INTO automation_directory
         (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
          owning_workstream_id, title, description, next_run_at, projected_at, region)
       VALUES (?, ?, ?, 3, 'h', 'active', 'workspace', NULL, 'Morning briefing', '', NULL, 7, 'global')`,
    ).run("00000000-0000-7000-8000-0000000000c1", WORKSPACE_ID, "00000000-0000-7000-8000-0000000000c3");
    database.prepare(`INSERT INTO sidekick_imports (sidekick_id, state) VALUES (?, 'imported')`)
      .run("00000000-0000-7000-8000-0000000000c1");

    apply(database, HOSTED_SIDEKICK_VERSION + 1, HOSTED_SIDEKICK_VERSION);

    expect(database.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'sidekick_imports%'`).all()).toEqual([]);
    expect(database.prepare(`SELECT automation_id, title, region FROM automation_directory`).all()).toEqual([
      { automation_id: "00000000-0000-7000-8000-0000000000c1", title: "Morning briefing", region: "global" },
    ]);
  });

  it("turns every Thread-owned Sidekick into an Organization one, and archives one a room archive paused", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    apply(database, SIDEKICK_SCOPE_RETIREMENT_VERSION - 1);
    seedIdentity(database);
    const insert = database.prepare(
      `INSERT INTO automation_directory
         (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, paused_by, scope,
          owning_workstream_id, owning_substream_id, owning_room_archived_at, title, description, next_run_at,
          projected_at, region)
       VALUES (?, ?, ?, 1, 'h', ?, ?, ?, ?, ?, ?, ?, '', NULL, 1, 'global')`,
    );
    const author = "00000000-0000-7000-8000-0000000000c3";
    const room = "00000000-0000-7000-8000-0000000000d1";
    insert.run("00000000-0000-7000-8000-0000000000c1", WORKSPACE_ID, author, "active", null, "workstream",
      room, "00000000-0000-7000-8000-0000000000d2", null, "Breakout helper");
    insert.run("00000000-0000-7000-8000-0000000000c2", WORKSPACE_ID, author, "paused", "room_archive", "workstream",
      room, "0", 5, "Archived with its room");
    insert.run("00000000-0000-7000-8000-0000000000c4", WORKSPACE_ID, author, "active", null, "personal",
      null, "0", null, "Mine");
    // A draft that carries a room archive's marker was terminal under the old rule as well.
    insert.run("00000000-0000-7000-8000-0000000000c5", WORKSPACE_ID, author, "draft", null, "workstream",
      room, "0", 7, "Draft archived with its room");

    apply(database, SIDEKICK_SCOPE_RETIREMENT_VERSION, SIDEKICK_SCOPE_RETIREMENT_VERSION - 1);

    expect(database.prepare(
      `SELECT title, lifecycle, paused_by, scope, owning_workstream_id, owning_substream_id
         FROM automation_directory ORDER BY automation_id`,
    ).all()).toEqual([
      { title: "Breakout helper", lifecycle: "active", paused_by: null, scope: "workspace", owning_workstream_id: null, owning_substream_id: "0" },
      { title: "Archived with its room", lifecycle: "deleted", paused_by: null, scope: "workspace", owning_workstream_id: null, owning_substream_id: "0" },
      { title: "Mine", lifecycle: "active", paused_by: null, scope: "personal", owning_workstream_id: null, owning_substream_id: "0" },
      { title: "Draft archived with its room", lifecycle: "deleted", paused_by: null, scope: "workspace", owning_workstream_id: null, owning_substream_id: "0" },
    ]);
    expect(database.prepare(`SELECT name FROM sqlite_master WHERE name = 'channel_rail_sidekick_owner_update'`).all()).toEqual([]);
  });
});
