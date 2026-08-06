import {
  ConnectorError,
  type ConnectorConnectionContext,
  type ResolvedConnectorAdapter,
} from "@avalon/connectors";
import { nowIso } from "@avalon/db";
import { z } from "zod";
import type { Env } from "../env";
import { decryptString, encryptString } from "../lib/crypto";

const CredentialRowSchema = z.object({
  encrypted_credentials: z.string().min(1),
  credential_iv: z.string().min(1),
});

type CredentialEnv = Pick<Env,
  "DB" | "CONNECTOR_CREDENTIALS_KEY" | "CONNECTOR_CREDENTIALS_KEY_VERSION"
>;

export async function ensureFreshConnectorCredentials(
  env: CredentialEnv,
  connection: ConnectorConnectionContext,
  adapter: ResolvedConnectorAdapter,
  signal: AbortSignal,
  minimumValidityMs = 60_000,
): Promise<void> {
  if (!adapter.refreshCredentials || !needsRefresh(connection.credentials, minimumValidityMs)) return;
  while (true) {
    signal.throwIfAborted();
    const leaseId = crypto.randomUUID();
    const at = nowIso();
    const claimed = await env.DB.prepare(
      `UPDATE connector_connections SET
         credential_refresh_lease_id = ?, credential_refresh_lease_expires_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'healthy'
         AND (credential_refresh_lease_id IS NULL OR credential_refresh_lease_expires_at < ?)
       RETURNING encrypted_credentials, credential_iv`,
    ).bind(
      leaseId,
      new Date(Date.now() + 2 * 60_000).toISOString(),
      connection.id,
      connection.workspaceId,
      at,
    ).first<Record<string, unknown>>();

    if (!claimed) {
      const current = await loadCredentials(env, connection);
      if (!needsRefresh(current, minimumValidityMs)) {
        connection.credentials = current;
        return;
      }
      await abortableDelay(100, signal);
      continue;
    }

    try {
      const current = await decryptCredentials(env, connection.id, CredentialRowSchema.parse(claimed));
      if (!needsRefresh(current, minimumValidityMs)) {
        connection.credentials = current;
        await releaseLease(env.DB, connection, leaseId);
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
      const persisted = await env.DB.prepare(
        `UPDATE connector_connections SET
           encrypted_credentials = ?, credential_iv = ?, credential_key_version = ?,
           credential_refresh_lease_id = NULL, credential_refresh_lease_expires_at = NULL,
           updated_at = ?
         WHERE id = ? AND workspace_id = ? AND status = 'healthy'
           AND credential_refresh_lease_id = ?
         RETURNING id`,
      ).bind(
        encrypted.ciphertext,
        encrypted.iv,
        Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1),
        nowIso(),
        connection.id,
        connection.workspaceId,
        leaseId,
      ).first<{ id: string }>();
      if (!persisted) throw new ConnectorError("provider_error", "Connector credentials changed while they were being refreshed");
      connection.credentials = refreshed;
      return;
    } catch (error) {
      await releaseLease(env.DB, connection, leaseId);
      if (error instanceof ConnectorError && error.code === "unauthorized") {
        await env.DB.prepare(
          `UPDATE connector_connections SET status = 'needs_reconnect', error_json = ?, updated_at = ?
           WHERE id = ? AND workspace_id = ? AND status = 'healthy'`,
        ).bind(
          JSON.stringify({
            code: "connector_reauthorization_required",
            message: "Reconnect this connector account",
            reconnectRequired: true,
            reason: "authorization_failed",
          }),
          nowIso(),
          connection.id,
          connection.workspaceId,
        ).run();
      }
      throw error;
    }
  }
}

function needsRefresh(credentials: Record<string, unknown>, minimumValidityMs: number): boolean {
  return typeof credentials.expiresAt === "string"
    && Date.parse(credentials.expiresAt) < Date.now() + minimumValidityMs;
}

async function loadCredentials(
  env: CredentialEnv,
  connection: ConnectorConnectionContext,
): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    `SELECT encrypted_credentials, credential_iv
     FROM connector_connections
     WHERE id = ? AND workspace_id = ? AND status = 'healthy'`,
  ).bind(connection.id, connection.workspaceId).first<Record<string, unknown>>();
  if (!row) throw new ConnectorError("unauthorized", "Connector authorization is unavailable");
  return decryptCredentials(env, connection.id, CredentialRowSchema.parse(row));
}

async function decryptCredentials(
  env: CredentialEnv,
  connectionId: string,
  row: z.infer<typeof CredentialRowSchema>,
): Promise<Record<string, unknown>> {
  const plaintext = await decryptString(
    row.encrypted_credentials,
    row.credential_iv,
    env.CONNECTOR_CREDENTIALS_KEY,
    connectionId,
  );
  return z.record(z.string(), z.unknown()).parse(JSON.parse(plaintext));
}

async function releaseLease(
  database: D1Database,
  connection: Pick<ConnectorConnectionContext, "id" | "workspaceId">,
  leaseId: string,
): Promise<void> {
  await database.prepare(
    `UPDATE connector_connections SET
       credential_refresh_lease_id = NULL, credential_refresh_lease_expires_at = NULL
     WHERE id = ? AND workspace_id = ? AND credential_refresh_lease_id = ?`,
  ).bind(connection.id, connection.workspaceId, leaseId).run();
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
