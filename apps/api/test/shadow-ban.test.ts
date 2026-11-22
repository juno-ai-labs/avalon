import "../../../tests/isolated-region";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { setUserShadowBan } from "../src/services/shadow-ban";
import { ensureGuestRelationship } from "../src/services/workspace-relationship-service";
import type * as WorkspaceRealtimeService from "../src/services/workspace-realtime-service";
import { WorkspaceService } from "../src/services/workspace-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

// The Organization object behind the sync publish does not run in this suite.
vi.mock("../src/services/workspace-realtime-service", async (importActual) => ({
  ...await importActual<typeof WorkspaceRealtimeService>(),
  publishWorkspaceSync: vi.fn(async () => 1),
}));

/**
 * Shadow bans against the checked-in migrations, so the guard under test is
 * the trigger production runs (`docs/shadow-ban.md`). The creation services
 * are covered beside the other creation cases, in
 * `regional-workspace-create.test.ts`.
 */

const at = "2026-11-01T00:00:00.000Z";
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000b001");
const OTHER_WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-00000000b002");
const OWNER = asUserId("00000000-0000-7000-8000-00000000b010");
/** Shadow banned, with a verified address, and in no Organization. */
const BANNED = asUserId("00000000-0000-7000-8000-00000000b011");

let database: DatabaseSync;

function env(): Env {
  return createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global", APP_ENV: "production", LOG_LEVEL: "error",
    PUBLIC_WEB_BASE_URL: "https://rally.example.test", EMAIL_FROM: "Rally <team@example.test>",
    EMAIL: { send: async () => ({ messageId: "email-1" }) },
  });
}

const ownerAuth: AuthContext = { sessionId: "session-1", userId: OWNER, workspaceId: WORKSPACE, region: "global", role: "owner" };

const createOrganization = (id: string, creator: string, conflict = "") => database.prepare(
  `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
   VALUES (?, 'Org', ?, 'global', ?, ?, ?) ${conflict}`).run(id, `org-${id.slice(-4)}`, creator, at, at);

beforeEach(() => {
  database = migratedSqliteDatabase();
  const user = database.prepare("INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
  user.run(OWNER, "owner@example.test", "Owner", at, at);
  user.run(BANNED, "banned@example.test", "Banned", at, at);
  database.prepare("INSERT INTO user_verified_emails (email, user_id, verified_at) VALUES ('banned@example.test', ?, ?)").run(BANNED, at);
  createOrganization(WORKSPACE, OWNER);
  database.prepare("INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at) VALUES (?, ?, 'owner', 'active', ?)")
    .run(WORKSPACE, OWNER, at);
  database.prepare("UPDATE users SET shadow_banned_at = ? WHERE id = ?").run(at, BANNED);
});

afterEach(() => database.close());

describe("the Organization guard", () => {
  it("refuses an Organization a shadow-banned account creates, and allows it once the ban is lifted", () => {
    expect(() => createOrganization(OTHER_WORKSPACE, BANNED)).toThrow(/account_shadow_banned/u);
    expect(database.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 1 });

    database.prepare("UPDATE users SET shadow_banned_at = NULL WHERE id = ?").run(BANNED);
    createOrganization(OTHER_WORKSPACE, BANNED);
    expect(database.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 2 });
  });

  it("leaves an upsert over an Organization the account made before its ban alone", () => {
    database.prepare("UPDATE users SET shadow_banned_at = ? WHERE id = ?").run(at, OWNER);
    createOrganization(WORKSPACE, OWNER, "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at");
    expect(database.prepare("SELECT COUNT(*) AS n FROM workspaces").get()).toEqual({ n: 1 });
  });
});

describe("a shadow-banned account in other people's Organizations", () => {
  it("can still be added as a member, and as a guest", async () => {
    const added = await new WorkspaceService(env(), ownerAuth).addMember("banned@example.test", "member");
    expect(added.member).toEqual({ userId: BANNED, email: "banned@example.test", role: "member" });

    createOrganization(OTHER_WORKSPACE, OWNER);
    await expect(ensureGuestRelationship(sqliteD1(database), OTHER_WORKSPACE, BANNED))
      .resolves.toMatchObject({ userId: BANNED, accessClass: "guest", status: "active" });
    // Both are what `search_users` then lists for the banned account.
    expect(database.prepare("SELECT workspace_id, access_class FROM workspace_members WHERE user_id = ? ORDER BY workspace_id").all(BANNED))
      .toEqual([{ workspace_id: WORKSPACE, access_class: "member" }, { workspace_id: OTHER_WORKSPACE, access_class: "guest" }]);
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
