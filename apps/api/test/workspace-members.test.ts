import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Hono } from "hono";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { requireIdentityAuth, requireWorkspaceAuth } from "../src/middleware/auth";
import { workspaceMembers } from "../src/routes/workspace";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The roster as a guest reads it, through the real middleware and checked-in
 * migrations: everyone active in the Organization, other guests included, with
 * their email and timezone.
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
  app.get("/workspace/members", requireWorkspaceAuth, workspaceMembers);
  app.onError(errorHandler);
  return app.request("/workspace/members", {
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

type Row = { user: { name: string; email: string; timezone: string }; accessClass?: string; role: string | null };

describe("the roster as a guest reads it", () => {
  it("shows a guest every active person, other guests included, with email and timezone", async () => {
    const response = await roster(GUEST_ID);

    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: Row[] }).items;
    expect(items.map((row) => [row.user.name, row.user.email, row.accessClass ?? "member", row.role])).toEqual([
      ["Guest", "guest@example.test", "guest", null],
      ["Member", "member@example.test", "member", "member"],
      ["Owner", "owner@example.test", "member", "owner"],
      ["Visitor", "visitor@example.test", "guest", null],
    ]);
    expect(items.every((row) => row.user.timezone.length > 0)).toBe(true);
  });
});
