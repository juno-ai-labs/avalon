import {
  asAutomationId,
  asSpaceId,
  asUserId,
  asWorkspaceId,
  type ContainerOrder,
  ContainerOrderSchema,
  type CreateSpaceRequest,
  MoveChannelBetweenSpacesResultSchema,
  type SpaceChannelPage,
  SpaceChannelPageSchema,
  type SpaceDefaultKind,
  type SpaceErrorCode,
  type SpaceId,
  SpaceRefusalDetailsSchema,
  type SpaceScope,
  type SpaceSummary,
  SpaceSummarySchema,
  type UpdateSpaceAudienceRequest,
  type UpdateSpacePresentationRequest,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";

import { automationDOName, conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceSpaceChannelPageResultSchema,
  WorkspaceSpaceDefaultResultSchema,
  WorkspaceContainerOrderResultSchema,
  WorkspaceSpaceGeneralOpenResultSchema,
  WorkspaceSpaceMembersResultSchema,
  WorkspaceSpaceMembershipMoveOutcomeSchema,
  WorkspaceSpaceMutationResultSchema,
  WorkspaceSpaceReserveResultSchema,
  WorkspaceSpaceChannelChangeResultSchema,
  WorkspaceSpaceIntentResumeResultSchema,
  WorkspaceSpaceMemberWalkResultSchema,
  type SpaceActorAuth,
  type ParsedSpaceChannelRefusal,
  type SpaceMemberWalkKind,
  type WorkspaceSpaceChannelChangeResult,
  type SpaceMember,
  type MemberWalkReach,
  type WorkspaceSpaceMutationResult,
} from "../durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { spaceAccessError } from "./channel-access-service";
import { ResourceService } from "./resource-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "./workstream-runtime-database";
import { WorkstreamObjectClient } from "./workstream-object-client";

/**
 * One refusal per closed code, each naming the Space it is about.
 *
 * Separate from `spaceAccessError` in `channel-access-service.ts`, which writes
 * the same codes about a *Channel*. The code is the contract; the sentence is
 * about whichever object the caller was acting on, and telling somebody their
 * Channel cannot be archived when they asked to archive a Space is worse than
 * having two tables.
 */
export function spaceRefusal(
  code: SpaceErrorCode,
  spaceName: string,
  unreachable: readonly UserId[] = [],
  blockedChannelIds: readonly WorkstreamId[] = [],
): ApiError {
  // Named when the caller has the name in hand and "this Space" when it does
  // not, rather than rendering an empty pair of quotation marks: a refusal that
  // says “” about a Space is worse than one that does not name it.
  const subject = spaceName.trim().length > 0 ? `“${spaceName.trim()}”` : "this Space";
  // Carried on refusals that are about a Channel, so a confirmation can
  // name what has to move first instead of asking the person to find it.
  const details = blockedChannelIds.length > 0
    ? SpaceRefusalDetailsSchema.parse({ channelIds: [...blockedChannelIds] })
    : undefined;
  switch (code) {
    // True of a read as well as a write. This one code answers a guest and a
    // removed member asking to *see* a Space — `spaceRefusalCode` refuses both
    // at the same gate for every RPC, read or write — as well as somebody who
    // reaches a Space through a Channel in it asking to change it. "You cannot
    // change this Space" was written when only the second existed, and told
    // the first the wrong thing about the wrong verb.
    case "space_access_denied":
      return new ApiError(403, code, `Your access to ${subject} does not allow this`);
    case "space_not_found":
      return new ApiError(404, code, "Space not found");
    case "space_protected":
      return new ApiError(409, code, "General cannot be archived or made private");
    case "space_membership_final":
      return new ApiError(409, code,
        `A Channel in ${subject} belongs to no other Space, so it would have no home`, details);
    case "space_audience_incompatible":
      return new ApiError(409, code,
        `Leaving ${subject} would leave ${unreachable.length || "some"} of its readers unable to find the Channel in any Space they can see`,
        details);
    case "space_membership_content_fence":
      return new ApiError(409, code,
        "A Channel holds retained content this audience cannot view");
    case "space_default_audience_mismatch":
      return new ApiError(409, code,
        `Everyone who can read a Channel in ${subject} must be able to use this`);
    case "space_revision_conflict":
      return new ApiError(409, code, "The Space changed while this was being applied; try again");
    case "space_bootstrap_pending":
      return new ApiError(409, code, "This Organization is still being prepared");
    case "channel_scope_locked_by_space":
      return new ApiError(409, code,
        `A Channel in ${subject} is public through an Organization-wide Space, so its own audience cannot narrow`);
    case "space_conversation_unreachable":
      return new ApiError(409, code,
        `A Channel in ${subject} could not be asked whether this audience may read it`);
    case "space_authority_unreachable":
      // 503 rather than 500: nothing about the request is wrong, the Space's
      // own authority did not answer, and retrying is the whole of what the
      // caller can do about it.
      return new ApiError(503, code, `${subject} could not be reached; try again`);
    case "space_audience_self_excluded":
      return new ApiError(409, code,
        `Making ${subject} private without you in it would leave you unable to change it back`);
    case "space_cursor_invalid":
      return new ApiError(400, code, "That page cursor is not one this Space issued");
  }
}

/**
 * The refusal a WorkspaceDO-driven Space operation answered, as the error the
 * route renders: a Space refusal names the Space, a Channel refusal names the
 * Channel, and the Channel conversation's own refusal keeps its code and
 * sentence.
 */
function channelChangeRefusal(refusal: ParsedSpaceChannelRefusal): ApiError {
  switch (refusal.about) {
    case "space":
      return spaceRefusal(refusal.code, refusal.subject, refusal.unreachableUserIds, refusal.blockedWorkstreamIds);
    case "channel":
      return spaceAccessError(refusal.code, refusal.subject);
    case "conversation":
      return new ApiError(apiErrorStatus(refusal.status), refusal.code, refusal.message, refusal.details);
  }
}

function apiErrorStatus(status: number): ApiError["status"] {
  switch (status) {
    case 400: case 401: case 403: case 404: case 409: case 413:
    case 422: case 426: case 429: case 502: case 503: return status;
    default: return 500;
  }
}

/**
 * How a resumed Space intent ended.
 *
 * `abandoned` carries the receipt the intent was settled with, because the
 * consumer is what writes the log line and an operation that settled without
 * doing its work is otherwise a row nobody looks at. A resume that throws is
 * neither of these: it stays unsettled and is retried.
 */
export type SpaceIntentResumeOutcome =
  | { readonly outcome: "settled" }
  | { readonly outcome: "abandoned"; readonly reason: string };

/**
 * The regional facade over the Organization's Space authority.
 *
 * Three objects have to agree for a Space to mean anything, and this is where
 * they are ordered: WorkspaceDO owns the relationship and stages every
 * operation behind a fence, the Space's own `SpaceDO` and hidden main
 * conversation own what the Space *is* — its name, appearance, scope,
 * participants and attachments — and each member Channel owns its own audience.
 *
 * Nothing here writes a Channel's audience itself. A membership, an audience
 * change, an archive, a restore and every resume are driven by WorkspaceDO
 * (`SpaceChannelAccess`), which applies the delta through the Channel's
 * canonical scope and participant operations so the retained-content
 * containment preflight and its SQL triggers stay the only fence.
 */
export class SpaceService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  /**
   * One container's order for the person asking: the Organization's Spaces, a
   * Space's Channels, or a Channel's Breakouts.
   *
   * It lives on this service rather than beside the workspace's own settings
   * because everything it touches is the Space authority's — the rows, the
   * refusal vocabulary, the snapshot the answer is republished on — even though
   * only one of the three containers is a Space. The route is at the workspace
   * level for the mirror-image reason: a Breakout's order is not a `/spaces`
   * fact.
   *
   * The answer is what was *stored*, not an acknowledgement, so a client can
   * see what its request lost to this container's rule.
   */
  async reorderContainer(input: ContainerOrder): Promise<ContainerOrder> {
    const result = WorkspaceContainerOrderResultSchema.parse(await (await this.workspace()).reorderContainer({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      order: input,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return ContainerOrderSchema.parse(result.order);
  }

  async summary(spaceId: SpaceId): Promise<SpaceSummary> {
    return this.settled(await (await this.workspace()).spaceSummary({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
    }), "");
  }

  /**
   * The Space an operation is about, refused when it is not this person's to
   * change.
   *
   * Four operations write on the Space's *own* object before WorkspaceDO's
   * gate ever sees them — a rename, an appearance, an audience and a default —
   * and that object answers a non-participant of a personal conversation
   * `workstream_not_found`. It is the wrong authority saying the wrong word:
   * the caller is looking at the Space, they were refused because they may not
   * change it, and `docs/naming-a-schema-failure.md` is about exactly this.
   * Everything else (an add, a removal, an archive, a restore) addresses
   * WorkspaceDO first and is named there.
   *
   * The reach is on the summary this already reads, so this costs nothing over
   * the read each of those four was making anyway.
   */
  private async editable(spaceId: SpaceId): Promise<SpaceSummary> {
    const space = await this.summary(spaceId);
    if (space.reach === "through_channel") throw spaceRefusal("space_access_denied", space.name);
    return space;
  }

  async listChannels(spaceId: SpaceId, cursor: string | null): Promise<SpaceChannelPage> {
    const result = WorkspaceSpaceChannelPageResultSchema.parse(
      await (await this.workspace()).listSpaceChannels({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId,
        cursor,
      }),
    );
    if (!result.ok) throw spaceRefusal(result.code, "");
    return SpaceChannelPageSchema.parse(result.page);
  }

  /**
   * Create a Space: ask whether this person may, anchor it, reserve it with
   * its parent, then open its hidden conversation.
   *
   * The permission is asked first, because the two steps before the
   * reservation write outside WorkspaceDO: the id is minted here (or is the
   * caller's stable creation id) so the D1 anchor and authority route a
   * Channel's creation writes, under `parentKind: "space"`, can be written
   * before the Space is listed. WorkspaceDO then writes the Space and its
   * hosted parent in one transaction. Last, the hidden main conversation is
   * provisioned with no opening message and admitting no run, because nothing
   * in the product opens a Space's feed and a Space that started an agent loop
   * would be a conversation the product cannot show. A provisioning that fails
   * takes the Space back (`cancelSpaceReservation`) when this call created
   * it, so no retry is left facing a listed Space whose conversation never
   * opened.
   */
  async create(input: CreateSpaceRequest, spaceId?: SpaceId): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    const actor = { workspaceId: asWorkspaceId(this.auth.workspaceId), userId: asUserId(this.auth.userId) };
    const admitted = await workspace.admitSpaceCreation(actor);
    if (!admitted.ok) throw spaceRefusal(admitted.code, input.name);
    const id = spaceId ?? asSpaceId(uuidV7());
    await this.throughSpaceAuthority(id, input.name, "provision", () =>
      bootstrapWorkstreamRuntimeEnvironment(this.env, this.auth.workspaceId, id, "space"));
    const reservation = WorkspaceSpaceReserveResultSchema.parse(await workspace.reserveSpace({
      ...actor,
      space: input,
      spaceId: id,
    }));
    if (!reservation.ok) throw spaceRefusal(reservation.code, input.name, reservation.unreachableUserIds, reservation.blockedWorkstreamIds);
    const reserved = reservation.space;
    if (spaceId && (reserved.name !== input.name.trim() || reserved.scope !== input.scope
      || reserved.iconKey !== input.iconKey || reserved.colorKey !== input.colorKey || reserved.reach === "through_channel")) {
      throw new ApiError(409, "space_revision_conflict", "The creation identity already names a different Space");
    }
    // A replay under a stable id resumes here: provisioning keeps initialized
    // state and the appearance writer is idempotent.
    await this.provisionOrTakeBack(reserved.id, input, reservation.created);
    return this.summary(reserved.id);
  }

  /**
   * The Organization's General Space, opened if this caller is the first.
   *
   * `create`'s steps under one idempotent front door. The first call only asks
   * whether General exists, which is the whole cost for every caller after the
   * Organization's first. When it does not, the D1 anchor is written under a
   * fresh id and General is created with its parent in one WorkspaceDO
   * transaction; the unique partial index still decides a race, the loser is
   * answered with the Space the winner made, and only the caller that *made*
   * it provisions the conversation, taking General back if that fails so the
   * next caller makes it again. The loser's anchor names an id nothing else
   * ever will.
   *
   * Reached by the cutover and by a Channel creation that names no Space in
   * an Organization without General, which is why it is here rather than
   * inside either.
   */
  async ensureGeneral(): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    const actor = {
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    };
    const existing = WorkspaceSpaceGeneralOpenResultSchema.parse(await workspace.openGeneralSpace(actor));
    if (!existing.ok) throw spaceRefusal(existing.code, "General");
    if (!("absent" in existing)) return existing.space;
    const id = asSpaceId(uuidV7());
    await this.throughSpaceAuthority(id, "General", "provision", () =>
      bootstrapWorkstreamRuntimeEnvironment(this.env, this.auth.workspaceId, id, "space"));
    const result = WorkspaceSpaceGeneralOpenResultSchema.parse(await workspace.openGeneralSpace({ ...actor, spaceId: id }));
    if (!result.ok) throw spaceRefusal(result.code, "General");
    if ("absent" in result) throw new Error("space_general_open_absent");
    if (!result.created) return result.space;
    await this.provisionOrTakeBack(result.space.id, {
      name: result.space.name,
      iconKey: result.space.iconKey,
      colorKey: result.space.colorKey,
      scope: result.space.scope,
    }, true);
    return this.summary(result.space.id);
  }

  /**
   * Provision a Space's hidden conversation, and when this caller created the
   * Space and provisioning fails, take the Space back before the failure is
   * answered. A take-back WorkspaceDO refuses (a Channel or the conversation
   * got there first) or cannot reach is logged; the refusal the caller sees
   * is the provisioning one either way.
   */
  private async provisionOrTakeBack(spaceId: SpaceId, input: CreateSpaceRequest, created: boolean): Promise<void> {
    try {
      await this.provisionSpaceConversation(spaceId, input);
    } catch (error) {
      if (!created) throw error;
      try {
        const taken = await (await this.workspace()).cancelSpaceReservation({
          workspaceId: asWorkspaceId(this.auth.workspaceId),
          userId: asUserId(this.auth.userId),
          spaceId,
        });
        if (!taken.cancelled) {
          logWarn(this.env, "space_creation_take_back_refused", {
            workspace_id: this.auth.workspaceId, space_id: spaceId, reason: "space_creation_in_use",
          });
        }
      } catch (takeBackError) {
        logWarn(this.env, "space_creation_take_back_failed", {
          workspace_id: this.auth.workspaceId,
          space_id: spaceId,
          reason: diagnosticErrorCode(takeBackError, "space_creation_take_back_failed"),
        });
      }
      throw error;
    }
  }

  /** Presentation belongs to the Space's own authority; this is its door. */
  async updatePresentation(spaceId: SpaceId, input: UpdateSpacePresentationRequest): Promise<SpaceSummary> {
    const current = await this.editable(spaceId);
    const client = this.spaceConversation(spaceId);
    await this.throughSpaceAuthority(spaceId, current.name, "presentation", async () => {
      await client.update({ title: input.name });
      await client.setAppearance({ icon: input.iconKey, color: input.colorKey });
    });
    return this.settled(await (await this.workspace()).noteSpacePresentation({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      presentation: input,
    }), current.name);
  }

  /**
   * Change who a Space is for, and carry that to every Channel it reaches.
   *
   * Three things in order, and the order is the whole design. Every member
   * Channel is asked first whether it *could* take the wider audience, because
   * widening cannot be undone — somebody may have read — and discovering a
   * retained-content fence on the fourth Channel after three are already wider
   * is not a failure anybody can recover from. Then the Space's own authority
   * accepts the change, which advances the revision every staged membership is
   * fenced on. Only then does each member Channel converge.
   *
   * Convergence is retract-then-apply rather than a second application.
   * `audienceSourceApplicationPlan` only ever widens and seats — by
   * construction, because a source that could narrow would be able to revoke
   * access another source still supplies — so re-applying a shrunken roster
   * would leave the readers it no longer names seated, with nothing accounting
   * for them. Withdrawing the source first is what takes them out, and the
   * retraction plan seats every surviving reader before it narrows anything.
   */
  async updateAudience(spaceId: SpaceId, input: UpdateSpaceAudienceRequest): Promise<SpaceSummary> {
    const current = await this.editable(spaceId);
    const currentParticipants = new Set<string>(current.participants.map((participant) => participant.userId));
    const requested = new Set<string>(input.participantUserIds);
    const removed = [...currentParticipants].filter((userId) => !requested.has(userId));
    if (removed.some((userId) => userId !== this.auth.userId)
      && this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "participant_removal_denied",
        "Only an Organization owner or admin can remove another Space participant");
    }
    // A person cannot narrow themselves out of a Space. `personal` admits its
    // participants and nobody else, so this request would leave its own caller
    // holding a Space they can no longer edit, and — unless a Channel in it is
    // one they can read — no longer see. There is no undo: the Space's own
    // authority accepts, the walk carries it to every member Channel, and the
    // one person who would ask for it back is the one who cannot. Removing
    // somebody else is the rule above, and stays theirs to make.
    if (input.scope === "personal" && !requested.has(this.auth.userId)) {
      throw spaceRefusal("space_audience_self_excluded", current.name);
    }
    if (current.systemRole === "general" && input.scope === "personal") {
      throw spaceRefusal("space_protected", current.name);
    }
    await this.preflightContainment(spaceId, input);

    const operationId = uuidV7();
    const spaceClient = this.spaceConversation(spaceId);
    const applyAudience = async (
      scope: SpaceScope,
      participants: ReadonlySet<string>,
      previousScope: SpaceScope,
      previousParticipants: ReadonlySet<string>,
    ) => this.throughSpaceAuthority(spaceId, current.name, "audience", async () => {
      if (scope !== previousScope) await spaceClient.update({ scope });
      for (const userId of participants) {
        if (!previousParticipants.has(userId)) await spaceClient.addParticipant(userId);
      }
      for (const userId of previousParticipants) {
        if (!participants.has(userId)) await spaceClient.removeParticipant(userId);
      }
    });
    try {
      // The Space is the audience authority. Commit it before WorkspaceDO
      // publishes the projection or stages the fan-out intent; otherwise a
      // refused Space mutation leaves every sidebar and socket claiming an
      // audience the authority never accepted.
      await applyAudience(input.scope, requested, current.scope, currentParticipants);
    } catch (error) {
      await applyAudience(current.scope, currentParticipants, input.scope, requested).catch((rollbackError) => {
        logWarn(this.env, "space_audience_authority_rollback_failed", {
          workspace_id: this.auth.workspaceId,
          space_id: spaceId,
          reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      });
      throw error;
    }

    let updated: SpaceSummary;
    try {
      updated = this.settled(await (await this.workspace()).noteSpaceAudience({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId,
        operationId,
        audience: input,
      }), current.name);
    } catch (error) {
      await applyAudience(current.scope, currentParticipants, input.scope, requested).catch((rollbackError) => {
        logWarn(this.env, "space_audience_projection_rollback_failed", {
          workspace_id: this.auth.workspaceId,
          space_id: spaceId,
          reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      });
      throw error;
    }

    // Each member Channel converges by retract-then-apply in WorkspaceDO. The
    // walk abandons if a later audience change overtakes it, because that
    // change walks every member itself.
    return this.walkMembers({
      spaceId, operationId, kind: "audience", cursor: null, expectedSpaceRevision: updated.revision,
    });
  }

  /**
   * Put a Channel in a Space: one WorkspaceDO call.
   *
   * WorkspaceDO stages the membership, asks the Channel's conversation for the
   * audience it implies, and only then activates it, so nothing renders a
   * placement whose readers have not been granted; a failure part way cancels
   * the staged row rather than leaving a `joining` membership.
   */
  async addChannel(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<SpaceSummary> {
    return this.changedChannel(await (await this.workspace()).addSpaceChannel({
      auth: this.actor(), spaceId, workstreamId,
    }));
  }

  /** Take a Channel out of a Space, when it still has another home: one WorkspaceDO call. */
  async removeChannel(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<SpaceSummary> {
    return this.changedChannel(await (await this.workspace()).removeSpaceChannel({
      auth: this.actor(), spaceId, workstreamId,
    }));
  }

  /**
   * Move one Channel between Spaces behind one server boundary.
   *
   * Equal audiences need no Channel audience mutation, and everything such a
   * move touches (both memberships and the Channel's recorded provenance) is in
   * WorkspaceDO, so it is one RPC and one transaction there. Different
   * audiences, or a Channel whose provenance does not match the Spaces as they
   * are now, take the destination-first add/remove path so its canonical
   * audience operations still enforce every content and grant fence.
   */
  async moveChannel(
    sourceSpaceId: SpaceId,
    targetSpaceId: SpaceId,
    workstreamId: WorkstreamId,
  ) {
    if (sourceSpaceId === targetSpaceId) {
      const space = await this.summary(targetSpaceId);
      return MoveChannelBetweenSpacesResultSchema.parse({ source: space, target: space });
    }
    const moved = WorkspaceSpaceMembershipMoveOutcomeSchema.parse(await (await this.workspace()).moveSpaceMembership({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      sourceSpaceId,
      targetSpaceId,
      workstreamId,
    }));
    if (!moved.ok) throw spaceRefusal(moved.code, "", moved.unreachableUserIds, moved.blockedWorkstreamIds);
    if (!moved.moved) return this.moveChannelThroughAudienceChange(sourceSpaceId, targetSpaceId, workstreamId);
    return MoveChannelBetweenSpacesResultSchema.parse({ source: moved.source, target: moved.target });
  }

  private async moveChannelThroughAudienceChange(
    sourceSpaceId: SpaceId,
    targetSpaceId: SpaceId,
    workstreamId: WorkstreamId,
  ) {
    const target = await this.addChannel(targetSpaceId, workstreamId);
    const source = await this.removeChannel(sourceSpaceId, workstreamId);
    return MoveChannelBetweenSpacesResultSchema.parse({ source, target });
  }

  /**
   * Archive a Space once no member Channel would be stranded by it.
   *
   * The fan-out asks for the Channels this Space still *reaches* rather than
   * its active members, because `prepareSpaceArchive` is what takes them out of
   * the active set: it flips every membership to `removing` before the first
   * Channel is asked to withdraw anything. Reading the active set here would
   * retract from nothing and leave this Space's access source live on every
   * Channel it had, which is access nothing accounts for any more.
   */
  async archive(spaceId: SpaceId): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    // One id, minted here and carried to both halves. The settlement has to
    // name the intent the preflight staged, and deriving it from the Space
    // revision — which the archive itself advances — made the two halves agree
    // by arithmetic over writes in two objects rather than by saying so.
    const operationId = uuidV7();
    this.settled(await workspace.prepareSpaceArchive({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
    }), "");
    // The last page of the walk finalizes the archive and answers with it.
    return this.walkMembers({ spaceId, operationId, kind: "archive", cursor: null, expectedSpaceRevision: null });
  }

  /**
   * Bring an archived Space back, and with it the access it used to supply.
   *
   * Its memberships return first — the archive is what took them out — and then
   * each Channel has this Space's source applied again. Re-applying rather than
   * assuming, because the Channel's own audience has moved on in the meantime
   * and the plan is a delta against what it is now.
   */
  async restore(spaceId: SpaceId): Promise<SpaceSummary> {
    // One id, minted here and carried to both halves, exactly as an archive's
    // is: the restore stages an intent and the walk below settles it.
    const operationId = uuidV7();
    this.settled(await (await this.workspace()).restoreSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
    }), "");
    // Each membership the restore put back is re-applied at the generation the
    // restore advanced it to, read in WorkspaceDO as the walk reaches it.
    return this.walkMembers({ spaceId, operationId, kind: "restore", cursor: null, expectedSpaceRevision: null });
  }

  /**
   * Add a resource or a Sidekick every member Channel inherits.
   *
   * Attached to the Space's own authority first, because that attachment is the
   * inheritance record a person sees, and registered in WorkspaceDO second,
   * because the registry is what stages and fences delivery. The audience
   * preflight runs before either: the full effective audience of every member
   * Channel has to fit inside what the resource or Sidekick admits, and a
   * default that fails that test must not be published at all.
   */
  async addDefault(spaceId: SpaceId, kind: SpaceDefaultKind, targetId: string): Promise<SpaceSummary> {
    const space = await this.editable(spaceId);
    if (kind === "resource") {
      await new ResourceService(this.env, this.auth).get(targetId);
      await this.assertResourceAudience(space, targetId);
    } else {
      await this.assertSidekickScope(targetId);
    }
    await this.setDefaultAttachment(spaceId, space.name, kind, targetId, true);
    try {
      const result = WorkspaceSpaceDefaultResultSchema.parse(await (await this.workspace()).addSpaceDefault({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId,
        kind,
        targetId,
      }));
      if (!result.ok) {
        throw spaceRefusal(result.code, space.name, result.unreachableUserIds, result.blockedWorkstreamIds);
      }
      return result.space;
    } catch (error) {
      await this.setDefaultAttachment(spaceId, space.name, kind, targetId, false);
      throw error;
    }
  }

  /**
   * Stop handing a default down.
   *
   * It is not detached from Channels that already have it: a Channel's
   * transcript and execution context were built with it, and removing a
   * resource everybody has been using is a different decision from stopping the
   * next Channel inheriting it.
   */
  async removeDefault(spaceId: SpaceId, kind: SpaceDefaultKind, targetId: string): Promise<SpaceSummary> {
    const space = await this.editable(spaceId);
    await this.setDefaultAttachment(spaceId, space.name, kind, targetId, false);
    try {
      return this.settled(await (await this.workspace()).removeSpaceDefault({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId,
        kind,
        targetId,
      }), space.name);
    } catch (error) {
      await this.setDefaultAttachment(spaceId, space.name, kind, targetId, true);
      throw error;
    }
  }

  private async setDefaultAttachment(
    spaceId: SpaceId,
    spaceName: string,
    kind: SpaceDefaultKind,
    targetId: string,
    attached: boolean,
  ): Promise<void> {
    if (kind === "resource") {
      await this.throughSpaceAuthority(
        spaceId,
        spaceName,
        attached ? "attach_default_resource" : "detach_default_resource",
        async () => {
          if (attached) await this.spaceConversation(spaceId).attachResource(targetId);
          else await this.spaceConversation(spaceId).detachResource(targetId);
        },
      );
      return;
    }
    await this.throughSpaceAuthority(
      spaceId,
      spaceName,
      attached ? "attach_default_sidekick" : "detach_default_sidekick",
      async () => (await this.spaceParent()).setSidekickRecommendation({
        workspaceId: this.auth.workspaceId,
        parentId: spaceId,
        userId: this.auth.userId,
        sidekickId: targetId,
        attached,
      }),
    );
  }

  /**
   * One page of the Channels the Space holds, archived ones included.
   *
   * `reach` is the difference between the Channels a surface would call members
   * and the Channels this Space's access source is still on. A retraction
   * fan-out runs *after* the prepare that staged it, and a prepare is what
   * flips a membership out of `active` — so an archive that asked for the
   * default set would walk nothing.
   */
  async memberPage(
    spaceId: SpaceId,
    reach: MemberWalkReach = "active",
    cursor: string | null = null,
  ): Promise<{ members: SpaceMember[]; nextCursor: string | null }> {
    const result = WorkspaceSpaceMembersResultSchema.parse(await (await this.workspace()).listSpaceMembers({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      reach,
      cursor,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return { members: result.members, nextCursor: result.nextCursor };
  }

  /**
   * Carry one staged operation to every member Channel, a page at a time.
   *
   * The one walk an audience change, an archive and a restore all take, and
   * the one their resume takes. Each page is one WorkspaceDO call: it changes
   * every member Channel's source there, through the Channel's own
   * conversation, and writes the cursor the page ended at onto the intent
   * before it answers. A Space past one invocation's budget fails part way,
   * the intent stays unsettled with its cursor, and the resume continues from
   * that page. The last page settles the intent (an archive is finalized) and
   * answers with the Space.
   */
  private async walkMembers(input: {
    spaceId: SpaceId;
    operationId: string;
    kind: SpaceMemberWalkKind;
    cursor: string | null;
    expectedSpaceRevision: number | null;
  }): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    let cursor = input.cursor;
    for (;;) {
      const page = WorkspaceSpaceMemberWalkResultSchema.parse(await workspace.walkSpaceMembers({
        auth: this.actor(),
        spaceId: input.spaceId,
        operationId: input.operationId,
        kind: input.kind,
        cursor,
        expectedSpaceRevision: input.expectedSpaceRevision,
      }));
      if (!page.ok) throw channelChangeRefusal(page.refusal);
      if (page.outcome !== "page") return page.space;
      cursor = page.cursor;
    }
  }

  /**
   * Finish a staged operation whose request never came back, for a
   * `space_intent_resume` message already on the Queue.
   *
   * WorkspaceDO resumes the intent from its row, as this person, one step per
   * call (`SpaceChannelAccess.resume`); this calls it until the intent is no
   * longer progressing. Every way of giving up is named to the caller rather
   * than swallowed here, because the consumer is what writes the log line and
   * an intent that settled without doing its work is the thing nobody would
   * otherwise notice.
   */
  async resumeIntent(operationId: string): Promise<SpaceIntentResumeOutcome> {
    const workspace = await this.workspace();
    for (;;) {
      const resumed = WorkspaceSpaceIntentResumeResultSchema.parse(await workspace.resumeSpaceIntent({
        auth: this.actor(),
        operationId,
      }));
      if (!resumed.ok) throw channelChangeRefusal(resumed.refusal);
      if (resumed.outcome === "abandoned") return { outcome: "abandoned", reason: resumed.reason };
      if (resumed.outcome === "settled") return { outcome: "settled" };
    }
  }

  /**
   * Ask every member Channel whether the proposed audience still contains its
   * retained content, before any of them is changed.
   *
   * An early-out rather than the fence. The fence is the canonical scope and
   * participant operations, which run the same predicate inside the transaction
   * that changes the audience; this exists because those operations run one
   * Channel at a time and the first failure would leave the earlier Channels
   * already wider.
   *
   * It reads pages but carries no cursor, and that is not the oversight it
   * looks like. There is no intent yet — this runs in front of the write that
   * stages one — and there is nothing to resume: the pass writes nothing, so a
   * failure part way through refuses the request and the next attempt asks
   * every Channel again.
   */
  private async preflightContainment(
    spaceId: SpaceId,
    audience: UpdateSpaceAudienceRequest,
  ): Promise<void> {
    const proposed = audience.scope === "workspace"
      ? { scope: "workspace" as const }
      : { scope: "personal" as const, userIds: [...audience.participantUserIds] };
    let cursor: string | null = null;
    do {
      const page = await this.memberPage(spaceId, "active", cursor);
      for (const { workstreamId } of page.members) {
        // Tri-state: `true` admits, `false` is the content fence, and `null` is
        // the object saying it is not that Channel's main conversation — so the
        // question was never asked. Only `true` may pass, which is the reading
        // `SpaceBootstrapService.admit` has always taken; treating `null` as
        // consent let a Channel nobody could ask be widened on the strength of
        // a non-answer.
        // A throw is the same answer as a `null` and gets the same name: the
        // question was never asked. Reported rather than propagated raw,
        // because a rejection that crosses the RPC hop has no code on it and
        // reached the route as `internal_error`.
        const contains = await this.askContainment(workstreamId, proposed);
        if (contains !== true) {
          throw spaceRefusal(
            contains === false ? "space_membership_content_fence" : "space_conversation_unreachable",
            "",
          );
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
  }

  private async askContainment(
    workstreamId: WorkstreamId,
    audience: { scope: "workspace" } | { scope: "personal"; userIds: string[] },
  ): Promise<boolean | null> {
    try {
      return await (await this.conversationStub(workstreamId)).previewAudienceContainment({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        workstreamId,
        audience,
      });
    } catch (error) {
      logWarn(this.env, "space_conversation_unreachable", {
        workspace_id: this.auth.workspaceId,
        workstream_id: workstreamId,
        reason: diagnosticErrorCode(error, "space_conversation_unreachable"),
      });
      return null;
    }
  }

  private async assertResourceAudience(space: SpaceSummary, resourceId: string): Promise<void> {
    const readerIds = space.scope === "workspace"
      ? (await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' AND access_class = 'member' ORDER BY user_id`,
      ).bind(this.auth.workspaceId).all<{ user_id: string }>()).results.map((row) => row.user_id)
      : space.participants.map((participant) => participant.userId);
    for (const userId of [...new Set(readerIds)]) {
      try {
        // The ordinary authoritative resource read, as each reader. It routes
        // resource, connector, note, upload and inbound-email visibility
        // through WorkspaceDO, so there is no second audience model here.
        await new ResourceService(this.env, { ...this.auth, userId: asUserId(userId) }).get(resourceId);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        throw spaceRefusal("space_default_audience_mismatch", space.name);
      }
    }
  }

  /**
   * A Space hands down Organization Sidekicks only.
   *
   * The same eligibility `WorkstreamService.setSidekickRecommendation` asks
   * for: a personal Sidekick recommended to a Space would be offered in every
   * member Channel and runnable by nobody but its author.
   */
  private async assertSidekickScope(sidekickId: string): Promise<void> {
    const source = await durableObjectStubForWorkspace(
      this.env, this.env.AUTOMATION_DOS, this.auth.workspaceId,
      automationDOName(
        this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId), asAutomationId(sidekickId),
      ),
    );
    const sidekick = await source.readAuthorizationFacts({
      workspaceId: this.auth.workspaceId,
      parentId: sidekickId,
      userId: this.auth.userId,
      substreamIds: [],
    });
    if (!sidekick.exists) throw new ApiError(404, "sidekick_not_found", "Sidekick not found");
    if (sidekick.scope !== "workspace") {
      throw new ApiError(422, "sidekick_attachment_scope_invalid", "Choose an Organization Sidekick");
    }
  }

  /**
   * The hidden conversation's own state: title, scope and creator, then the
   * appearance through the same writer a Channel's icon and colour go through,
   * so there is one place a stored appearance is produced and one effect that
   * carries it. A failure names the Space authority boundary.
   */
  private provisionSpaceConversation(spaceId: SpaceId, input: CreateSpaceRequest): Promise<void> {
    return this.throughSpaceAuthority(spaceId, input.name, "provision", async () => {
      await provisionWorkstreamObject(this.env, {
        workspaceId: this.auth.workspaceId,
        workstreamId: spaceId,
        title: input.name.trim(),
        objective: "",
        scope: input.scope,
        createdByUserId: this.auth.userId,
        participantUserIds: [this.auth.userId],
        harnessStatus: "idle",
        titleStatus: "settled",
        emailAddress: null,
        emailRouteStatus: null,
        systemKind: null,
        modelOverride: null,
        now: Date.now(),
      });
      await this.spaceConversation(spaceId).setAppearance({
        icon: input.iconKey,
        color: input.colorKey,
      });
    });
  }

  /** The person this request acts as, for WorkspaceDO to act as on a Channel's conversation. */
  private actor(): SpaceActorAuth {
    return {
      sessionId: this.auth.sessionId,
      userId: asUserId(this.auth.userId),
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      region: this.auth.region,
      role: this.auth.role,
      ...(this.auth.principal ? { principal: this.auth.principal } : {}),
    };
  }

  private changedChannel(result: WorkspaceSpaceChannelChangeResult): SpaceSummary {
    const parsed = WorkspaceSpaceChannelChangeResultSchema.parse(result);
    if (!parsed.ok) throw channelChangeRefusal(parsed.refusal);
    return SpaceSummarySchema.parse(parsed.space);
  }

  private settled(result: WorkspaceSpaceMutationResult, spaceName: string): SpaceSummary {
    const parsed = WorkspaceSpaceMutationResultSchema.parse(result);
    if (!parsed.ok) {
      throw spaceRefusal(parsed.code, spaceName, parsed.unreachableUserIds, parsed.blockedWorkstreamIds);
    }
    return SpaceSummarySchema.parse(parsed.space);
  }

  /**
   * The Space's hidden main conversation: its participants and resources.
   *
   * Addressed as a Space rather than as a Channel, which is what makes every
   * *other* route into this object refuse: a product request that says
   * `workstream` about an id the object knows is a Space is answered as not
   * found, so a Space id on `/workstreams/:id` cannot archive General or make
   * it personal behind the Space authority's back.
   */
  private spaceConversation(spaceId: SpaceId): WorkstreamObjectClient {
    return WorkstreamObjectClient.forSpace(this.env, this.auth, spaceId);
  }

  /**
   * One piece of work against the Space's *own* authority, with its failure
   * named.
   *
   * The Space's hidden conversation and the `SpaceDO` above it are reached over
   * Durable Object RPC, and a rejection that is not the object's own refusal
   * crosses that hop as a bare `Error` with no code on it. Every one of those
   * arrived at the route as `internal_error` — the same word the Worker uses
   * for every unhandled failure it has — so a Space whose authority could not
   * answer was indistinguishable in a log from a bug in the route beside it.
   * A Space's conversation that could not be rebuilt from storage cost a
   * separate diagnosis for each of the five operations that address it.
   *
   * An `ApiError` passes through untouched: it already carries the code the
   * object chose, and re-naming it here would replace a particular refusal —
   * `space_protected`, a content fence, a revoked session — with a generic one.
   * The reason itself is not widened to the caller; it goes to the log as a
   * diagnostic code, which is where an operator reads it.
   */
  private async throughSpaceAuthority<T>(
    spaceId: SpaceId,
    spaceName: string,
    operation: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // A refusal the object chose keeps its own code: `space_protected`, a
      // content fence, a revoked session, a parent-kind mismatch. A 500 is the
      // object saying it does not know what went wrong, and a rejection that
      // crossed the RPC hop is not an `ApiError` at all — both are this Space's
      // authority failing to answer, and both used to reach a person as
      // `internal_error`.
      if (error instanceof ApiError && error.status !== 500) throw error;
      logWarn(this.env, "space_authority_unreachable", {
        workspace_id: this.auth.workspaceId,
        space_id: spaceId,
        operation,
        reason: diagnosticErrorCode(error, "space_authority_unreachable"),
      });
      throw spaceRefusal("space_authority_unreachable", spaceName);
    }
  }

  private conversationStub(workstreamId: string) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.SUBSTREAM_AGENTS,
      this.auth.workspaceId,
      conversationObjectName(
        this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId), workstreamId,
      ),
    );
  }

  /** The Organization object, which hosts every Space's parent. */
  private spaceParent() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)),
    );
  }

  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }
}
