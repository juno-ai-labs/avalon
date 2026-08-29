import { asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
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
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");
const RESOURCE_ID = "00000000-0000-7000-8000-0000000000a2";

const open: DatabaseSync[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

/**
 * The reaper's decisions, against a real WorkspaceDO over its own schema.
 *
 * The claim, the reference check and the retirement are the object's now, so
 * these seed the object's real tables — with its real triggers, which is what
 * makes the historical-version and re-deletion cases honest — and read the
 * rows back rather than recording routed SQL.
 */
function fixture(payloads: Partial<R2Bucket>): { database: DatabaseSync; env: Env } {
  const regional = new DatabaseSync(":memory:");
  open.push(regional);
  const workspaceObject = createTestWorkspaceDO({
    workspaceId,
    regionalDatabase: regional,
    register: (created) => { open.push(created); },
  });
  return {
    database: workspaceObject.objectDatabase,
    env: createTestEnv({
      DB: createTestD1Database({}),
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspaceObject.instance, [
        "listReapableResourceObjects",
        "claimResourceObjectRemoval",
        "retireResourceObjectStaging",
        "recordResourceObjectCleanupFailure",
      ]),
      PAYLOADS: payloads,
    }),
  };
}

function seedOutboxRow(
  database: DatabaseSync,
  objectRef: string,
  input: { cleanupEligible?: number; objectKind?: string; resourceId?: string; createdAt?: string } = {},
): void {
  database.prepare(
    `INSERT OR IGNORE INTO resource_object_deletion_outbox
       (object_ref, workspace_id, resource_id, object_kind, cleanup_eligible, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    objectRef,
    workspaceId,
    input.resourceId ?? RESOURCE_ID,
    input.objectKind ?? "original",
    input.cleanupEligible ?? 1,
    input.createdAt ?? "2026-08-12T00:00:00.000Z",
    "2026-08-12T00:00:00.000Z",
  );
}

function seedResource(
  database: DatabaseSync,
  input: { id?: string; contentRef?: string | null; modelContentRef?: string | null } = {},
): void {
  database.prepare(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, content_ref, model_content_ref,
        metadata_json, attachment_status, created_at, updated_at)
     VALUES (?, ?, 'document', 'fixture', 'Current', ?, ?, '{}', 'attached',
             '2026-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z')`,
  ).run(input.id ?? RESOURCE_ID, workspaceId, input.contentRef ?? null, input.modelContentRef ?? null);
}

function outboxCount(database: DatabaseSync): number {
  return Number((database.prepare(
    "SELECT COUNT(*) AS count FROM resource_object_deletion_outbox",
  ).get() as { count: number }).count);
}

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
    const deleted: string[] = [];
    const { database, env } = fixture({
      async delete(key: string) { deleted.push(key as string); },
    } as Partial<R2Bucket>);
    for (let index = 0; index < 101; index += 1) {
      seedOutboxRow(database, `regional/receipt-${String(index).padStart(3, "0")}`, {
        objectKind: "receipt",
        createdAt: `2026-08-12T00:00:00.${String(index).padStart(3, "0")}Z`,
      });
    }

    // The count is what the alarm reads as progress: a batch that retired rows
    // re-derives the same instant and must not be read as a stall.
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(100);
    expect(deleted).toHaveLength(100);
    expect(outboxCount(database)).toBe(1);

    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(1);
    expect(deleted).toHaveLength(101);
    expect(outboxCount(database)).toBe(0);
  });

  it("keeps a failed object queued with bounded retry metadata, then converges", async () => {
    let fail = true;
    const deleted: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { database, env } = fixture({
      async delete(key: string) {
        if (fail) throw Object.assign(new Error("secret provider body"), { code: "temporary_r2_failure" });
        deleted.push(key as string);
      },
    } as Partial<R2Bucket>);
    seedOutboxRow(database, "regional/object", { objectKind: "derivative" });

    // A failure retires nothing, and says so: the alarm holds the entry.
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(0);
    expect(database.prepare(
      "SELECT attempt_count, last_error_code FROM resource_object_deletion_outbox WHERE object_ref = 'regional/object'",
    ).get()).toEqual({ attempt_count: 1, last_error_code: "temporary_r2_failure" });
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "resource_object_cleanup_failed",
      resource_id: RESOURCE_ID,
      object_kind: "derivative",
      reason: "temporary_r2_failure",
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret provider body");

    fail = false;
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(1);
    expect(deleted).toEqual(["regional/object"]);
    expect(outboxCount(database)).toBe(0);
    warning.mockRestore();
  });

  it("cancels deletion when an object became current again before the reaper ran", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const { database, env } = fixture({ delete: deleteObject } as Partial<R2Bucket>);
    seedResource(database, { contentRef: "regional/original", modelContentRef: "regional/reactivated" });
    seedOutboxRow(database, "regional/reactivated", { objectKind: "derivative" });

    // Retiring the outbox row without touching R2 is still progress.
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(1);

    expect(deleteObject).not.toHaveBeenCalled();
    expect(outboxCount(database)).toBe(0);
  });

  it("does not reap a staged publication before its resource pointer commits", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const { database, env } = fixture({ delete: deleteObject } as Partial<R2Bucket>);
    seedOutboxRow(database, "regional/in-flight", { cleanupEligible: 0 });

    // This is the production race: R2 has accepted the put, but the following
    // WorkspaceDO pointer write has not committed yet.
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(0);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT cleanup_eligible FROM resource_object_deletion_outbox WHERE object_ref = 'regional/in-flight'",
    ).get()).toEqual({ cleanup_eligible: 0 });

    seedResource(database, { contentRef: "regional/in-flight" });

    // Once the pointer exists, maintenance retires only the staging record.
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(outboxCount(database)).toBe(0);
  });

  it("cancels deletion while an historical version still references the object", async () => {
    const deleteObject = vi.fn(async () => undefined);
    const { database, env } = fixture({ delete: deleteObject } as Partial<R2Bucket>);
    // The historical reference comes from the object's own capture trigger: a
    // content swap records the superseded pointer as version 1 and stages the
    // old object, exactly as a hydration re-fetch does.
    seedResource(database, { contentRef: "regional/historical" });
    database.prepare(
      "UPDATE resources SET content_ref = 'regional/current', updated_at = '2026-08-12T01:00:00.000Z' WHERE id = ?",
    ).run(RESOURCE_ID);

    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(1);
    expect(deleteObject).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT content_ref FROM resource_versions WHERE version = 1",
    ).get()).toEqual({ content_ref: "regional/historical" });
  });

  it("keeps cleanup ownership when a resource is deleted after its staging row was retired", async () => {
    // The old two-round-trip reaper could retire staging while a concurrent
    // deletion promoted the row, orphaning the bytes. In the object the claim
    // and the retirement are one critical section; a deletion after it
    // re-queues the objects through the schema's own triggers, so ownership
    // converges instead of being lost.
    const deleted: string[] = [];
    const { database, env } = fixture({
      async delete(key: string) { deleted.push(key as string); },
    } as Partial<R2Bucket>);
    seedResource(database, { contentRef: "regional/racing" });
    seedOutboxRow(database, "regional/racing", { cleanupEligible: 0 });

    expect(await reapDeletedResourceObjects(env, workspaceId)).toBe(1);
    expect(deleted).toEqual([]);
    expect(outboxCount(database)).toBe(0);

    database.prepare("DELETE FROM resources WHERE id = ?").run(RESOURCE_ID);
    expect(outboxCount(database)).toBeGreaterThan(0);
    expect(await reapDeletedResourceObjects(env, workspaceId)).toBeGreaterThan(0);
    expect(deleted).toContain("regional/racing");
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
