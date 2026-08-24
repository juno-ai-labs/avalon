import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { sha256 } from "../src/lib/crypto";
import { AuthService } from "../src/services/auth-service";
import { WorkspaceService } from "../src/services/workspace-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * The account timezone as a preference, proved against the checked-in schema.
 *
 * This is the one behaviour `users.timezone_source` exists for, and it is a
 * column and two guarded statements rather than a runtime feature — so it is
 * proved here, on a database with every migration applied, by reading the row
 * back. A stub that records SQL can only assert that a string still contains
 * the column name, which is the same assertion whether or not `0096` ever ran.
 */

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000101");
const chooserId = asUserId("00000000-0000-7000-8000-000000000102");
const newcomerId = asUserId("00000000-0000-7000-8000-000000000103");

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
});

function seededDatabase(): DatabaseSync {
  const database = migratedSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, timezone, created_at, updated_at)
    VALUES
      ('${chooserId}', 'subject-101', 'chooser@example.com', 'Chooser', 'America/Los_Angeles', '2026-01-01', '2026-01-01'),
      ('${newcomerId}', 'subject-102', 'newcomer@example.com', 'Newcomer', 'America/Los_Angeles', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, timezone, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Avalon Studio', 'avalon-studio', 'global', 'America/Los_Angeles', '${chooserId}', '2026-01-01', '2026-01-01');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES
      ('${workspaceId}', '${chooserId}', 'owner', 'active', '2026-01-01'),
      ('${workspaceId}', '${newcomerId}', 'member', 'active', '2026-01-01');
  `);
  return database;
}

function environment(database: DatabaseSync): Env {
  return createTestEnv({
    DB: sqliteD1(database),
    APP_ENV: "test",
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
    SESSION_SIGNING_KEY: "test-session-signing-key-with-enough-entropy",
  });
}

function authFor(userId: string): AuthContext {
  return {
    sessionId: "session-1",
    userId: asUserId(userId),
    workspaceId,
    region: "global",
    role: "owner",
  };
}

async function seedTicket(
  database: DatabaseSync,
  input: { userId: string; ticket: string; attemptId: string; verifier: string },
): Promise<void> {
  database.prepare(
    `INSERT INTO desktop_login_tickets
       (id, ticket_hash, user_id, workspace_id, region, desktop_attempt_id, desktop_code_challenge,
        expires_at, created_at)
     VALUES (?, ?, ?, ?, 'global', ?, ?, ?, ?)`,
  ).run(
    `ticket-${input.attemptId.slice(0, 8)}`,
    await sha256(input.ticket),
    input.userId,
    workspaceId,
    input.attemptId,
    await sha256(input.verifier),
    "2026-08-25T12:00:00.000Z",
    "2026-08-24T11:00:00.000Z",
  );
}

function timezoneRow(database: DatabaseSync, userId: string): { timezone: string; timezone_source: string } {
  return database.prepare("SELECT timezone, timezone_source FROM users WHERE id = ?")
    .get(userId) as { timezone: string; timezone_source: string };
}

describe("account timezone as a preference", () => {
  it("keeps a zone chosen in settings when the next sign-in comes from another machine", async () => {
    const database = seededDatabase();
    const verifier = "v".repeat(64);
    await seedTicket(database, {
      userId: chooserId,
      ticket: "ticket-value-longer-than-twenty-characters",
      attemptId: "a".repeat(43),
      verifier,
    });

    // Every account starts following its machine, which is what a new one wants.
    expect(timezoneRow(database, chooserId).timezone_source).toBe("client");

    await new WorkspaceService(environment(database), authFor(chooserId))
      .updateMyTimezone("America/New_York");
    expect(timezoneRow(database, chooserId)).toEqual({
      timezone: "America/New_York",
      timezone_source: "user",
    });

    // A laptop in another zone. Before this was a preference, signing in here
    // moved every automation and digest the person had scheduled.
    await new AuthService(environment(database)).exchangeDesktopTicket({
      ticket: "ticket-value-longer-than-twenty-characters",
      region: "global",
      attemptId: "a".repeat(43),
      codeVerifier: verifier,
      timezone: "Europe/London",
    });

    expect(timezoneRow(database, chooserId)).toEqual({
      timezone: "America/New_York",
      timezone_source: "user",
    });
  });

  it("seeds an account that has never chosen from the signing-in machine", async () => {
    const database = seededDatabase();
    const verifier = "w".repeat(64);
    await seedTicket(database, {
      userId: newcomerId,
      ticket: "second-ticket-value-longer-than-twenty",
      attemptId: "b".repeat(43),
      verifier,
    });

    await new AuthService(environment(database)).exchangeDesktopTicket({
      ticket: "second-ticket-value-longer-than-twenty",
      region: "global",
      attemptId: "b".repeat(43),
      codeVerifier: verifier,
      timezone: "Europe/London",
    });

    // Seeded, and still following the machine — the person has said nothing yet.
    expect(timezoneRow(database, newcomerId)).toEqual({
      timezone: "Europe/London",
      timezone_source: "client",
    });
  });

  it("leaves the account alone when the client sends no zone at all", async () => {
    const database = seededDatabase();
    const verifier = "x".repeat(64);
    await seedTicket(database, {
      userId: newcomerId,
      ticket: "third-ticket-value-longer-than-twenty-c",
      attemptId: "c".repeat(43),
      verifier,
    });

    await new AuthService(environment(database)).exchangeDesktopTicket({
      ticket: "third-ticket-value-longer-than-twenty-c",
      region: "global",
      attemptId: "c".repeat(43),
      codeVerifier: verifier,
    });

    // A client that sends nothing knows nothing; answering it with a default
    // wrote Pacific over accounts whose own setting was the only real answer.
    expect(timezoneRow(database, newcomerId)).toEqual({
      timezone: "America/Los_Angeles",
      timezone_source: "client",
    });
  });

  it("refuses a source outside the two the column admits", () => {
    const database = seededDatabase();
    expect(() => database.prepare("UPDATE users SET timezone_source = ? WHERE id = ?")
      .run("machine", chooserId)).toThrow(/CHECK constraint failed/u);
  });
});
