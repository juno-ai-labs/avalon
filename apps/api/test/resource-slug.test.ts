/**
 * Allocating a resource's short alias.
 *
 * The alias is an alias: the UUID stays the primary key, so what these prove
 * is that allocation converges — one alias per resource, never two resources
 * on one alias, and a resource that already has one keeps it.
 */
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ResourceService } from "../src/services/resource-service";
import { backfillResourceSlugs, ensureResourceSlug, RESOURCE_SLUG_PATTERN } from "../src/services/resource-slug";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { workspaceObjectSqliteDatabase } from "./helpers/workspace-object-tables";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-0000000000d1");

const open: DatabaseSync[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

function fixture(resourceIds: string[]): { database: DatabaseSync; env: ReturnType<typeof createTestEnv> } {
  const database = workspaceObjectSqliteDatabase(workspaceId);
  open.push(database);
  const insert = database.prepare(
    `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at)
     VALUES (?, ?, 'document', 'notion', 'Spec', '{}',
             '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z')`,
  );
  for (const id of resourceIds) insert.run(id, workspaceId);
  return {
    database,
    env: createTestEnv({
      DB: sqliteD1(database),
      SESSION_SIGNING_KEY: "0".repeat(64),
    }),
  };
}

function slugOf(database: DatabaseSync, resourceId: string): string | null {
  return (database.prepare("SELECT slug FROM resources WHERE id = ?").get(resourceId) as {
    slug: string | null;
  }).slug;
}

describe("resource slug allocation", () => {
  it("gives a resource one alias and keeps returning it", async () => {
    const { database, env } = fixture(["resource-1"]);

    const first = await ensureResourceSlug(env, workspaceId, "resource-1");

    expect(first).toMatch(RESOURCE_SLUG_PATTERN);
    expect(slugOf(database, "resource-1")).toBe(first);
    // Idempotent: a second caller — the maintenance pass beside a creation
    // path, or a retried request — reads the alias rather than minting one.
    await expect(ensureResourceSlug(env, workspaceId, "resource-1")).resolves.toBe(first);
  });

  it("leaves an alias a resource already carries exactly as it is", async () => {
    const { database, env } = fixture(["resource-1"]);
    // An alias no generator would mint, so a re-allocation is visible rather
    // than hidden behind a deterministic candidate. Aliases appear in what a
    // model has already read and written; re-minting one breaks those.
    database.exec("UPDATE resources SET slug = 'alias-from-somewhere-else' WHERE id = 'resource-1'");

    await expect(ensureResourceSlug(env, workspaceId, "resource-1"))
      .resolves.toBe("alias-from-somewhere-else");
    expect(slugOf(database, "resource-1")).toBe("alias-from-somewhere-else");
  });

  it("gives two resources different aliases, and answers nothing for a resource that is gone", async () => {
    const { env } = fixture(["resource-1", "resource-2"]);

    const first = await ensureResourceSlug(env, workspaceId, "resource-1");
    const second = await ensureResourceSlug(env, workspaceId, "resource-2");

    expect(second).not.toBe(first);
    await expect(ensureResourceSlug(env, workspaceId, "resource-missing")).resolves.toBeNull();
  });

  it("regenerates rather than failing when a candidate is already taken", async () => {
    const { database, env } = fixture(["resource-1", "resource-2"]);
    const taken = await ensureResourceSlug(env, workspaceId, "resource-1");
    // The alias `resource-2`'s first attempt would produce, parked on another
    // row: the allocator must move to its next attempt rather than give up or
    // hand two resources the same alias.
    database.exec("DELETE FROM resources WHERE id = 'resource-1'");
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at, slug)
       VALUES ('resource-3', ?, 'document', 'notion', 'Spec', '{}',
               '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z', ?)`,
    ).run(workspaceId, await firstCandidate(env, "resource-2"));

    const allocated = await ensureResourceSlug(env, workspaceId, "resource-2");

    expect(allocated).toMatch(RESOURCE_SLUG_PATTERN);
    expect(allocated).not.toBe(slugOf(database, "resource-3"));
    expect(allocated).not.toBe(taken);
  });

  it("fills in the resources an upgraded workspace had before aliases existed", async () => {
    const { database, env } = fixture(["resource-1", "resource-2", "resource-3"]);
    database.exec("UPDATE resources SET slug = 'kept-alias-from-before' WHERE id = 'resource-2'");

    await expect(backfillResourceSlugs(env, workspaceId)).resolves.toBe(2);

    expect(slugOf(database, "resource-2")).toBe("kept-alias-from-before");
    expect(slugOf(database, "resource-1")).toMatch(RESOURCE_SLUG_PATTERN);
    expect(slugOf(database, "resource-3")).toMatch(RESOURCE_SLUG_PATTERN);
    // Nothing is left due, so the alarm's stall check sees the pass finish.
    await expect(backfillResourceSlugs(env, workspaceId)).resolves.toBe(0);
  });

  it("carries the alias on the resource the listing surfaces read", async () => {
    const { database, env } = fixture(["00000000-0000-7000-8000-0000000000f1"]);
    const allocated = await ensureResourceSlug(env, workspaceId, "00000000-0000-7000-8000-0000000000f1");
    const service = new ResourceService(env, {
      sessionId: "session-1", userId: asUserId("00000000-0000-7000-8000-0000000000d2"),
      workspaceId, region: "global", role: "owner",
    });

    await expect(service.get("00000000-0000-7000-8000-0000000000f1"))
      .resolves.toMatchObject({ slug: allocated });
    await expect(service.list({ limit: 10 }))
      .resolves.toMatchObject({ items: [{ slug: allocated }] });
    void database;
  });

  it("does not turn an alias into a new version of the resource", async () => {
    const { database, env } = fixture(["resource-1"]);

    await ensureResourceSlug(env, workspaceId, "resource-1");

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resource_versions WHERE resource_id = 'resource-1'",
    ).get()).toEqual({ count: 1 });
  });
});

/** The alias the allocator would mint first for a resource, without writing. */
async function firstCandidate(env: ReturnType<typeof createTestEnv>, resourceId: string): Promise<string> {
  const { resourceSlugCandidate } = await import("../src/services/resource-slug");
  return resourceSlugCandidate(env, workspaceId, resourceId, 0);
}
