import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { addEngineeringOrgMember } from "../src/services/engineering-members";
import { setUserShadowBan } from "../src/services/shadow-ban";
import { WorkspaceService, acceptInvitationForUser } from "../src/services/workspace-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { openWorkstreamAuthorityForTest } from "./helpers/durable-authority";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * Shadow bans against the checked-in migrations, so the guard under test is
 * the trigger pair production runs (`docs/shadow-ban.md`). Creating an
 * Organization is covered beside the other creation cases, in
 * `regional-workspace-create.test.ts`, and a Canvas share in
 * `test-workers/scope-invitations.test.ts`.
 */

const at = "2026-11-01T00:00:00.000Z";
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000b001");
const OTHER_WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000b002");
const OWNER = asUserId("00000000-0000-7000-8000-00000000b010");
/** Shadow banned, with a verified address, and in no Organization. */
const BANNED = asUserId("00000000-0000-7000-8000-00000000b011");
/** Shadow banned, and already a guest of `WORKSPACE`. */
const BANNED_GUEST = asUserId("00000000-0000-7000-8000-00000000b012");
const INVITATION = "00000000-0000-7000-8000-00000000b020";

let database: DatabaseSync;
let emailSend = vi.fn<(message: EmailMessageBuilder) => Promise<EmailSendResult>>();

function env(): Env {
  return createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "production", LOG_LEVEL: "error",
    PUBLIC_WEB_BASE_URL: "https://rally.example.test", EMAIL_FROM: "Rally <team@example.test>",
    EMAIL: { send: emailSend },
  });
}

const ownerAuth: AuthContext = { sessionId: "session-1", userId: OWNER, workspaceId: WORKSPACE, region: "global", role: "owner" };

const membership = (workspaceId: string, userId: string) => database.prepare(
  "SELECT role, access_class, status FROM workspace_members WHERE workspace_id = ? AND user_id = ?").get(workspaceId, userId);

const addMembership = (workspaceId: string, userId: string, accessClass: "member" | "guest") => database.prepare(
  "INSERT INTO workspace_members (workspace_id, user_id, role, access_class, status, joined_at) VALUES (?, ?, ?, ?, 'active', ?)",
).run(workspaceId, userId, accessClass === "member" ? "member" : null, accessClass, at);

beforeEach(() => {
  database = migratedSqliteDatabase();
  emailSend = vi.fn<(message: EmailMessageBuilder) => Promise<EmailSendResult>>(async () => ({ messageId: "email-1" }));
  const user = database.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  user.run(OWNER, "owner@example.test", "Owner", at, at);
  user.run(BANNED, "banned@example.test", "Banned", at, at);
  user.run(BANNED_GUEST, "banned-guest@example.test", "Banned Guest", at, at);
  const verified = database.prepare("INSERT INTO user_verified_emails (email, user_id, verified_at) VALUES (?, ?, ?)");
  verified.run("banned@example.test", BANNED, at);
  verified.run("banned-guest@example.test", BANNED_GUEST, at);
  const workspace = database.prepare(
    "INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, 'global', ?, ?, ?)");
  workspace.run(WORKSPACE, "Northwind", "northwind", OWNER, at, at);
  workspace.run(OTHER_WORKSPACE, "Southwind", "southwind", OWNER, at, at);
  database.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES (?, ?, 'owner', 'active', ?)")
    .run(WORKSPACE, OWNER, at);
  // A guest before the ban: a ban leaves what an account already has.
  addMembership(WORKSPACE, BANNED_GUEST, "guest");
  database.prepare("UPDATE users SET shadow_banned_at = ? WHERE id IN (?, ?)").run(at, BANNED, BANNED_GUEST);
});

afterEach(() => database.close());

describe("the membership guard", () => {
  it("gives a shadow-banned account no new relationship, as a member or as a guest", () => {
    expect(() => addMembership(WORKSPACE, BANNED, "member")).toThrow(/account_shadow_banned/u);
    expect(() => addMembership(WORKSPACE, BANNED, "guest")).toThrow(/account_shadow_banned/u);
    expect(membership(WORKSPACE, BANNED)).toBeUndefined();
  });

  it("keeps the relationship a banned account already has, and refuses to make its guest a member", () => {
    expect(() => database.prepare(
      "UPDATE workspace_members SET access_class = 'member', role = 'member' WHERE workspace_id = ? AND user_id = ?",
    ).run(WORKSPACE, BANNED_GUEST)).toThrow(/account_shadow_banned/u);
    expect(membership(WORKSPACE, BANNED_GUEST)).toEqual({ role: null, access_class: "guest", status: "active" });
    // A second relationship is a new one, even for an account that holds a first.
    expect(() => addMembership(OTHER_WORKSPACE, BANNED_GUEST, "guest")).toThrow(/account_shadow_banned/u);
  });

  it("lets a banned account's relationship be suspended, and not made active again", () => {
    const setStatus = database.prepare("UPDATE workspace_members SET status = ? WHERE workspace_id = ? AND user_id = ?");
    setStatus.run("suspended", WORKSPACE, BANNED_GUEST);
    expect(membership(WORKSPACE, BANNED_GUEST)).toEqual({ role: null, access_class: "guest", status: "suspended" });
    expect(() => setStatus.run("active", WORKSPACE, BANNED_GUEST)).toThrow(/account_shadow_banned/u);
  });

  it("admits the account again once the ban is lifted", () => {
    database.prepare("UPDATE users SET shadow_banned_at = NULL WHERE id = ?").run(BANNED);
    addMembership(WORKSPACE, BANNED, "member");
    expect(membership(WORKSPACE, BANNED)).toEqual({ role: "member", access_class: "member", status: "active" });
  });
});

describe("setting and lifting a shadow ban", () => {
  it("keeps the original time when a banned account is banned again, and clears it when lifted", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-05T00:00:00.000Z"));
      await expect(setUserShadowBan(env(), { userId: OWNER, banned: true }))
        .resolves.toEqual({ userId: OWNER, email: "owner@example.test", shadowBannedAt: "2026-11-05T00:00:00.000Z" });
      vi.setSystemTime(new Date("2026-11-09T00:00:00.000Z"));
      await expect(setUserShadowBan(env(), { userId: OWNER, banned: true }))
        .resolves.toEqual({ userId: OWNER, email: "owner@example.test", shadowBannedAt: "2026-11-05T00:00:00.000Z" });
      await expect(setUserShadowBan(env(), { userId: OWNER, banned: false }))
        .resolves.toEqual({ userId: OWNER, email: "owner@example.test", shadowBannedAt: null });
      expect(database.prepare("SELECT shadow_banned_at FROM users WHERE id = ?").get(OWNER)).toEqual({ shadow_banned_at: null });
    } finally { vi.useRealTimers(); }
  });

  it("refuses an id no user in this region has", async () => {
    await expect(setUserShadowBan(env(), { userId: "00000000-0000-7000-8000-00000000b0ff", banned: true }))
      .rejects.toMatchObject({ status: 404, code: "user_not_found" });
  });
});

describe("adding a shadow-banned account to an Organization", () => {
  beforeEach(() => {
    database.prepare(`INSERT INTO workspace_invitations
      (id, workspace_id, email, invited_by_user_id, token_hash, role, expires_at, created_at)
      VALUES (?, ?, 'banned@example.test', ?, 'hash-1', 'member', ?, ?)`)
      .run(INVITATION, WORKSPACE, OWNER, new Date(Date.now() + 86_400_000).toISOString(), at);
  });

  it("tells the administrator only that it could not be done, adds nobody, and sends no email", async () => {
    await expect(new WorkspaceService(env(), ownerAuth).addMember("banned@example.test", "member"))
      .rejects.toMatchObject({ status: 409, code: "request_unavailable", diagnosticCode: "account_shadow_banned" });
    expect(membership(WORKSPACE, BANNED)).toBeUndefined();
    // The add's batch also revokes a waiting invitation; a refused add leaves it as it was.
    expect(database.prepare("SELECT revoked_at FROM workspace_invitations WHERE id = ?").get(INVITATION)).toEqual({ revoked_at: null });
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("leaves a banned guest a guest when an administrator adds them as a member", async () => {
    await expect(new WorkspaceService(env(), ownerAuth).addMember("banned-guest@example.test", "member"))
      .rejects.toMatchObject({ status: 409, code: "request_unavailable" });
    expect(membership(WORKSPACE, BANNED_GUEST)).toEqual({ role: null, access_class: "guest", status: "active" });
  });

  it("tells an operator adding through the engineering tool that the account is shadow banned", async () => {
    // The engineering entryway resolves the Organization's authority route before acting.
    openWorkstreamAuthorityForTest(database);
    await expect(addEngineeringOrgMember(env(), { orgId: WORKSPACE, adminUserId: OWNER, email: "banned@example.test", role: "member" }, "op-1"))
      .rejects.toMatchObject({ status: 409, code: "account_shadow_banned" });
    expect(membership(WORKSPACE, BANNED)).toBeUndefined();
  });

  it("refuses an invitation the banned account accepts, and leaves the invitation unaccepted", async () => {
    await expect(acceptInvitationForUser(env(), INVITATION, { id: BANNED, email: "banned@example.test", name: "Banned" }))
      .rejects.toMatchObject({ status: 409, code: "request_unavailable", diagnosticCode: "account_shadow_banned" });
    expect(membership(WORKSPACE, BANNED)).toBeUndefined();
    expect(database.prepare("SELECT accepted_at, accepted_by_user_id FROM workspace_invitations WHERE id = ?").get(INVITATION))
      .toEqual({ accepted_at: null, accepted_by_user_id: null });
  });

  it("refuses to promote a banned guest to a member", async () => {
    const guest = database.prepare("SELECT incarnation, revision FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .get(WORKSPACE, BANNED_GUEST) as { incarnation: string; revision: number };
    await expect(new WorkspaceService(env(), ownerAuth).promoteGuest(BANNED_GUEST, { incarnation: guest.incarnation, expectedRevision: guest.revision }))
      .rejects.toMatchObject({ status: 409, code: "request_unavailable", diagnosticCode: "account_shadow_banned" });
    expect(membership(WORKSPACE, BANNED_GUEST)).toEqual({ role: null, access_class: "guest", status: "active" });
  });
});
