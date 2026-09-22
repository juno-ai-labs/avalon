import {
  asAutomationId,
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  ContainerOrderSchema,
  SpaceChannelPageSchema,
  MoveChannelBetweenSpacesResultSchema,
  SpaceRefusalDetailsSchema,
  SpaceSummarySchema,
  type CreateSpaceRequest,
  type SpaceChannelPage,
  type SpaceDefaultKind,
  type SpaceErrorCode,
  type SpaceId,
  type SpaceScope,
  type SpaceSummary,
  type ContainerOrder,
  type UpdateSpaceAudienceRequest,
  type UpdateSpacePresentationRequest,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";

import { automationDOName, conversationObjectName, spaceDOName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceSpaceChannelPageResultSchema,
  WorkspaceSpaceDefaultResultSchema,
  WorkspaceContainerOrderResultSchema,
  WorkspaceSpaceGeneralResultSchema,
  WorkspaceSpaceMembersResultSchema,
  WorkspaceSpaceMembershipPlanResultSchema,
  WorkspaceSpaceMutationResultSchema,
  type SpaceIntentKind,
  type SpaceMember,
  type MemberWalkReach,
  type WorkspaceSpaceMembershipPlanResult,
  type WorkspaceSpaceMutationResult,
} from "../durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
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
 * Cloudflare permits six simultaneous outgoing connections per invocation
 * (https://developers.cloudflare.com/workers/platform/limits/, verified
 * 2026-09-21).
 * A member step reaches one Channel authority at a time, so six independent
 * archive retractions can overlap without asking the runtime to queue a
 * seventh connection for us.
 */
const SPACE_ARCHIVE_MEMBER_CONCURRENCY = 6;

/**
 * The participant roster a walk may re-apply, refusing a summary that is not
 * the Organization's answer.
 *
 * `SpaceSummary` is viewer-scoped in exactly one way, and it is this one: a
 * `through_channel` viewer's `participants` is empty *by design*, because they
 * are told a Space's mark so the Channel they can read has somewhere to be
 * drawn and nothing about who is in it. Applying that roster to a member
 * Channel is not "narrow this Space" — it is "withdraw every reader this Space
 * supplies", and the application would report success.
 *
 * {@link SpaceService.resumeIntent} refuses such a requester before any branch
 * runs; this is the fence at the point of use, so the next consumer to read a
 * summary and hand its roster to `applySpaceSource` fails by name instead.
 */
function rosterOf(space: SpaceSummary): UserId[] {
  if (space.reach === "through_channel") throw new Error("space_roster_viewer_scoped");
  return space.participants.map((participant) => participant.userId);
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

    const access = new ChannelAccessService(this.env, this.auth);
    const walk = await this.walkMembers({
      spaceId,
      operationId,
      pageReceipt: "audience_page",
      cursor: null,
      step: async ({ workstreamId, membershipGeneration }) => {
        // The Space, re-read each time round. Every step below is a
        // cross-object await, so a later audience change can accept and
        // overtake this one part way through the walk; carrying on would leave
        // the Channels behind it on a roster nobody asked for. Abandoning here
        // is safe because the newer change walks every member itself.
        if ((await this.summary(spaceId)).revision !== updated.revision) return "abandon";
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
        return "continue";
      },
    });
    await this.recordReceipt(
      operationId, walk === "abandoned" ? "audience_superseded" : "audience_settled", true,
    );
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
    const access = new ChannelAccessService(this.env, this.auth);
    let sourceApplied = false;
    try {
      await access.applySpaceSource(workstreamId, {
        spaceId,
        scope: plan.space.scope,
        participantUserIds: plan.space.participants.map((participant) => participant.userId),
        spaceRevision: plan.space.revision,
        membershipGeneration: plan.membershipGeneration,
        operationId: uuidV7(),
      });
      sourceApplied = true;
      return this.settled(await workspace.finalizeSpaceMembership(settle), plan.space.name);
    } catch (error) {
      if (sourceApplied) {
        await access.retractSpaceSource(workstreamId, spaceId, uuidV7(), plan.space.revision);
      }
      await workspace.cancelSpaceMembership(settle).catch(() => undefined);
      throw error;
    }
  }

  /** Take a Channel out of a Space, when it still has another home. */
  async removeChannel(spaceId: SpaceId, workstreamId: WorkstreamId): Promise<SpaceSummary> {
    const access = new ChannelAccessService(this.env, this.auth);
    const workspace = await this.workspace();
    const plan = this.planned(await workspace.prepareSpaceMembershipRemoval({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      workstreamId,
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
   * Move one Channel between Spaces behind one server boundary.
   *
   * The destination settles first, so an interrupted request may temporarily
   * leave an extra placement but can never leave the Channel without a home.
   * Each half keeps its existing durable intent and recovery path; delivery of
   * inherited defaults and realtime convergence remain asynchronous behind
   * those primitives.
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
    const workspace = await this.workspace();
    this.settled(await workspace.preflightSpaceMembershipMoveSource({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId: sourceSpaceId,
      workstreamId,
    }), "");
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
    const plan = this.settled(await workspace.prepareSpaceArchive({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
    }), "");
    const access = new ChannelAccessService(this.env, this.auth);
    await this.walkMembers({
      spaceId,
      operationId,
      pageReceipt: "archive_page",
      reach: "reaching",
      cursor: null,
      concurrency: SPACE_ARCHIVE_MEMBER_CONCURRENCY,
      step: async ({ workstreamId }) => {
        await access.retractSpaceSource(workstreamId, spaceId, uuidV7());
        return "continue";
      },
    });
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
    // One id, minted here and carried to both halves, exactly as an archive's
    // is: the restore stages an intent and the walk below settles it.
    const operationId = uuidV7();
    const restored = this.settled(await (await this.workspace()).restoreSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      operationId,
    }), "");
    const access = new ChannelAccessService(this.env, this.auth);
    // The memberships the restore just put back, each at the generation that
    // restore advanced it to — read after it, so the fence every application
    // carries is the row's own rather than a constant.
    await this.walkMembers({
      spaceId,
      operationId,
      pageReceipt: "restore_page",
      cursor: null,
      step: async ({ workstreamId, membershipGeneration }) => {
        await access.applySpaceSource(workstreamId, {
          spaceId,
          scope: restored.scope,
          participantUserIds: restored.participants.map((participant) => participant.userId),
          spaceRevision: restored.revision,
          membershipGeneration,
          operationId: uuidV7(),
        });
        return "continue";
      },
    });
    await this.recordReceipt(operationId, "restored", true);
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
      async () => (await this.spaceParent(spaceId)).setSidekickRecommendation({
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
   * The one walk an audience change, an archive and a restore all take, and the
   * one the resume takes for them — which is the point of it being a function
   * rather than a loop written out three times. A request and its resume that
   * walked differently are two implementations of the same convergence, and the
   * resume is the one nobody watches.
   *
   * Paged, and the page is recorded on the intent before the next one starts.
   * Each member Channel costs a retraction and an application — several
   * cross-object awaits each — so an unbounded walk is not a slow invocation
   * but one that runs out of subrequests, and before this the resume re-read
   * the whole member list and started again at the first Channel: every
   * redelivery redoing the same prefix and dying in the same place. A Space
   * under the ceiling still completes inside the request, exactly as it did.
   * Past it the invocation fails, the intent stays unsettled with its cursor,
   * and the alarm's resume continues from the page it names.
   *
   * The last page writes no cursor. The caller settles the intent immediately
   * after, and a settle that does not land leaves the cursor at the start of
   * that page — so the resume redoes one page rather than the whole walk.
   *
   * Archive is the one walk that opts into bounded overlap: its retractions
   * are independent, and the caller still waits for every started retraction
   * before advancing the cursor or finalizing. `allSettled` is deliberate — a
   * failed Channel must not leave sibling writes floating after this method
   * rejects.
   */
  private async walkMembers(input: {
    spaceId: SpaceId;
    /** The intent whose cursor this walk advances. */
    operationId: string;
    pageReceipt: string;
    reach?: MemberWalkReach;
    cursor: string | null;
  } & (
    | {
      concurrency?: undefined;
      step: (member: SpaceMember) => Promise<"continue" | "abandon">;
    }
    | {
      concurrency: number;
      step: (member: SpaceMember) => Promise<"continue">;
    }
  )): Promise<"walked" | "abandoned"> {
    let cursor = input.cursor;
    const concurrency = input.concurrency ?? 1;
    for (;;) {
      const page = await this.memberPage(input.spaceId, input.reach ?? "active", cursor);
      for (let offset = 0; offset < page.members.length; offset += concurrency) {
        const results = await Promise.allSettled(
          page.members.slice(offset, offset + concurrency).map(input.step),
        );
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
        if (results.some((result) => result.status === "fulfilled" && result.value === "abandon")) {
          return "abandoned";
        }
      }
      if (page.nextCursor === null) return "walked";
      cursor = page.nextCursor;
      await this.recordReceipt(input.operationId, input.pageReceipt, false, cursor);
    }
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
   *
   * Every way of giving up is named to the caller rather than swallowed here,
   * because the consumer is what writes the log line and an intent that
   * settled without doing its work is the thing nobody would otherwise notice.
   */
  async resumeIntent(intent: {
    operationId: string;
    kind: SpaceIntentKind;
    spaceId: SpaceId;
    workstreamId: WorkstreamId | null;
    spaceRevision: number;
    membershipGeneration: number | null;
    cursor: string | null;
  }): Promise<SpaceIntentResumeOutcome> {
    const workspace = await this.workspace();
    // Settling an intent is what takes it out of the alarm's claim, so giving
    // up on one is a receipt like any other rather than a second operation.
    const abandon = async (reason: string): Promise<SpaceIntentResumeOutcome> => {
      await this.recordReceipt(intent.operationId, reason, true);
      return { outcome: "abandoned", reason };
    };
    const space = await this.summary(intent.spaceId);
    // The resume runs as the person who staged the intent, and `summary` is
    // *their* view of the Space. Somebody taken out of a Space between staging
    // an operation and its resume still reaches it through a Channel placed in
    // it, so this read no longer refuses them — it answers `through_channel`,
    // whose roster is empty by design. Every branch below re-applies that
    // roster to member Channels, so the walk would withdraw every reader this
    // Space supplies, seat nobody, and settle itself as a success.
    //
    // Terminal rather than retried, the way `requester_inactive` is: no later
    // delivery gives the requester their reach back, so republishing this
    // forever would cost an alarm wake and a dead-letter message per delivery
    // and never converge. The reason goes on the row as well as into the
    // consumer's log — `recordIntentFailure` only writes while the intent is
    // unsettled, so it goes on before the receipt that settles it.
    if (space.reach === "through_channel") {
      await workspace.recordSpaceIntentFailure({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        operationId: intent.operationId,
        errorCode: "requester_reach_lost",
      });
      return abandon("requester_reach_lost");
    }
    const access = new ChannelAccessService(this.env, this.auth);
    if (intent.kind === "add") {
      // Both fences are written by the staging and neither is nullable for
      // this kind, so a row without them is a malformed one rather than an
      // operation to re-run. Named rather than re-run, and named for what is
      // missing rather than for the kind.
      if (!intent.workstreamId || !intent.membershipGeneration) {
        return abandon("add_fences_missing");
      }
      // A fence against a Space whose *audience* moved, and nothing more. A
      // viewer projection flips `is_participant` without touching `revision`,
      // so this guard does not see a requester who has been taken out of the
      // Space — which is why the reach check above it is the one that covers
      // an emptied roster, for this branch as much as for the walks.
      if (space.revision !== intent.spaceRevision) {
        await workspace.cancelSpaceMembership({
          workspaceId: asWorkspaceId(this.auth.workspaceId),
          userId: asUserId(this.auth.userId),
          spaceId: intent.spaceId,
          workstreamId: intent.workstreamId,
          spaceRevision: intent.spaceRevision,
          membershipGeneration: intent.membershipGeneration,
        });
        return abandon("add_superseded");
      }
      await access.applySpaceSource(intent.workstreamId, {
        spaceId: intent.spaceId,
        scope: space.scope,
        participantUserIds: rosterOf(space),
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
      return { outcome: "settled" };
    }
    if (intent.kind === "remove") {
      if (!intent.workstreamId || !intent.membershipGeneration) {
        return abandon("remove_fences_missing");
      }
      await access.retractSpaceSource(intent.workstreamId, intent.spaceId, uuidV7());
      await workspace.finalizeSpaceMembershipRemoval({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: intent.spaceId,
        workstreamId: intent.workstreamId,
        spaceRevision: intent.spaceRevision,
        membershipGeneration: intent.membershipGeneration,
      });
      return { outcome: "settled" };
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
      // From the page the request got to, not from the first Channel: the same
      // walk the request takes, continued rather than restarted.
      await this.walkMembers({
        spaceId: intent.spaceId,
        operationId: intent.operationId,
        pageReceipt: "audience_page",
        cursor: intent.cursor,
        step: async ({ workstreamId, membershipGeneration }) => {
          await access.retractSpaceSource(workstreamId, intent.spaceId, uuidV7(), space.revision);
          await access.applySpaceSource(workstreamId, {
            spaceId: intent.spaceId,
            scope: space.scope,
            participantUserIds: rosterOf(space),
            spaceRevision: space.revision,
            membershipGeneration,
            operationId: uuidV7(),
          });
          return "continue";
        },
      });
      await this.recordReceipt(
        intent.operationId,
        superseded ? "audience_superseded" : "audience_settled",
        true,
      );
      return { outcome: "settled" };
    }
    if (intent.kind === "archive") {
      // `reaching`, for the reason `archive` uses it: the prepare that staged
      // this intent already flipped every membership to `removing`, so the
      // active set is empty and the Channels whose source is still live are
      // exactly the ones this read names.
      await this.walkMembers({
        spaceId: intent.spaceId,
        operationId: intent.operationId,
        pageReceipt: "archive_page",
        reach: "reaching",
        cursor: intent.cursor,
        concurrency: SPACE_ARCHIVE_MEMBER_CONCURRENCY,
        step: async ({ workstreamId }) => {
          await access.retractSpaceSource(workstreamId, intent.spaceId, uuidV7());
          return "continue";
        },
      });
      await workspace.finalizeSpaceArchive({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: intent.spaceId,
        operationId: intent.operationId,
      });
      return { outcome: "settled" };
    }
    if (intent.kind === "restore") {
      // The audience walk minus the retraction. The archive is what took this
      // Space's source off every member Channel, so there is nothing to
      // withdraw; what is left half-done is the re-application, and it is an
      // idempotent delta on a Channel that already has it.
      await this.walkMembers({
        spaceId: intent.spaceId,
        operationId: intent.operationId,
        pageReceipt: "restore_page",
        cursor: intent.cursor,
        step: async ({ workstreamId, membershipGeneration }) => {
          await access.applySpaceSource(workstreamId, {
            spaceId: intent.spaceId,
            scope: space.scope,
            participantUserIds: rosterOf(space),
            spaceRevision: space.revision,
            membershipGeneration,
            operationId: uuidV7(),
          });
          return "continue";
        },
      });
      await this.recordReceipt(intent.operationId, "restored", true);
      return { outcome: "settled" };
    }
    // Every kind that stages an intent has a branch above, and
    // `SpaceIntentKindSchema` admits no others — so this is unreachable rather
    // than a fallback, and a kind added without a branch fails to compile here
    // rather than being abandoned by name at three in the morning.
    const exhaustiveKind: never = intent.kind;
    throw new Error(`unsupported_space_intent_kind:${String(exhaustiveKind)}`);
  }

  private async recordReceipt(
    operationId: string,
    receipt: string,
    settled: boolean,
    cursor?: string | null,
  ): Promise<void> {
    await (await this.workspace()).recordSpaceIntentReceipt({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      operationId,
      receipt,
      settled,
      ...(cursor === undefined ? {} : { cursor }),
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

  private provisionSpaceObject(spaceId: SpaceId, input: CreateSpaceRequest): Promise<void> {
    // Named like every other reach into this object: a provision that fails is
    // the Space's authority not opening, and the caller cancels the
    // reservation and answers a person either way.
    return this.throughSpaceAuthority(spaceId, input.name, "provision", () =>
      this.openSpaceObject(spaceId, input));
  }

  private async openSpaceObject(spaceId: SpaceId, input: CreateSpaceRequest): Promise<void> {
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
    if (!parsed.ok) {
      throw spaceRefusal(parsed.code, spaceName, parsed.unreachableUserIds, parsed.blockedWorkstreamIds);
    }
    return SpaceSummarySchema.parse(parsed.space);
  }

  private planned(
    result: WorkspaceSpaceMembershipPlanResult,
    spaceName: string,
  ): Extract<WorkspaceSpaceMembershipPlanResult, { ok: true }> {
    const parsed = WorkspaceSpaceMembershipPlanResultSchema.parse(result);
    if (!parsed.ok) {
      throw spaceRefusal(parsed.code, spaceName, parsed.unreachableUserIds, parsed.blockedWorkstreamIds);
    }
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
