import { ConnectorError } from "@rally/connectors";
import { encryptString } from "../src/lib/crypto";
import { ensureFreshConnectorCredentials } from "../src/services/connector-credential-refresh";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { commitConnectorCursor, recordConnectorPollFailure } from "../src/services/integrations";
import { markConnectorNeedsReconnect } from "../src/services/connector-connection-access";
import { createTestWorkspaceDO } from "./helpers/workspace-object-rpcs";
import { sqliteD1 } from "./helpers/sqlite-d1";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const connectionId = "00000000-0000-7000-8000-000000000002";
const input = { workspaceId, connectionId };
const now = "2026-10-19T23:56:28.000Z";
const pollError = { code: "connector_poll_failed", message: "Connector poll failed after retries" };
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// These tests prove SQL transitions against the real WorkspaceDO migrations;
// no runtime alarm, transaction rollback, or RPC transport is under test.
function fixture(status = "healthy", error: unknown = null) {
  const regionalDatabase = new DatabaseSync(":memory:");
  databases.push(regionalDatabase);
  const { objectDatabase } = createTestWorkspaceDO({
    workspaceId, regionalDatabase, register: (db) => databases.push(db),
  });
  objectDatabase.prepare(`INSERT INTO connector_connections
    (id, workspace_id, connector_type, scope, display_name, status, error_json, created_at, updated_at, model_plugin_id)
    VALUES (?, ?, 'google', 'workspace', 'Account', ?, ?, ?, ?, 'plugin_google')`)
    .run(connectionId, workspaceId, status, error === null ? null : JSON.stringify(error), now, now);
  return {
    db: sqliteD1(objectDatabase),
    objectDatabase,
    read: () => objectDatabase.prepare("SELECT status, error_json, cursor_json FROM connector_connections WHERE id = ?").get(connectionId),
  };
}

const commit = (db: D1Database, baseCursorJson = "{}") => commitConnectorCursor(db, input,
  { baseCursorJson, cursorJson: '{"page":2}' }, now);

describe("connector authorization and polling health", () => {
  it.each(["connector_poll_failed", "connector_poll_timeout"])("recovers %s after a successful committed poll", async (code) => {
    const { db, read } = fixture();
    await recordConnectorPollFailure(db, input, { ...pollError, code }, now);
    expect(read()).toMatchObject({ status: "error", error_json: JSON.stringify({ ...pollError, code }) });
    await expect(commit(db)).resolves.toBe("committed");
    expect(read()).toEqual({ status: "healthy", error_json: null, cursor_json: '{"page":2}' });
  });

  it.each(["needs_reconnect", "disabled", "error"])("preserves %s and its non-poll diagnosis across background failures and successes", async (status) => {
    const error = { code: "missing_scopes", reconnectRequired: true };
    const { db, read } = fixture(status, error);
    await recordConnectorPollFailure(db, input, pollError, now);
    expect(read()).toMatchObject({ status, error_json: JSON.stringify(error) });
    if (status === "disabled") await expect(commit(db)).rejects.toThrow("connector_cursor_commit_failed");
    else await commit(db);
    expect(read()).toMatchObject({ status, error_json: JSON.stringify(error) });
  });

  it("does not clear polling failure from a superseded cursor", async () => {
    const { db, read } = fixture("error", pollError);
    await expect(commit(db, '{"stale":true}')).resolves.toBe("superseded");
    expect(read()).toEqual({ status: "error", error_json: JSON.stringify(pollError), cursor_json: "{}" });
  });

  it("lets a provider refusal supersede a polling error and retains that first authorization diagnosis", async () => {
    const { db, read } = fixture("error", pollError);
    await markConnectorNeedsReconnect(db, { id: connectionId, workspaceId }, "invalid_grant");
    const expected = { status: "needs_reconnect", error_json: JSON.stringify({
      code: "connector_reauthorization_required", message: "Reconnect this connector account",
      reconnectRequired: true, reason: "invalid_grant",
    }) };
    expect(read()).toMatchObject(expected);
    await markConnectorNeedsReconnect(db, { id: connectionId, workspaceId }, "authorization_failed");
    await recordConnectorPollFailure(db, input, pollError, now);
    await commit(db);
    expect(read()).toMatchObject(expected);
  });

  it("records a rejected token refresh even when polling already marked an error", async () => {
    const { db, read, objectDatabase } = fixture("error", pollError);
    const credentials = { accessToken: "expired", refreshToken: "revoked", expiresAt: "2020-01-01T00:00:00Z" };
    const secret = "test-connector-health-key";
    const encrypted = await encryptString(JSON.stringify(credentials), secret, connectionId);
    objectDatabase.prepare(`UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?, credential_key_version = 1 WHERE id = ?`)
      .run(encrypted.ciphertext, encrypted.iv, connectionId);
    await expect(ensureFreshConnectorCredentials({ DB: db, CONNECTOR_CREDENTIALS_KEY: secret,
      CONNECTOR_CREDENTIALS_KEY_VERSION: "1" }, {
      id: connectionId, workspaceId, scope: "workspace", ownerUserId: null,
      credentials, grantedScopes: [], config: {}, cursor: {},
    }, { refreshCredentials: async () => {
      throw new ConnectorError("unauthorized", "Grant revoked", { reconnectRequired: true });
    } }, new AbortController().signal)).rejects.toThrow("Grant revoked");
    expect(read()).toMatchObject({ status: "needs_reconnect", error_json: JSON.stringify({
      code: "connector_reauthorization_required", message: "Reconnect this connector account",
      reconnectRequired: true, reason: "authorization_failed",
    }) });
  });

  it("never revives a disabled connection after a provider refusal", async () => {
    const { db, read } = fixture("disabled");
    await markConnectorNeedsReconnect(db, { id: connectionId, workspaceId }, "invalid_grant");
    expect(read()).toEqual({ status: "disabled", error_json: null, cursor_json: "{}" });
  });
});
