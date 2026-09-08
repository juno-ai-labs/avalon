/**
 * Allocating a resource's short alias.
 *
 * The alias is an alias: the UUID stays the primary key, so what these prove
 * is that allocation converges — one alias per resource, never two resources
 * on one alias, and a resource that already has one keeps it. The claims run
 * against a real WorkspaceDO over its own schema; only the transport is
 * doubled, so the partial unique index and the version-capture triggers are
 * the object's rather than a fixture's.
 */
import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ResourceService } from "../src/services/resource-service";
import { backfillResourceSlugs, ensureResourceSlug, RESOURCE_SLUG_PATTERN } from "../src/services/resource-slug";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import {
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-0000000000d1");
const RESOURCE_1 = "00000000-0000-7000-8000-0000000000e1";
const RESOURCE_2 = "00000000-0000-7000-8000-0000000000e2";
const RESOURCE_3 = "00000000-0000-7000-8000-0000000000e3";
const RESOURCE_MISSING = "00000000-0000-7000-8000-0000000000ee";

const open: DatabaseSync[] = [];
afterEach(() => { for (const database of open.splice(0)) database.close(); });

function fixture(resourceIds: string[]): { database: DatabaseSync; env: ReturnType<typeof createTestEnv> } {
  const regional = new DatabaseSync(":memory:");
  open.push(regional);
  regional.exec(`CREATE TABLE workspace_members(workspace_id TEXT, user_id TEXT, status TEXT)`);
  regional.prepare("INSERT INTO workspace_members VALUES (?, ?, 'active')").run(workspaceId, "00000000-0000-7000-8000-0000000000d2");
  const workspaceObject = createTestWorkspaceDO({
    workspaceId,
    regionalDatabase: regional,
    register: (created) => { open.push(created); },
  });
  const database = workspaceObject.objectDatabase;
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
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      SESSION_SIGNING_KEY: "0".repeat(64),
      WORKSPACE_DOS: testWorkspaceObjectBinding(workspaceObject.instance, [
        "claimResourceSlug",
        "listResourcesAwaitingSlug",
        // The listing surfaces still read through the workspace runtime port;
        // the real object answers that SQL over the same store the claims use.
        "executeRuntimeSql",
      ]),
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
    const { database, env } = fixture([RESOURCE_1]);

    const first = await ensureResourceSlug(env, workspaceId, RESOURCE_1);

    expect(first).toMatch(RESOURCE_SLUG_PATTERN);
    expect(slugOf(database, RESOURCE_1)).toBe(first);
    // Idempotent: a second caller — the maintenance pass beside a creation
    // path, or a retried request — reads the alias rather than minting one.
    await expect(ensureResourceSlug(env, workspaceId, RESOURCE_1)).resolves.toBe(first);
  });

  it("leaves an alias a resource already carries exactly as it is", async () => {
    const { database, env } = fixture([RESOURCE_1]);
    // An alias no generator would mint, so a re-allocation is visible rather
    // than hidden behind a deterministic candidate. Aliases appear in what a
    // model has already read and written; re-minting one breaks those.
    database.prepare("UPDATE resources SET slug = 'alias-from-somewhere-else' WHERE id = ?")
      .run(RESOURCE_1);

    await expect(ensureResourceSlug(env, workspaceId, RESOURCE_1))
      .resolves.toBe("alias-from-somewhere-else");
    expect(slugOf(database, RESOURCE_1)).toBe("alias-from-somewhere-else");
  });

  it("gives two resources different aliases, and answers nothing for a resource that is gone", async () => {
    const { env } = fixture([RESOURCE_1, RESOURCE_2]);

    const first = await ensureResourceSlug(env, workspaceId, RESOURCE_1);
    const second = await ensureResourceSlug(env, workspaceId, RESOURCE_2);

    expect(second).not.toBe(first);
    await expect(ensureResourceSlug(env, workspaceId, RESOURCE_MISSING)).resolves.toBeNull();
  });

  it("regenerates rather than failing when a candidate is already taken", async () => {
    const { database, env } = fixture([RESOURCE_1, RESOURCE_2]);
    const taken = await ensureResourceSlug(env, workspaceId, RESOURCE_1);
    // The alias `RESOURCE_2`'s first attempt would produce, parked on another
    // row: the allocator must move to its next attempt rather than give up or
    // hand two resources the same alias.
    database.prepare("DELETE FROM resources WHERE id = ?").run(RESOURCE_1);
    database.prepare(
      `INSERT INTO resources
         (id, workspace_id, resource_type, provider, title, metadata_json, created_at, updated_at, slug)
       VALUES (?, ?, 'document', 'notion', 'Spec', '{}',
               '2026-08-28T01:00:00.000Z', '2026-08-28T01:00:00.000Z', ?)`,
    ).run(RESOURCE_3, workspaceId, await firstCandidate(env, RESOURCE_2));

    const allocated = await ensureResourceSlug(env, workspaceId, RESOURCE_2);

    expect(allocated).toMatch(RESOURCE_SLUG_PATTERN);
    expect(allocated).not.toBe(slugOf(database, RESOURCE_3));
    expect(allocated).not.toBe(taken);
  });

  it("fills in the resources an upgraded workspace had before aliases existed", async () => {
    const { database, env } = fixture([RESOURCE_1, RESOURCE_2, RESOURCE_3]);
    database.prepare("UPDATE resources SET slug = 'kept-alias-from-before' WHERE id = ?")
      .run(RESOURCE_2);

    await expect(backfillResourceSlugs(env, workspaceId)).resolves.toBe(2);

    expect(slugOf(database, RESOURCE_2)).toBe("kept-alias-from-before");
    expect(slugOf(database, RESOURCE_1)).toMatch(RESOURCE_SLUG_PATTERN);
    expect(slugOf(database, RESOURCE_3)).toMatch(RESOURCE_SLUG_PATTERN);
    // Nothing is left due, so the alarm's stall check sees the pass finish.
    await expect(backfillResourceSlugs(env, workspaceId)).resolves.toBe(0);
  });

  it("carries the alias on the resource the listing surfaces read", async () => {
    const { env } = fixture(["00000000-0000-7000-8000-0000000000f1"]);
    const allocated = await ensureResourceSlug(env, workspaceId, "00000000-0000-7000-8000-0000000000f1");
    const service = new ResourceService(env, {
      sessionId: "session-1", userId: asUserId("00000000-0000-7000-8000-0000000000d2"),
      workspaceId, region: "global", role: "owner",
    });

    await expect(service.get("00000000-0000-7000-8000-0000000000f1"))
      .resolves.toMatchObject({ slug: allocated });
    await expect(service.list({ limit: 10 }))
      .resolves.toMatchObject({ items: [{ slug: allocated }] });
  });

  it("does not turn an alias into a new version of the resource", async () => {
    const { database, env } = fixture([RESOURCE_1]);

    await ensureResourceSlug(env, workspaceId, RESOURCE_1);

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM resource_versions WHERE resource_id = ?",
    ).get(RESOURCE_1)).toEqual({ count: 1 });
  });
});

/** The alias the allocator would mint first for a resource, without writing. */
async function firstCandidate(env: ReturnType<typeof createTestEnv>, resourceId: string): Promise<string> {
  const { resourceSlugCandidate } = await import("../src/services/resource-slug");
  return resourceSlugCandidate(env, workspaceId, resourceId, 0);
}
