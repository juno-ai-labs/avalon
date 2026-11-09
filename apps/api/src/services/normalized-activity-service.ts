import {
  NormalizedActivitySchema,
  type NormalizedActivity,
} from "@rally/contracts";
import { newId } from "@rally/db";
import type { Env } from "../env";
import { enqueueWorkspaceConnectorEvent } from "./workspace-connector-event-ingress";
import { withWorkspaceRuntimeDatabase } from "./workspace-runtime-database";

const NormalizedActivityInputSchema = NormalizedActivitySchema.omit({ id: true });

/**
 * Persists one already-verified connector activity and schedules its canonical
 * row. Provider transports retain ownership of signature checks and routing;
 * this helper owns the shared idempotent activity-to-queue handoff.
 */
export async function persistNormalizedActivity(
  env: Env,
  input: Omit<NormalizedActivity, "id">,
  knownConnectorType?: string,
): Promise<{ activityId: string; duplicate: boolean }> {
  const activity = NormalizedActivityInputSchema.parse(input);
  const proposedId = newId();
  let connectorType = knownConnectorType;
  if (!connectorType) {
    const workspaceEnv = withWorkspaceRuntimeDatabase(env, activity.workspaceId);
    const connection = await workspaceEnv.DB.prepare(
      `SELECT connector_type FROM connector_connections
        WHERE id = ? AND workspace_id = ? AND status <> 'disabled'`,
    ).bind(activity.connectionId, activity.workspaceId).first<{ connector_type: string }>();
    if (!connection) throw new Error("Connector connection is unavailable");
    connectorType = connection.connector_type;
  }
  await enqueueWorkspaceConnectorEvent(env, {
    connectorType,
    activity: { id: proposedId, ...activity },
  });
  // WorkspaceDO resolves provider/dedupe uniqueness when the Queue delivers.
  // The HTTP/Slack/Workflow caller needs the handoff identity, not a second
  // synchronous cross-object round trip to predict the canonical event ID.
  return { activityId: proposedId, duplicate: false };
}

