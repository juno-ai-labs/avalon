import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Hono } from "hono";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { requireIdentityAuth, requireWorkspaceAuth } from "../src/middleware/auth";
import { workspaceRoster } from "../src/routes/workspace";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The roster a guest may read, through the real middleware and checked-in
 * migrations: who is in the Organization, without addresses, and without the
 * other guests.
 */
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const OWNER_ID = "00000000-0000-7000-8000-000000000011";
const MEMBER_ID = "00000000-0000-7000-8000-000000000022";
const GUEST_ID = "00000000-0000-7000-8000-000000000033";
const OTHER_GUEST_ID = "00000000-0000-7000-8000-000000000044";
const SUSPENDED_ID = "00000000-0000-7000-8000-000000000055";
const NOW = "2026-10-24T12:00:00.000Z";

let database: DatabaseSync;
let env: Env;

function seed(id: string, name: string, role: string | null, accessClass: "member" | "guest", status = "active"): void {
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `google-${id}`, `${name.toLowerCase()}@example.test`, name, NOW, NOW);
  database.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, role, access_class, status, joined_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(WORKSPACE_ID, id, role, accessClass, status, NOW);
}

async function roster(actor: string): Promise<Response> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", requireIdentityAuth);
  app.get("/workspace/roster", requireWorkspaceAuth, workspaceRoster);
  app.onError(errorHandler);
  return app.request("/workspace/roster", {
    headers: { "x-rally-dev-user-id": actor, "x-rally-dev-workspace-id": WORKSPACE_ID },
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
    `INSERT INTO workspace_members(workspace_id, user_id, role, access_class, status, joined_at)
     VALUES (?, ?, 'owner', 'member', 'active', ?)`,
  ).run(WORKSPACE_ID, OWNER_ID, NOW);
  seed(MEMBER_ID, "Member", "member", "member");
  seed(GUEST_ID, "Guest", null, "guest");
  seed(OTHER_GUEST_ID, "Visitor", null, "guest");
  seed(SUSPENDED_ID, "Suspended", "member", "member", "suspended");
});

afterEach(() => { database.close(); });

describe("the guest-readable roster", () => {
  it("shows a guest the members and themselves, by name and role, with no address", async () => {
    const response = await roster(GUEST_ID);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [
      { id: GUEST_ID, name: "Guest", avatarUrl: null, presentation: null, accessClass: "guest", role: null },
      { id: MEMBER_ID, name: "Member", avatarUrl: null, presentation: null, accessClass: "member", role: "member" },
      { id: OWNER_ID, name: "Owner", avatarUrl: null, presentation: null, accessClass: "member", role: "owner" },
    ] });
  });

  it("shows a member every active person, guests included", async () => {
    const response = await roster(MEMBER_ID);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: Array<{ name: string }> }).items.map((person) => person.name))
      .toEqual(["Guest", "Member", "Owner", "Visitor"]);
  });
});
