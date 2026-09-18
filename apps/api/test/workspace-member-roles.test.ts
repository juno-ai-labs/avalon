import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import type { AuthContext, Env } from "../src/env";
import { WorkspaceService } from "../src/services/workspace-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type * as WorkspaceRealtimeService from "../src/services/workspace-realtime-service";

/**
 * A workspace's second administrator.
 *
 * `workspace_members.role` has always been one row per person, so N
 * administrators were representable from migration 0001 — nothing here changes
 * the schema. What is proved instead is the write that assigns one: it runs
 * against the checked-in migrations, so the `CHECK (role IN (...))` the column
 * declares and the conditional `WHERE` the guards live in are the production
 * ones rather than a fixture's.
 *
 * The sync publish is the one collaborator doubled: it addresses a WorkspaceDO,
 * and the Node suite runs none.
 */
vi.mock("../src/services/workspace-realtime-service", async (importActual) => ({
  ...await importActual<typeof WorkspaceRealtimeService>(),
  publishWorkspaceSync: vi.fn(async () => 1),
}));

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const OWNER_ID = "00000000-0000-7000-8000-000000000011";
const ADMIN_ID = "00000000-0000-7000-8000-000000000022";
const MEMBER_ID = "00000000-0000-7000-8000-000000000033";
const INVITEE_ID = "00000000-0000-7000-8000-000000000044";
const NOW = "2026-09-17T12:00:00.000Z";

let database: DatabaseSync;
let env: Env;

function seedUser(id: string, email: string, name: string): void {
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, `google-${id}`, email, name, NOW, NOW);
}

function seedMember(userId: string, role: string, status = "active"): void {
  database.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(WORKSPACE_ID, userId, role, status, NOW);
}

function roleOf(userId: string): string | undefined {
  return (database.prepare(
    "SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?",
  ).get(WORKSPACE_ID, userId) as { role: string } | undefined)?.role;
}

function serviceAs(userId: string, role: "owner" | "admin" | "member"): WorkspaceService {
  const auth: AuthContext = {
    sessionId: `session-${userId}`,
    userId: asUserId(userId),
    workspaceId: asWorkspaceId(WORKSPACE_ID),
    region: env.AVALON_REGION,
    role,
  };
  return new WorkspaceService(env, auth);
}

beforeEach(() => {
  database = migratedSqliteDatabase();
  env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "production" });
  seedUser(OWNER_ID, "owner@example.test", "Founder");
  seedUser(ADMIN_ID, "admin@example.test", "Second Admin");
  seedUser(MEMBER_ID, "member@example.test", "Ordinary Member");
  seedUser(INVITEE_ID, "invitee@example.test", "Not Yet Here");
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Rally', 'rally', 'global', ?, ?, ?)`,
  ).run(WORKSPACE_ID, OWNER_ID, NOW, NOW);
  seedMember(OWNER_ID, "owner");
  seedMember(MEMBER_ID, "member");
  seedMember(INVITEE_ID, "member", "invited");
});

afterEach(() => { database.close(); vi.restoreAllMocks(); });

describe("assigning a workspace member's role", () => {
  it("promotes a member to administrator, and lets that new administrator promote another", async () => {
    await serviceAs(OWNER_ID, "owner").setMemberRole(MEMBER_ID, "admin");
    expect(roleOf(MEMBER_ID)).toBe("admin");

    // The point of the whole change: the second administrator is a real one,
    // not a badge. They can hand the same standing to somebody else without
    // the founder being present.
    seedMember(ADMIN_ID, "member");
    await serviceAs(MEMBER_ID, "admin").setMemberRole(ADMIN_ID, "admin");
    expect(roleOf(ADMIN_ID)).toBe("admin");
  });

  it("demotes an administrator back to member while another administrator remains", async () => {
    seedMember(ADMIN_ID, "admin");
    await serviceAs(OWNER_ID, "owner").setMemberRole(ADMIN_ID, "member");
    expect(roleOf(ADMIN_ID)).toBe("member");
  });

  it("refuses to remove the last administrator, naming that as the reason", async () => {
    // A workspace whose only administrator is an `admin` — the schema permits
    // it (nothing declares that an owner row must exist), so the write may not
    // lean on the owner invariant another module enforces.
    database.prepare("DELETE FROM workspace_members WHERE user_id = ?").run(OWNER_ID);
    seedMember(ADMIN_ID, "admin");
    await expect(serviceAs(ADMIN_ID, "admin").setMemberRole(ADMIN_ID, "member"))
      .rejects.toMatchObject({ status: 409, code: "last_workspace_administrator" });
    expect(roleOf(ADMIN_ID)).toBe("admin");
  });

  it("lets an administrator step down once a second one exists", async () => {
    database.prepare("DELETE FROM workspace_members WHERE user_id = ?").run(OWNER_ID);
    seedMember(ADMIN_ID, "admin");
    await serviceAs(ADMIN_ID, "admin").setMemberRole(MEMBER_ID, "admin");
    await serviceAs(ADMIN_ID, "admin").setMemberRole(ADMIN_ID, "member");
    expect(roleOf(ADMIN_ID)).toBe("member");
    expect(roleOf(MEMBER_ID)).toBe("admin");
  });

  it("refuses an ordinary member, a missing person, the owner, and somebody who has not joined", async () => {
    await expect(serviceAs(MEMBER_ID, "member").setMemberRole(INVITEE_ID, "admin"))
      .rejects.toMatchObject({ status: 403, code: "workspace_admin_required" });
    await expect(serviceAs(OWNER_ID, "owner").setMemberRole(ADMIN_ID, "admin"))
      .rejects.toMatchObject({ status: 404, code: "member_not_found" });
    await expect(serviceAs(OWNER_ID, "owner").setMemberRole(OWNER_ID, "member"))
      .rejects.toMatchObject({ status: 403, code: "cannot_change_owner_role" });
    await expect(serviceAs(OWNER_ID, "owner").setMemberRole(INVITEE_ID, "admin"))
      .rejects.toMatchObject({ status: 409, code: "member_not_active" });
    expect(roleOf(OWNER_ID)).toBe("owner");
    expect(roleOf(INVITEE_ID)).toBe("member");
  });

  it("names the field when the role is not one an administrator may assign", async () => {
    await expect(serviceAs(OWNER_ID, "owner")
      .setMemberRole(MEMBER_ID, "owner" as unknown as "admin"))
      .rejects.toMatchObject({ status: 400, code: "member_role_invalid:-root-:invalid_value" });
    expect(roleOf(MEMBER_ID)).toBe("member");
  });
});
