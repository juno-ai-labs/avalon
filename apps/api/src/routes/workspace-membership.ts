import { IdSchema, WorkspaceDepartureSchema } from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { getAuth } from "../middleware/auth";
import { zValidator } from "../middleware/validation";
import { WorkspaceService } from "../services/workspace-service";

const memberParam = z.object({ workspaceId: IdSchema, userId: IdSchema });

/**
 * Membership of one workspace, addressed by its own id.
 *
 * Every other protected route takes the workspace from the session; this one
 * names it in the path, so the first thing it does is refuse a path that names
 * a different workspace than the caller is authenticated for. Without that the
 * path parameter would be an invitation to act on somebody else's workspace.
 */
export const workspaceMembershipRoutes = new Hono<HonoAppEnv>();

workspaceMembershipRoutes.delete(
  "/:workspaceId/membership",
  zValidator("param", z.object({ workspaceId: IdSchema })),
  async (c) => {
    const auth = getAuth(c);
    const { workspaceId } = c.req.valid("param");
    if (workspaceId !== auth.workspaceId) {
      throw new ApiError(403, "forbidden", "That workspace is not the one you are signed in to");
    }
    return c.json(WorkspaceDepartureSchema.parse(
      await new WorkspaceService(c.env, auth).leaveWorkspace(),
    ));
  },
);

workspaceMembershipRoutes.delete(
  "/:workspaceId/membership/member/:userId",
  zValidator("param", memberParam),
  async (c) => {
    const auth = getAuth(c);
    const { workspaceId, userId } = c.req.valid("param");
    if (workspaceId !== auth.workspaceId) {
      throw new ApiError(403, "forbidden", "That workspace is not the one you are signed in to");
    }
    await new WorkspaceService(c.env, auth).removeMember(userId);
    return c.body(null, 204);
  },
);
