import { ConnectionSchema, type Connection } from "@rally/contracts";
import { z } from "zod";

const ConnectionRowSchema = z.object({
  id: z.string(),
  model_plugin_id: z.string(),
  workspace_id: z.string(),
  connector_type: z.string(),
  scope: z.string(),
  owner_user_id: z.string().nullable(),
  owner_name: z.string().nullable(),
  display_name: z.string(),
  granted_scopes_json: z.string(),
  status: z.string(),
  last_sync_at: z.string().nullable(),
  created_at: z.string(),
});

export function connectionFromRow(
  input: unknown,
  userDelivery: Connection["userDelivery"] = null,
): Connection {
  const row = ConnectionRowSchema.parse(input);
  const grantedCapabilities: unknown = JSON.parse(row.granted_scopes_json);
  const candidate = {
    id: row.id,
    modelPluginId: row.model_plugin_id,
    workspaceId: row.workspace_id,
    connectorType: row.connector_type,
    scope: row.scope,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    displayName: row.display_name,
    grantedCapabilities,
    status: row.status,
    settingsKind: row.connector_type === "github" ? "github_repository_access" : null,
    userDelivery,
    lastSyncAt: row.last_sync_at,
    createdAt: row.created_at,
  } satisfies Record<keyof Connection, unknown>;

  return ConnectionSchema.parse(candidate);
}
