import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthContext, Env } from "../src/env";
import { desktopHandoffUrl } from "../src/lib/desktop-handoff";
import { __connectionServiceTesting, ConnectionService } from "../src/services/connection-service";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000002";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return { success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<unknown>;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null;
  }
}

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function fixture(): { database: DatabaseSync; env: Env; auth: AuthContext } {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec(`
    CREATE TABLE connector_oauth_attempts (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      connection_id TEXT,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const binding = {
    prepare: (sql: string) => new SqliteD1Statement(database.prepare(sql)) as unknown as D1PreparedStatement,
  } as unknown as D1Database;
  return {
    database,
    env: {
      DB: binding,
      AVALON_REGION: "global",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
    } as Env,
    auth: {
      sessionId: "session",
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global",
      role: "owner",
    },
  };
}

function insertAttempt(
  database: DatabaseSync,
  input: { id: string; userId?: string; status?: string; expiresAt: string },
): void {
  database.prepare(
    `INSERT INTO connector_oauth_attempts
     (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
      expires_at, completed_at, created_at, updated_at)
     VALUES (?, 'global', 'linear', ?, ?, ?, NULL, NULL, ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.userId ?? USER_ID,
    WORKSPACE_ID,
    input.status ?? "pending",
    input.expiresAt,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}

describe("connector OAuth handoff", () => {
  it("keeps the desktop target in a fragment on the no-store handoff surface", () => {
    const target = `avalon://auth/complete?provider=linear&region=global&attempt=${"a".repeat(43)}&status=denied&error=oauth_denied`;
    const handoff = new URL(desktopHandoffUrl({ PUBLIC_WEB_BASE_URL: "https://with-avalon.com" }, target));

    expect(handoff.origin).toBe("https://with-avalon.com");
    expect(handoff.pathname).toBe("/auth/desktop/");
    expect(handoff.search).toBe("");
    expect(new URLSearchParams(handoff.hash.slice(1)).get("target")).toBe(target);
    expect(__connectionServiceTesting.normalizeOAuthErrorCode("Provider denied access!"))
      .toBe("provider_denied_access");
  });

  it("returns an active attempt only to its initiating workspace principal", async () => {
    const { auth, database, env } = fixture();
    const attemptId = "a".repeat(43);
    insertAttempt(database, { id: attemptId, expiresAt: "2099-01-01T00:00:00.000Z" });

    await expect(new ConnectionService(env, auth).getOAuthAttempt(attemptId)).resolves.toEqual({
      attemptId,
      provider: "linear",
      status: "pending",
      connectionId: null,
      errorCode: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    await expect(new ConnectionService(env, { ...auth, userId: OTHER_USER_ID }).getOAuthAttempt(attemptId))
      .rejects.toMatchObject({ status: 404, code: "oauth_attempt_not_found" });
  });

  it("durably converts an expired pending attempt into a terminal failure", async () => {
    const { auth, database, env } = fixture();
    const attemptId = "b".repeat(43);
    insertAttempt(database, { id: attemptId, expiresAt: "2020-01-01T00:00:00.000Z" });

    await expect(new ConnectionService(env, auth).getOAuthAttempt(attemptId)).resolves.toMatchObject({
      attemptId,
      status: "failed",
      errorCode: "oauth_attempt_expired",
    });
    expect(database.prepare("SELECT status, error_code FROM connector_oauth_attempts WHERE id = ?")
      .get(attemptId)).toEqual({ status: "failed", error_code: "oauth_attempt_expired" });
  });
});
