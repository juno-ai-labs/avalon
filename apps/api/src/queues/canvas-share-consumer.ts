import { CanvasShareStateSchema, type CanvasShareChangedMessage } from "@rally/contracts/canvas-share-federation";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { applyCanvasShare, publishSharedCanvasesToOrganizations } from "../services/canvas-share-inbox";

/**
 * One `canvas_share_changed` delivery (`docs/canvas-share-federation.md`): read
 * the person's current state of the Canvas from its Organization, apply it to
 * their inbox, and, when that changed it, have their other Organizations push
 * it to the sockets they have open. Throws to be retried; the inbox write is
 * idempotent by revision, so a retry after a partial pass repeats nothing.
 */
export async function consumeCanvasShareChanged(env: Env, message: CanvasShareChangedMessage): Promise<void> {
  const origin = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, message.workspaceId,
    workspaceDOName(message.region, message.workspaceId));
  const state = CanvasShareStateSchema.parse(await origin.canvasShareState({
    workspaceId: message.workspaceId, canvasId: message.canvasId, userId: message.userId,
  }));
  const changed = await applyCanvasShare(env, message, state);
  if (changed) await publishSharedCanvasesToOrganizations(env, message.userId, message.workspaceId);
}
