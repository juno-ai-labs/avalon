import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workspaceOperatorRoutes } from "../src/routes/workspace-operations";
import { createTestEnv } from "./helpers/cloudflare-test";
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
const SUPPORT_TOKEN = "support-operator-token-0123456789abcdef012345678";
const WORKSPACE_ID = "00000000-0000-7000-8000-00000000aaaa";
const OTHER_ID = "00000000-0000-7000-8000-00000000bbbb";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): { env: Env; app: Hono<HonoAppEnv> } {
  const database = migratedSqliteDatabase();
  databases.push(database);
  const env = createTestEnv({
    APP_ENV: "development",
    AVALON_REGION: "global",
    DB: sqliteD1(database),
    TELEMETRY_OPERATORS_JSON: JSON.stringify({
      [DEMOS_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d1", role: "demos" },
      [SUPPORT_TOKEN]: { operatorId: "00000000-0000-7000-8000-0000000000d2", role: "support" },
    }),
  });
  const app = new Hono<HonoAppEnv>();
  app.route("/internal/workspaces", workspaceOperatorRoutes);
  app.onError(errorHandler);
  return { env, app };
}

const confirmed = (workspaceId: string) => JSON.stringify({ confirmWorkspaceId: workspaceId });

describe("the workspace retirement route", () => {
  it("admits only the demos role", async () => {
    const { env, app } = fixture();
    const path = `/internal/workspaces/${WORKSPACE_ID}/retire`;
    const anonymous = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: confirmed(WORKSPACE_ID) }, env);
    expect(anonymous.status).toBe(401);
    const support = await app.request(path, {
      method: "POST", headers: { authorization: `Bearer ${SUPPORT_TOKEN}`, "content-type": "application/json" }, body: confirmed(WORKSPACE_ID),
    }, env);
    expect(support.status).toBe(403);
    await expect(support.json()).resolves.toMatchObject({ error: { code: "operator_role_forbidden" } });
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
});
