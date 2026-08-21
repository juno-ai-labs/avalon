import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  authorizationKey,
  permittedWorkspaceSocketIdentities,
} from "../src/durable-objects/workspace-socket-authorization";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const OTHER_WORKSPACE = "00000000-0000-7000-8000-000000000002";
const MEMBER_A = "00000000-0000-7000-8000-000000000003";
const MEMBER_B = "00000000-0000-7000-8000-000000000004";
const FOUNDER = "00000000-0000-7000-8000-000000000005";
const NOW = "2026-08-21T20:00:00.000Z";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

interface SessionRow {
  id: string;
  userId: string;
  workspaceId?: string;
  revokedAt?: string | null;
  expiresAt?: string;
}

function insertUser(database: DatabaseSync, userId: string): void {
  database.prepare(
    `INSERT INTO users(id, google_subject, email, name, created_at, updated_at)
     VALUES (?, ?, ?, 'Test Person', ?, ?)`,
  ).run(userId, `google-${userId}`, `${userId}@example.test`, NOW, NOW);
}

function seed(options: { members: Array<{ userId: string; status: string }>; sessions: SessionRow[] }): D1Database {
  const database = migratedSqliteDatabase();
  databases.push(database);
  insertUser(database, FOUNDER);
  for (const workspaceId of [WORKSPACE, OTHER_WORKSPACE]) {
    database.prepare(
      `INSERT INTO workspaces(id, name, slug, region, created_by_user_id, created_at, updated_at)
       VALUES (?, 'Test', ?, 'global', ?, ?, ?)`,
    ).run(workspaceId, `slug-${workspaceId.slice(-4)}`, FOUNDER, NOW, NOW);
  }
  for (const member of options.members) {
    insertUser(database, member.userId);
    database.prepare(
      `INSERT INTO workspace_members(workspace_id, user_id, role, status, joined_at)
       VALUES (?, ?, 'member', ?, ?)`,
    ).run(WORKSPACE, member.userId, member.status, NOW);
  }
  for (const session of options.sessions) {
    database.prepare(
      `INSERT INTO sessions(id, user_id, workspace_id, region, refresh_token_hash,
                            created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, 'global', ?, ?, ?, ?)`,
    ).run(
      session.id,
      session.userId,
      session.workspaceId ?? WORKSPACE,
      `hash-${session.id}`,
      NOW,
      session.expiresAt ?? "2099-01-01T00:00:00.000Z",
      session.revokedAt ?? null,
    );
  }
  return sqliteD1(database);
}

const options = { workspaceId: WORKSPACE, region: "global", devAuth: false, now: NOW };

describe("permittedWorkspaceSocketIdentities", () => {
  it("permits a live session held by an active member", async () => {
    const db = seed({
      members: [{ userId: MEMBER_A, status: "active" }],
      sessions: [{ id: "session-a", userId: MEMBER_A }],
    });
    const permitted = await permittedWorkspaceSocketIdentities(db, options, [
      { sessionId: "session-a", userId: MEMBER_A },
    ]);
    expect([...permitted]).toEqual([authorizationKey("session-a", MEMBER_A)]);
  });

  it.each([
    ["revoked", { revokedAt: NOW }],
    ["expired", { expiresAt: "2020-01-01T00:00:00.000Z" }],
    ["in another workspace", { workspaceId: OTHER_WORKSPACE }],
  ])("refuses a session that is %s", async (_label, overrides) => {
    const db = seed({
      members: [{ userId: MEMBER_A, status: "active" }],
      sessions: [{ id: "session-a", userId: MEMBER_A, ...overrides }],
    });
    const permitted = await permittedWorkspaceSocketIdentities(db, options, [
      { sessionId: "session-a", userId: MEMBER_A },
    ]);
    expect([...permitted]).toEqual([]);
  });

  it("refuses a live session whose member is no longer active", async () => {
    const db = seed({
      members: [{ userId: MEMBER_A, status: "suspended" }],
      sessions: [{ id: "session-a", userId: MEMBER_A }],
    });
    const permitted = await permittedWorkspaceSocketIdentities(db, options, [
      { sessionId: "session-a", userId: MEMBER_A },
    ]);
    expect([...permitted]).toEqual([]);
  });

  it("keys the answer to the session's own user, not the socket's claim", async () => {
    const db = seed({
      members: [
        { userId: MEMBER_A, status: "active" },
        { userId: MEMBER_B, status: "active" },
      ],
      sessions: [{ id: "session-a", userId: MEMBER_A }],
    });
    // A socket presenting A's session under B's id: the row it named permits
    // A, so B's claim on it is not in the answer.
    const permitted = await permittedWorkspaceSocketIdentities(db, options, [
      { sessionId: "session-a", userId: MEMBER_B },
    ]);
    expect(permitted.has(authorizationKey("session-a", MEMBER_B))).toBe(false);
  });

  it("decides each development-auth user separately under one shared session id", async () => {
    // Development auth issues the literal session id `development` to every
    // user, so an answer keyed by session alone would give both of these the
    // same fate — the suspended one would ride on the active one's membership.
    const db = seed({
      members: [
        { userId: MEMBER_A, status: "active" },
        { userId: MEMBER_B, status: "suspended" },
      ],
      sessions: [],
    });
    const permitted = await permittedWorkspaceSocketIdentities(
      db,
      { ...options, devAuth: true },
      [
        { sessionId: "development", userId: MEMBER_A },
        { sessionId: "development", userId: MEMBER_B },
      ],
    );
    expect(permitted.has(authorizationKey("development", MEMBER_A))).toBe(true);
    expect(permitted.has(authorizationKey("development", MEMBER_B))).toBe(false);
  });

  it("refuses the development session id when the bypass is off", async () => {
    const db = seed({
      members: [{ userId: MEMBER_A, status: "active" }],
      sessions: [],
    });
    const permitted = await permittedWorkspaceSocketIdentities(db, options, [
      { sessionId: "development", userId: MEMBER_A },
    ]);
    expect([...permitted]).toEqual([]);
  });

  it("answers for more identities than fit in one bound statement", async () => {
    // D1 permits 100 bound parameters, so a sweep of 60 sessions has to be
    // more than one query or it fails outright.
    const members = Array.from({ length: 60 }, (_, index) => ({
      // Offset past the fixed ids above, which would otherwise collide.
      userId: `00000000-0000-7000-8000-${String(index + 100).padStart(12, "0")}`,
      status: "active",
    }));
    const db = seed({
      members,
      sessions: members.map((member, index) => ({ id: `session-${index}`, userId: member.userId })),
    });
    const permitted = await permittedWorkspaceSocketIdentities(
      db,
      options,
      members.map((member, index) => ({ sessionId: `session-${index}`, userId: member.userId })),
    );
    expect(permitted.size).toBe(60);
  });
});
