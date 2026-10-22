import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ExecutionPrincipal } from "@rally/contracts";
import {
  loadVisibleWorkstreamResourceInventory,
  loadVisibleWorkstreamResourcePage,
  loadVisibleWorkstreamResourcesByIds,
  ownInventoryRevision,
} from "../src/services/workstream-resource-visibility";
import { unlistedResourceMetadata } from "../src/services/resource-listing";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";
import { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1Result,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";
import { migratedSqliteDatabase } from "./helpers/sqlite-d1";
import {
  seedWorkstreamObjectRoot,
  testConversationResourceLinks,
  testResourcePort,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";

const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-0000000000a1");
const WORKSTREAM = "00000000-0000-7000-8000-0000000000a2";
const PUBLISHED = "00000000-0000-7000-8000-0000000000b1";
const BACKUP = "00000000-0000-7000-8000-0000000000b2";
const AT = "2026-09-10T22:34:53.788Z";

const principal: ExecutionPrincipal = {
  type: "user",
  userId: asUserId("00000000-0000-7000-8000-0000000000a3"),
};

/**
 * The real `resources` table, behind the D1 shape `loadVisibleRows` is typed
 * against. The listing predicate is SQL, so a stubbed database would answer for
 * the stub rather than for the statement that ships.
 */
function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare(sql: string) {
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
            meta: {
              duration: 0, size_after: 0, rows_read: 0, rows_written: 0,
              last_row_id: 0, changed_db: false, changes: 0,
            },
          });
        },
      };
    },
  });
}

function fixture(onFinished: (close: () => void) => void): {
  database: D1Database;
  attachments: ReturnType<typeof testConversationResourceLinks>;
} {
  const regional = new DatabaseSync(":memory:");
  const workspace = createTestWorkspaceDO({ workspaceId: WORKSPACE, regionalDatabase: regional });
  const store = testWorkstreamObjectStore();
  onFinished(() => { workspace.objectDatabase.close(); regional.close(); store.close(); });
  seedWorkstreamObjectRoot(store, { workstreamId: WORKSTREAM, workspaceId: WORKSPACE });

  const insert = workspace.objectDatabase.prepare(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, provider_resource_id, title,
        mime_type, metadata_json, attachment_status, created_at, updated_at)
     VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, ?, ?, 'attached', ?, ?)`,
  );
  insert.run(PUBLISHED, WORKSPACE, "terminal:published", "Design notes", "text/markdown", "{}", AT, AT);
  insert.run(
    BACKUP, WORKSPACE, "terminal-workspace-backup:call-1", "Terminal backup before acme/widget",
    "application/gzip", JSON.stringify({ size: 22_535_876, ...unlistedResourceMetadata() }), AT, AT,
  );

  const link = store.prepare(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type,
        resource_json, attached_at, updated_at)
     VALUES (?, NULL, 0, 'generated', '{}', ?, ?)`,
  );
  link.run(PUBLISHED, Date.parse(AT), Date.parse(AT));
  link.run(BACKUP, Date.parse(AT) + 1, Date.parse(AT) + 1);

  return { database: sqliteD1(workspace.objectDatabase), attachments: testConversationResourceLinks(store) };
}

describe("unlisted resources", () => {
  it("are attached and reachable by id, but absent from every enumeration", async ({ onTestFinished }) => {
    const { database, attachments } = fixture((close) => onTestFinished(close));
    const scope = { workspaceId: WORKSPACE, workstreamId: WORKSTREAM, principal };

    const page = await loadVisibleWorkstreamResourcePage(database, attachments, {
      ...scope, attachmentKind: null, limit: 10,
    });
    expect(page.rows.map((row) => row.id)).toEqual([PUBLISHED]);
    expect(page.totalVisibleResources).toBe(1);

    const inventory = await loadVisibleWorkstreamResourceInventory(database, attachments, scope);
    expect(inventory.totalVisibleResources).toBe(1);

    // The reachable half. This is the path the checkout receipt's
    // `backup.resourceId` takes into `import_resource`, and the one an
    // opened resource link takes; unlisting must not close it.
    const byId = await loadVisibleWorkstreamResourcesByIds(database, attachments, {
      ...scope, resourceIds: [BACKUP],
    });
    expect(byId.map((row) => row.id)).toEqual([BACKUP]);
    expect(byId[0]?.relationship_type).toBe("generated");
  });
});

// The version that unlists the recovery backups written before the producer
// marked them. The harness stops one short of it so the upgrade runs against
// rows that a released schema actually holds, rather than against a fresh one.
const BACKUP_UNLISTING_VERSION = 52;

function applyThrough(database: DatabaseSync, through: number, after = 0): void {
  database.exec("PRAGMA foreign_keys = ON");
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

describe("unlisting the recovery backups already attached", () => {
  it("reaches every stored backup and nothing else", ({ onTestFinished }) => {
    const database = new DatabaseSync(":memory:");
    onTestFinished(() => { try { database.close(); } catch { /* already closed */ } });
    applyThrough(database, BACKUP_UNLISTING_VERSION - 1);
    // Every `resources` write is fenced against the object's own identity.
    database.prepare(
      `INSERT INTO workspace_identity
         (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, 'global', 'wnam', 1, 1)`,
    ).run(WORKSPACE);

    const insert = database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title,
          metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'generated_file', ?, ?, ?, ?, 'attached', ?, ?)`,
    );
    // The two shapes the backup path has written: the pre-substream tool-call
    // identity and the current one. Both are its rows and both have to be reached.
    insert.run(BACKUP, WORKSPACE, "avalon_generated",
      "terminal-workspace-backup:01a049f7:turn:4:tool:0", "Terminal backup before acme/widget",
      JSON.stringify({ source: "terminal_repository_replacement", size: 139 }), AT, AT);
    insert.run("00000000-0000-7000-8000-0000000000b3", WORKSPACE, "avalon_generated",
      "terminal-workspace-backup:workstream:01a088b3:substream:0:loop:turn:37:tool:0",
      "Terminal backup before acme/widget",
      JSON.stringify({ source: "terminal_repository_replacement", size: 22_535_876 }), AT, AT);
    insert.run(PUBLISHED, WORKSPACE, "avalon_generated",
      "terminal-final-diff:stream:1:diff", "Terminal final diff",
      JSON.stringify({ source: "terminal_expiry", summaryOnly: false }), AT, AT);

    // The precondition that makes the search half real: these rows were indexed
    // some time ago and their projection has gone quiet. The insert trigger
    // marked them pending when this test seeded them, which a settled workspace
    // would not still be.
    database.exec("UPDATE resource_search_versions SET pending = 0");
    const revisionBefore = Number(database.prepare(
      "SELECT revision FROM resource_search_versions WHERE resource_id = ?",
    ).get(BACKUP)!.revision);

    applyThrough(database, BACKUP_UNLISTING_VERSION, BACKUP_UNLISTING_VERSION - 1);

    const listing = new Map(database.prepare(
      "SELECT id, json_extract(metadata_json, '$.listing') AS listing FROM resources ORDER BY id",
    ).all().map((row) => [row.id as string, row.listing]));
    const pending = new Map(database.prepare(
      "SELECT resource_id, pending FROM resource_search_versions",
    ).all().map((row) => [row.resource_id as string, row.pending]));
    expect(listing.get(BACKUP)).toBe("unlisted");
    expect(listing.get("00000000-0000-7000-8000-0000000000b3")).toBe("unlisted");
    // A preserved diff is the work's own output; the backfill is no wider than
    // the one producer whose captures nobody asked for.
    expect(listing.get(PUBLISHED)).toBeNull();
    // The size the backup path recorded is what makes the archive recoverable.
    expect(JSON.parse(database.prepare("SELECT metadata_json FROM resources WHERE id = ?")
      .get(BACKUP)!.metadata_json as string)).toMatchObject({ size: 139 });

    // Migration 43 narrowed the `AFTER UPDATE` trigger to the columns search
    // reads plus `metadata_json`'s `description`, so writing `listing` fires
    // nothing. Without the migration's own upsert a backup indexed before this
    // upgrade is never re-projected, and stays in search results forever while
    // absent from every other surface — so the enqueue is the fix, not the
    // trigger.
    expect(pending.get(BACKUP)).toBe(1);
    expect(pending.get("00000000-0000-7000-8000-0000000000b3")).toBe(1);
    expect(Number(database.prepare(
      "SELECT revision FROM resource_search_versions WHERE resource_id = ?",
    ).get(BACKUP)!.revision)).toBe(revisionBefore + 1);
    // And no wider than the rows it unlists: a listed final diff is left where
    // the projection already put it.
    expect(pending.get(PUBLISHED)).toBe(0);

    // `resources_create_semantic_version` watches `metadata_json` wholesale, so
    // it fires for this write and mints a version. It is attributed rather than
    // suppressed: the alternative leaves `current_version` ahead of the history
    // it indexes, and an unattributed row is one nobody can account for later.
    expect(database.prepare(
      "SELECT current_version FROM resources WHERE id = ?",
    ).get(BACKUP)!.current_version).toBe(2);
    expect(database.prepare(
      "SELECT version, author_kind, cause FROM resource_versions WHERE resource_id = ? ORDER BY version",
    ).all(BACKUP).map((row) => [row.version, row.author_kind, row.cause])).toEqual([
      [1, null, null],
      [2, "system", null],
    ]);
    // The staging column is cleared by the trigger, so the attribution does not
    // leak onto whatever writes this row next.
    expect(database.prepare(
      "SELECT revision_author_kind FROM resources WHERE id = ?",
    ).get(BACKUP)!.revision_author_kind).toBeNull();
  });
});

describe("the member's artifacts rail", () => {
  it("advertises what the work produced and not the archive taken to protect it", async ({ onTestFinished }) => {
    // The current regional topology, because the rail resolves its participants
    // there while the resources it lists come from the object beside it.
    const regional = migratedSqliteDatabase();
    const workspace = createTestWorkspaceDO({ workspaceId: WORKSPACE, regionalDatabase: regional });
    const objectDatabase = new DatabaseSync(":memory:");
    onTestFinished(() => {
      workspace.objectDatabase.close();
      regional.close();
      objectDatabase.close();
    });

    const sql = createTestSqlStorage(objectDatabase);
    const storage = createCloudflareTestBinding<DurableObjectStorage>({
      transactionSync: (callback: () => unknown) => callback(),
      setAlarm: async () => undefined,
      sql,
    });
    const store = new WorkstreamObjectStore(storage, "resource-listing-rail", "global");
    store.ensureIdentity(
      { workspaceId: WORKSPACE, parentKind: "workstream", parentId: WORKSTREAM },
      "global",
    );
    sql.exec(
      `UPDATE workstream
          SET authority_mode = 'authoritative', authority_generation = 1,
              scope = 'workspace', title = 'Repository work', created_by_user_id = ?
        WHERE id = 1`,
      principal.userId,
    );
    const at = Date.parse(AT);
    regional.prepare(
      `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
       VALUES (?, 'resource-listing-subject', 'listing@example.test', 'Listing', ?, ?)`,
    ).run(principal.userId, AT, AT);
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, first_opened_at, updated_at)
       VALUES (?, 'explicit', ?, 'active', 0, ?, NULL, NULL, ?)`,
      principal.userId, principal.userId, at, at,
    );
    sql.exec(
      `INSERT INTO member_attention
         (user_id, unread_tracking_start_ordinal, seen_attention_ordinal,
          manual_unread_from_ordinal, latest_mention_attention_ordinal,
          last_seen_at, version, updated_at)
       VALUES (?, 0, 0, 0, 0, ?, 1, ?)`,
      principal.userId, at, at,
    );

    const insert = workspace.objectDatabase.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, provider_resource_id, title,
          mime_type, metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'generated_file', 'avalon_generated', ?, ?, ?, ?, 'attached', ?, ?)`,
    );
    insert.run(PUBLISHED, WORKSPACE, "terminal:published", "Design notes", "text/markdown", "{}", AT, AT);
    insert.run(
      BACKUP, WORKSPACE, "terminal-workspace-backup:call-1", "Terminal backup before acme/widget",
      "application/gzip", JSON.stringify({ size: 22_535_876, ...unlistedResourceMetadata() }), AT, AT,
    );
    const link = (resourceId: string, attachedAt: number): void => {
      sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES (?, NULL, 0, 'generated', '{}', ?, ?)`,
        resourceId, attachedAt, attachedAt,
      );
    };
    link(PUBLISHED, at);
    link(BACKUP, at + 1);

    const product = new WorkstreamObjectProductService(storage, store, createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspace.instance, ["executeRuntimeSql"]),
    }));

    // `GET /workstreams/:id` and the socket's first frame assemble here, and
    // this list is `workstream.resources` — the rail's whole input.
    const detail = await product.getAdmitted({
      sessionId: "resource-listing-session",
      userId: principal.userId,
      workspaceId: WORKSPACE,
      region: "global",
      role: "owner",
    }, [], false);
    expect(detail.resources.map((resource) => resource.id)).toEqual([PUBLISHED]);
    expect(detail.resources[0]?.direction).toBe("artifact");
  });
});

describe("a Breakout's resource links", () => {
  const BREAKOUT = "00000000-0000-7000-8000-0000000000c1";

  /** A conversation object holding one link each to `links`, as an attach writes them. */
  function conversationStore(
    onFinished: (close: () => void) => void,
    links: Array<[resourceId: string, relationship: string, attachedAt: number]>,
    substreamId?: string,
  ) {
    const store = testWorkstreamObjectStore();
    onFinished(() => store.close());
    seedWorkstreamObjectRoot(store, { workstreamId: WORKSTREAM, workspaceId: WORKSPACE });
    if (substreamId) {
      store.prepare(`INSERT INTO substream_agent_identity (id, external_substream_id, created_at, updated_at)
        VALUES (1, ?, 1, 1) ON CONFLICT(id) DO UPDATE SET external_substream_id = excluded.external_substream_id`)
        .run(substreamId);
    }
    for (const [resourceId, relationship, attachedAt] of links) {
      store.prepare(`INSERT INTO workstream_resource_links
          (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
        VALUES (?, NULL, 0, ?, '{}', ?, ?)`).run(resourceId, relationship, attachedAt, attachedAt);
    }
    return store;
  }

  it("keeps its own link where it and its Channel both hold one", async ({ onTestFinished }) => {
    const close = (fn: () => void) => onTestFinished(fn);
    const channel = conversationStore(close, [[PUBLISHED, "generated", 1], [BACKUP, "generated", 2]]);
    const breakout = conversationStore(close, [[PUBLISHED, "attachment", 3]], BREAKOUT);

    const { links } = await testConversationResourceLinks(breakout, channel).links({});
    expect(links.map((row) => [row.resource_id, row.relationship_type]))
      .toEqual([[PUBLISHED, "attachment"], [BACKUP, "generated"]]);
  });

  it("identifies Breakouts, Sidekicks and ordinary workers for resource inheritance", async ({ onTestFinished }) => {
    const close = (fn: () => void) => onTestFinished(fn);
    const inherits = (store: DatabaseSync) => testResourcePort(store).inheritanceContext();
    await expect(inherits(conversationStore(close, [], BREAKOUT))).resolves.toEqual({ kind: "breakout" });
    // A Channel's own conversation.
    await expect(inherits(conversationStore(close, []))).resolves.toEqual({ kind: "none" });
    // A Sidekick's run child is a substream of an automation parent.
    const run = conversationStore(close, [], BREAKOUT);
    run.prepare(`UPDATE workstream SET parent_kind = 'automation' WHERE id = 1`).run();
    await expect(inherits(run)).resolves.toEqual({ kind: "sidekick", sidekickId: WORKSTREAM, substreamId: BREAKOUT });
    // A start_agent worker is a substream of the Channel, and sees only what it was handed.
    const worker = conversationStore(close, [], BREAKOUT);
    worker.prepare(`INSERT INTO background_agent (id, execution_principal_json) VALUES (1, '{}')`).run();
    await expect(inherits(worker)).resolves.toEqual({ kind: "none" });
  });

  it("reads its own revision back from either fingerprint", () => {
    expect(ownInventoryRevision("inventory:7")).toBe(7);
    expect(ownInventoryRevision("inventory:7/3")).toBe(7);
    expect(ownInventoryRevision("inventory:")).toBeNull();
    expect(ownInventoryRevision("inventory:7/")).toBeNull();
  });
});
