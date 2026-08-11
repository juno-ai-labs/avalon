import {
  ConnectorError,
  authorizedConnection,
  type AuthorizedConnectorConnection,
  type ConnectorConnectionContext,
  type ResolvedConnectorAdapter,
} from "@avalon/connectors";
import { nowIso } from "@avalon/db";
import type { Env } from "../env";
import { encryptString } from "../lib/crypto";
import { ensureFreshConnectorCredentials } from "./connector-credential-refresh";

type ConnectionAccessEnv = Pick<Env,
  "DB" | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION" | "CONNECTOR_CREDENTIALS_KEYS_JSON"
>;

/**
 * The one door through which a connector adapter is reached.
 *
 * Every provider-calling adapter entry point takes an
 * `AuthorizedConnectorConnection`, and this is the only function in the API
 * that produces one. Calling out with a stale credential is therefore not a
 * step a caller can forget; it is a value a caller cannot obtain. Around the
 * operation the door also owns the two lifecycle duties that used to be
 * stacked by hand at each call site, and were dropped wherever the refresh
 * was:
 *
 * - credentials the adapter rotated in place are persisted, and
 * - an authorization the provider refuses marks the connection
 *   `needs_reconnect` so the desktop stops presenting it as healthy.
 *
 * `ensureFreshConnectorCredentials` persists the tokens it rotates itself, so
 * a refresh here is durable even when the operation later fails.
 */
export async function withAuthorizedConnection<T>(
  env: ConnectionAccessEnv,
  input: {
    connection: ConnectorConnectionContext;
    adapter: ResolvedConnectorAdapter;
    signal: AbortSignal;
    /** Refresh a credential expiring within this window. */
    minimumValidityMs?: number;
  },
  operation: (connection: AuthorizedConnectorConnection) => Promise<T>,
): Promise<T> {
  const { connection, adapter, signal } = input;
  await ensureFreshConnectorCredentials(env, connection, adapter, signal, input.minimumValidityMs);
  const credentialsBefore = JSON.stringify(connection.credentials);
  try {
    return await operation(authorizedConnection(connection));
  } catch (error) {
    if (!isReconnectRequiredConnectorError(error)) throw error;
    const reason = reconnectReason(error);
    await markConnectorNeedsReconnect(env.DB, connection, reason);
    throw new ConnectorError("unauthorized", "This connector connection needs reconnecting", {
      reconnectRequired: true,
      reason,
    });
  } finally {
    if (JSON.stringify(connection.credentials) !== credentialsBefore) {
      await persistConnectorCredentials(env, connection);
    }
  }
}

export function isReconnectRequiredConnectorError(error: unknown): error is ConnectorError {
  if (!(error instanceof ConnectorError) || error.code !== "unauthorized") return false;
  const details = error.details;
  return Boolean(
    details &&
    typeof details === "object" &&
    "reconnectRequired" in details &&
    details.reconnectRequired === true,
  );
}

export function reconnectReason(error: ConnectorError): string {
  const details = error.details;
  if (!details || typeof details !== "object" || !("reason" in details) || typeof details.reason !== "string") {
    return "authorization_failed";
  }
  return [
    "invalid_grant",
    "api_unauthorized",
    "missing_access_token",
    "missing_credentials",
    "missing_refresh_token",
  ].includes(details.reason)
    ? details.reason
    : "authorization_failed";
}

export async function persistConnectorCredentials(
  env: Pick<Env, "DB" | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION">,
  connection: ConnectorConnectionContext,
): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify(connection.credentials),
    env.CONNECTOR_CREDENTIALS_KEY,
    connection.id,
  );
  await env.DB.prepare(
    `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
     credential_key_version = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status = 'healthy'`,
  ).bind(
    encrypted.ciphertext,
    encrypted.iv,
    Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
    nowIso(),
    connection.id,
    connection.workspaceId,
  ).run();
}

export async function markConnectorNeedsReconnect(
  database: D1Database,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
  reason: string,
): Promise<void> {
  await database.prepare(
    `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status != 'disabled'`,
  ).bind(
    JSON.stringify({
      code: "connector_reauthorization_required",
      message: "Reconnect this connector account",
      reconnectRequired: true,
      reason,
    }),
    nowIso(),
    connection.id,
    connection.workspaceId,
  ).run();
}
