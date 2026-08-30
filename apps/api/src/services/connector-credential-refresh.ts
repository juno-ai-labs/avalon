import {
  ConnectorError,
  isRevokedGrantError,
  type ConnectorConnectionContext,
  type ResolvedConnectorAdapter,
} from "@rally/connectors";
import { nowIso } from "@rally/db";
import { z } from "zod";
import { asWorkspaceId } from "@rally/contracts";

import type { Env } from "../env";
import { encryptString } from "../lib/crypto";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceConnectionLeaseClaimResultSchema,
  WorkspaceConnectionResultSchema,
  WorkspaceConnectionSettleResultSchema,
  type WorkspaceConnectionLeaseClaimResult,
} from "../durable-objects/workspace-connections-protocol";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";

/** Waits before a rotation gives up rather than spinning to the caller's deadline. */
const ROTATION_WAIT_ATTEMPTS = 8;

const CredentialRowSchema = z.object({
  encrypted_credentials: z.string().min(1),
  credential_iv: z.string().min(1),
  credential_key_version: z.coerce.number().int().positive(),
});

type CredentialEnv = Pick<Env,
  "DB" | "WORKSPACE_DOS" | "AVALON_REGION"
  | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION" | "CONNECTOR_CREDENTIALS_KEYS_JSON"
>;

/**
 * How long a refresh may hold the connection before a rival may take it.
 *
 * Not a new number: it is the two minutes this lease has always used, moved
 * from a `Date.now()` the caller computed to a duration the object turns into
 * a deadline. The object owns lifecycle time, so a caller with a slow clock can
 * no longer mint a lease that is already expired.
 */
const CREDENTIAL_LEASE_MS = 2 * 60_000;

function workspaceObjectFor(env: CredentialEnv, workspaceId: string) {
  return durableObjectStubForWorkspace(
    env as Env,
    env.WORKSPACE_DOS,
    asWorkspaceId(workspaceId),
    workspaceDOName(env.AVALON_REGION, asWorkspaceId(workspaceId)),
  );
}

/** The only adapter capability credential coordination is allowed to use. */
export type CredentialRefreshAdapter = Pick<ResolvedConnectorAdapter, "refreshCredentials">;

export async function ensureFreshConnectorCredentials(
  env: CredentialEnv,
  connection: ConnectorConnectionContext,
  adapter: CredentialRefreshAdapter,
  signal: AbortSignal,
  minimumValidityMs = 60_000,
): Promise<void> {
  if (!adapter.refreshCredentials || !needsRefresh(connection.credentials, minimumValidityMs)) return;
  let waited = 0;
  while (true) {
    signal.throwIfAborted();
    const claim = await claimCredentialLease(env, connection);

    if (claim.outcome !== "claimed") {
      const current = await loadCredentials(env, connection);
      if (!needsRefresh(current, minimumValidityMs)) {
        connection.credentials = current;
        return;
      }
      // Bounded and backed off, matching `rotateConnectorCredentials`. A flat
      // 100ms poll re-reads D1 ~300 times under the default tool deadline, and
      // a lease a crashed sibling left behind holds it there for the full
      // two-minute expiry. That was survivable while only healthy rows reached
      // here; admitting every non-disabled row puts a much larger population on
      // this path.
      waited += 1;
      if (waited > ROTATION_WAIT_ATTEMPTS) {
        throw new ConnectorError("provider_error", "Connector credentials are still being refreshed by another request");
      }
      await abortableDelay(Math.min(100 * 2 ** (waited - 1), 2_000), signal);
      continue;
    }

    try {
      const current = await decryptClaimedCredentials(env, connection, claim);
      if (!needsRefresh(current, minimumValidityMs)) {
        connection.credentials = current;
        await releaseLease(env, connection, claim.leaseId);
        return;
      }
      const refreshed = await adapter.refreshCredentials(
        { ...connection, credentials: current },
        signal,
      );
      const encrypted = await encryptString(
        JSON.stringify(refreshed),
        env.CONNECTOR_CREDENTIALS_KEY,
        connection.id,
      );
      // Writes the credential and nothing else. An earlier draft also healed
      // the row to `healthy` here, on the reasoning that a provider honouring
      // the refresh token has said the grant is alive. It does say that — and
      // grant *liveness* is not grant *sufficiency*. A token exchange
      // succeeds no matter which scopes the installation holds, so healing
      // here would have cleared the incident's own `missing_scopes:
      // reactions:read` verdict within one token lifetime, dropped the
      // reconnect badge, and left a connection reporting healthy while every
      // scoped call kept failing — a stricter version of the erasure this
      // work exists to end. Worse, the next failure re-marks it and the next
      // rotation heals it again, so the row and the badge oscillate.
      //
      // Healing belongs to the paths that get an answer covering the whole
      // question: reauthorization, which re-grants the scopes, and an
      // explicit connection test, which calls the provider. Both already do
      // it. Nothing is lost by not healing here — the connection *works*
      // while marked now, which was the damage.
      const persisted = WorkspaceConnectionSettleResultSchema.parse(
        await (await workspaceObjectFor(env, connection.workspaceId))
          .settleConnectionCredentialLease({
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            leaseId: claim.leaseId,
            credentials: {
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
            },
            at: nowIso(),
          }),
      );
      if (persisted.outcome !== "settled") throw new ConnectorError("provider_error", "Connector credentials changed while they were being refreshed");
      connection.credentials = refreshed;
      return;
    } catch (error) {
      await releaseLease(env, connection, claim.leaseId);
      // Only a refusal that says so. `unauthorized` alone is what a token
      // endpoint yields for `invalid_client` or a malformed request of ours —
      // Avalon's configuration being wrong, which no member can fix by
      // reconnecting an account that still works. Adapters mark a genuinely
      // dead grant with `reconnectRequired`, matching what the credential door
      // already required.
      if (isReconnectRequired(error)) await markNeedsReconnect(env, connection);
      throw error;
    }
  }
}

/**
 * Whether the provider said the grant itself is gone, not merely that a call
 * failed.
 *
 * An adapter that classified the failure itself is believed outright — that is
 * the contract, and it is the only thing that can read a provider's private
 * vocabulary (Slack answers a refused refresh with HTTP 200 and
 * `{ok: false, error: "token_revoked"}`, which no status test can see).
 *
 * When an adapter states nothing, the fallback is deliberately *not* silence.
 * Requiring the flag makes forgetting it strand a connection: the row stays
 * `healthy`, every run drops the plugin, and nobody is ever prompted — a
 * failure that is invisible until someone happens to test the connection.
 * `isRevokedGrantError` reads the provider's own OAuth code instead, so a named
 * `invalid_client` or `invalid_request` — Avalon's configuration being wrong,
 * which no member can fix by reconnecting a working account — still declines to
 * mark, while an unclassifiable 400/401/403 from a token endpoint does.
 */
function isReconnectRequired(error: unknown): boolean {
  if (!(error instanceof ConnectorError) || error.code !== "unauthorized") return false;
  if (
    typeof error.details === "object"
    && error.details !== null
    && "reconnectRequired" in error.details
  ) {
    return error.details.reconnectRequired === true;
  }
  return isRevokedGrantError(error);
}

/**
 * Rotates a credential the provider has just refused, under the same lease
 * that serializes expiry-driven refreshes.
 *
 * A rotating refresh token is single-use. Two calls that are in flight together
 * and are both refused would otherwise each redeem the stored one, and the
 * loser's `invalid_grant` would mark a connection `needs_reconnect` that had in
 * fact just been rotated successfully by its sibling. Serializing through the
 * lease makes the second caller wait and then discover the sibling's result:
 * credentials that differ from the ones that were refused are the sibling's
 * rotation, and are adopted rather than redeemed over.
 */
export async function rotateConnectorCredentials(
  env: CredentialEnv,
  connection: ConnectorConnectionContext,
  adapter: CredentialRefreshAdapter,
  signal: AbortSignal,
  refused: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!adapter.refreshCredentials) {
    throw new ConnectorError("unauthorized", "This connector cannot rotate its credentials");
  }
  let attempt = 0;
  while (true) {
    signal.throwIfAborted();
    const claim = await claimCredentialLease(env, connection);

    if (claim.outcome !== "claimed") {
      const current = await loadCredentials(env, connection);
      if (!sameCredentials(current, refused)) return current;
      // Bounded and backed off. A waiter polling flat out re-reads D1 ~300
      // times under the default tool deadline, and a lease a crashed sibling
      // left behind pushes that to its two-minute expiry with the waiter
      // spinning throughout. This path is reached on rejection, where several
      // in-flight calls are likelier to pile onto one connection than they are
      // on the expiry route.
      attempt += 1;
      if (attempt > ROTATION_WAIT_ATTEMPTS) {
        throw new ConnectorError("provider_error", "Connector credentials are still being rotated by another request");
      }
      await abortableDelay(Math.min(100 * 2 ** (attempt - 1), 2_000), signal);
      continue;
    }

    try {
      const current = await decryptClaimedCredentials(env, connection, claim);
      if (!sameCredentials(current, refused)) {
        await releaseLease(env, connection, claim.leaseId);
        return current;
      }
      const refreshed = await adapter.refreshCredentials({ ...connection, credentials: current }, signal);
      const encrypted = await encryptString(
        JSON.stringify(refreshed),
        env.CONNECTOR_CREDENTIALS_KEY,
        connection.id,
      );
      // Writes the credential and nothing else. An earlier draft also healed
      // the row to `healthy` here, on the reasoning that a provider honouring
      // the refresh token has said the grant is alive. It does say that — and
      // grant *liveness* is not grant *sufficiency*. A token exchange
      // succeeds no matter which scopes the installation holds, so healing
      // here would have cleared the incident's own `missing_scopes:
      // reactions:read` verdict within one token lifetime, dropped the
      // reconnect badge, and left a connection reporting healthy while every
      // scoped call kept failing — a stricter version of the erasure this
      // work exists to end. Worse, the next failure re-marks it and the next
      // rotation heals it again, so the row and the badge oscillate.
      //
      // Healing belongs to the paths that get an answer covering the whole
      // question: reauthorization, which re-grants the scopes, and an
      // explicit connection test, which calls the provider. Both already do
      // it. Nothing is lost by not healing here — the connection *works*
      // while marked now, which was the damage.
      const persisted = WorkspaceConnectionSettleResultSchema.parse(
        await (await workspaceObjectFor(env, connection.workspaceId))
          .settleConnectionCredentialLease({
            workspaceId: connection.workspaceId,
            connectionId: connection.id,
            leaseId: claim.leaseId,
            credentials: {
              ciphertext: encrypted.ciphertext,
              iv: encrypted.iv,
              keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
            },
            at: nowIso(),
          }),
      );
      if (persisted.outcome !== "settled") throw new ConnectorError("provider_error", "Connector credentials changed while they were being rotated");
      return refreshed;
    } catch (error) {
      await releaseLease(env, connection, claim.leaseId);
      if (isReconnectRequired(error)) await markNeedsReconnect(env, connection);
      throw error;
    }
  }
}

function sameCredentials(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function markNeedsReconnect(
  env: CredentialEnv,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
): Promise<void> {
  // `fromStatus: "healthy"`, and deliberately not relaxed with the gates around
  // it: this one is a *write*, not a refusal to try. A row already marked
  // carries the first and most specific diagnosis of why it broke, and
  // re-marking would overwrite it with this generic one on every later
  // attempt — the exact way a `missing_scopes: reactions:read` verdict was
  // lost behind a bare `unauthorized` hours after the fact.
  await (await workspaceObjectFor(env, connection.workspaceId)).setConnectionStatus({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    status: "needs_reconnect",
    errorJson: JSON.stringify({
      code: "connector_reauthorization_required",
      message: "Reconnect this connector account",
      reconnectRequired: true,
      reason: "authorization_failed",
    }),
    fromStatus: "healthy",
    at: nowIso(),
  });
}

function needsRefresh(credentials: Record<string, unknown>, minimumValidityMs: number): boolean {
  return typeof credentials.expiresAt === "string"
    && Date.parse(credentials.expiresAt) < Date.now() + minimumValidityMs;
}

async function loadCredentials(
  env: CredentialEnv,
  connection: ConnectorConnectionContext,
): Promise<Record<string, unknown>> {
  const { connection: row } = WorkspaceConnectionResultSchema.parse(
    await (await workspaceObjectFor(env, connection.workspaceId)).connection({
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      activeOnly: true,
    }),
  );
  if (!row) throw new ConnectorError("unauthorized", "Connector authorization is unavailable");
  return decryptCredentials(env, connection.id, CredentialRowSchema.parse(row), connection.workspaceId);
}

/**
 * The envelope the claim already returned, decrypted.
 *
 * The claim hands back what it won in the same write, so this never re-reads:
 * a second read could see an envelope a rival settled after the claim, and
 * decrypt credentials this holder does not own the lease for.
 */
async function decryptClaimedCredentials(
  env: CredentialEnv,
  connection: ConnectorConnectionContext,
  claim: Extract<WorkspaceConnectionLeaseClaimResult, { outcome: "claimed" }>,
): Promise<Record<string, unknown>> {
  if (!claim.credentials) {
    throw new ConnectorError("unauthorized", "Connector authorization is unavailable");
  }
  return decryptCredentials(env, connection.id, CredentialRowSchema.parse({
    encrypted_credentials: claim.credentials.ciphertext,
    credential_iv: claim.credentials.iv,
    credential_key_version: claim.credentials.keyVersion,
  }), connection.workspaceId);
}

async function claimCredentialLease(
  env: CredentialEnv,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
): Promise<WorkspaceConnectionLeaseClaimResult> {
  const object = await workspaceObjectFor(env, connection.workspaceId);
  return WorkspaceConnectionLeaseClaimResultSchema.parse(
    await object.claimConnectionCredentialLease({
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      leaseMs: CREDENTIAL_LEASE_MS,
      at: nowIso(),
    }),
  );
}

async function decryptCredentials(
  env: CredentialEnv,
  connectionId: string,
  row: z.infer<typeof CredentialRowSchema>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const plaintext = await decryptVersionedConnectorCredentials(env, {
    id: connectionId,
    workspace_id: workspaceId,
    encrypted_credentials: row.encrypted_credentials,
    credential_iv: row.credential_iv,
    credential_key_version: row.credential_key_version,
  });
  return z.record(z.string(), z.unknown()).parse(JSON.parse(plaintext));
}

async function releaseLease(
  env: CredentialEnv,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
  leaseId: string,
): Promise<void> {
  await (await workspaceObjectFor(env, connection.workspaceId)).releaseConnectionCredentialLease({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    leaseId,
  });
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
