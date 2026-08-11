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
import {
  ensureFreshConnectorCredentials,
  rotateConnectorCredentials,
} from "./connector-credential-refresh";

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
    /**
     * The connection's stored status, for the callers that can hold one which
     * is not healthy.
     *
     * Rotation requires a healthy row — the refresh coordinator filters both
     * its lease claim and its credential reload on `status = 'healthy'` — so
     * for anything else a refresh cannot succeed and would only replace the
     * provider's answer with `Connector authorization is unavailable`. The
     * diagnostic paths that exist precisely to ask a broken connection what is
     * wrong with it (testing one, revoking one on disconnect) pass what they
     * loaded and reach the provider with the credentials on hand. Omitting
     * this asks for a refresh, which is the safe default: every other caller
     * selects healthy rows to begin with.
     */
    connectionStatus?: string;
  },
  operation: (connection: AuthorizedConnectorConnection) => Promise<T>,
): Promise<T> {
  const { connection, adapter, signal } = input;
  // Both the refresh and the rotation below claim a lease filtered on
  // `status = 'healthy'`, so neither can succeed for a connection D1 holds in
  // any other state. Gating them together is what keeps a diagnostic path
  // reaching the provider: with no rotation registered,
  // `withProviderReauthorization` falls back to the adapter's own refresh, and
  // the provider's answer survives instead of being replaced by an
  // availability error from a lease that could never have been claimed.
  const rotatable = input.connectionStatus === undefined || input.connectionStatus === "healthy";
  if (rotatable) {
    await ensureFreshConnectorCredentials(env, connection, adapter, signal, input.minimumValidityMs);
  }
  let credentialsBefore = JSON.stringify(connection.credentials);
  const persistIfChanged = async () => {
    if (JSON.stringify(connection.credentials) === credentialsBefore) return;
    await persistConnectorCredentials(env, connection);
    credentialsBefore = JSON.stringify(connection.credentials);
  };
  try {
    // An adapter that meets a mid-call rejection rotates through the same lease
    // this door's refresh uses, rather than redeeming the stored refresh token
    // beside it. Like the refresh above, that coordinator persists what it
    // rotated, so the baseline moves with it and only mutations the adapter
    // makes afterwards are written again below.
    return await operation(authorizedConnection(
      connection,
      rotatable
        ? async (refused, rotateSignal) => {
            const rotated = await rotateConnectorCredentials(env, connection, adapter, rotateSignal, refused);
            credentialsBefore = JSON.stringify(rotated);
            return rotated;
          }
        : undefined,
    ));
  } catch (error) {
    if (!isReconnectRequiredConnectorError(error)) throw error;
    // Persisted before the row leaves `healthy`: `persistConnectorCredentials`
    // filters on that status, so marking first would silently discard a
    // credential the adapter had rotated in place and leave only a spent one
    // stored.
    await persistIfChanged();
    const reason = reconnectReason(error);
    await markConnectorNeedsReconnect(env.DB, connection, reason);
    throw new ConnectorError("unauthorized", "This connector connection needs reconnecting", {
      reconnectRequired: true,
      reason,
    });
  } finally {
    await persistIfChanged();
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
