import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  putStagedResourceObject,
  reapDeletedResourceObjects,
} from "../src/services/resource-object-cleanup";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
  createTestEnv,
} from "./helpers/cloudflare-test";

describe("resource object cleanup", () => {
  it("stages before R2 and releases a failed put without hiding its error", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        object_kind TEXT NOT NULL, cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const storageError = new Error("injected_r2_put_failure");
    const put = vi.fn(async () => { throw storageError; });

    await expect(putStagedResourceObject({
      database: sqliteD1(database),
      payloads: createCloudflareTestBinding<R2Bucket>({ put }),
      objectRef: "regional/staged-put",
      workspaceId: "workspace-one",
      resourceId: "resource-one",
      objectKind: "original",
      value: new Uint8Array([1, 2, 3]),
      at: "2026-08-28T12:00:00.000Z",
    })).rejects.toBe(storageError);

    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare(
      `SELECT cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref = 'regional/staged-put'`,
    ).get()).toEqual({ cleanup_eligible: 1 });
    database.close();
  });

  it("keeps the R2 put error when the best-effort release also fails", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        object_kind TEXT NOT NULL, cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const storageError = new Error("injected_r2_put_failure");

    await expect(putStagedResourceObject({
      database: sqliteD1(database, {
        beforeRun(sql) {
          if (sql.includes("UPDATE resource_object_deletion_outbox")) throw new Error("release_unavailable");
        },
      }),
      payloads: createCloudflareTestBinding<R2Bucket>({
        async put() { throw storageError; },
      }),
      objectRef: "regional/staged-put-release-failure",
      workspaceId: "workspace-one",
      resourceId: "resource-one",
      objectKind: "original",
      value: new Uint8Array([1, 2, 3]),
      at: "2026-08-28T12:00:00.000Z",
    })).rejects.toBe(storageError);

    expect(database.prepare(
      `SELECT cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref = 'regional/staged-put-release-failure'`,
    ).get()).toEqual({ cleanup_eligible: 0 });
    database.close();
  });

  it("releases a staging insert whose committed response is lost before R2 put", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        object_kind TEXT NOT NULL, cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const stagingError = new Error("staging_response_lost");
    let failed = false;
    const put = vi.fn(async () => undefined);

    await expect(putStagedResourceObject({
      database: sqliteD1(database, {
        afterRun(sql) {
          if (!failed && sql.includes("INSERT OR IGNORE INTO resource_object_deletion_outbox")) {
            failed = true;
            throw stagingError;
          }
        },
      }),
      payloads: createCloudflareTestBinding<R2Bucket>({ put }),
      objectRef: "regional/staging-response-lost",
      workspaceId: "workspace-one",
      resourceId: "resource-one",
      objectKind: "original",
      value: new Uint8Array([1, 2, 3]),
      at: "2026-08-28T12:00:00.000Z",
    })).rejects.toBe(stagingError);

    expect(put).not.toHaveBeenCalled();
    expect(database.prepare(
      `SELECT cleanup_eligible FROM resource_object_deletion_outbox
        WHERE object_ref = 'regional/staging-response-lost'`,
    ).get()).toEqual({ cleanup_eligible: 1 });
    database.close();
  });

  it("reaps exactly one bounded batch before continuing on the next pass", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
        cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const insert = database.prepare(`
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
      VALUES (?, 'workspace-one', ?, 'receipt', ?, ?)
    `);
    for (let index = 0; index < 101; index += 1) {
      const key = `regional/receipt-${String(index).padStart(3, "0")}`;
      insert.run(key, `resource-${index}`, `2026-08-12T00:00:00.${String(index).padStart(3, "0")}Z`, "2026-08-12");
    }
    const deleted: string[] = [];
    const env = createTestEnv({
      DB: sqliteD1(database),
      PAYLOADS: { async delete(key: string) { deleted.push(key); } },
    });

    // The count is what the alarm reads as progress: a batch that retired rows
    // re-derives the same instant and must not be read as a stall.
    expect(await reapDeletedResourceObjects(env)).toBe(100);
    expect(deleted).toHaveLength(100);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 1 });

    expect(await reapDeletedResourceObjects(env)).toBe(1);
    expect(deleted).toHaveLength(101);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("keeps a failed object queued with bounded retry metadata, then converges", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
        cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
      VALUES ('regional/object', 'workspace-one', 'resource-one', 'derivative', '2026-08-12', '2026-08-12');
    `);
    let fail = true;
    const deleted: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const env = createTestEnv({
      DB: sqliteD1(database),
      PAYLOADS: {
        async delete(key: string) {
          if (fail) throw Object.assign(new Error("secret provider body"), { code: "temporary_r2_failure" });
          deleted.push(key);
        },
      },
    });

    // A failure retires nothing, and says so: the alarm holds the entry.
    expect(await reapDeletedResourceObjects(env)).toBe(0);
    expect(database.prepare(
      "SELECT attempt_count, last_error_code FROM resource_object_deletion_outbox WHERE object_ref = 'regional/object'",
    ).get()).toEqual({ attempt_count: 1, last_error_code: "temporary_r2_failure" });
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "resource_object_cleanup_failed",
      resource_id: "resource-one",
      object_kind: "derivative",
      reason: "temporary_r2_failure",
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret provider body");

    fail = false;
    expect(await reapDeletedResourceObjects(env)).toBe(1);
    expect(deleted).toEqual(["regional/object"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
    warning.mockRestore();
    database.close();
  });

  it("cancels deletion when an object became current again before the reaper ran", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
        cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO resources (id, workspace_id, content_ref, model_content_ref)
      VALUES ('resource-current', 'workspace-one', 'original', 'regional/reactivated');
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
      VALUES ('regional/reactivated', 'workspace-one', 'resource-current', 'derivative', '2026-08-12', '2026-08-12');
    `);
    const deleteObject = vi.fn(async () => undefined);
    const env = createTestEnv({
      DB: sqliteD1(database),
      PAYLOADS: { delete: deleteObject },
    });

    // Retiring the outbox row without touching R2 is still progress.
    expect(await reapDeletedResourceObjects(env)).toBe(1);

    expect(deleteObject).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("does not reap a staged publication before its resource pointer commits", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
        cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
      VALUES ('regional/in-flight', 'workspace-one', 'resource-one', 'original', 0, '2026-08-28', '2026-08-28');
    `);
    const deleteObject = vi.fn(async () => undefined);
    const env = createTestEnv({ DB: sqliteD1(database), PAYLOADS: { delete: deleteObject } });

    // This is the production race: R2 has accepted the put, but the following
    // WorkspaceDO pointer write has not committed yet.
    expect(await reapDeletedResourceObjects(env)).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_ref = 'regional/in-flight'",
    ).get()).toEqual({ cleanup_eligible: 0 });

    database.prepare(
      "INSERT INTO resources (id, workspace_id, content_ref) VALUES (?, ?, ?)",
    ).run("resource-one", "workspace-one", "regional/in-flight");

    // Once the pointer exists, maintenance retires only the staging record.
    expect(await reapDeletedResourceObjects(env)).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get())
      .toEqual({ count: 0 });
    database.close();
  });

  it("cancels deletion while an historical version still references the object", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL, object_kind TEXT NOT NULL,
        cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO resources (id, workspace_id, content_ref, model_content_ref)
      VALUES ('resource-current', 'workspace-one', 'regional/current', NULL);
      INSERT INTO resource_versions (resource_id, workspace_id, content_ref, model_content_ref)
      VALUES ('resource-current', 'workspace-one', 'regional/historical', NULL);
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
      VALUES ('regional/historical', 'workspace-one', 'resource-current', 'original', 0, '2026-08-12', '2026-08-12');
    `);
    const deleteObject = vi.fn(async () => undefined);
    const env = createTestEnv({ DB: sqliteD1(database), PAYLOADS: { delete: deleteObject } });

    expect(await reapDeletedResourceObjects(env)).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
    database.close();
  });

  it("does not retire cleanup ownership when resource deletion races the active-pointer check", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_versions (
        resource_id TEXT NOT NULL, workspace_id TEXT NOT NULL, content_ref TEXT, model_content_ref TEXT
      );
      CREATE TABLE resource_object_deletion_outbox (
        object_ref TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        object_kind TEXT NOT NULL, cleanup_eligible INTEGER NOT NULL DEFAULT 1,
        attempt_count INTEGER NOT NULL DEFAULT 0, last_error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TRIGGER promote_resource_object_before_delete
      BEFORE DELETE ON resources BEGIN
        UPDATE resource_object_deletion_outbox SET cleanup_eligible = 1
         WHERE workspace_id = OLD.workspace_id AND object_ref = OLD.content_ref;
      END;
      INSERT INTO resources VALUES ('resource-one', 'workspace-one', 'regional/racing', NULL);
      INSERT INTO resource_object_deletion_outbox
        (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
      VALUES ('regional/racing', 'workspace-one', 'resource-one', 'original', 0, '2026-08-12', '2026-08-12');
    `);
    let interleaved = false;
    const deleteObject = vi.fn(async () => undefined);
    const env = createTestEnv({
      DB: sqliteD1(database, {
        beforeRun(sql) {
          if (!interleaved && sql.includes("DELETE FROM resource_object_deletion_outbox") && sql.includes("EXISTS")) {
            interleaved = true;
            database.prepare("DELETE FROM resources WHERE id = 'resource-one'").run();
          }
        },
      }),
      PAYLOADS: { delete: deleteObject },
    });

    expect(await reapDeletedResourceObjects(env)).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_ref = 'regional/racing'",
    ).get()).toEqual({ cleanup_eligible: 1 });
    database.close();
  });
});

function sqliteD1(database: DatabaseSync, hooks: {
  beforeRun?: (sql: string) => void;
  afterRun?: (sql: string) => void;
} = {}): D1Database {
  const prepare = (sql: string): D1PreparedStatement => {
    let values: unknown[] = [];
    const statement = {
      bind(...next: unknown[]) { values = next; return statement; },
      async first<T>() { return (database.prepare(sql).get(...values as never[]) ?? null) as T | null; },
      async all<T>() {
        return createTestD1Result<T>({ results: database.prepare(sql).all(...values as never[]) as T[], success: true, meta: {} });
      },
      async run<T>() {
        hooks.beforeRun?.(sql);
        const result = database.prepare(sql).run(...values as never[]);
        hooks.afterRun?.(sql);
        return createTestD1Result<T>({ results: [], success: true, meta: { changes: Number(result.changes) } });
      },
    };
    return createTestD1PreparedStatement(statement);
  };
  return createTestD1Database({ prepare });
}
