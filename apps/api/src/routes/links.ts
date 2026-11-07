import { parseLinkPathTarget } from "@rally/contracts/links";
import { asWorkspaceId } from "@rally/contracts";
import { Hono } from "hono";
import { z } from "zod";

import { workspaceDOName } from "../durable-objects/names";
import type { WorkspaceLinkTitleRequest } from "../durable-objects/workspace-directory-protocol";
import type { HonoAppEnv } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { ApiError } from "../lib/api-error";

/**
 * Public, signed-out reads behind a shared link. Holding a Canvas or Sidekick
 * link is the permission to see its name; nothing here reaches what is inside
 * it. See docs/links.md#the-handoff-page.
 */
export const linkRoutes = new Hono<HonoAppEnv>();

const LinkTitleQuerySchema = z.strictObject({ path: z.string().min(1) });
/** This route owns its answer's shape; the site reads only `title`. */
const LinkTitleResponseSchema = z.strictObject({ title: z.string().min(1) });

/** The workspace and resource a canonical link path names, or null for any other path. */
export function linkTitleTarget(pathname: string): { region: string; request: WorkspaceLinkTitleRequest } | null {
  const target = parseLinkPathTarget(pathname);
  if (!target) return null;
  // A Canvas link that opens onto one artifact still names the Canvas.
  return { region: target.region, request: { workspaceId: target.workspaceId, target: target.kind === "canvas"
    ? { kind: "canvas", canvasId: target.canvasId }
    : { kind: "sidekick", sidekickId: target.sidekickId } } };
}

linkRoutes.get("/title", async (c) => {
  const query = LinkTitleQuerySchema.safeParse(c.req.query());
  const target = query.success ? linkTitleTarget(query.data.path) : null;
  if (!target) throw new ApiError(400, "link_path_invalid", "The path is not a Rally link");
  // A link minted in another region is that region's API to answer.
  if (target.region !== c.env.AVALON_REGION) throw new ApiError(404, "link_not_found", "Nothing at this link");
  const workspaceId = asWorkspaceId(target.request.workspaceId);
  let stub;
  try {
    stub = await durableObjectStubForWorkspace(c.env, c.env.WORKSPACE_DOS, workspaceId, workspaceDOName(c.env.AVALON_REGION, workspaceId));
  } catch (error) {
    // No Organization by this id here, refused before any object is opened.
    if (error instanceof Error && error.message === "workspace_placement_affinity_unavailable") {
      throw new ApiError(404, "link_not_found", "Nothing at this link");
    }
    throw error;
  }
  const { title } = await stub.linkTitle(target.request);
  if (title === null) throw new ApiError(404, "link_not_found", "Nothing at this link");
  c.header("Cache-Control", "no-store");
  return c.json(LinkTitleResponseSchema.parse({ title }));
});
