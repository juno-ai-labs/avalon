/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Which database `resolveOriginResource` reaches for the `resources` row a work
 * stream's origin attachment points at.
 *
 * `resources` is a `WORKSPACE_LOCAL_TABLES` entry: it lives in WorkspaceDO's
 * own SQLite, and migration 0090 dropped it from regional D1. Every caller
 * hands this function an unwrapped environment — `POST
 * /work-opportunities/:id/start` → `WorkOpportunityService` →
 * `WorkstreamService.resolveDurableOpportunityOriginResources` → here, and none
 * of them wraps — so without a wrap of its own the lookup went to the regional
 * binding and raised `no such table: resources`. The caller catches that,
 * logs `workstream_opportunity_origin_resolve_failed` and returns an empty
 * list, so nothing failed visibly: a work stream started from a suggestion was
 * created normally and carried zero origin resources, on every attempt, from
 * the migration onwards.
 *
 * The Node coverage of the same function
 * (`test/workstream-origin-attachment.test.ts`) cannot see that, by
 * construction: it runs against `preRetirementProductSqliteDatabase()`, a D1
 * double that still has the retired product tables, so an unrouted read finds
 * one there. Here the table exists only inside the object that owns it and the
 * region genuinely does not have it, which is what makes a statement pointed at
 * the wrong authority fail the way it failed in production.
 *
 * Every call below is made with the plain workers-suite `env` — never wrapped
 * in `withWorkspaceRuntimeDatabase` — because the routing under test is the
 * function's own.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import {
  resolveOriginResource,
  type OriginResourceDescriptor,
} from "../src/services/workstream-origin-resource";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000e7000");
const CONNECTION_ID = "00000000-0000-7000-8000-0000000e7010";
const OTHER_CONNECTION_ID = "00000000-0000-7000-8000-0000000e7011";
const EXISTING_RESOURCE_ID = "00000000-0000-7000-8000-0000000e7020";
const PROVIDER_RESOURCE_ID = "RAL-417";
const CANONICAL_URL = "https://linear.app/juno-labs/issue/RAL-417";
const EARLIER = "2026-08-29T09:00:00.000Z";

/**
 * The environment the production callers hand this function: the regional
 * bindings, with no workspace-runtime port over `DB`. Annotated rather than
 * cast — the workers-suite `env` already satisfies `Env`, and a cast here would
 * hide binding drift.
 */
const testEnv: Env = env;

function workspaceStub(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/**
 * The regional half: the workspace row the object stub is addressed through,
 * and nothing else. Deliberately no `resources` — that is the state of a
 * migrated region, and declaring it here would let the defect this file covers
 * pass.
 */
async function seedRegionalDatabase(): Promise<void> {
  // `IF NOT EXISTS` / `OR REPLACE` rather than the bare forms: `reset()` is
  // supposed to drop D1's schema, but `participant-notification.test.ts` records
  // an incomplete wipe leaving tables standing, where a bare `CREATE TABLE` then
  // fails as `already exists` and buries the original failure.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, placement_affinity TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces (id, region, placement_affinity)
      VALUES (?, 'global', 'wnam')`).bind(WORKSPACE_ID),
  ]);
}

/**
 * Seed a row into the object that owns the table. The real WorkspaceDO already
 * carries the `resources` schema from its own migrations, so this inserts into
 * it rather than creating it — a hand-built table here would be asserting
 * against the fixture's schema instead of the object's.
 */
async function seedWorkspaceResource(input: {
  id?: string;
  connectionId?: string;
  title?: string;
  canonicalUrl?: string | null;
  contentRef?: string | null;
}): Promise<string> {
  const id = input.id ?? EXISTING_RESOURCE_ID;
  await runInDurableObject(workspaceStub(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO resources
         (id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
          title, content_ref, canonical_url, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, 'linear_issue', 'linear', ?, ?, ?, ?, '{}', ?, ?)`,
      id,
      WORKSPACE_ID,
      input.connectionId ?? CONNECTION_ID,
      PROVIDER_RESOURCE_ID,
      input.title ?? "Earlier title",
      input.contentRef ?? null,
      input.canonicalUrl ?? null,
      EARLIER,
      EARLIER,
    );
  });
  return id;
}

/** Every `resources` row the object holds, read inside the object that holds them. */
async function workspaceResourceRows(): Promise<Array<Record<string, string | number | null>>> {
  return runInDurableObject(workspaceStub(), (_instance, state) => (
    state.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT id, workspace_id, connection_id, resource_type, provider, provider_resource_id,
              title, content_ref, canonical_url, metadata_json, created_at, updated_at
         FROM resources ORDER BY id`,
    ).toArray()
  ));
}

/**
 * The shape `describeWorkstreamOrigin` hands on: a connector's origin, bound to
 * the connection it was reached through, with `contentRef` pinned to null the
 * way that function pins it.
 */
function descriptor(overrides: Partial<OriginResourceDescriptor> = {}): OriginResourceDescriptor {
  return {
    connectionId: CONNECTION_ID,
    provider: "linear",
    resourceType: "linear_issue",
    providerResourceId: PROVIDER_RESOURCE_ID,
    title: "Ship the origin attachment",
    canonicalUrl: null,
    contentRef: null,
    metadata: { identifier: "RAL-417" },
    ...overrides,
  };
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("resolving a work stream's origin resource against the authority that has the table", () => {
  // First, because it is the premise every other test in this file rests on.
  it("keeps `resources` out of regional D1, which is what makes the rest of this file evidence", async () => {
    await expect(env.DB.prepare(`SELECT id FROM resources LIMIT 1`).all())
      .rejects.toThrow(/no such table: resources/u);
  });

  it("finds the row a previous origin left in the workspace object", async () => {
    await seedWorkspaceResource({ canonicalUrl: CANONICAL_URL });

    await expect(resolveOriginResource(testEnv, WORKSPACE_ID, descriptor({
      canonicalUrl: CANONICAL_URL,
    }))).resolves.toBe(EXISTING_RESOURCE_ID);

    // The lookup alone: nothing was created beside the row it found.
    expect(await workspaceResourceRows()).toHaveLength(1);
  });

  it("fills a link the earlier row was created without, in the object that holds it", async () => {
    // A connector activity carries no permalink, so the row an earlier ingress
    // created has none; an origin described later does, and the rail row is
    // only clickable if it lands.
    await seedWorkspaceResource({ canonicalUrl: null });

    await expect(resolveOriginResource(testEnv, WORKSPACE_ID, descriptor({
      title: "A later, different title",
      canonicalUrl: CANONICAL_URL,
    }))).resolves.toBe(EXISTING_RESOURCE_ID);

    const [row] = await workspaceResourceRows();
    expect(row).toMatchObject({
      id: EXISTING_RESOURCE_ID,
      canonical_url: CANONICAL_URL,
      // The title belongs to whichever path created the row; rewriting it would
      // make the rail's wording flip with whichever ingress ran most recently.
      title: "Earlier title",
      // The other half of the same backfill. No caller supplies a content ref
      // today — `describeWorkstreamOrigin` pins it to null on purpose — so this
      // asserts the statement leaves it alone rather than exercising the fill.
      content_ref: null,
    });
    expect(row?.updated_at).not.toBe(EARLIER);
  });

  it("never overwrites a link the row already has", async () => {
    await seedWorkspaceResource({ canonicalUrl: "https://linear.app/juno-labs/issue/first" });

    await expect(resolveOriginResource(testEnv, WORKSPACE_ID, descriptor({
      canonicalUrl: CANONICAL_URL,
    }))).resolves.toBe(EXISTING_RESOURCE_ID);

    // No write at all, which the untouched `updated_at` is what proves.
    expect(await workspaceResourceRows()).toEqual([expect.objectContaining({
      canonical_url: "https://linear.app/juno-labs/issue/first",
      updated_at: EARLIER,
    })]);
  });

  it("creates the row in the workspace object when this workspace has never seen the object", async () => {
    const resourceId = await resolveOriginResource(testEnv, WORKSPACE_ID, descriptor({
      canonicalUrl: CANONICAL_URL,
    }));

    expect(resourceId).not.toBeNull();
    // Where it landed is the point: in the object's own SQLite, read back
    // through the object rather than through the port that wrote it.
    expect(await workspaceResourceRows()).toEqual([expect.objectContaining({
      id: resourceId,
      workspace_id: WORKSPACE_ID,
      connection_id: CONNECTION_ID,
      resource_type: "linear_issue",
      provider: "linear",
      provider_resource_id: PROVIDER_RESOURCE_ID,
      title: "Ship the origin attachment",
      canonical_url: CANONICAL_URL,
      content_ref: null,
      metadata_json: JSON.stringify({ identifier: "RAL-417" }),
    })]);
    // And nowhere else: the insert did not quietly acquire a regional copy.
    await expect(env.DB.prepare(`SELECT id FROM resources LIMIT 1`).all())
      .rejects.toThrow(/no such table: resources/u);
  });

  it("attaches the one row when a second work stream starts from the same object", async () => {
    const first = await resolveOriginResource(testEnv, WORKSPACE_ID, descriptor());
    const second = await resolveOriginResource(testEnv, WORKSPACE_ID, descriptor());

    // The read-back after the conflict-tolerant insert, against the object's
    // real unique index on (workspace, connection, provider, resource id).
    expect(second).toBe(first);
    expect(await workspaceResourceRows()).toHaveLength(1);
  });

  it("keeps the same provider object on a second connection apart", async () => {
    const first = await resolveOriginResource(testEnv, WORKSPACE_ID, descriptor());
    const second = await resolveOriginResource(testEnv, WORKSPACE_ID, descriptor({
      connectionId: OTHER_CONNECTION_ID,
    }));

    expect(second).not.toBe(first);
    expect((await workspaceResourceRows()).map((row) => row.connection_id))
      .toEqual(expect.arrayContaining([CONNECTION_ID, OTHER_CONNECTION_ID]));
  });
});
