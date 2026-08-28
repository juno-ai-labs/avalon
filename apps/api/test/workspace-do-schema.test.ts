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
