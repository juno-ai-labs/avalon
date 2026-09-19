import { z } from "zod";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import type { ConnectorConnectionContext } from "@rally/connectors";
import { HOSTED_MCP_DEFAULT_TOOL_TIMEOUT_MS } from "@rally/connectors";
import type { Env } from "../env";
import { withDeadline } from "../lib/deadline";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { createToolReceiptObjectPort } from "../runtime/tool-receipt-port";
import { decryptVersionedConnectorCredentials } from "./connector-credential-envelope";
import { isReconnectRequiredConnectorError, withAuthorizedConnection } from "./connector-connection-access";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

const StoredConnection = z.object({
  id: z.string(), workspace_id: z.string(), owner_user_id: z.string(),
  encrypted_credentials: z.string(), credential_iv: z.string(), credential_key_version: z.number(),
  granted_scopes_json: z.string(), config_json: z.string(),
});
const Credentials = z.record(z.string(), z.unknown());

/** Runs in the existing receipted, retried post-run lane, including after restart. */
export async function cleanupCanvaTransactions(env: Env, input: WorkstreamWorkflowInput): Promise<string | null> {
  const receipts = createToolReceiptObjectPort(env, input.workspaceId, input.parentId, undefined, input.substreamId ?? "0");
  const targets = await receipts.canvaCleanupForRun({ runId: input.harnessRunId });
  let diagnostic: string | null = null;
  const scoped = withWorkspaceRuntimeDatabase(env, input.workspaceId);
  for (const target of targets) {
    if (target.state === "closed") continue;
    if (target.state === "uncertain") { diagnostic = "canva_transaction_outcome_uncertain"; continue; }
    if (input.executionPrincipal.type !== "user") { diagnostic = "canva_cleanup_authorization_unavailable"; continue; }
    const row = await scoped.DB.prepare(
      `SELECT id, workspace_id, owner_user_id, encrypted_credentials, credential_iv,
              credential_key_version, granted_scopes_json, config_json
         FROM connector_connections WHERE id = ? AND workspace_id = ?
           AND connector_type = 'canva' AND scope = 'personal' AND owner_user_id = ? AND status <> 'disabled'`,
    ).bind(target.connectionId, input.workspaceId, input.executionPrincipal.userId).first();
    const parsed = StoredConnection.safeParse(row);
    const member = await scoped.DB.prepare(
      "SELECT user_id FROM workspace_members WHERE workspace_id = ? AND user_id = ? AND status = 'active'",
    ).bind(input.workspaceId, input.executionPrincipal.userId).first();
    if (!parsed.success || !member) { diagnostic = "canva_cleanup_authorization_unavailable"; continue; }
    const stored = parsed.data;
    const adapter = connectorRegistryForEnv(scoped).get("canva");
    const connection: ConnectorConnectionContext = {
      id: stored.id, workspaceId: stored.workspace_id, ownerUserId: stored.owner_user_id, scope: "personal",
      credentials: Credentials.parse(JSON.parse(await decryptVersionedConnectorCredentials(scoped, stored))),
      grantedScopes: z.array(z.string()).parse(JSON.parse(stored.granted_scopes_json)), cursor: {},
      config: Credentials.parse(JSON.parse(stored.config_json)),
    };
    let providerCallFailed = false;
    try {
      await withDeadline(HOSTED_MCP_DEFAULT_TOOL_TIMEOUT_MS, (signal) => withAuthorizedConnection(scoped, { connection, adapter, signal }, async (authorized) => {
        const claim = await receipts.claimCanvaCleanup({ runId: input.harnessRunId, effectIntentId: target.effectIntentId });
        if (!claim) return;
        let cancelled = false;
        let providerError: unknown;
        try {
          const result = await adapter.executeTool("cancel-editing-transaction", { transaction_id: target.transactionId }, {
            connection: authorized, principal: input.executionPrincipal, signal,
          });
          const transaction = z.object({ transaction: z.object({ id: z.string(), status: z.string() }) }).parse(result.output).transaction;
          cancelled = transaction.id === target.transactionId && transaction.status === "cancelled";
        } catch (error) {
          providerError = error;
          // A lost response is not permission to replay a provider mutation.
          // The start receipt retains an explicit uncertainty checkpoint.
        }
        await receipts.settleCanvaCleanup({ runId: input.harnessRunId, effectIntentId: target.effectIntentId,
          checkpointIndex: claim.checkpointIndex, cancelled });
        if (!cancelled) diagnostic = "canva_transaction_outcome_uncertain";
        if (providerError) { providerCallFailed = true; throw providerError; }
      }));
    } catch (error) {
      if (isReconnectRequiredConnectorError(error)) diagnostic = "canva_cleanup_authorization_unavailable";
      else if (!providerCallFailed) throw error;
    }
  }
  return diagnostic;
}
