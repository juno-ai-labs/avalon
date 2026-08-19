import type { MiddlewareHandler } from "hono";

import type { HonoAppEnv } from "../env";
import { requestDeferral } from "../lib/defer";
import { logWarn } from "../observability/logger";
import {
  publishWorkspaceSync,
  workspaceSyncTopicsForMutation,
} from "../services/workspace-realtime-service";

/** Fan successful authenticated desktop mutations into the WorkspaceDO sync log. */
export const workspaceRealtimeInvalidation: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  await next();
  if (c.res.status >= 400) return;
  const auth = c.get("auth");
  if (!auth?.workspaceId) return;
  const topics = workspaceSyncTopicsForMutation(c.req.method, new URL(c.req.url).pathname);
  if (topics.length === 0) return;
  requestDeferral(c)(publishWorkspaceSync(c.env, auth.workspaceId, topics).catch((error) => {
    logWarn(c.env, "workspace_realtime_publish_failed", {
      workspace_id: auth.workspaceId,
      topics,
      reason: error instanceof Error ? error.message : "unknown",
    });
  }));
};
