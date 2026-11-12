import { ConnectorError, type ConnectorConnectionContext } from "@rally/connectors";

import type { SidekickRunProvisioning } from "../durable-objects/hosted-sidekick";
import type { Env } from "../env";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { diagnosticErrorCode } from "../observability/logger";
import { withAuthorizedConnection } from "./connector-connection-access";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";
export { openingWithEventContent } from "@rally/prompts/api/sidekick-event-content";

/**
 * What an admitted event is about, read by the host for the run it started.
 *
 * A connector event carries a title, a summary and a snippet. New mail's
 * snippet is a line or two, and a run that has to say what a message said
 * would otherwise read it with the mailbox's own tools, which only a person
 * who lets the Sidekick act as them lends. So the host reads that one message
 * with the connection the event came from, after the Organization has checked
 * that the connection's owner still lets the event in, and hands it to the
 * run in its opening. The run holds no tool on that account.
 *
 * Never throws: content that cannot be read leaves the run its event and a
 * line saying why. `docs/sidekick-sources.md` owns the rule.
 */
import type { SidekickEventContent } from "@rally/prompts/api/sidekick-event-content";
export type { SidekickEventContent };

export async function readSidekickEventContent(
  env: Env,
  input: { workspaceId: string; request: NonNullable<SidekickRunProvisioning["eventContent"]> },
  signal: AbortSignal,
): Promise<SidekickEventContent> {
  const registry = connectorRegistryForEnv(env);
  if (!registry.list().some((manifest) => manifest.type === input.request.connectorType)) return { outcome: "none" };
  const adapter = registry.get(input.request.connectorType);
  if (!adapter.readActivityContent) return { outcome: "none" };
  try {
    const row = await withWorkspaceRuntimeDatabase(env, input.workspaceId).DB.prepare(
      `SELECT id, connector_type, scope, owner_user_id, granted_scopes_json, encrypted_credentials, credential_iv,
              credential_key_version, cursor_json, config_json, status
         FROM connector_connections WHERE id = ? AND workspace_id = ?`,
    ).bind(input.request.connectionId, input.workspaceId).first<Record<string, unknown>>();
    if (!row || row.status === "disabled" || row.connector_type !== input.request.connectorType) {
      return { outcome: "unavailable", code: "connection_unavailable" };
    }
    const credentials = typeof row.encrypted_credentials === "string" && typeof row.credential_iv === "string"
      ? JSON.parse(await decryptVersionedConnectorCredentials(env, {
        id: input.request.connectionId,
        encrypted_credentials: row.encrypted_credentials,
        credential_iv: row.credential_iv,
        credential_key_version: Number(row.credential_key_version || 1),
      })) as Record<string, unknown>
      : {};
    const connection: ConnectorConnectionContext = {
      id: input.request.connectionId,
      workspaceId: input.workspaceId,
      scope: row.scope === "workspace" ? "workspace" : "personal",
      ownerUserId: row.owner_user_id == null ? null : String(row.owner_user_id),
      grantedScopes: JSON.parse(String(row.granted_scopes_json ?? "[]")) as string[],
      credentials,
      cursor: JSON.parse(String(row.cursor_json ?? "{}")) as Record<string, unknown>,
      config: JSON.parse(String(row.config_json ?? "{}")) as Record<string, unknown>,
    };
    const content = await withAuthorizedConnection(env, { connection, adapter, signal }, (authorized) =>
      adapter.readActivityContent!(authorized, { eventType: input.request.eventType, subject: input.request.subject }, signal));
    return content ? { outcome: "read", ...content } : { outcome: "none" };
  } catch (error) {
    if (signal.aborted) throw error;
    // A connector's own refusal already names its reason (`provider_error`, `unauthorized`); only its code crosses, never its message.
    return { outcome: "unavailable", code: error instanceof ConnectorError ? error.code : diagnosticErrorCode(error, "event_content_unreadable") };
  }
}

