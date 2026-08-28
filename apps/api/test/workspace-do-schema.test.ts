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
    // deployed object recorded, and each one then throws
    // `workspace_do_schema_hash_mismatch:4` in its constructor — for good.
    expect(bootstrapEntries(database)).toEqual([]);
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
