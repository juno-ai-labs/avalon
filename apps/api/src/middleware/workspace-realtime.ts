import type { Context, MiddlewareHandler } from "hono";

import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import {
  publishWorkspaceSync,
  workspaceSyncPublicationsForMutation,
  type WorkspaceSyncDetail,
} from "../services/workspace-realtime-service";

/**
 * Name the connection a `/connections` write created, so its invalidation
 * reaches that connection's audience rather than the whole Organization. A
 * route whose path already carries the id does not need to.
 */
export function noteChangedConnection(c: Context<HonoAppEnv>, connectionId: string): void {
  c.set("workspaceSyncConnectionId", connectionId);
}

/**
 * Fan successful authenticated desktop mutations into the WorkspaceDO sync
 * log, each to the people it is news to. After the response, never before it:
 * an invalidation is not something the person who made the write waits on.
 */
export const workspaceRealtimeInvalidation: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  await next();
  if (c.res.status >= 400) return;
  const auth = c.get("auth");
  if (!auth?.workspaceId) return;
  const publications = workspaceSyncPublicationsForMutation(c.req.method, new URL(c.req.url).pathname);
  for (const { topics, audience } of publications) {
    let detail: WorkspaceSyncDetail | undefined;
    if (audience.kind === "actor") {
      detail = { audienceUserIds: [auth.userId] };
    } else if (audience.kind === "connection") {
      const connectionId = c.get("workspaceSyncConnectionId") ?? audience.connectionId;
      detail = connectionId === null ? undefined : { connectionId };
    }
    requestDeferral(c)(publishWorkspaceSync(c.env, auth.workspaceId, topics, detail).catch((error) => {
      logWarn(c.env, "workspace_realtime_publish_failed", {
        workspace_id: auth.workspaceId,
        topics,
        code: diagnosticErrorCode(error, "workspace_realtime_publish_failed"),
      });
    }));
  }
};
