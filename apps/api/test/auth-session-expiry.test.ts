import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";

import { sha256 } from "../src/lib/crypto";
import { AuthService } from "../src/services/auth-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const USER = "00000000-0000-7000-8000-000000000001";
const WORKSPACE = "00000000-0000-7000-8000-0000000000a1";
const DAY_MS = 24 * 60 * 60 * 1_000;
const RENEWAL_WINDOW_MS = 30 * DAY_MS;
const MAX_LIFETIME_MS = 90 * DAY_MS;

const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

function service(database: DatabaseSync): AuthService {
  return new AuthService(createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    SESSION_SIGNING_KEY: "global-session-signing-key-with-enough-entropy",
  }));
}

/** A member with one session created `ageMs` ago whose expiry is still ahead. */
async function seedSession(ageMs: number, refreshToken: string): Promise<DatabaseSync> {
  const database = migratedSqliteDatabase();
  databases.push(database);
  const now = new Date().toISOString();
  const createdAt = new Date(Date.now() - ageMs).toISOString();
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, 'member@example.test', 'Member', ?, ?)`,
  ).run(USER, `google-${USER}`, now, now);
  database.prepare(
    `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
     VALUES (?, 'Test', 'test', 'global', ?, ?, ?)`,
  ).run(WORKSPACE, USER, now, now);
  database.prepare(
    `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
     VALUES (?, ?, 'owner', 'active', ?)`,
  ).run(WORKSPACE, USER, now);
  database.prepare(
    `INSERT INTO sessions(id, user_id, workspace_id, region, refresh_token_hash, expires_at, created_at)
     VALUES ('session-1', ?, ?, 'global', ?, ?, ?)`,
  ).run(USER, WORKSPACE, await sha256(refreshToken), new Date(Date.now() + DAY_MS).toISOString(), createdAt);
  return database;
}

function expiresAt(database: DatabaseSync): number {
  const row = database.prepare("SELECT expires_at FROM sessions WHERE id = 'session-1'").get() as { expires_at: string };
  return Date.parse(row.expires_at);
}

describe("a session's life slides with use", () => {
  const token = "refresh-token-with-more-than-twenty-characters";

  it("moves the expiry to thirty days from each renewal", async () => {
    const database = await seedSession(5 * DAY_MS, token);
    const before = Date.now();

    await service(database).refresh(token);

    const renewed = expiresAt(database);
    expect(renewed).toBeGreaterThanOrEqual(before + RENEWAL_WINDOW_MS);
    expect(renewed).toBeLessThanOrEqual(Date.now() + RENEWAL_WINDOW_MS);
  });

  it("never extends a session past ninety days from its creation", async () => {
    const database = await seedSession(80 * DAY_MS, token);
    const createdAt = Date.parse(
      (database.prepare("SELECT created_at FROM sessions WHERE id = 'session-1'").get() as { created_at: string }).created_at,
    );

    await service(database).refresh(token);

    // Ten days left, not thirty: the ceiling won.
    expect(expiresAt(database)).toBe(createdAt + MAX_LIFETIME_MS);
  });

  it("refuses to renew a session already past the ceiling", async () => {
    const database = await seedSession(91 * DAY_MS, token);

    await expect(service(database).refresh(token)).rejects.toMatchObject({ status: 401, code: "invalid_refresh_token" });
    // Refused means untouched: the token was not rotated out from under a retry.
    expect(await sha256(token)).toBe(
      (database.prepare("SELECT refresh_token_hash FROM sessions WHERE id = 'session-1'").get() as { refresh_token_hash: string }).refresh_token_hash,
    );
  });
});
