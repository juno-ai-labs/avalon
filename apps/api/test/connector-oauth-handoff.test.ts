import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AuthContext, Env } from "../src/env";
import { sealString } from "../src/lib/crypto";
import { desktopHandoffUrl } from "../src/lib/desktop-handoff";
import { __connectionServiceTesting, ConnectionService } from "../src/services/connection-service";
import { createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const OTHER_USER_ID = asUserId("00000000-0000-4000-8000-000000000002");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000003");

class SqliteD1Statement {
  private values: unknown[] = [];

  constructor(private readonly statement: StatementSync) {}

  bind(...values: unknown[]): SqliteD1Statement {
    this.values = values;
    return this;
  }

  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
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
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE oauth_states (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL,
      purpose TEXT NOT NULL,
      code_verifier_encrypted TEXT NOT NULL,
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      return_uri TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE connector_connections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  const binding = createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteD1Statement(database.prepare(sql))),
    batch: (statements: D1PreparedStatement[]) => Promise.all(
      statements.map((statement) => (statement as unknown as SqliteD1Statement).run()),
    ),
  });
  return {
    database,
    env: createTestEnv({
      DB: binding,
      AVALON_REGION: "global",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
      DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
      OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
    }),
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
  input: {
    id: string;
    userId?: string;
    status?: string;
    connectionId?: string | null;
    errorCode?: string | null;
    expiresAt: string;
  },
): void {
  database.prepare(
    `INSERT INTO connector_oauth_attempts
     (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
      expires_at, completed_at, created_at, updated_at)
     VALUES (?, 'global', 'linear', ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  ).run(
    input.id,
    input.userId ?? USER_ID,
    WORKSPACE_ID,
    input.status ?? "pending",
    input.connectionId ?? null,
    input.errorCode ?? null,
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

  it("derives the same minimal ingress route shape used by the migration triggers", () => {
    expect(__connectionServiceTesting.connectorIngressRouteValues({
      id: "connection",
      workspace_id: WORKSPACE_ID,
      connector_type: "github",
      scope: "workspace",
      provider_account_id: "installation",
      status: "needs_reconnect",
      config_json: JSON.stringify({ githubUserId: "github-user" }),
      updated_at: "2026-08-18T00:00:00.000Z",
    }, "global")).toEqual({
      connectionId: "connection",
      workspaceId: WORKSPACE_ID,
      region: "global",
      connectorType: "github",
      scope: "workspace",
      providerAccountId: "installation",
      providerUserId: "github-user",
      status: "active",
      updatedAt: "2026-08-18T00:00:00.000Z",
    });
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

  it("lets a callback that already consumed valid state win an expiry reconciliation race", async () => {
    const { auth, database, env } = fixture();
    const attemptId = "c".repeat(43);
    const connectionId = "00000000-0000-7000-8000-000000000004";
    insertAttempt(database, { id: attemptId, expiresAt: "2020-01-01T00:00:00.000Z" });
    const service = new ConnectionService(env, auth);

    await service.getOAuthAttempt(attemptId);
    await (service as unknown as {
      finishOAuthAttempt(
        id: string,
        status: "succeeded",
        result: { connectionId: string },
      ): Promise<void>;
    }).finishOAuthAttempt(attemptId, "succeeded", { connectionId });

    expect(database.prepare(
      "SELECT status, connection_id, error_code FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "succeeded",
      connection_id: connectionId,
      error_code: null,
    });
  });

  it("extends and revives an expiry-reconciled attempt for GitHub's second OAuth leg", async () => {
    const { auth, database, env } = fixture();
    const attemptId = "d".repeat(43);
    const expiresAt = "2099-01-01T00:10:00.000Z";
    insertAttempt(database, {
      id: attemptId,
      status: "failed",
      errorCode: "oauth_attempt_expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const service = new ConnectionService(env, auth);

    await (service as unknown as {
      extendOAuthAttempt(id: string, nextExpiry: string): Promise<void>;
    }).extendOAuthAttempt(attemptId, expiresAt);

    expect(database.prepare(
      "SELECT status, error_code, completed_at, expires_at FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "pending",
      error_code: null,
      completed_at: null,
      expires_at: expiresAt,
    });
  });

  it("reconciles a healthy committed connection as success after a later callback step fails", async () => {
    const { auth, database, env } = fixture();
    const attemptId = "e".repeat(43);
    const state = "s".repeat(32);
    const connectionId = "00000000-0000-7000-8000-000000000005";
    insertAttempt(database, {
      id: attemptId,
      status: "failed",
      errorCode: "oauth_state_already_used",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const service = new ConnectionService(env, auth);
    await (service as unknown as {
      persistConnectionMutation(
        statement: D1PreparedStatement,
        id: string,
        connectionIdValue: string,
      ): Promise<D1Result<unknown>>;
    }).persistConnectionMutation(
      env.DB.prepare(
        "INSERT INTO connector_connections (id, workspace_id, connector_type, status) VALUES (?, ?, 'linear', 'healthy')",
      ).bind(connectionId, WORKSPACE_ID),
      attemptId,
      connectionId,
    );
    const sealedState = await sealString(
      JSON.stringify({ attemptId }),
      env.OAUTH_STATE_ENCRYPTION_KEY,
    );
    database.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
        return_uri, expires_at, consumed_at)
       VALUES (?, 'global', 'linear', 'connector', ?, ?, ?, 'avalon://auth/complete', ?, NULL)`,
    ).run(state, sealedState, USER_ID, WORKSPACE_ID, "2099-01-01T00:00:00.000Z");

    const target = new URL(await service.failProviderAttempt("linear", state, "audit_write_failed"));

    expect(target.searchParams.get("status")).toBe("connected");
    expect(target.searchParams.get("connection")).toBe(connectionId);
    expect(database.prepare(
      "SELECT status, connection_id, error_code FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "succeeded",
      connection_id: connectionId,
      error_code: null,
    });
  });

  it("always returns to the hosted handoff when GitHub setup recovery also fails", async () => {
    const response = await createApp().request(
      `https://github.with-avalon.com/connections/github/setup?installation_id=1&state=${"x".repeat(20)}`,
      undefined,
      createTestEnv({
        ALLOWED_ORIGINS: "app://avalon",
        AVALON_REGION: "global",
        GITHUB_INGRESS_BASE_URL: "https://github.with-avalon.com",
        PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
        DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
        LOG_LEVEL: "error",
      }),
    );

    expect(response.status).toBe(302);
    const handoff = new URL(response.headers.get("location")!);
    const target = new URL(new URLSearchParams(handoff.hash.slice(1)).get("target")!);
    expect(handoff.pathname).toBe("/auth/desktop/");
    expect(target.searchParams.get("provider")).toBe("github");
    expect(target.searchParams.get("status")).toBe("failed");
    expect(target.searchParams.get("error")).toBe("invalid_oauth_state");
  });
});
