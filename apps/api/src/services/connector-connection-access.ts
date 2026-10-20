import { workspaceDOName } from "../durable-objects/names";
import { asWorkspaceId } from "@rally/contracts";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { decryptVersionedCredentialValue } from "./connector-credential-envelope";
import type { InstallationClaim } from "../durable-objects/connector-installation-protocol";
import type { ConnectorInstallationManagement } from "@rally/connectors";
import {
  ConnectorError,
  authorizedConnection,
  type AuthorizedConnectorConnection,
  type ConnectorConnectionContext,
} from "@rally/connectors";
import { nowIso } from "@rally/db";
import type { Env } from "../env";
import { encryptString } from "../lib/crypto";
import {
  ensureFreshConnectorCredentials,
  rotateConnectorCredentials,
  type CredentialRefreshAdapter,
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
/**
 * Read-only validation of a credential no connection holds yet.
 *
 * The door above exists because a stored credential can be stale, and only a
 * refresh against its row can say otherwise. Neither applies to a key an
 * administrator pasted a moment ago: there is no row to refresh from, nothing
 * to persist, and nothing that could have expired in between.
 *
 * It takes the facet and makes the call itself rather than handing the brand to
 * a callback. An earlier version did hand it over, with a comment saying the
 * operation had to be `validate` — which made the promise the seam exists to
 * enforce into a thing a caller had to remember, inside the one module the
 * lint rule exempts. Here there is nothing to misuse: the only call this can
 * make is the read the provider's own facet declares, so a failed setup leaves
 * nothing behind at the provider either.
 */
export async function validateUnstoredConnectorCredential(
  management: Pick<ConnectorInstallationManagement, "support" | "validate">,
  connection: ConnectorConnectionContext,
  signal: AbortSignal,
): Promise<void> {
  if (management.support.create !== "manual") throw new Error("unstored_validation_not_applicable");
  await management.validate(authorizedConnection(connection), signal);
}

/**
 * The one door through which a *stored* connector credential reaches an
 * adapter: see the contract above.
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
    // Any row a person has not disabled. Filtered on `status = 'healthy'`, this
    // silently dropped every credential an adapter rotated on a connection the
    // row believed was broken — the one case where the rotation was most likely
    // to be the thing that fixed it.
    `UPDATE connector_connections SET encrypted_credentials = ?, credential_iv = ?,
     credential_key_version = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
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
    // A provider refusal supersedes an operational error, but preserves an
    // existing reconnect diagnosis and a person's disabled state.
    `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ? AND status IN ('healthy', 'error')`,
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

/** Separate deletion-only purpose: no ordinary callback, refresh, or credential writes. */
export async function removeAuthorizedConnectorRegistration(
  env: Env, request: InstallationClaim, management: ConnectorInstallationManagement, signal: AbortSignal,
  onDispatch: () => void,
): Promise<void> {
  const workspaceId = asWorkspaceId(request.workspaceId);
  const object = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
  const snapshot = await object.connectorInstallationCleanup(request);
  const credentials = JSON.parse(await decryptVersionedCredentialValue(env, snapshot, request.connectionId)) as Record<string, unknown>;
  // Recheck after decryption, which yields; this also enforces retirement.
  const current = await object.connectorInstallationCleanup(request);
  if (current.providerId !== snapshot.providerId || current.encrypted_credentials !== snapshot.encrypted_credentials) throw new Error("connector_cleanup_superseded");
  signal.throwIfAborted();
  onDispatch();
  await management.remove(authorizedConnection({ id: request.connectionId, workspaceId: request.workspaceId,
    scope: "workspace", ownerUserId: null, credentials, config: {}, cursor: {}, grantedScopes: snapshot.grantedScopes }), snapshot.providerId, signal);
}
