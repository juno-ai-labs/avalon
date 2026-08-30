import {
  ConnectorError,
  authorizedConnection,
  type AuthorizedConnectorConnection,
  type ConnectorConnectionContext,
} from "@rally/connectors";
import { asWorkspaceId } from "@rally/contracts";
import { nowIso } from "@rally/db";
import type { Env } from "../env";
import { encryptString } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import {
  ensureFreshConnectorCredentials,
  rotateConnectorCredentials,
  type CredentialRefreshAdapter,
} from "./connector-credential-refresh";

type ConnectionAccessEnv = Pick<Env,
  "DB" | "WORKSPACE_DOS" | "AVALON_REGION"
  | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION" | "CONNECTOR_CREDENTIALS_KEYS_JSON"
>;

function connectionObject(env: ConnectionAccessEnv, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env as Env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

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
    adapter: CredentialRefreshAdapter;
    signal: AbortSignal;
    /** Refresh a credential expiring within this window. */
    minimumValidityMs?: number;
  },
  operation: (connection: AuthorizedConnectorConnection) => Promise<T>,
): Promise<T> {
  const { connection, adapter, signal } = input;
  // Refreshed unconditionally. This used to be gated on a healthy row, because
  // the coordinator's lease was too and a refusal there replaced the provider's
  // answer with `Connector authorization is unavailable`. Both halves of that
  // are gone: the coordinator serves any row that is not `disabled`, and a
  // stored status is not evidence about the grant — only the provider is.
  await ensureFreshConnectorCredentials(env, connection, adapter, signal, input.minimumValidityMs);
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
      async (refused, rotateSignal) => {
        const rotated = await rotateConnectorCredentials(env, connection, adapter, rotateSignal, refused);
        credentialsBefore = JSON.stringify(rotated);
        return rotated;
      },
    ));
  } catch (error) {
    if (!isReconnectRequiredConnectorError(error)) throw error;
    // Persisted before the row is marked. The ordering no longer decides
    // whether the write lands — `persistConnectorCredentials` accepts any row
    // that is not `disabled` — but a credential the adapter rotated in place is
    // still worth storing ahead of the verdict that follows it.
    await persistIfChanged();
    const reason = reconnectReason(error);
    await markConnectorNeedsReconnect(env, connection, reason);
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
  env: ConnectionAccessEnv,
  connection: ConnectorConnectionContext,
): Promise<void> {
  const encrypted = await encryptString(
    JSON.stringify(connection.credentials),
    env.CONNECTOR_CREDENTIALS_KEY,
    connection.id,
  );
  // `activeOnly`: any row a person has not disabled. Filtered on
  // `status = 'healthy'`, this silently dropped every credential an adapter
  // rotated on a connection the row believed was broken — the one case where
  // the rotation was most likely to be the thing that fixed it.
  await (await connectionObject(env, connection.workspaceId)).setConnectionCredentials({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    credentials: {
      ciphertext: encrypted.ciphertext,
      iv: encrypted.iv,
      keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
    },
    activeOnly: true,
    at: nowIso(),
  });
}

export async function markConnectorNeedsReconnect(
  env: ConnectionAccessEnv,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
  reason: string,
): Promise<void> {
  // `fromStatus: "healthy"`, not merely "not disabled". This write carries a
  // diagnosis, and a row that is already marked holds the first and most
  // specific one. The door now runs for marked connections, so without this
  // every later attempt would re-stamp them — which is exactly how a
  // `missing_scopes: reactions:read` verdict was replaced by a bare
  // `unauthorized` hours after the fact.
  await (await connectionObject(env, connection.workspaceId)).setConnectionStatus({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    status: "needs_reconnect",
    errorJson: JSON.stringify({
      code: "connector_reauthorization_required",
      message: "Reconnect this connector account",
      reconnectRequired: true,
      reason,
    }),
    fromStatus: "healthy",
    at: nowIso(),
  });
}
