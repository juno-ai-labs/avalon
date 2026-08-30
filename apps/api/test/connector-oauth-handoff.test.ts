import { asUserId, asWorkspaceId } from "@rally/contracts";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { AuthContext, Env } from "../src/env";
import { sealString } from "../src/lib/crypto";
import { desktopHandoffUrl } from "../src/lib/desktop-handoff";
import { __connectionServiceTesting, ConnectionService } from "../src/services/connection-service";
import { createTestEnv } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import {
  CONNECTION_WORKSPACE_OBJECT_METHODS,
  createTestWorkspaceDO,
  testWorkspaceObjectBinding,
} from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000001");
const OTHER_USER_ID = asUserId("00000000-0000-4000-8000-000000000002");
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000003");

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * A real `WorkspaceDO` over its own schema answers the attempt RPCs, and the
 * facade's remaining generic statements reach the same object through
 * `executeRuntimeSql` — only the transport is doubled. `oauth_states` and the
 * ingress-route projection stay on the regional database, as in production.
 */
/** The workspace object an env is bound to, for a test that sets state up. */
function workspaceObjectOf(env: Env) {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName("workspace"));
}

function fixture(): { regional: DatabaseSync; object: DatabaseSync; env: Env; auth: AuthContext } {
  const regional = new DatabaseSync(":memory:");
  databases.push(regional);
  regional.exec(`
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
    CREATE TABLE connector_ingress_routes (
      connection_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      scope TEXT NOT NULL,
      provider_account_id TEXT,
      provider_user_id TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const workspace = createTestWorkspaceDO({
    workspaceId: WORKSPACE_ID,
    regionalDatabase: regional,
    register: (created) => { databases.push(created); },
  });
  return {
    regional,
    object: workspace.objectDatabase,
    env: createTestEnv({
      DB: sqliteD1(regional),
      AVALON_REGION: "global",
      APP_ENV: "test",
      PUBLIC_WEB_BASE_URL: "https://with-avalon.com",
      DESKTOP_DEEP_LINK_URI: "avalon://auth/complete",
      OAUTH_STATE_ENCRYPTION_KEY: "test-oauth-state-encryption-key",
      // The connection methods ride with the attempt methods now: a completion
      // settles its attempt inside the same `transactionSync` that writes the
      // connection, so binding one without the other would serve half a
      // critical section from a different store.
      WORKSPACE_DOS: testWorkspaceObjectBinding(
        workspace.instance,
        CONNECTION_WORKSPACE_OBJECT_METHODS,
      ),
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
  object: DatabaseSync,
  input: {
    id: string;
    userId?: string;
    status?: string;
    connectionId?: string | null;
    errorCode?: string | null;
    expiresAt: string;
  },
): void {
  object.prepare(
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

function insertConnection(object: DatabaseSync, id: string): void {
  object.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id,
      display_name, granted_scopes_json, status, cursor_json, config_json,
      created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'linear', 'workspace', NULL, NULL, 'Linear', '[]', 'healthy',
             '{}', '{}', ?, ?, ?)`,
  ).run(id, WORKSPACE_ID, new Date().toISOString(), new Date().toISOString(), `plugin_linear_${id.slice(-4)}`);
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
    const { auth, object, env } = fixture();
    const attemptId = "a".repeat(43);
    insertAttempt(object, { id: attemptId, expiresAt: "2099-01-01T00:00:00.000Z" });

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
    const { auth, object, env } = fixture();
    const attemptId = "b".repeat(43);
    insertAttempt(object, { id: attemptId, expiresAt: "2020-01-01T00:00:00.000Z" });

    await expect(new ConnectionService(env, auth).getOAuthAttempt(attemptId)).resolves.toMatchObject({
      attemptId,
      status: "failed",
      errorCode: "oauth_attempt_expired",
    });
    expect(object.prepare("SELECT status, error_code FROM connector_oauth_attempts WHERE id = ?")
      .get(attemptId)).toEqual({ status: "failed", error_code: "oauth_attempt_expired" });
  });

  it("lets a callback that already consumed valid state win an expiry reconciliation race", async () => {
    const { auth, object, env } = fixture();
    const attemptId = "c".repeat(43);
    const connectionId = "00000000-0000-7000-8000-000000000004";
    insertConnection(object, connectionId);
    insertAttempt(object, { id: attemptId, expiresAt: "2020-01-01T00:00:00.000Z" });
    const service = new ConnectionService(env, auth);

    await service.getOAuthAttempt(attemptId);
    await (service as unknown as {
      finishOAuthAttempt(
        workspaceId: string,
        id: string,
        status: "succeeded",
        result: { connectionId: string },
      ): Promise<void>;
    }).finishOAuthAttempt(WORKSPACE_ID, attemptId, "succeeded", { connectionId });

    expect(object.prepare(
      "SELECT status, connection_id, error_code FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "succeeded",
      connection_id: connectionId,
      error_code: null,
    });
  });

  it("extends and revives an expiry-reconciled attempt for GitHub's second OAuth leg", async () => {
    const { auth, object, env } = fixture();
    const attemptId = "d".repeat(43);
    const expiresAt = "2099-01-01T00:10:00.000Z";
    insertAttempt(object, {
      id: attemptId,
      status: "failed",
      errorCode: "oauth_attempt_expired",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });
    const service = new ConnectionService(env, auth);

    await (service as unknown as {
      extendOAuthAttempt(workspaceId: string, id: string, nextExpiry: string): Promise<void>;
    }).extendOAuthAttempt(WORKSPACE_ID, attemptId, expiresAt);

    expect(object.prepare(
      "SELECT status, error_code, completed_at, expires_at FROM connector_oauth_attempts WHERE id = ?",
    ).get(attemptId)).toEqual({
      status: "pending",
      error_code: null,
      completed_at: null,
      expires_at: expiresAt,
    });
  });

  it("reconciles a healthy committed connection as success after a later callback step fails", async () => {
    const { auth, object, env, regional } = fixture();
    const attemptId = "e".repeat(43);
    const state = "s".repeat(32);
    const connectionId = "00000000-0000-7000-8000-000000000005";
    insertAttempt(object, {
      id: attemptId,
      status: "failed",
      errorCode: "oauth_state_already_used",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const service = new ConnectionService(env, auth);
    // The typed write, with its attempt bind — what the completion paths call.
    // This used to reach through the service into `persistConnectionMutation`
    // and hand it a hand-prepared statement, because the connection write and
    // the attempt bind were a D1 batch the test had to assemble. They are one
    // method now, so the setup is the same call production makes.
    await workspaceObjectOf(env).createConnection({
      workspaceId: WORKSPACE_ID,
      connectionId,
      connectorType: "linear",
      scope: "workspace",
      ownerUserId: null,
      providerAccountId: null,
      displayName: "Linear",
      credentials: null,
      grantedScopesJson: "[]",
      modelPluginId: "plugin_linear",
      configJson: "{}",
      nextPollAt: null,
      at: "2026-08-18T00:00:00.000Z",
      bindAttempt: { attemptId, region: "global" },
    });
    const sealedState = await sealString(
      JSON.stringify({ attemptId }),
      env.OAUTH_STATE_ENCRYPTION_KEY,
    );
    regional.prepare(
      `INSERT INTO oauth_states
       (id, region, provider, purpose, code_verifier_encrypted, user_id, workspace_id,
        return_uri, expires_at, consumed_at)
       VALUES (?, 'global', 'linear', 'connector', ?, ?, ?, 'avalon://auth/complete', ?, NULL)`,
    ).run(state, sealedState, USER_ID, WORKSPACE_ID, "2099-01-01T00:00:00.000Z");

    const target = new URL(await service.failProviderAttempt("linear", state, "audit_write_failed"));

    expect(target.searchParams.get("status")).toBe("connected");
    expect(target.searchParams.get("connection")).toBe(connectionId);
    expect(object.prepare(
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
