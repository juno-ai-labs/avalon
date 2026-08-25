import { SignJWT } from "jose";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";

import type { HonoAppEnv } from "../src/env";
import { getAuth, requireAuth } from "../src/middleware/auth";
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

/** The authenticated context the middleware resolved, as JSON. */
async function authenticatedContext(): Promise<Record<string, unknown>> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", requireAuth);
  app.get("/probe", (c) => c.json(getAuth(c)));
  const response = await app.request(
    "/probe",
    { headers: { authorization: `Bearer ${await bearer()}` } },
    env(),
  );
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
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

describe("analytics surrogates on the authenticated context", () => {
  it("resolves both from the session query the request already makes", async () => {
    database.prepare("UPDATE users SET analytics_person_id = ? WHERE id = ?")
      .run("person-analytics-1", userId);
    database.prepare("UPDATE workspaces SET analytics_workspace_id = ? WHERE id = ?")
      .run("workspace-analytics-1", workspaceId);

    // The point of the design: no second read, no cache, no KV — these arrive
    // on the query that authenticates the request.
    expect(await authenticatedContext()).toMatchObject({
      userId,
      workspaceId,
      analyticsPersonId: "person-analytics-1",
      analyticsWorkspaceId: "workspace-analytics-1",
    });
  });

  it("reports null until a product event has minted them", async () => {
    // Both columns are minted lazily by the telemetry pipeline, so an account
    // that has produced no product event has no PostHog identity to join to.
    expect(await authenticatedContext()).toMatchObject({
      analyticsPersonId: null,
      analyticsWorkspaceId: null,
    });
  });

  it("still authenticates a session whose workspace has no analytics id yet", async () => {
    database.prepare("UPDATE users SET analytics_person_id = ? WHERE id = ?")
      .run("person-analytics-1", userId);

    // The join added for these columns must not become a condition on them:
    // a half-minted pair is normal, and dropping the session over it would
    // turn a telemetry detail into a sign-out.
    expect(await authenticatedContext()).toMatchObject({
      userId,
      role: "owner",
      analyticsPersonId: "person-analytics-1",
      analyticsWorkspaceId: null,
    });
  });

  it("authenticates even when the user row the diagnostic join reads is gone", async () => {
    // Unreachable while the sessions -> users foreign key holds, which is why
    // this is a LEFT join. The invariant it pins is the one worth pinning:
    // a column added for observability must never be able to sign someone out.
    database.exec("PRAGMA foreign_keys = OFF");
    database.prepare("DELETE FROM users WHERE id = ?").run(userId);

    expect(await authenticatedContext()).toMatchObject({
      userId,
      role: "owner",
      analyticsPersonId: null,
    });
  });
});
