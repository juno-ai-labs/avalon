import { describe, expect, it } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { ResourceService } from "../src/services/resource-service";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const userId = "00000000-0000-7000-8000-000000000002";
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
    const database = {
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
    } as unknown as D1Database;
    const service = new ResourceService({ DB: database } as Env, auth);

    const first = await service.list({ limit: 2 });
    expect(first.items.map((resource) => resource.id)).toEqual([firstResourceId, secondResourceId]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(statements[0]?.sql.replace(/\s+/gu, " ")).toContain(
      "WHERE r.workspace_id = ? AND (c.id IS NULL OR c.scope = 'workspace' OR c.owner_user_id = ?)",
    );
    expect(statements[0]?.sql).toContain("ORDER BY r.updated_at DESC, r.id DESC");
    expect(statements[0]?.values).toEqual([workspaceId, userId, 3]);

    await service.list({ query: "Release_100%", cursor: first.nextCursor!, limit: 2 });
    const second = statements[1]!;
    expect(second.sql).toContain("LOWER(r.title) LIKE ?");
    expect(second.sql).toContain("r.updated_at < ? OR (r.updated_at = ? AND r.id < ?)");
    expect(second.values.slice(0, 6)).toEqual([
      workspaceId,
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
    const database = {
      prepare() {
        prepared = true;
        throw new Error("storage should not be queried");
      },
    } as unknown as D1Database;
    const service = new ResourceService({ DB: database } as Env, auth);

    await expect(service.list({ cursor: "not-a-cursor", limit: 25 })).rejects.toMatchObject({
      status: 422,
      code: "invalid_resource_cursor",
    });
    expect(prepared).toBe(false);
  });
});
