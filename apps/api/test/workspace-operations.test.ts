import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { WorkspaceRetirementResultSchema } from "@rally/contracts";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workspaceOperatorRoutes } from "../src/routes/workspace-operations";
import { createCloudflareTestBinding, createTestDurableObjectId, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The door in front of retirement.
 *
 * The walk itself infers nothing from an id; this route is where the checks
 * live: the operator credential in its `demos` role is the only way in, the
 * confirmation has to name the workspace being closed, and the id has to name
 * a workspace this region's own `workspaces` table holds — proved against the
 * real migrations, so the row read is the production one.
 */

const DEMOS_TOKEN = "demos-operator-token-0123456789abcdef0123456789";
const MISFILED_DEMOS_TOKEN = "demos-token-in-the-telemetry-map-0123456789abcdef";
const MISFILED_SUPPORT_TOKEN = "support-token-in-the-demo-map-0123456789abcdef";
const SUPPORT_TOKEN = "support-operator-token-0123456789abcdef012345678";
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000aaaa";
const OTHER_ID = "00000000-0000-7000-8000-00000000bbbb";
const OWNER_ID = "00000000-0000-7000-8000-00000000cccc";
const NOW = "2026-09-08T12:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/** A workspace row in the region the test names, so the door's row read has something to find. */
function seedWorkspace(database: DatabaseSync, region: "global" | "eu"): void {
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, 'owner@example.test', 'Owner', ?, ?)`,
  ).run(OWNER_ID, `google-${OWNER_ID}`, NOW, NOW);
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Alto Capital-demo', 'alto-capital-demo', ?, ?, ?, ?)`,
  ).run(WORKSPACE_ID, region, OWNER_ID, NOW, NOW);
}

/**
 * WorkspaceDO as the walk sees it, for a workspace with nothing under it: the
 * Node suite runs no Durable Object, and what this file proves is the door —
 * the row read, the D1 fence, and the receipt the route answers with.
 */
function emptyWorkspaceObjects(calls: string[]): Env["WORKSPACE_DOS"] {
  const stub = {
    beginWorkspaceRetirement: async () => { calls.push("beginWorkspaceRetirement"); return { nodes: [] }; },
    workspaceRetirementProgress: async () => ({ remaining: 0, complete: true, nodes: [] }),
    retireObject: async () => {
      calls.push("retireObject");
      return { retired: true, retiredAt: 1, operationId: "op", actorUserId: null, reason: "operator_retirement", retainedOutbox: 0 };
    },
  };
  const binding: Env["WORKSPACE_DOS"] = createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => stub,
    jurisdiction: (): Env["WORKSPACE_DOS"] => binding,
  });
  return binding;
}

function fixture(options: { workspaceRegion?: "global" | "eu"; objectCalls?: string[] } = {}): { env: Env; app: Hono<HonoAppEnv>; database: DatabaseSync } {
  const database = migratedSqliteDatabase();
  databases.push(database);
  if (options.workspaceRegion) seedWorkspace(database, options.workspaceRegion);
  const env = createTestEnv({
    APP_ENV: "development",
    AVALON_REGION: "global",
    DB: sqliteD1(database),
    ...(options.objectCalls ? { WORKSPACE_DOS: emptyWorkspaceObjects(options.objectCalls) } : {}),
    // Two secrets of one shape. A token filed in the wrong one is what the
    // isolation has to refuse: a demos principal in the telemetry map never
    // reaches this route, and a support principal in the demo map verifies
    // but is refused by role.
    DEMO_OPERATORS_JSON: JSON.stringify({
      [DEMOS_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d1", role: "demos" },
      [MISFILED_SUPPORT_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d3", role: "support" },
    }),
    TELEMETRY_OPERATORS_JSON: JSON.stringify({
      [SUPPORT_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d2", role: "support" },
      [MISFILED_DEMOS_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d4", role: "demos" },
    }),
  });
  const app = new Hono<HonoAppEnv>();
  app.route("/internal/workspaces", workspaceOperatorRoutes);
  app.onError(errorHandler);
  return { env, app, database };
}

const confirmed = (workspaceId: string) => JSON.stringify({ confirmWorkspaceId: workspaceId });

describe("the workspace retirement route", () => {
  it("admits only the demos role, and only from the demo secret", async () => {
    const { env, app } = fixture();
    const path = `/internal/workspaces/${WORKSPACE_ID}/retire`;
    const attempt = (token?: string) => app.request(path, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: confirmed(WORKSPACE_ID),
    }, env);
    expect((await attempt()).status).toBe(401);
    // The telemetry map is not consulted here, whatever role its tokens carry.
    const support = await attempt(SUPPORT_TOKEN);
    expect(support.status).toBe(401);
    await expect(support.json()).resolves.toMatchObject({ error: { code: "operator_authentication_invalid" } });
    expect((await attempt(MISFILED_DEMOS_TOKEN)).status).toBe(401);
    // The demo map is, and the role still narrows it.
    const misfiled = await attempt(MISFILED_SUPPORT_TOKEN);
    expect(misfiled.status).toBe(403);
    await expect(misfiled.json()).resolves.toMatchObject({ error: { code: "operator_role_forbidden" } });
  });

  it("refuses a retirement whose confirmation names another workspace, or a workspace this region does not own", async () => {
    const { env, app } = fixture();
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const noBody = await app.request(`/internal/workspaces/${WORKSPACE_ID}/retire`, { method: "POST", headers, body: "{}" }, env);
    expect(noBody.status).toBe(400);
    const unconfirmed = await app.request(`/internal/workspaces/${WORKSPACE_ID}/retire`, {
      method: "POST", headers, body: confirmed(OTHER_ID),
    }, env);
    expect(unconfirmed.status).toBe(409);
    await expect(unconfirmed.json()).resolves.toMatchObject({ error: { code: "workspace_retirement_unconfirmed" } });

    // Confirmed, and unknown here: an id the other region owns would otherwise
    // be "retired" as a set of brand-new empty objects.
    const unknown = await app.request(`/internal/workspaces/${WORKSPACE_ID}/retire`, {
      method: "POST", headers, body: confirmed(WORKSPACE_ID),
    }, env);
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: { code: "workspace_not_found" } });
  });

  it("refuses a workspace the other region owns, even though its row is in the table", async () => {
    // The predicate the door exists for. Against an empty table the 404 above
    // proves nothing about the region clause; this row is present, named by the
    // request, and owned by EU — dropping `AND region = ?` admits it.
    const { env, app } = fixture({ workspaceRegion: "eu" });
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const response = await app.request(`/internal/workspaces/${WORKSPACE_ID}/retire`, {
      method: "POST", headers, body: confirmed(WORKSPACE_ID),
    }, env);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "workspace_not_found" } });
  });

  it("closes the workspace in D1 before walking its objects, and answers the contract's receipt", async () => {
    // The objects' gate stops what reaches an object; authentication, the
    // member list and invitations are D1 reads that reach none, and
    // `abandoned_at` is the fence every one of them applies. A retirement that
    // left it NULL left the workspace open to sign-in.
    const calls: string[] = [];
    const { env, app, database } = fixture({ workspaceRegion: "global", objectCalls: calls });
    const headers = { authorization: `Bearer ${DEMOS_TOKEN}`, "content-type": "application/json" };
    const response = await app.request(`/internal/workspaces/${WORKSPACE_ID}/retire`, {
      method: "POST", headers, body: confirmed(WORKSPACE_ID),
    }, env);
    expect(response.status).toBe(200);
    const receipt = WorkspaceRetirementResultSchema.parse(await response.json());
    expect(receipt).toMatchObject({ workspaceId: WORKSPACE_ID, complete: true, remaining: 0, parents: 0, failed: [] });
    expect(calls).toEqual(["beginWorkspaceRetirement", "retireObject"]);

    const row = database.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?").get(WORKSPACE_ID) as { abandoned_at: string | null };
    expect(row.abandoned_at).not.toBeNull();

    // Resumable: a second pass keeps the first instant rather than moving it.
    const again = await app.request(`/internal/workspaces/${WORKSPACE_ID}/retire`, {
      method: "POST", headers, body: confirmed(WORKSPACE_ID),
    }, env);
    expect(again.status).toBe(200);
    const after = database.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?").get(WORKSPACE_ID) as { abandoned_at: string | null };
    expect(after.abandoned_at).toBe(row.abandoned_at);
  });
});
