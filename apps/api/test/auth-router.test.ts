import { SignJWT } from "jose";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const userId = "00000000-0000-7000-8000-000000000001";
const workspaceId = "00000000-0000-7000-8000-000000000002";
const sessionId = "00000000-0000-7000-8000-000000000003";
const signingKey = "session-signing-key-for-tests-only-long-enough";
const at = "2026-08-20T12:00:00.000Z";

let database: DatabaseSync;

function env() {
  return createTestEnv({
    DB: sqliteD1(database),
    ALLOWED_ORIGINS: "app://rallywithai",
    AVALON_REGION: "global",
    APP_ENV: "production",
    RALLY_DEV_AUTH: "false",
    SESSION_SIGNING_KEY: signingKey,
    LOG_LEVEL: "error",
  });
}

async function bearer(): Promise<string> {
  return new SignJWT({ sid: sessionId, wid: workspaceId, region: "global" })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer("avalon-api")
    .setAudience("avalon-desktop")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(signingKey));
}

beforeEach(() => {
  database = migratedSqliteDatabase();
  database.prepare(
    `INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
     VALUES (?, 'google-subject', ?, 'Member', ?, ?)`,
  ).run(userId, "member@example.com", at, at);
  database.prepare(
    `INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Avalon', 'avalon', 'global', ?, ?, ?)`,
  ).run(workspaceId, userId, at, at);
  database.prepare(
    `INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(workspaceId, userId, at);
  database.prepare(
    `INSERT INTO sessions
       (id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, 'global', 'hash', '2099-01-01T00:00:00.000Z', ?)`,
  ).run(sessionId, userId, workspaceId, at);
});

afterEach(() => { database.close(); });

describe("authentication in the complete application router", () => {
  it("reads the session once and checks revocation again on the next request", async () => {
    const bindings = env();
    const prepare = vi.spyOn(bindings.DB, "prepare");
    const app = createApp();
    const token = await bearer();
    const request = () => app.request("/speech", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    }, bindings);
    // Validation proves the protected route was reached without invoking Azure.
    const response = await request();
    expect(response.status).toBe(400);
    const sessionReads = () => prepare.mock.calls.filter(([sql]) => sql.includes("FROM sessions s"));
    expect(sessionReads()).toHaveLength(1);

    database.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ?").run(at, sessionId);
    const revoked = await request();
    expect(revoked.status).toBe(401);
    expect(sessionReads()).toHaveLength(2);
    await expect(revoked.json()).resolves.toMatchObject({ error: { code: "session_revoked" } });
  });

  it("still refuses an identity-only session at a protected route", async () => {
    database.prepare("UPDATE sessions SET workspace_id = NULL WHERE id = ?").run(sessionId);
    const token = await new SignJWT({ sid: sessionId, wid: null, region: "global" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" }).setSubject(userId)
      .setIssuer("avalon-api").setAudience("avalon-desktop")
      .setIssuedAt().setExpirationTime("15m").sign(new TextEncoder().encode(signingKey));
    const response = await createApp().request("/speech", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
    }, env());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "workspace_setup_required" } });
  });
});
