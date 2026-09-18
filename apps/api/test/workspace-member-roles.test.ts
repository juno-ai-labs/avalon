import "../../../tests/isolated-region";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Hono } from "hono";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import type { HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { requireAuth } from "../src/middleware/auth";
import { workspaceRoutes } from "../src/routes/workspace";

import type { AuthContext, Env } from "../src/env";
import { WorkspaceService } from "../src/services/workspace-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { publishWorkspaceSync } from "../src/services/workspace-realtime-service";
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
const OUTSIDER_ID = "00000000-0000-7000-8000-000000000055";
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
  // The module mock is created once by the factory above, so its call record
  // outlives a test unless it is cleared here.
  vi.mocked(publishWorkspaceSync).mockClear();
  database = migratedSqliteDatabase();
  env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    // The route test authenticates through the real middleware, which needs the
    // development header path switched on; the service tests ignore both.
    APP_ENV: "development",
    RALLY_DEV_AUTH: "true",
  });
  seedUser(OWNER_ID, "owner@example.test", "Founder");
  seedUser(ADMIN_ID, "admin@example.test", "Second Admin");
  seedUser(MEMBER_ID, "member@example.test", "Ordinary Member");
  seedUser(INVITEE_ID, "invitee@example.test", "Not Yet Here");
  seedUser(OUTSIDER_ID, "outsider@example.test", "Ordinary Somebody");
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Rally', 'rally', 'global', ?, ?, ?)`,
  ).run(WORKSPACE_ID, OWNER_ID, NOW, NOW);
  seedMember(OWNER_ID, "owner");
  seedMember(MEMBER_ID, "member");
  seedMember(INVITEE_ID, "member", "invited");
});

afterEach(() => { database.close(); vi.restoreAllMocks(); });

/** The topics a committed role change has to invalidate, and nothing else. */
const ROLE_CHANGE_TOPICS = ["member_directory", "workspace_profile"];

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

  it("invalidates both the roster and the workspace profile, and neither for a write that did not happen", async () => {
    // Without this the call could be deleted, or either topic dropped, and
    // every other open window would keep drawing the old roster and the old
    // administrator controls with the suite still green.
    await serviceAs(OWNER_ID, "owner").setMemberRole(MEMBER_ID, "admin");
    expect(publishWorkspaceSync).toHaveBeenCalledTimes(1);
    expect(publishWorkspaceSync).toHaveBeenCalledWith(env, WORKSPACE_ID, ROLE_CHANGE_TOPICS);

    // Assigning the role somebody already holds writes nothing and still
    // announces: it is the retry path, and the only request able to repair an
    // invalidation an earlier identical call failed to publish.
    vi.mocked(publishWorkspaceSync).mockClear();
    await serviceAs(OWNER_ID, "owner").setMemberRole(MEMBER_ID, "admin");
    expect(publishWorkspaceSync).toHaveBeenCalledWith(env, WORKSPACE_ID, ROLE_CHANGE_TOPICS);

    // A refusal announces nothing, because nothing about the workspace moved.
    vi.mocked(publishWorkspaceSync).mockClear();
    await expect(serviceAs(OWNER_ID, "owner").setMemberRole(OWNER_ID, "member")).rejects.toThrow();
    expect(publishWorkspaceSync).not.toHaveBeenCalled();
  });

  it("republishes on retry after a publish that failed, without writing the row twice", async () => {
    // The whole reason the no-op path publishes. The first call commits the
    // role and loses its announcement; the retry a caller makes next finds the
    // role already set, writes nothing, and is what puts the invalidation out.
    vi.mocked(publishWorkspaceSync).mockRejectedValueOnce(new Error("workspace_object_unreachable"));
    await serviceAs(OWNER_ID, "owner").setMemberRole(MEMBER_ID, "admin");
    expect(roleOf(MEMBER_ID)).toBe("admin");

    vi.mocked(publishWorkspaceSync).mockClear();
    await serviceAs(OWNER_ID, "owner").setMemberRole(MEMBER_ID, "admin");
    expect(publishWorkspaceSync).toHaveBeenCalledWith(env, WORKSPACE_ID, ROLE_CHANGE_TOPICS);
    expect(roleOf(MEMBER_ID)).toBe("admin");
  });

  it("keeps a committed role change successful when its invalidation cannot be published", async () => {
    // The write has already committed, so reporting a publish failure as a
    // failed role change tells the caller the opposite of what happened — and
    // on a self-demotion their next request no longer has the standing to
    // retry, while the idempotent no-op above means a retry could not
    // republish either.
    vi.mocked(publishWorkspaceSync).mockRejectedValueOnce(new Error("workspace_object_unreachable"));
    await expect(serviceAs(OWNER_ID, "owner").setMemberRole(MEMBER_ID, "admin")).resolves.toBeUndefined();
    expect(roleOf(MEMBER_ID)).toBe("admin");
  });

  it("carries the route's own path, body and status, with real authentication in front of it", async () => {
    // The service tests above drive the method directly, which proves nothing
    // about the endpoint's path parameter, its body schema, or the middleware
    // that resolves `auth.role` from `workspace_members` ahead of it.
    const app = new Hono<HonoAppEnv>();
    app.use("*", requireAuth);
    app.route("/workspace", workspaceRoutes);
    app.onError(errorHandler);
    const patch = (actor: string, target: string, body: unknown) => app.request(
      `/workspace/members/${target}/role`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-rally-dev-user-id": actor,
          "x-rally-dev-workspace-id": WORKSPACE_ID,
        },
        body: JSON.stringify(body),
      },
      env,
    );

    expect((await patch(OWNER_ID, MEMBER_ID, { role: "admin" })).status).toBe(204);
    expect(roleOf(MEMBER_ID)).toBe("admin");

    // The promoted member is an administrator on their very next request,
    // because the middleware reads the row rather than anything cached.
    seedMember(ADMIN_ID, "member");
    expect((await patch(MEMBER_ID, ADMIN_ID, { role: "admin" })).status).toBe(204);
    expect(roleOf(ADMIN_ID)).toBe("admin");

    // The body schema, and a role the route may not assign.
    expect((await patch(OWNER_ID, MEMBER_ID, { role: "owner" })).status).toBe(400);
    expect((await patch(OWNER_ID, MEMBER_ID, {})).status).toBe(400);
    expect(roleOf(MEMBER_ID)).toBe("admin");

    // The path parameter names somebody, and the gate is real.
    expect((await patch(OWNER_ID, INVITEE_ID, { role: "admin" })).status).toBe(409);
    seedMember(OUTSIDER_ID, "member");
    expect((await patch(OUTSIDER_ID, MEMBER_ID, { role: "member" })).status).toBe(403);
    expect(roleOf(MEMBER_ID)).toBe("admin");
  });

  it("names the field when the role is not one an administrator may assign", async () => {
    await expect(serviceAs(OWNER_ID, "owner")
      .setMemberRole(MEMBER_ID, "owner" as unknown as "admin"))
      .rejects.toMatchObject({ status: 400, code: "member_role_invalid:-root-:invalid_value" });
    expect(roleOf(MEMBER_ID)).toBe("member");
  });
});
