import {
  asAutomationId,
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  SpaceChannelPageSchema,
  SpaceDirectorySchema,
  SpaceSummarySchema,
  type CreateSpaceRequest,
  type SpaceChannelPage,
  type SpaceDirectory,
  type SpaceDefaultKind,
  type SpaceErrorCode,
  type SpaceId,
  type SpaceSummary,
  type ReorderSpacesRequest,
  type UpdateSpaceAudienceRequest,
  type UpdateSpacePresentationRequest,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";

import { automationDOName, conversationObjectName, spaceDOName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceSpaceChannelPageResultSchema,
  WorkspaceSpaceDefaultResultSchema,
  WorkspaceSpaceDirectoryResultSchema,
  WorkspaceSpaceGeneralResultSchema,
  WorkspaceSpaceMembersResultSchema,
  WorkspaceSpaceMembershipPlanResultSchema,
  WorkspaceSpaceMutationResultSchema,
  type SpaceMember,
  type SpaceMembershipReach,
  type WorkspaceSpaceMembershipPlanResult,
  type WorkspaceSpaceMutationResult,
} from "../durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { effectiveChannelAudience } from "../lib/channel-audience";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import { ChannelAccessService } from "./channel-access-service";
import { ResourceService } from "./resource-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "./workstream-runtime-database";
import { readWorkstreamAuthorityControl } from "./workstream-authority";
import { WorkstreamDirectoryService } from "./workstream-directory-service";
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
export function spaceRefusal(code: SpaceErrorCode, spaceName: string, unreachable: readonly UserId[] = []): ApiError {
  // Named when the caller has the name in hand and "this Space" when it does
  // not, rather than rendering an empty pair of quotation marks: a refusal that
  // says “” about a Space is worse than one that does not name it.
  const subject = spaceName.trim().length > 0 ? `“${spaceName.trim()}”` : "this Space";
  switch (code) {
    case "space_access_denied":
      return new ApiError(403, code, "You cannot change this Space");
    case "space_not_found":
      return new ApiError(404, code, "Space not found");
    case "space_protected":
      return new ApiError(409, code, "General cannot be archived or made private");
    case "space_membership_final":
      return new ApiError(409, code,
        `A Channel in ${subject} belongs to no other Space, so it would have no home`);
    case "space_audience_incompatible":
      return new ApiError(409, code,
        `Leaving ${subject} would leave ${unreachable.length || "some"} of its readers unable to find the Channel in any Space they can see`);
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
  }
}

/**
 * The regional facade over the Organization's Space authority.
 *
 * Three objects have to agree for a Space to mean anything, and this is where
 * they are ordered: WorkspaceDO owns the relationship and stages every
 * operation behind a fence, the Space's own `SpaceDO` and hidden main
 * conversation own what the Space *is* — its name, appearance, scope,
 * participants and attachments — and each member Channel owns its own audience.
 *
 * Nothing here writes a Channel's audience itself. Every membership, audience
 * change, archive and restore goes through {@link ChannelAccessService}, which
 * applies the delta through the Channel's canonical scope and participant
 * operations so the retained-content containment preflight and its SQL triggers
 * stay the only fence.
 */
export class SpaceService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  async reorder(input: ReorderSpacesRequest): Promise<SpaceDirectory> {
    const result = WorkspaceSpaceDirectoryResultSchema.parse(await (await this.workspace()).reorderSpaces({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      order: input,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return SpaceDirectorySchema.parse(result.directory);
  }

  async summary(spaceId: SpaceId): Promise<SpaceSummary> {
    return this.settled(await (await this.workspace()).spaceSummary({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
    }), "");
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
   * Create a Space: reserve it, then open the object that *is* it.
   *
   * The reservation comes first so the id is the Organization's rather than
   * something this service invents and hopes nothing else took, and so a
   * failure to open the object has something to undo. Provisioning writes the
   * same D1 anchor and authority route a Channel's creation writes, under
   * `parentKind: "space"`, and then reserves the hidden main conversation —
   * with no opening message and admitting no run, because nothing in the
   * product opens a Space's feed and a Space that started an agent loop would
   * be a conversation the product cannot show.
   */
  async create(input: CreateSpaceRequest): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    const reserved = this.settled(await workspace.reserveSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      space: input,
    }), input.name);
    try {
      await this.provisionSpaceObject(reserved.id, input);
      return await this.summary(reserved.id);
    } catch (error) {
      // The Space never opened, so nothing may see it. A reservation left
      // behind would be a Space in every member's sidebar that answers nothing.
      await workspace.cancelSpaceReservation({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: reserved.id,
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * The Organization's General Space, opened if this caller is the first.
   *
   * `create`'s two halves under one idempotent front door. The reservation is
   * the unique partial index's decision rather than a read — every caller here
   * is a retry of another, and the loser is answered with the Space the winner
   * made — and only the caller that *made* it opens the object, because
   * provisioning the same Space twice would reserve its main conversation
   * twice.
   *
   * Reached by every creation that names no Space and by the cutover, which is
   * why it is here rather than inside either: a Channel created while the
   * bootstrap is still running lands in the same General the bootstrap is
   * placing everything else into.
   */
  async ensureGeneral(): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    const result = WorkspaceSpaceGeneralResultSchema.parse(await workspace.ensureGeneralSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    }));
    if (!result.ok) throw spaceRefusal(result.code, "General");
    if (!result.created) return result.space;
    try {
      await this.provisionSpaceObject(result.space.id, {
        name: result.space.name,
        iconKey: result.space.iconKey,
        colorKey: result.space.colorKey,
        scope: result.space.scope,
      });
    } catch (error) {
      // The same undo `create` does, for the same reason: a reservation whose
      // object never opened is a Space in every member's sidebar that answers
      // nothing — and General is in every member's sidebar by construction.
      await workspace.cancelSpaceReservation({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: result.space.id,
      }).catch(() => undefined);
      throw error;
    }
    return this.summary(result.space.id);
  }

  /** Presentation belongs to the Space's own authority; this is its door. */
  async updatePresentation(spaceId: SpaceId, input: UpdateSpacePresentationRequest): Promise<SpaceSummary> {
    const current = await this.summary(spaceId);
    const client = this.spaceConversation(spaceId);
    await client.update({ title: input.name });
    await client.setAppearance({ icon: input.iconKey, color: input.colorKey });
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
    const current = await this.summary(spaceId);
    const currentParticipants = new Set<string>(current.participants.map((participant) => participant.userId));
    const requested = new Set<string>(input.participantUserIds);
    const removed = [...currentParticipants].filter((userId) => !requested.has(userId));
    if (removed.some((userId) => userId !== this.auth.userId)
      && this.auth.role !== "owner" && this.auth.role !== "admin") {
      throw new ApiError(403, "participant_removal_denied",
        "Only an Organization owner or admin can remove another Space participant");
    }
    const members = await this.memberChannels(spaceId);
    await this.preflightContainment(members.map((member) => member.workstreamId), input);

    const operationId = uuidV7();
    const updated = this.settled(await (await this.workspace()).noteSpaceAudience({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
      audience: input,
    }), current.name);

    const spaceClient = this.spaceConversation(spaceId);
    if (input.scope !== current.scope) await spaceClient.update({ scope: input.scope });
    for (const userId of requested) {
      if (!currentParticipants.has(userId)) await spaceClient.addParticipant(userId);
    }
    for (const userId of removed) await spaceClient.removeParticipant(userId);

    const access = new ChannelAccessService(this.env, this.auth);
    for (const { workstreamId, membershipGeneration } of members) {
      // The Space, re-read each time round. Every step below is a cross-object
      // await, so a later audience change can accept and overtake this one part
      // way through the walk; carrying on would leave the Channels behind it on
      // a roster nobody asked for. Abandoning here is safe because the newer
      // change walks every member itself.
      if ((await this.summary(spaceId)).revision !== updated.revision) {
        await this.recordReceipt(operationId, "audience_superseded", true);
        return this.summary(spaceId);
      }
      // The revision travels with the retraction as well as the application:
      // the retraction deletes the row the application's fence reads, so
      // without it an older convergence would be refused by nothing.
      await access.retractSpaceSource(workstreamId, spaceId, uuidV7(), updated.revision);
      await access.applySpaceSource(workstreamId, {
        spaceId,
        scope: input.scope,
        participantUserIds: [...requested].map(asUserId),
        spaceRevision: updated.revision,
        membershipGeneration,
        operationId: uuidV7(),
      });
      await this.recordReceipt(operationId, `audience:${workstreamId}`, false);
    }
    await this.recordReceipt(operationId, "audience_settled", true);
    return this.summary(spaceId);
  }

  /**
   * Put a Channel in a Space: stage, apply, settle.
   *
   * The membership is not visible until the audience it implies has been
   * applied, so nothing ever renders a placement whose readers have not been
   * granted. A failure anywhere in between cancels the staged row rather than
   * leaving a `joining` membership that no list shows and no alarm finishes.
   */
  async addChannel(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<SpaceSummary> {
    if (!await new WorkstreamDirectoryService(this.env, this.auth).visible(workstreamId)) {
      throw new ApiError(404, "workstream_not_found", "Channel not found");
    }
    const workspace = await this.workspace();
    const plan = this.planned(await workspace.prepareSpaceMembership({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      workstreamId,
    }), "");
    const settle = {
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      workstreamId,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    };
    try {
      await new ChannelAccessService(this.env, this.auth).applySpaceSource(workstreamId, {
        spaceId,
        scope: plan.space.scope,
        participantUserIds: plan.space.participants.map((participant) => participant.userId),
        spaceRevision: plan.space.revision,
        membershipGeneration: plan.membershipGeneration,
        operationId: uuidV7(),
      });
      return this.settled(await workspace.finalizeSpaceMembership(settle), plan.space.name);
    } catch (error) {
      await workspace.cancelSpaceMembership(settle).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Take a Channel out of a Space, when the Channel still has a home and its
   * readers can still find it.
   *
   * The remaining audience is computed from the Channel's own access sources
   * with this Space taken out, because WorkspaceDO cannot see a Channel's
   * direct source and the discoverability test is about the readers who
   * *survive* the retraction rather than the ones this Space supplied.
   */
  async removeChannel(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<SpaceSummary> {
    const access = new ChannelAccessService(this.env, this.auth);
    const sources = await access.readSources(workstreamId);
    const remaining = effectiveChannelAudience({
      direct: sources.direct,
      sources: sources.spaces
        .filter((source) => source.spaceId !== spaceId)
        .map((source) => ({ sourceId: source.spaceId, ...source })),
    });
    const workspace = await this.workspace();
    const plan = this.planned(await workspace.prepareSpaceMembershipRemoval({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      workstreamId,
      remainingAudience: { scope: remaining.scope, participantUserIds: [...remaining.participantUserIds] },
    }), "");
    await access.retractSpaceSource(workstreamId, spaceId, uuidV7());
    return this.settled(await workspace.finalizeSpaceMembershipRemoval({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      workstreamId,
      spaceRevision: plan.space.revision,
      membershipGeneration: plan.membershipGeneration,
    }), plan.space.name);
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
    const plan = this.settled(await workspace.prepareSpaceArchive({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
    }), "");
    const access = new ChannelAccessService(this.env, this.auth);
    for (const { workstreamId } of await this.memberChannels(spaceId, "reaching")) {
      await access.retractSpaceSource(workstreamId, spaceId, uuidV7());
    }
    return this.settled(await workspace.finalizeSpaceArchive({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
    }), plan.name);
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
    const restored = this.settled(await (await this.workspace()).restoreSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
    }), "");
    const access = new ChannelAccessService(this.env, this.auth);
    // The memberships the restore just put back, each at the generation that
    // restore advanced it to — read after it, so the fence every application
    // carries is the row's own rather than a constant.
    for (const { workstreamId, membershipGeneration } of await this.memberChannels(spaceId)) {
      await access.applySpaceSource(workstreamId, {
        spaceId,
        scope: restored.scope,
        participantUserIds: restored.participants.map((participant) => participant.userId),
        spaceRevision: restored.revision,
        membershipGeneration,
        operationId: uuidV7(),
      });
    }
    return this.summary(spaceId);
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
    const space = await this.summary(spaceId);
    if (kind === "resource") {
      await new ResourceService(this.env, this.auth).get(targetId);
      await this.assertResourceAudience(space, targetId);
      await this.spaceConversation(spaceId).attachResource(targetId);
    } else {
      await this.assertSidekickScope(targetId);
      await (await this.spaceParent(spaceId)).setSidekickRecommendation({
        workspaceId: this.auth.workspaceId,
        parentId: spaceId,
        userId: this.auth.userId,
        sidekickId: targetId,
        attached: true,
      });
    }
    const result = WorkspaceSpaceDefaultResultSchema.parse(await (await this.workspace()).addSpaceDefault({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      kind,
      targetId,
    }));
    if (!result.ok) throw spaceRefusal(result.code, space.name, result.unreachableUserIds);
    return result.space;
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
    const space = await this.summary(spaceId);
    if (kind === "sidekick") {
      await (await this.spaceParent(spaceId)).setSidekickRecommendation({
        workspaceId: this.auth.workspaceId,
        parentId: spaceId,
        userId: this.auth.userId,
        sidekickId: targetId,
        attached: false,
      });
    } else {
      await this.spaceConversation(spaceId).detachResource(targetId).catch(() => undefined);
    }
    return this.settled(await (await this.workspace()).removeSpaceDefault({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      kind,
      targetId,
    }), space.name);
  }

  /**
   * Every Channel the Space holds, archived ones included.
   *
   * `reach` is the difference between the Channels a surface would call members
   * and the Channels this Space's access source is still on. A retraction
   * fan-out runs *after* the prepare that staged it, and a prepare is what
   * flips a membership out of `active` — so an archive that asked for the
   * default set would walk nothing.
   */
  async memberChannels(
    spaceId: SpaceId,
    reach: SpaceMembershipReach = "active",
  ): Promise<SpaceMember[]> {
    const result = WorkspaceSpaceMembersResultSchema.parse(await (await this.workspace()).listSpaceMembers({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      reach,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.members;
  }

  /**
   * Finish a staged operation whose request never came back.
   *
   * Every branch is the same work the request would have done, against the
   * fences the intent recorded. That is what makes a redelivery safe: the
   * Channel operations are idempotent deltas against the audience as it is now,
   * and the WorkspaceDO settlement refuses a generation or revision that has
   * moved, so a resume that is no longer wanted settles as a refusal rather
   * than as a second application.
   *
   * An intent whose Space has moved on is abandoned rather than forced. The
   * work it describes was staged against a Space that no longer exists in that
   * shape, and re-running it would apply an audience nobody asked for.
   */
  async resumeIntent(intent: {
    operationId: string;
    kind: "add" | "remove" | "audience" | "archive" | "restore" | "default" | "bootstrap";
    spaceId: SpaceId;
    workstreamId: WorkstreamId | null;
    spaceRevision: number;
    membershipGeneration: number | null;
  }): Promise<void> {
    const workspace = await this.workspace();
    // Settling an intent is what takes it out of the alarm's claim, so giving
    // up on one is a receipt like any other rather than a second operation.
    const abandon = (reason: string): Promise<void> =>
      this.recordReceipt(intent.operationId, reason, true);
    const space = await this.summary(intent.spaceId);
    const access = new ChannelAccessService(this.env, this.auth);
    if (intent.kind === "add" && intent.workstreamId && intent.membershipGeneration) {
      if (space.revision !== intent.spaceRevision) {
        await workspace.cancelSpaceMembership({
          workspaceId: asWorkspaceId(this.auth.workspaceId),
          userId: asUserId(this.auth.userId),
          spaceId: intent.spaceId,
          workstreamId: intent.workstreamId,
          spaceRevision: intent.spaceRevision,
          membershipGeneration: intent.membershipGeneration,
        });
        await abandon("add_superseded");
        return;
      }
      await access.applySpaceSource(intent.workstreamId, {
        spaceId: intent.spaceId,
        scope: space.scope,
        participantUserIds: space.participants.map((participant) => participant.userId),
        spaceRevision: intent.spaceRevision,
        membershipGeneration: intent.membershipGeneration,
        operationId: uuidV7(),
      });
      await workspace.finalizeSpaceMembership({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: intent.spaceId,
        workstreamId: intent.workstreamId,
        spaceRevision: intent.spaceRevision,
        membershipGeneration: intent.membershipGeneration,
      });
      return;
    }
    if (intent.kind === "remove" && intent.workstreamId && intent.membershipGeneration) {
      await access.retractSpaceSource(intent.workstreamId, intent.spaceId, uuidV7());
      await workspace.finalizeSpaceMembershipRemoval({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: intent.spaceId,
        workstreamId: intent.workstreamId,
        spaceRevision: intent.spaceRevision,
        membershipGeneration: intent.membershipGeneration,
      });
      return;
    }
    if (intent.kind === "audience") {
      // A superseded audience change is still an interrupted one. The request
      // that staged this died part way through its walk, so some member
      // Channels carry the roster it was applying and the rest carry whatever
      // came before — and the newer change that overtook it has a walk of its
      // own that may have died the same way. Abandoning here left those
      // Channels split with nothing to notice, so this converges against the
      // Space *as it is now* instead: re-applying the current source is an
      // idempotent delta on a Channel that already has it.
      const superseded = space.revision !== intent.spaceRevision;
      if (superseded) {
        logWarn(this.env, "space_audience_intent_superseded", {
          workspace_id: this.auth.workspaceId,
          space_id: intent.spaceId,
          operation_id: intent.operationId,
          staged_revision: intent.spaceRevision,
          current_revision: space.revision,
        });
      }
      for (const { workstreamId, membershipGeneration } of await this.memberChannels(intent.spaceId)) {
        await access.retractSpaceSource(workstreamId, intent.spaceId, uuidV7(), space.revision);
        await access.applySpaceSource(workstreamId, {
          spaceId: intent.spaceId,
          scope: space.scope,
          participantUserIds: space.participants.map((participant) => participant.userId),
          spaceRevision: space.revision,
          membershipGeneration,
          operationId: uuidV7(),
        });
      }
      await this.recordReceipt(
        intent.operationId,
        superseded ? "audience_superseded" : "audience_settled",
        true,
      );
      return;
    }
    if (intent.kind === "archive") {
      // `reaching`, for the reason `archive` uses it: the prepare that staged
      // this intent already flipped every membership to `removing`, so the
      // active set is empty and the Channels whose source is still live are
      // exactly the ones this read names.
      for (const { workstreamId } of await this.memberChannels(intent.spaceId, "reaching")) {
        await access.retractSpaceSource(workstreamId, intent.spaceId, uuidV7());
      }
      await workspace.finalizeSpaceArchive({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: intent.spaceId,
        operationId: intent.operationId,
      });
      return;
    }
    // `restore`, `default` and `bootstrap` stage no intent in this phase. An
    // intent of one of those kinds is a message from a release that does, so it
    // is abandoned by name rather than silently acknowledged.
    await abandon(`unsupported_${intent.kind}`);
  }

  private async recordReceipt(operationId: string, receipt: string, settled: boolean): Promise<void> {
    await (await this.workspace()).recordSpaceIntentReceipt({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      operationId,
      receipt,
      settled,
    });
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
   */
  private async preflightContainment(
    members: readonly WorkstreamId[],
    audience: UpdateSpaceAudienceRequest,
  ): Promise<void> {
    const proposed = audience.scope === "workspace"
      ? { scope: "workspace" as const }
      : { scope: "personal" as const, userIds: [...audience.participantUserIds] };
    for (const workstreamId of members) {
      const contains = await (await this.conversationStub(workstreamId)).previewAudienceContainment({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        workstreamId,
        audience: proposed,
      });
      if (contains === false) throw spaceRefusal("space_membership_content_fence", "");
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

  private async provisionSpaceObject(spaceId: SpaceId, input: CreateSpaceRequest): Promise<void> {
    const now = Date.now();
    await bootstrapWorkstreamRuntimeEnvironment(this.env, this.auth.workspaceId, spaceId, "space");
    const authority = await readWorkstreamAuthorityControl(this.env);
    await (await this.spaceParent(spaceId)).reserveChild({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      parentId: spaceId,
      substreamId: asSubstreamId("0"),
      kind: "main",
      createdByUserId: asUserId(this.auth.userId),
      authorityGeneration: authority.generation,
      directory: {
        title: input.name.trim(),
        description: "",
        scope: input.scope,
        systemKind: null,
        emailAddress: null,
        titleStatus: "settled",
        createdAt: new Date(now).toISOString(),
      },
    });
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
      now,
    });
    // The appearance goes through the same writer a Channel's icon and colour
    // do, so there is one place a stored appearance is produced and one effect
    // that carries it.
    await this.spaceConversation(spaceId).setAppearance({
      icon: input.iconKey,
      color: input.colorKey,
    });
  }

  private settled(result: WorkspaceSpaceMutationResult, spaceName: string): SpaceSummary {
    const parsed = WorkspaceSpaceMutationResultSchema.parse(result);
    if (!parsed.ok) throw spaceRefusal(parsed.code, spaceName, parsed.unreachableUserIds);
    return SpaceSummarySchema.parse(parsed.space);
  }

  private planned(
    result: WorkspaceSpaceMembershipPlanResult,
    spaceName: string,
  ): Extract<WorkspaceSpaceMembershipPlanResult, { ok: true }> {
    const parsed = WorkspaceSpaceMembershipPlanResultSchema.parse(result);
    if (!parsed.ok) throw spaceRefusal(parsed.code, spaceName, parsed.unreachableUserIds);
    return parsed;
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

  private spaceParent(spaceId: SpaceId) {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.SPACE_DOS,
      this.auth.workspaceId,
      spaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId), asSpaceId(spaceId)),
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
