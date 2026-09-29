import { ConnectorError, type ConnectorConnectionContext } from "@rally/connectors";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { withAuthorizedConnection } from "../src/services/connector-connection-access";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

/**
 * A refused grant marks the row `needs_reconnect`, the one status the desktop
 * turns into "Reconnect". A failed poll used to stamp a generic `error` over
 * that mark, and the mark only matched `healthy` rows, so a revoked Google
 * grant was never shown as one again and was polled forever.
 */

const workspaceId = "00000000-0000-7000-8000-00000000a001";
const connectionId = "00000000-0000-7000-8000-00000000c001";
const userId = "00000000-0000-7000-8000-00000000u001";
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("marking a connection for reconnect", () => {
  it("upgrades a generic error, so a failed poll cannot hide a revoked grant", async () => {
    const database = seeded("error", JSON.stringify({ code: "connector_poll_failed" }));

    await expect(refuse(database)).rejects.toThrow(ConnectorError);

    expect(row(database)).toEqual({
      status: "needs_reconnect",
      reason: "invalid_grant",
    });
  });

  it("keeps the first reconnect diagnosis", async () => {
    const database = seeded("needs_reconnect", JSON.stringify({ reason: "missing_scopes" }));

    await expect(refuse(database)).rejects.toThrow(ConnectorError);

    expect(row(database)).toEqual({ status: "needs_reconnect", reason: "missing_scopes" });
  });
});

function refuse(database: DatabaseSync): Promise<unknown> {
  const connection: ConnectorConnectionContext = {
    id: connectionId,
    workspaceId,
    scope: "personal",
    ownerUserId: userId,
    grantedScopes: [],
    credentials: { accessToken: "token", expiresAt: "2099-01-01T00:00:00.000Z" },
    cursor: {},
    config: {},
  };
  return withAuthorizedConnection(
    { DB: sqliteD1(database), CONNECTOR_CREDENTIALS_KEY: "key", CONNECTOR_CREDENTIALS_KEY_VERSION: "1" },
    { connection, adapter: {}, signal: AbortSignal.timeout(2_000) },
    async () => {
      throw new ConnectorError("unauthorized", "Grant revoked", { reconnectRequired: true, reason: "invalid_grant" });
    },
  );
}

function seeded(status: string, errorJson: string): DatabaseSync {
  const database = legacyProductSqliteDatabase();
  databases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${userId}', 'owner-subject', 'owner@example.com', 'Owner', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${workspaceId}', 'Workspace', 'workspace', 'global', '${userId}', '2026-01-01', '2026-01-01');
  `);
  database.prepare(
    `INSERT INTO connector_connections
     (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
      granted_scopes_json, status, error_json, cursor_json, config_json, created_at, updated_at, model_plugin_id)
     VALUES (?, ?, 'google', 'personal', ?, 'acct', 'Google', '[]', ?, ?, '{}', '{}', '2026-01-01', '2026-01-01', 'plugin_google')`,
  ).run(connectionId, workspaceId, userId, status, errorJson);
  return database;
}

function row(database: DatabaseSync): { status: string; reason: unknown } {
  const stored = database.prepare("SELECT status, error_json FROM connector_connections WHERE id = ?")
    .get(connectionId) as { status: string; error_json: string };
  return { status: stored.status, reason: (JSON.parse(stored.error_json) as { reason?: unknown }).reason };
}
