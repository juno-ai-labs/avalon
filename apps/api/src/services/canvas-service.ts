import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../durable-objects/names";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { bootstrapWorkstreamRuntimeEnvironment, provisionWorkstreamObject } from "./workstream-runtime-database";

/** The title a Canvas has until someone names it. */
export const UNTITLED_CANVAS = "Untitled Canvas";

/**
 * Bring a Canvas into existence with its Chat open and no artifacts.
 *
 * The directory row commits first, so the conversation's parent exists before
 * the conversation does; then the Chat (substream `"0"`) is bootstrapped and
 * provisioned the way a Sidekick's conversation is, with the creator as its
 * one participant. Every other reader the Canvas admits is seated when they
 * open it. Both steps run on a replay too: the D1 anchors are insert-or-ignore
 * and the object answers `already_provisioned`. `docs/canvases.md`.
 */
export async function createCanvas(env: Env, input: {
  workspaceId: string;
  creatorUserId: string;
  title?: string;
  canvasId?: string;
  writer?: { sidekickId: string; runId: string };
}): Promise<{ canvasId: string; created: boolean }> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const canvasId = input.canvasId ?? uuidV7();
  const title = input.title?.trim() || UNTITLED_CANVAS;
  const authority = await readWorkstreamAuthorityControl(env);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const { created } = await workspace.canvasCreate({
    workspaceId, canvasId, title, createdByUserId: asUserId(input.creatorUserId),
    authorityGeneration: authority.generation,
    ...(input.writer ? { writer: input.writer } : {}),
  });
  await bootstrapWorkstreamRuntimeEnvironment(env, workspaceId, canvasId, "canvas");
  await provisionWorkstreamObject(env, {
    workspaceId,
    workstreamId: canvasId,
    title,
    objective: "",
    scope: "personal",
    createdByUserId: input.creatorUserId,
    participantUserIds: [input.creatorUserId],
    harnessStatus: "idle",
    titleStatus: "settled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    now: Date.now(),
  });
  return { canvasId, created };
}
