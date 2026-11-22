/// <reference types="@cloudflare/vitest-pool-workers/types" />
import "../../../tests/isolated-region";
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";

import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import { SHADOW_BAN_SCHEMA } from "./helpers/shadow-ban-schema";

/**
 * Setting a shadow ban through the operator bridge, on real D1 and the real
 * audit database. What a ban then refuses is in `engineering-creation.test.ts`.
 */

const USER = "00000000-0000-7000-8000-00000000b909";
const OTHER = "00000000-0000-7000-8000-00000000b90a";
const OPERATOR = { subject: "shadow-ban-test-operator", email: "operator@example.test", audience: "engineering" };
const request = { region: "global", userId: USER, banned: true, reason: "Signup spam" };

const bannedAt = async () => (await env.DB.prepare("SELECT shadow_banned_at FROM users WHERE id = ?").bind(USER)
  .first<{ shadow_banned_at: string | null }>())!.shadow_banned_at;

beforeEach(async () => {
  await reset();
  await ensureAuditSchema();
  await env.AUDIT_DB.prepare("DELETE FROM audit_events WHERE target_id = ?").bind(USER).run();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, created_at TEXT)"),
    env.DB.prepare("CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, slug TEXT, region TEXT, created_by_user_id TEXT)"),
    env.DB.prepare(`CREATE TABLE workspace_members (workspace_id TEXT, user_id TEXT, role TEXT, access_class TEXT,
      status TEXT, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id))`),
    ...SHADOW_BAN_SCHEMA.map((sql) => env.DB.prepare(sql)),
    env.DB.prepare(`INSERT INTO users (id, email, name, created_at) VALUES
      (?, 'reviewer@example.test', 'Reviewer', '2026-11-01T00:00:00.000Z'),
      (?, 'other@example.test', 'Other', '2026-11-02T00:00:00.000Z')`).bind(USER, OTHER),
  ]);
});

it("sets and lifts a ban through the operator bridge, and audits who did it and why", async () => {
  const ctx = createExecutionContext();
  const bridge = new EngineeringInspectionBridge(ctx, env);

  const banned = await bridge.setUserShadowBan(request, OPERATOR);
  expect(banned).toEqual({ region: "global", userId: USER, email: "reviewer@example.test", shadowBannedAt: await bannedAt() });
  expect(banned.shadowBannedAt).toEqual(expect.any(String));
  // The search row names the ban only on the banned account. The MCP Worker deploys after the API
  // and parses rows strictly, so a key on every row would fail the build still running.
  const row = { region: "global", lastSeenAt: null, organizations: [] };
  expect((await bridge.searchUsers({})).items.sort((left, right) => left.userId.localeCompare(right.userId))).toStrictEqual([
    { ...row, userId: USER, name: "Reviewer", email: "reviewer@example.test", createdAt: "2026-11-01T00:00:00.000Z", shadowBannedAt: banned.shadowBannedAt },
    { ...row, userId: OTHER, name: "Other", email: "other@example.test", createdAt: "2026-11-02T00:00:00.000Z" },
  ]);

  expect(await bridge.setUserShadowBan({ ...request, banned: false, reason: "Cleared on appeal" }, OPERATOR))
    .toEqual({ region: "global", userId: USER, email: "reviewer@example.test", shadowBannedAt: null });
  expect(await bannedAt()).toBeNull();

  const audit = await env.AUDIT_DB.prepare("SELECT action, metadata_json FROM audit_events WHERE target_id = ? ORDER BY rowid")
    .bind(USER).all<{ action: string; metadata_json: string }>();
  expect(audit.results.map((event) => event.action)).toEqual([
    "engineering.set_user_shadow_ban.attempt", "engineering.set_user_shadow_ban.result",
    "engineering.set_user_shadow_ban.attempt", "engineering.set_user_shadow_ban.result",
  ]);
  expect(JSON.parse(audit.results[1]!.metadata_json))
    .toMatchObject({ operator: OPERATOR, representedUserId: USER, outcome: "admitted", reason: "Signup spam" });
  expect(JSON.parse(audit.results[3]!.metadata_json)).toMatchObject({ shadowBannedAt: null, reason: "Cleared on appeal" });
  await waitOnExecutionContext(ctx);
});

it("leaves the ban unset without a trusted operator, the region that holds the row, or an attempt audit", async () => {
  const ctx = createExecutionContext();
  const bridge = new EngineeringInspectionBridge(ctx, env);
  await expect(bridge.setUserShadowBan(request, {})).rejects.toThrow(/subject/u);
  // A configured deployment, but not the one this Worker serves.
  await expect(bridge.setUserShadowBan({ ...request, region: "enterprise" }, OPERATOR))
    .rejects.toThrow("engineering_operation_failed:region_mismatch");
  await expect(bridge.setUserShadowBan({ ...request, userId: "00000000-0000-7000-8000-00000000b9ff" }, OPERATOR))
    .rejects.toThrow("engineering_operation_failed:user_not_found");
  await env.AUDIT_DB.prepare(`CREATE TRIGGER reject_shadow_ban_audit BEFORE INSERT ON audit_events
    WHEN NEW.action = 'engineering.set_user_shadow_ban.attempt'
    BEGIN SELECT RAISE(ABORT, 'shadow_ban_test_audit_unavailable'); END;`).run();
  try {
    await expect(bridge.setUserShadowBan(request, OPERATOR)).rejects.toThrow("shadow_ban_test_audit_unavailable");
  } finally {
    await env.AUDIT_DB.exec("DROP TRIGGER reject_shadow_ban_audit");
    await waitOnExecutionContext(ctx);
  }
  expect(await bannedAt()).toBeNull();
});
