import { type UserId } from "@avalon/contracts";
import { asUserId, asWorkspaceId } from "@avalon/contracts";
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { AuthContext } from "../src/env";
import { ResourceService } from "../src/services/resource-service";
import { createTestD1Database, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";
import { testSubstreamAgentsBinding } from "./helpers/durable-authority";

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
};

function row(id: string, title: string, updatedAt: string): Record<string, unknown> {
  return {
    id,
    workspace_id: workspaceId,
    connection_id: "00000000-0000-7000-8000-000000000004",
    resource_type: "github_pull_request",
    provider: "github",
    provider_resource_id: `provider-${id}`,
    title,
    mime_type: null,
    canonical_url: `https://github.com/avalon/example/pull/${id}`,
    watch_enabled: 0,
    last_hydrated_at: null,
    content_ref: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

describe("resource listing", () => {
  it("uses workspace-scoped keyset pagination and searches generic resource rows", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const pages = [
      [
        row(firstResourceId, "Release repository", "2026-08-01T12:00:00.000Z"),
        row(secondResourceId, "Release pull request", "2026-08-01T11:00:00.000Z"),
        row(thirdResourceId, "Older result", "2026-08-01T10:00:00.000Z"),
      ],
      [],
    ];
    const database = createTestD1Database({
      prepare(sql: string) {
        const recorded = { sql, values: [] as unknown[] };
        statements.push(recorded);
        return {
          bind(...values: unknown[]) {
            recorded.values = values;
            return this;
          },
          async all() {
            return { results: pages.shift() ?? [], success: true, meta: {} };
          },
        };
      },
    });
    const service = new ResourceService(createTestEnv({ DB: database }), auth);

    const first = await service.list({ limit: 2 });
    expect(first.items.map((resource) => resource.id)).toEqual([firstResourceId, secondResourceId]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const firstResourceStatement = statements.find((statement) => statement.sql.includes("FROM resources r"));
    expect(firstResourceStatement?.sql.replace(/\s+/gu, " ")).toContain(
      "WHERE r.workspace_id = ? AND (c.id IS NULL OR c.scope = 'workspace' OR c.owner_user_id = ?)",
    );
    expect(firstResourceStatement?.sql).toContain("ORDER BY r.updated_at DESC, r.id DESC");
    // Two fewer `userId` bindings than before: the inbound-email visibility
    // clause they belonged to was the closed-authority arm's, and inbound-email
    // scoping is now a per-row authorization read against the work-stream
    // object rather than a subquery in this statement.
    expect(firstResourceStatement?.values).toEqual([workspaceId, userId, userId, 3]);

    await service.list({ query: "Release_100%", cursor: first.nextCursor!, limit: 2 });
    const second = statements.filter((statement) => statement.sql.includes("FROM resources r"))[1]!;
    expect(second.sql).toContain("LOWER(r.title) LIKE ?");
    expect(second.sql).toContain("r.updated_at < ? OR (r.updated_at = ? AND r.id < ?)");
    expect(second.values.slice(0, 7)).toEqual([
      workspaceId,
      userId,
      userId,
      "%release\\_100\\%%",
      "%release\\_100\\%%",
      "%release\\_100\\%%",
      "%release\\_100\\%%",
    ]);
    expect(second.values.slice(-4)).toEqual([
      "2026-08-01T11:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
      secondResourceId,
      3,
    ]);
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

  it("keeps inbound-email resources scoped to visible attached work streams", async () => {
    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE connector_connections (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner_user_id TEXT
      );
      CREATE TABLE resources (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT,
        resource_type TEXT NOT NULL, provider TEXT NOT NULL, provider_resource_id TEXT,
        title TEXT NOT NULL, mime_type TEXT, canonical_url TEXT, content_ref TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}', last_hydrated_at TEXT,
        uploaded_by_user_id TEXT, attachment_status TEXT NOT NULL DEFAULT 'attached',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE automation_subscriptions (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL, owner_user_id TEXT
      );
      CREATE TABLE workstreams (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
        created_by_user_id TEXT, automation_subscription_id TEXT
      );
      CREATE TABLE workstream_participants (
        workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, removed_at TEXT
      );
      CREATE TABLE workstream_resources (
        workstream_id TEXT NOT NULL, resource_id TEXT NOT NULL, relationship_type TEXT NOT NULL
      );
      -- The workspace object's own link table, which the listing statement
      -- reads now that the closed-authority arm reading message_attachments
      -- is gone.
      CREATE TABLE workspace_workstream_resource_links (
        workstream_id TEXT NOT NULL, resource_id TEXT NOT NULL
      );
      CREATE TABLE resource_watches (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, workstream_id TEXT NOT NULL,
        resource_id TEXT NOT NULL, enabled INTEGER NOT NULL
      );
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT NOT NULL,
        scope TEXT NOT NULL, owner_user_id TEXT NOT NULL, archived_at TEXT
      );
      INSERT INTO automation_subscriptions (id, workspace_id, scope, owner_user_id)
        VALUES ('personal-subscription', '${workspaceId}', 'personal', 'c0000000-0000-4000-8000-000000000c01');
      INSERT INTO workstreams (id, workspace_id, scope, created_by_user_id, automation_subscription_id)
        VALUES ('private-workstream', '${workspaceId}', 'personal',
                'c0000000-0000-4000-8000-000000000c01', 'personal-subscription'),
               ('private-ad-hoc-workstream', '${workspaceId}', 'personal',
                'c0000000-0000-4000-8000-000000000c01', NULL);
      INSERT INTO workstream_participants (workstream_id, user_id, removed_at)
        VALUES ('private-workstream', 'c0000000-0000-4000-8000-000000000c03', NULL);
      INSERT INTO resources
        (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
         title, mime_type, canonical_url, content_ref, last_hydrated_at, created_at, updated_at)
        VALUES ('email-resource', '${workspaceId}', NULL, 'email', 'resend', 'email-1',
                'Private email', 'application/json', NULL, 'private/email.json',
                '2026-08-02T18:00:00.000Z', '2026-08-02T18:00:00.000Z', '2026-08-02T18:00:00.000Z'),
               ('ad-hoc-email-resource', '${workspaceId}', NULL, 'email', 'resend', 'email-2',
                'Private ad hoc email', 'application/json', NULL, 'private/ad-hoc-email.json',
                '2026-08-02T19:00:00.000Z', '2026-08-02T19:00:00.000Z', '2026-08-02T19:00:00.000Z');
    `);
    const d1 = sqliteD1(database);
    const payloadReads: string[] = [];
    const environment = createTestEnv({
      DB: d1,
      AVALON_REGION: "global",
      // Inbound-email visibility used to be a subquery in the listing statement;
      // it is a per-row `resourceAccess` call against the workspace object now.
      // The stub answers that from the same fixture, so what this test is about
      // — who may see a private email, and who may not — is unchanged.
      WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
        extra: { resourceAccess: resourceAccessFrom(database) },
      }),
      PAYLOADS: {
        async get(key: string) {
          payloadReads.push(key);
          return null;
        },
      },
    });

    // Provider identity keeps the email private even before the attachment
    // transaction has committed.
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c01"))).list({ limit: 10 }))
      .resolves.toMatchObject({ items: [] });

    database.exec(`
      INSERT INTO workstream_resources (workstream_id, resource_id, relationship_type)
        VALUES ('private-workstream', 'email-resource', 'inbound_email'),
               ('private-ad-hoc-workstream', 'ad-hoc-email-resource', 'inbound_email');
    `);

    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c02"))).list({ limit: 10 }))
      .resolves.toMatchObject({ items: [] });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c02"))).get("email-resource"))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c02"))).get("ad-hoc-email-resource"))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c02"))).content("email-resource"))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c02"))).preview("email-resource", new AbortController().signal))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    expect(payloadReads).toHaveLength(0);

    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c03"))).list({ limit: 10 }))
      .resolves.toMatchObject({ items: [expect.objectContaining({ id: "email-resource" })] });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c03"))).get("email-resource"))
      .resolves.toMatchObject({ id: "email-resource", provider: "resend" });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c01"))).get("email-resource"))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    await expect(new ResourceService(environment, authFor(asUserId("c0000000-0000-4000-8000-000000000c01"))).get("ad-hoc-email-resource"))
      .rejects.toMatchObject({ status: 404, code: "resource_not_found" });
    database.close();
  });
});

/**
 * The workspace object's `resourceAccess`, answering from this fixture.
 *
 * Inbound-email visibility used to be a subquery inside the listing statement.
 * That arm only ran with the authority closed; the live path asks the object
 * per row. The stub reads the same seeded tables, so what this test is about —
 * which member may see a private email — is unchanged.
 */
function resourceAccessFrom(database: DatabaseSync) {
  return async (input: { resourceId: string; userId: string }) => ({
    items: database.prepare(
      `SELECT wr.workstream_id, w.scope, w.created_by_user_id, w.automation_subscription_id,
              EXISTS (
                SELECT 1 FROM workstream_participants p
                 WHERE p.workstream_id = wr.workstream_id AND p.user_id = ?
                   AND p.removed_at IS NULL
              ) AS is_participant
         FROM workstream_resources wr
         JOIN workstreams w ON w.id = wr.workstream_id
        WHERE wr.resource_id = ?`,
    ).all(input.userId, input.resourceId).map((row) => {
      const item = row as Record<string, unknown>;
      return {
        workstreamId: String(item.workstream_id),
        scope: String(item.scope) as "personal" | "workspace",
        createdByUserId: item.created_by_user_id == null ? null : String(item.created_by_user_id),
        automationSubscriptionId: item.automation_subscription_id == null
          ? null
          : String(item.automation_subscription_id),
        isParticipant: Number(item.is_participant) === 1,
      };
    }),
  });
}

function authFor(authUserId: UserId): AuthContext {
  return { ...auth, userId: authUserId };
}

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
