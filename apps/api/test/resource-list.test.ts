import { asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthContext } from "../src/env";
import { ResourceReadContext } from "../src/services/authorization-service";
import { ResourceService } from "../src/services/resource-service";
import { unlistedResourceMetadata } from "../src/services/resource-listing";
import { createTestD1Database, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const firstResourceId = "00000000-0000-7000-8000-000000000011";
const secondResourceId = "00000000-0000-7000-8000-000000000010";
const thirdResourceId = "00000000-0000-7000-8000-000000000009";

const auth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "owner",
  accessClass: "member",
};

describe("resource listing", () => {
  it("reuses an explicit request-membership observation", async ({ onTestFinished }) => {
    const regional = new DatabaseSync(':memory:');
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: regional });
    seedMember(regional);
    onTestFinished(() => { workspace.objectDatabase.close(); regional.close(); });
    workspace.objectDatabase.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'document', 'fixture', 'One membership read', '{}', 'attached', ?, ?)`)
      .run(firstResourceId, workspaceId, '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z');
    let membershipReads = 0;
    const env = createTestEnv({
      DB: sqliteD1(regional, (sql) => { if (sql.includes('workspace_members')) membershipReads += 1; }),
      APP_ENV: 'test',
      AVALON_REGION: 'global',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ['executeRuntimeSql', 'authorizationResourceFacts']),
    });
    const reads = new ResourceReadContext(env, auth, {
        workspaceId,
        userId,
        accessClass: 'member',
        validatedAt: Date.now(),
      });
    const service = new ResourceService(env, auth, undefined, reads);

    await expect(service.get(firstResourceId)).resolves.toMatchObject({ id: firstResourceId });
    expect(membershipReads).toBe(0);
  });

  it("uses the caller clock for evidence returned by another isolate", async ({ onTestFinished }) => {
    const regional = new DatabaseSync(':memory:');
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: regional });
    seedMember(regional);
    onTestFinished(() => { workspace.objectDatabase.close(); regional.close(); });
    workspace.objectDatabase.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'document', 'fixture', 'Clock skew', '{}', 'attached', ?, ?)`)
      .run(firstResourceId, workspaceId, '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z');
    const readFacts = workspace.instance.authorizationResourceFacts.bind(workspace.instance);
    vi.spyOn(workspace.instance, 'authorizationResourceFacts').mockImplementation(async (input) =>
      (await readFacts(input)).map((value) => ({ ...value, validatedAt: Number.MAX_SAFE_INTEGER })));
    const service = new ResourceService(createTestEnv({
      DB: sqliteD1(regional), APP_ENV: 'test', AVALON_REGION: 'global',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ['executeRuntimeSql', 'authorizationResourceFacts']),
    }), auth);

    await expect(service.get(firstResourceId)).resolves.toMatchObject({ id: firstResourceId, title: 'Clock skew' });
  });

  it("reads an upload draft to its uploader and refuses it as something to attach", async ({ onTestFinished }) => {
    const regional = new DatabaseSync(':memory:');
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: regional });
    seedMember(regional);
    onTestFinished(() => { workspace.objectDatabase.close(); regional.close(); });
    workspace.objectDatabase.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, uploaded_by_user_id,
       created_at, updated_at)
      VALUES (?, ?, 'file', 'avalon_upload', 'Unsent draft', '{}', 'draft', ?, ?, ?)`)
      .run(firstResourceId, workspaceId, userId, '2026-09-21T12:00:00.000Z', '2026-09-21T12:00:00.000Z');
    const service = new ResourceService(createTestEnv({
      DB: sqliteD1(regional), APP_ENV: 'test', AVALON_REGION: 'global',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ['executeRuntimeSql', 'authorizationResourceFacts']),
    }), auth);

    // A draft is its uploader's to see, and is reaped when it expires, so a
    // Space default that named it would outlive the resource.
    await expect(service.get(firstResourceId)).resolves.toMatchObject({ id: firstResourceId });
    await expect(service.getAttachable(firstResourceId)).rejects.toMatchObject({
      status: 409, code: 'attachment_draft_requires_message',
    });
  });

  it("uses keyset pagination and literal resource title search", async ({ onTestFinished }) => {
    const regional = new DatabaseSync(':memory:');
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: regional });
    seedMember(regional);
    onTestFinished(() => { workspace.objectDatabase.close(); regional.close(); });
    const insert = workspace.objectDatabase.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'document', 'fixture', ?, '{}', 'attached', ?, ?)`);
    for (const [id, title, at] of [
      [firstResourceId, 'Release_100%', '2026-08-01T12:00:00.000Z'],
      [secondResourceId, 'ReleaseA100x', '2026-08-01T11:00:00.000Z'],
      [thirdResourceId, 'Older result', '2026-08-01T10:00:00.000Z'],
    ]) insert.run(id!, workspaceId, title!, at!, at!);
    const snapshots = vi.spyOn(workspace.instance, 'readAuthorizationSnapshots');
    const facts = vi.spyOn(workspace.instance, 'authorizationResourceFacts');
    const writes = vi.spyOn(workspace.instance, 'writeAuthorizationSnapshots');
    const service = new ResourceService(createTestEnv({
      DB: sqliteD1(regional), APP_ENV: 'test', AVALON_REGION: 'global',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ['executeRuntimeSql', 'readAuthorizationSnapshots', 'writeAuthorizationSnapshots', 'authorizationResourceFacts']),
    }), auth);
    const first = await service.list({ limit: 2 });
    expect(first.items.map((resource) => resource.id)).toEqual([firstResourceId, secondResourceId]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(snapshots).not.toHaveBeenCalled();
    expect(facts).toHaveBeenCalledTimes(1);
    expect(facts.mock.calls[0]?.[0].resourceIds).toEqual([firstResourceId, secondResourceId]);
    expect(writes).not.toHaveBeenCalled();

    const next = await service.list({ limit: 2, cursor: first.nextCursor! });
    expect(next.items.map((resource) => resource.id)).toEqual([thirdResourceId]);
    expect(next.nextCursor).toBeNull();
    const literal = await service.list({ query: 'Release_100%', limit: 2 });
    expect(literal.items.map((resource) => resource.id)).toEqual([firstResourceId]);
  });

  it("confines a page to the named resource types, and reads an empty list as nothing rather than everything", async ({ onTestFinished }) => {
    const regional = new DatabaseSync(':memory:');
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: regional });
    seedMember(regional);
    onTestFinished(() => { workspace.objectDatabase.close(); regional.close(); });
    const insert = workspace.objectDatabase.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, ?, 'fixture', ?, '{}', 'attached', ?, ?)`);
    for (const [id, type, title, at] of [
      [firstResourceId, 'github_repository', 'juno-ai-labs/avalon', '2026-08-01T10:00:00.000Z'],
      [secondResourceId, 'github_file', 'juno-ai-labs/avalon README', '2026-08-01T12:00:00.000Z'],
      [thirdResourceId, 'drive_file', 'avalon planning', '2026-08-01T11:00:00.000Z'],
    ]) insert.run(id!, workspaceId, type!, title!, at!, at!);
    const service = new ResourceService(createTestEnv({
      DB: sqliteD1(regional), APP_ENV: 'test', AVALON_REGION: 'global',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ['executeRuntimeSql', 'readAuthorizationSnapshots', 'writeAuthorizationSnapshots', 'authorizationResourceFacts']),
    }), auth);

    // Two types at once, against the schema the object really runs: the `IN`
    // list has to bind in the same order its placeholders sit in, between the
    // query patterns before it and the cursor after it. A binding slipped by
    // one here reads as a filter that silently matches the wrong thing.
    const both = await service.list({ query: 'avalon', limit: 10, resourceTypes: ['github_repository', 'drive_file'] });
    expect(both.items.map((resource) => resource.id)).toEqual([thirdResourceId, firstResourceId]);

    // The `github_file` is the newest row and matches the query; confining the
    // page is what keeps it out, and the repository in.
    const one = await service.list({ query: 'avalon', limit: 10, resourceTypes: ['github_repository'] });
    expect(one.items.map((resource) => resource.id)).toEqual([firstResourceId]);

    // Absent is every type. An empty array is not that.
    const every = await service.list({ query: 'avalon', limit: 10 });
    expect(every.items).toHaveLength(3);
    const none = await service.list({ query: 'avalon', limit: 10, resourceTypes: [] });
    expect(none.items).toEqual([]);
    expect(none.nextCursor).toBeNull();

    // The cursor keeps its meaning under the filter: page two of a confined
    // list is the rest of that list, not the rest of the workspace.
    const firstPage = await service.list({ limit: 1, resourceTypes: ['github_repository', 'drive_file'] });
    expect(firstPage.items.map((resource) => resource.id)).toEqual([thirdResourceId]);
    const secondPage = await service.list({ limit: 1, cursor: firstPage.nextCursor!, resourceTypes: ['github_repository', 'drive_file'] });
    expect(secondPage.items.map((resource) => resource.id)).toEqual([firstResourceId]);
  });

  it("omits an unlisted resource from the workspace list while still serving it by id", async ({ onTestFinished }) => {
    const regional = new DatabaseSync(':memory:');
    const workspace = createTestWorkspaceDO({ workspaceId, regionalDatabase: regional });
    seedMember(regional);
    onTestFinished(() => { workspace.objectDatabase.close(); regional.close(); });
    // `fixture`, like the case above: `avalon_generated` carries
    // `requiresAttachment`, and an attachment decision is a different axis from
    // the listing one under test here.
    const insert = workspace.objectDatabase.prepare(`INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, metadata_json, attachment_status, created_at, updated_at)
      VALUES (?, ?, 'document', 'fixture', ?, ?, 'attached', ?, ?)`);
    const at = '2026-09-11T04:00:00.000Z';
    insert.run(firstResourceId, workspaceId, 'Migration plan.md', '{}', at, at);
    insert.run(
      secondResourceId, workspaceId, 'Terminal backup before acme/widget',
      JSON.stringify({ size: 22_535_876, ...unlistedResourceMetadata() }), at, at,
    );
    const service = new ResourceService(createTestEnv({
      DB: sqliteD1(regional), APP_ENV: 'test', AVALON_REGION: 'global',
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ['executeRuntimeSql', 'readAuthorizationSnapshots', 'writeAuthorizationSnapshots', 'authorizationResourceFacts']),
    }), auth);

    const listed = await service.list({ limit: 25 });
    expect(listed.items.map((resource) => resource.id)).toEqual([firstResourceId]);

    // The other half of the same rule: `RESOURCE_WITH_WATCH_STATE_SQL` omits
    // the predicate on purpose, so whoever holds the id still gets the row.
    await expect(service.get(secondResourceId)).resolves.toMatchObject({
      id: secondResourceId,
      title: 'Terminal backup before acme/widget',
    });
  });

  it("rejects malformed cursors before querying storage", async () => {
    let prepared = false;
    const database = createTestD1Database({
      prepare() {
        prepared = true;
        throw new Error("storage should not be queried");
      },
    });
    const service = new ResourceService(createTestEnv({ DB: database }), auth);

    await expect(service.list({ cursor: "not-a-cursor", limit: 25 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_resource_cursor",
    });
    expect(prepared).toBe(false);
  });

  it("lists every authorized resource version newest first", async () => {
    // The history lives in a real WorkspaceDO, written by its own capture
    // triggers rather than seeded: an insert records version 1, and the
    // content swap after it is what makes version 2 exist.
    const regional = new DatabaseSync(":memory:");
    const workspaceObject = createTestWorkspaceDO({
      workspaceId,
      regionalDatabase: regional,
    });
    seedMember(regional);
    const database = workspaceObject.objectDatabase;
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
          model_content_ref, metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'document', 'fixture', 'First', 'text/plain', 'original-1',
               'model-1', '{"size":5}', 'attached', '2026-08-27T01:00:00.000Z',
               '2026-08-27T01:00:00.000Z')`,
    ).run(firstResourceId, workspaceId);
    database.prepare(
      `UPDATE resources
          SET title = 'Current', content_ref = 'original-2', model_content_ref = 'model-2',
              metadata_json = '{"size":6}', updated_at = '2026-08-27T02:00:00.000Z'
        WHERE id = ?`,
    ).run(firstResourceId);
    const service = new ResourceService(createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspaceObject.instance, [
        "listResourceVersions", "readAuthorizationSnapshots", "writeAuthorizationSnapshots", "authorizationResourceFacts",
        "executeRuntimeSql",
      ]),
      PAYLOADS: {
        async get(key: string) {
          return {
            body: new Response(key).body,
            httpEtag: '"fixture"',
            writeHttpMetadata(headers: Headers) { headers.set("content-type", "text/plain"); },
          } as R2ObjectBody;
        },
      },
    }), auth);

    await expect(service.versions(firstResourceId)).resolves.toMatchObject([
      { version: 2, title: "Current", contentAvailable: true, modelContentAvailable: true, sizeBytes: 6 },
      { version: 1, title: "First", contentAvailable: true, modelContentAvailable: true, sizeBytes: 5 },
    ]);
    await expect(service.version(firstResourceId, 1)).resolves.toMatchObject({ version: 1, title: "First" });
    await expect(service.version(firstResourceId, 3)).rejects.toMatchObject({
      status: 404,
      code: "resource_version_not_found",
    });
    await expect((await service.versionContent(firstResourceId, 1, "original")).text())
      .resolves.toBe("original-1");
    await expect((await service.versionContent(firstResourceId, 2, "model")).text())
      .resolves.toBe("model-2");
    database.close();
  });

});

function sqliteD1(database: DatabaseSync, onPrepare?: (sql: string) => void): D1Database {
  return createTestD1Database({
    prepare(sql: string) {
      onPrepare?.(sql);
      let values: Array<string | number | null> = [];
      return {
        bind(...next: Array<string | number | null>) {
          values = next;
          return this;
        },
        async first<T>() {
          return (database.prepare(sql).get(...values) ?? null) as T | null;
        },
        async all<T>() {
          return createTestD1Result<T>({
            results: database.prepare(sql).all(...values) as T[],
            success: true,
            meta: emptyD1Meta(),
          });
        },
      };
    },
  });
}

function emptyD1Meta(): D1Meta {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };
}

function seedMember(database: DatabaseSync) {
  database.exec(`CREATE TABLE workspace_members(workspace_id TEXT, user_id TEXT, status TEXT, access_class TEXT DEFAULT 'member')`);
  database.prepare("INSERT INTO workspace_members(workspace_id,user_id,status) VALUES (?, ?, 'active')").run(workspaceId, userId);
}
