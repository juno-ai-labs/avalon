import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Hono } from "hono";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { requireAuth } from "../src/middleware/auth";
import { workspaceRoutes } from "../src/routes/workspace";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * Renaming an Organization from settings, through the real route, middleware
 * and checked-in migrations.
 */
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const OWNER_ID = "00000000-0000-7000-8000-000000000011";
const MEMBER_ID = "00000000-0000-7000-8000-000000000033";
const NOW = "2026-09-17T12:00:00.000Z";

let database: DatabaseSync;
let env: Env;

function seedMember(id: string, role: string): void {
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `google-${id}`, `${role}@example.test`, role, NOW, NOW);
  database.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(WORKSPACE_ID, id, role, NOW);
}

function stored(): { name: string; timezone: string } {
  return database.prepare("SELECT name, timezone FROM workspaces WHERE id = ?")
    .get(WORKSPACE_ID) as { name: string; timezone: string };
}

function patch(actor: string, body: unknown): Promise<Response> | Response {
  const app = new Hono<HonoAppEnv>();
  app.use("*", requireAuth);
  app.route("/workspace", workspaceRoutes);
  app.onError(errorHandler);
  return app.request("/workspace", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-rally-dev-user-id": actor,
      "x-rally-dev-workspace-id": WORKSPACE_ID,
    },
    body: JSON.stringify(body),
  }, env);
}

beforeEach(() => {
  database = migratedSqliteDatabase();
  env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    APP_ENV: "development",
    RALLY_DEV_AUTH: "true",
  });
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-owner', 'owner@example.test', 'Owner', ?, ?)`,
  ).run(OWNER_ID, NOW, NOW);
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Rally', 'rally', 'global', 'America/Los_Angeles', ?, ?, ?)`,
  ).run(WORKSPACE_ID, OWNER_ID, NOW, NOW);
  database.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(WORKSPACE_ID, OWNER_ID, NOW);
  seedMember(MEMBER_ID, "member");
});

afterEach(() => { database.close(); });

describe("renaming an Organization", () => {
  it("stores the trimmed name and leaves the timezone alone", async () => {
    const response = await patch(OWNER_ID, { name: "  Juno Labs  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "Juno Labs", timezone: "America/Los_Angeles" });
    expect(stored()).toEqual({ name: "Juno Labs", timezone: "America/Los_Angeles" });
  });

  it("leaves the name alone when only the timezone changes", async () => {
    expect((await patch(OWNER_ID, { timezone: "Europe/London" })).status).toBe(200);
    expect(stored()).toEqual({ name: "Rally", timezone: "Europe/London" });
  });

  it("refuses a member, a blank name and an empty body without writing", async () => {
    expect((await patch(MEMBER_ID, { name: "Taken Over" })).status).toBe(403);
    expect((await patch(OWNER_ID, { name: "   " })).status).toBe(400);
    expect((await patch(OWNER_ID, {})).status).toBe(400);
    expect(stored()).toEqual({ name: "Rally", timezone: "America/Los_Angeles" });
  });
});
