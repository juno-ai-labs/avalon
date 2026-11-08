import { asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { CanvasAccess, CanvasAccessDecision, CanvasAccessDecisionRequest, CanvasAccessRequest, CanvasAccessRequestResult, CanvasAudienceUpdate, CanvasDetail, CanvasSidebarRow, CanvasUpdateRequest, CreateCanvasRequest, CreatedCanvas } from "@rally/contracts/canvases";

import { workspaceDOName } from "../durable-objects/names";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { ConversationService } from "./conversation-service";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { bootstrapWorkstreamRuntimeEnvironment, provisionWorkstreamObject } from "./workstream-runtime-database";
import { UNTITLED_CANVAS } from "../durable-objects/canvas-schema";

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
  /** The caller's id has a D1 anchor; see `CanvasCreateRequestSchema.anchored`. */
  anchored?: boolean;
}): Promise<{ canvasId: string; created: boolean }> {
  const workspaceId = asWorkspaceId(input.workspaceId);
  const requestedId = input.canvasId ?? uuidV7();
  const title = input.title?.trim() || UNTITLED_CANVAS;
  const authority = await readWorkstreamAuthorityControl(env);
  const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId));
  const made = await workspace.canvasCreate({
    workspaceId, canvasId: requestedId, title, createdByUserId: asUserId(input.creatorUserId),
    authorityGeneration: authority.generation,
    ...(input.writer ? { writer: input.writer } : {}),
    ...(input.anchored ? { anchored: true } : {}),
    // Made with no title, it is "Untitled Canvas", settled, until its first
    // message starts naming it (`HostedCanvas.onChildProjection`).
  });
  // A run's second create answers with the Canvas its first made.
  const canvasId = made.canvasId;
  const created = made.created;
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

/** A Canvas on behalf of an authenticated member or guest. */
export class CanvasService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  private workspace() {
    return durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)));
  }

  private actor() {
    return { userId: asUserId(this.auth.userId), actorRole: this.auth.role };
  }

  /**
   * A new Canvas, and for the "Start from a prompt" card its first message,
   * sent to the Chat as the creator's through the ordinary message admission.
   * A guest makes none: a Canvas is the Organization's.
   *
   * A caller-minted `canvasId` makes a retry answer the first create's Canvas,
   * and the prompt's `clientMessageId` makes it send once there. An id some
   * conversation already anchors is a replay only when it is this creator's
   * Canvas; the Organization object decides that inside its transaction.
   */
  async create(request: CreateCanvasRequest): Promise<CreatedCanvas> {
    if (this.auth.role === null) throw new ApiError(403, "canvas_create_member_required", "Only a member of the Organization can make a Canvas");
    const anchored = request.canvasId !== undefined && await this.env.DB.prepare(
      `SELECT 1 AS anchored FROM workstreams WHERE id = ? LIMIT 1`,
    ).bind(request.canvasId).first() !== null;
    const { canvasId } = await createCanvas(this.env, {
      workspaceId: this.auth.workspaceId, creatorUserId: this.auth.userId,
      ...(request.canvasId ? { canvasId: request.canvasId, anchored } : {}),
      ...(request.title ? { title: request.title } : {}),
    });
    if (!request.prompt) return { canvasId: asWorkstreamId(canvasId), turnId: null };
    const client = await new ConversationService(this.env, this.auth).writableClient(canvasId, "0");
    const receipt = await client.createMessage({
      text: request.prompt.text, clientMessageId: request.prompt.clientMessageId,
      mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
    });
    return { canvasId: asWorkstreamId(canvasId), turnId: receipt.turn.turnId };
  }

  async detail(canvasId: string): Promise<CanvasDetail> {
    return (await this.workspace()).canvasDetail({ workspaceId: asWorkspaceId(this.auth.workspaceId), canvasId, actor: this.actor() });
  }

  async setAudience(canvasId: string, update: CanvasAudienceUpdate): Promise<CanvasDetail> {
    return (await this.workspace()).canvasSetAudience({ workspaceId: asWorkspaceId(this.auth.workspaceId), canvasId, actor: this.actor(), update });
  }

  /** Whether this member may ask to open a Canvas they cannot; see `HostedCanvas.access`. */
  async access(canvasId: string): Promise<CanvasAccess> {
    return (await this.workspace()).canvasAccess({ workspaceId: asWorkspaceId(this.auth.workspaceId), canvasId, actor: this.actor() });
  }

  /** Ask to open a Canvas; see `HostedCanvas.requestAccess`. */
  async requestAccess(canvasId: string, request: CanvasAccessRequest): Promise<CanvasAccessRequestResult> {
    return (await this.workspace()).canvasRequestAccess({ workspaceId: asWorkspaceId(this.auth.workspaceId), canvasId, actor: this.actor(), request });
  }

  /** Approve or deny a request to open a Canvas; see `HostedCanvas.decideAccess`. */
  async decideAccess(canvasId: string, requesterUserId: string, decision: CanvasAccessDecisionRequest["decision"]): Promise<CanvasAccessDecision> {
    return (await this.workspace()).canvasDecideAccess({ workspaceId: asWorkspaceId(this.auth.workspaceId), canvasId, actor: this.actor(),
      requesterUserId: asUserId(requesterUserId), decision });
  }

  /** Order this viewer's Pinned group of Canvases or Sidekicks; see `WorkspacePinStorage.reorder`. */
  async reorderPins(kind: "canvas" | "sidekick", itemIds: string[]): Promise<void> {
    await (await this.workspace()).reorderSidebarPins({ workspaceId: this.auth.workspaceId, userId: this.auth.userId, kind, itemIds });
  }

  /** Retitle a Canvas, choose its icon and colour, or both; see `HostedCanvas.update`. */
  async update(canvasId: string, update: CanvasUpdateRequest): Promise<CanvasDetail> {
    return (await this.workspace()).canvasUpdate({ workspaceId: asWorkspaceId(this.auth.workspaceId), canvasId, actor: this.actor(), ...update });
  }

  /** Pin a Canvas or a Sidekick in, or out of, its list's Pinned group; refused for one the viewer may not open. */
  async pin(kind: "canvas" | "sidekick", itemId: string, pinned: boolean): Promise<void> {
    const result = await (await this.workspace()).setSidebarPin({
      workspaceId: this.auth.workspaceId, userId: this.auth.userId, accessClass: this.auth.role === null ? "guest" : "member",
      kind, itemId, pinned,
    });
    if (!result.ok) throw new ApiError(404, kind === "canvas" ? "canvas_not_found" : "sidekick_not_found", "That cannot be pinned here");
  }
}
