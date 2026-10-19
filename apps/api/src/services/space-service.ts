import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  type ContainerOrder,
  ContainerOrderSchema,
  type CreateSpaceRequest,
  DEFAULT_WORKSTREAM_ICON_KEY,
  MoveChannelBetweenSpacesResultSchema,
  type SpaceChannelPage,
  SpaceChannelPageSchema,
  type ActivityEvent,
  type ActivityFilter,
  type ActivityPage,
  type ChannelFeedPage,
  type ChannelStats,
  type ChannelStatsList,
  type MemoryForgetResponse,
  type MemoryReview,
  type MyThreadsPage,
  type PinKind,
  type PinList,
  type ArtifactPinList,
  type SpaceDefaultKind,
  type SpaceErrorCode,
  type SpaceId,
  SpaceRefusalDetailsSchema,
  type SpaceSummary,
  SpaceSummarySchema,
  type UpdateSpaceAudienceRequest,
  type UpdateSpacePresentationRequest,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceActivityResultSchema,
  WorkspaceChannelFeedResultSchema,
  WorkspaceChannelMessageRemoveResultSchema,
  WorkspaceChannelStatsResultSchema,
  WorkspaceSpaceReadResultSchema,
  WorkspaceMyThreadsResultSchema,
  WorkspacePinResultSchema,
  type WorkspacePinResult,
  WorkspaceArtifactPinResultSchema,
  type WorkspaceArtifactPinResult,
  WorkspaceSpaceChannelPageResultSchema,
  WorkspaceSpaceDefaultResultSchema,
  WorkspaceContainerOrderResultSchema,
  WorkspacePinnedOrderResultSchema,
  WorkspaceSpaceGeneralOpenResultSchema,
  WorkspaceSpaceMembershipMoveOutcomeSchema,
  WorkspaceSpaceMutationResultSchema,
  WorkspaceSpaceReserveResultSchema,
  WorkspaceSpaceChannelChangeResultSchema,
  WorkspaceSpaceIntentResumeResultSchema,
  type SpaceActorAuth,
  type ParsedSpaceChannelRefusal,
  type WorkspaceSpaceChannelChangeResult,
  type WorkspaceSpaceMutationResult,
} from "../durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { spaceAccessError } from "./channel-access-service";
import { forgetReviewedMemory, readMemoryReview } from "./memory-review-service";
import type { MemoryReviewScope } from "../durable-objects/workspace-memory-facts-protocol";
import { pendingInvitees } from "./workspace-service";
import { ResourceService } from "./resource-service";
import { chooseSpaceIcon } from "./workstream-naming-service";
import { claimParentAnchor } from "./workstream-runtime-database";

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
  const subject = spaceName.trim().length > 0 ? `“${spaceName.trim()}”` : "this channel";
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
      return new ApiError(404, code, "Channel not found");
    case "space_protected":
      return new ApiError(409, code, "This channel cannot be archived and its audience cannot be changed");
    case "space_membership_final":
      return new ApiError(409, code,
        `A thread in ${subject} belongs to no other channel, so it would have no home`, details);
    case "space_audience_incompatible":
      return new ApiError(409, code,
        `Leaving ${subject} would leave ${unreachable.length || "some"} of its readers unable to find the thread in any channel they can see`,
        details);
    case "space_membership_content_fence":
      return new ApiError(409, code,
        "A thread holds retained content this audience cannot view");
    case "space_default_audience_mismatch":
      return new ApiError(409, code,
        `Everyone who can read a thread in ${subject} must be able to use this`);
    case "space_revision_conflict":
      return new ApiError(409, code, "The channel changed while this was being applied; try again");
    case "space_bootstrap_pending":
      return new ApiError(409, code, "This Organization is still being prepared");
    case "channel_scope_locked_by_space":
      return new ApiError(409, code,
        `A thread in ${subject} is public through an Organization-wide channel, so its own audience cannot narrow`);
    case "space_conversation_unreachable":
      return new ApiError(409, code,
        `A thread in ${subject} could not be asked whether this audience may read it`);
    case "space_authority_unreachable":
      // 503 rather than 500: nothing about the request is wrong, the Space's
      // own authority did not answer, and retrying is the whole of what the
      // caller can do about it.
      return new ApiError(503, code, `${subject} could not be reached; try again`);
    case "space_audience_self_excluded":
      return new ApiError(409, code,
        `Making ${subject} private without you in it would leave you unable to change it back`);
    case "space_cursor_invalid":
      return new ApiError(400, code, "That page cursor is not one this channel issued");
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
 * WorkspaceDO owns what the Space *is* (its name, appearance, participants and
 * defaults) and which Channels it holds; each Channel owns its own audience.
 * A Space grants no reader, so nothing here or in WorkspaceDO writes a
 * Channel's audience, and every Space change is one WorkspaceDO transaction.
 */
/** A Channel's own feed is the conversation its review is scoped to. */
function channelMemoryScope(spaceId: SpaceId): MemoryReviewScope {
  return { kind: "conversation", conversation: { parentKind: "space", parentId: spaceId, substreamId: "0" } };
}

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

  /** This person's order for All's Pinned section, answered with what was stored. */
  async reorderAllPinned(itemIds: string[]): Promise<string[]> {
    const result = WorkspacePinnedOrderResultSchema.parse(await (await this.workspace()).reorderAllPinned({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      itemIds,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.itemIds;
  }

  /** A Channel's feed: the threads this person may open, newest placement first. */
  async listFeed(spaceId: SpaceId, cursor: string | null): Promise<ChannelFeedPage> {
    const result = WorkspaceChannelFeedResultSchema.parse(await (await this.workspace()).listChannelFeed({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      cursor,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.page;
  }

  /**
   * What Rally remembers about this Channel, as this person may see it.
   * `WorkspaceDO` checks the Channel is listed to them in the same read, as
   * the feed does; removing takes an administrator.
   */
  getChannelMemory(spaceId: SpaceId): Promise<MemoryReview> {
    return readMemoryReview(this.env, this.auth, channelMemoryScope(spaceId));
  }

  forgetChannelMemory(spaceId: SpaceId, factId: string): Promise<MemoryForgetResponse> {
    return forgetReviewedMemory(this.env, this.auth, channelMemoryScope(spaceId), factId);
  }

  /**
   * Remove one Channel message, a merge's **Remove**: the author's own, or any
   * for an Organization owner or admin. The attachments a merge made stay.
   */
  async removeMessage(spaceId: SpaceId, messageId: string): Promise<void> {
    const result = WorkspaceChannelMessageRemoveResultSchema.parse(await (await this.workspace()).removeChannelMessage({
      auth: this.actor(), spaceId, messageId,
    }));
    if (result.ok) return;
    if (result.code === "channel_message_not_found") {
      throw new ApiError(404, result.code, "That message is no longer in this channel");
    }
    throw spaceRefusal(result.code, "");
  }

  /** The Threads tab: what this person takes part in or pinned, newest activity first. */
  async listMyThreads(cursor: string | null): Promise<MyThreadsPage> {
    const result = WorkspaceMyThreadsResultSchema.parse(await (await this.workspace()).listMyThreads({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      cursor,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.page;
  }

  /** The Activity tab, newest first. */
  async listActivity(cursor: string | null, only: ActivityFilter | null = null): Promise<ActivityPage> {
    const result = WorkspaceActivityResultSchema.parse(await (await this.workspace()).listActivity({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      cursor,
      only,
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.page;
  }

  /** A support session reads Activity without moving the person's position (`docs/impersonation.md`). */
  async markActivitySeen(seenThrough: number): Promise<void> {
    if (this.auth.impersonatorUserId) return;
    await (await this.workspace()).markActivitySeen({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      seenThrough,
    });
  }

  /** What the person did that settles Activity rows; a support session settles nothing. */
  async recordActivityEvents(events: readonly ActivityEvent[]): Promise<void> {
    if (this.auth.impersonatorUserId) return;
    await (await this.workspace()).recordActivityEvents({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      events: [...events],
    });
  }

  /** The Channels tab's thread counts and last activity. */
  async listChannelStats(): Promise<ChannelStatsList> {
    const result = WorkspaceChannelStatsResultSchema.parse(await (await this.workspace()).listChannelStats({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    }));
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.stats;
  }

  /**
   * Acknowledge a Channel read through a placement, answered with the
   * person's `ChannelStats` row for it. A support session reads without moving
   * the person's position (`docs/impersonation.md`), as a thread's
   * acknowledgement does.
   */
  async acknowledgeRead(
    spaceId: SpaceId,
    input: { readThroughSequenceNumber: number },
  ): Promise<ChannelStats> {
    if (this.auth.impersonatorUserId) return this.currentChannelStats(spaceId);
    return this.channelReadAnswer(await (await this.workspace()).acknowledgeSpaceRead({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      readThroughSequenceNumber: input.readThroughSequenceNumber,
    }));
  }

  private channelReadAnswer(result: unknown): ChannelStats {
    const parsed = WorkspaceSpaceReadResultSchema.parse(result);
    if (!parsed.ok) throw spaceRefusal(parsed.code, "");
    return parsed.stats;
  }

  private async currentChannelStats(spaceId: SpaceId): Promise<ChannelStats> {
    const stats = (await this.listChannelStats()).find((row) => row.channelId === spaceId);
    if (!stats) throw spaceRefusal("space_not_found", "");
    return stats;
  }

  async listPins(): Promise<PinList> {
    return this.pins(await (await this.workspace()).listPins({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    }));
  }

  async changePin(kind: PinKind, itemId: string, parentId: WorkstreamId | null, pinned: boolean): Promise<PinList> {
    return this.pins(await (await this.workspace()).changePin({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      kind,
      itemId,
      parentId,
      pinned,
    }));
  }

  async reorderPins(kind: PinKind, ids: string[]): Promise<PinList> {
    return this.pins(await (await this.workspace()).reorderPins({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      kind,
      ids,
    }));
  }

  private pins(result: WorkspacePinResult): PinList {
    const parsed = WorkspacePinResultSchema.parse(result);
    if (parsed.ok) return parsed.pins;
    return this.refusePinCode(parsed.code);
  }

  private refusePinCode(code: "pin_target_not_found" | "pin_limit_reached"): never {
    if (code === "pin_limit_reached") {
      return this.refusePin(409, code, "You have pinned as many items as Rally allows");
    }
    return this.refusePin(404, code, "Nothing you can see has that id");
  }

  async listArtifactPins(): Promise<ArtifactPinList> {
    return this.artifactPins(await (await this.workspace()).listArtifactPins({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    }));
  }

  async changeArtifactPin(itemId: string, threadId: WorkstreamId | null, pinned: boolean): Promise<ArtifactPinList> {
    return this.artifactPins(await (await this.workspace()).changeArtifactPin({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      itemId,
      threadId,
      pinned,
    }));
  }

  async reorderArtifactPins(ids: string[]): Promise<ArtifactPinList> {
    return this.artifactPins(await (await this.workspace()).reorderArtifactPins({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      ids,
    }));
  }

  private artifactPins(result: WorkspaceArtifactPinResult): ArtifactPinList {
    const parsed = WorkspaceArtifactPinResultSchema.parse(result);
    if (parsed.ok) return parsed.artifactPins;
    if (parsed.code === "space_access_denied") throw spaceRefusal(parsed.code, "");
    return this.refusePinCode(parsed.code);
  }

  private refusePin(status: 404 | 409, code: string, message: string): never {
    throw new ApiError(status, code, message);
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
   * Create a Space: ask whether this person may, anchor it, then reserve it
   * with its parent.
   *
   * The permission is asked first, because the step before the reservation
   * writes outside WorkspaceDO: the id is minted here (or is the caller's
   * stable creation id) so the D1 anchor and authority route a Channel's
   * creation writes, under `parentKind: "space"`, can claim the id before the
   * Space is listed. WorkspaceDO then writes the Space and its hosted parent in
   * one transaction, and that is the whole Space: nothing outside WorkspaceDO
   * holds any of it.
   *
   * A request with no icon is reserved under the catalog's neutral mark and
   * handed to {@link chooseIcon}, off the caller's clock when `defer` is given.
   */
  async create(
    input: CreateSpaceRequest,
    spaceId?: SpaceId,
    defer?: (work: Promise<void>) => void,
  ): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    const actor = { workspaceId: asWorkspaceId(this.auth.workspaceId), userId: asUserId(this.auth.userId) };
    const admitted = await workspace.admitSpaceCreation(actor);
    if (!admitted.ok) throw spaceRefusal(admitted.code, input.name);
    const id = spaceId ?? asSpaceId(uuidV7());
    await this.throughSpaceAuthority(id, input.name, "provision", () =>
      claimParentAnchor(this.env, this.auth.workspaceId, id, "space"));
    const reservation = WorkspaceSpaceReserveResultSchema.parse(await workspace.reserveSpace({
      ...actor,
      space: { ...input, iconKey: input.iconKey ?? DEFAULT_WORKSTREAM_ICON_KEY },
      spaceId: id,
    }));
    if (!reservation.ok) throw spaceRefusal(reservation.code, input.name, reservation.unreachableUserIds, reservation.blockedWorkstreamIds);
    const reserved = reservation.space;
    // A replay that let Rally choose the icon cannot compare it: the first
    // attempt's pass may already have written one.
    if (spaceId && (reserved.name !== input.name.trim() || reserved.scope !== input.scope
      || (input.iconKey !== undefined && reserved.iconKey !== input.iconKey)
      || reserved.colorKey !== input.colorKey || reserved.reach === "through_channel")) {
      throw new ApiError(409, "space_revision_conflict", "The creation identity already names a different channel");
    }
    if (input.iconKey === undefined && reservation.created) {
      const choosing = this.chooseIcon(reserved);
      if (defer) defer(choosing); else await choosing;
    }
    return reserved;
  }

  /**
   * Give a Space created without an icon one chosen from its name. Never
   * rejects; see `docs/spaces.md#the-icon-rally-chooses`.
   */
  private async chooseIcon(space: SpaceSummary): Promise<void> {
    const fields = { workspace_id: this.auth.workspaceId, space_id: space.id };
    try {
      const iconKey = await chooseSpaceIcon(this.env, {
        workspaceId: this.auth.workspaceId,
        spaceId: space.id,
        name: space.name,
        userId: this.auth.userId,
      });
      if (iconKey === null || iconKey === space.iconKey) return;
      const result = await (await this.workspace()).noteSpacePresentation({
        workspaceId: asWorkspaceId(this.auth.workspaceId),
        userId: asUserId(this.auth.userId),
        spaceId: space.id,
        presentation: { name: space.name, iconKey, colorKey: space.colorKey },
        ifRevision: space.revision,
      });
      logInfo(this.env, "space_icon_chosen", {
        ...fields,
        icon: iconKey,
        outcome: result.ok ? "written" : result.code,
      });
    } catch (error) {
      logWarn(this.env, "space_icon_failed", {
        ...fields,
        error_code: diagnosticErrorCode(error, "space_icon_write_failed"),
      });
    }
  }

  /**
   * The Organization's General Space, opened if this caller is the first.
   *
   * `create`'s steps under one idempotent front door. The first call only asks
   * whether General exists, which is the whole cost for every caller after the
   * Organization's first. When it does not, the D1 anchor is written under a
   * fresh id and General is created with its parent in one WorkspaceDO
   * transaction; the unique partial index still decides a race, and the loser
   * is answered with the Space the winner made. The loser's anchor names an id
   * nothing else ever will.
   *
   * Reached by the cutover and by a Channel creation that names no Space in
   * an Organization without General, which is why it is here rather than
   * inside either.
   */
  async ensureGeneral(): Promise<SpaceSummary> {
    const existing = WorkspaceSpaceGeneralOpenResultSchema.parse(await (await this.workspace()).openGeneralSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    }));
    if (!existing.ok) throw spaceRefusal(existing.code, "General");
    return "absent" in existing ? this.openGeneral() : existing.space;
  }

  /** The Organization's General as this caller sees it, or `null` while it has none. Writes nothing. */
  async general(): Promise<SpaceSummary | null> {
    const result = await (await this.workspace()).readGeneralSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    });
    if (!result.ok) throw spaceRefusal(result.code, "General");
    return result.space === null ? null : SpaceSummarySchema.parse(result.space);
  }

  private async openGeneral(): Promise<SpaceSummary> {
    const workspace = await this.workspace();
    const actor = {
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
    };
    const id = asSpaceId(uuidV7());
    await this.throughSpaceAuthority(id, "General", "provision", () =>
      claimParentAnchor(this.env, this.auth.workspaceId, id, "space"));
    const result = WorkspaceSpaceGeneralOpenResultSchema.parse(await workspace.openGeneralSpace({ ...actor, spaceId: id }));
    if (!result.ok) throw spaceRefusal(result.code, "General");
    if ("absent" in result) throw new Error("space_general_open_absent");
    return result.space;
  }

  /** A Space's name and appearance: one WorkspaceDO write. */
  async updatePresentation(spaceId: SpaceId, input: UpdateSpacePresentationRequest): Promise<SpaceSummary> {
    const current = await this.editable(spaceId);
    return this.settled(await (await this.workspace()).noteSpacePresentation({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      presentation: input,
    }), current.name);
  }

  /**
   * Change a Space's scope and participants: one WorkspaceDO write. `null`
   * when the caller left a private Space, which then has no summary for them.
   *
   * A Space grants no reader to the threads in it, so making one private or
   * Organization-wide changes who may list the Space and nothing else: there
   * is nothing to preflight and no member thread to reach.
   */
  async updateAudience(spaceId: SpaceId, input: UpdateSpaceAudienceRequest): Promise<SpaceSummary | null> {
    const current = await this.editable(spaceId);
    const currentParticipants = new Set<string>(current.participants.map((participant) => participant.userId));
    const requested = new Set<string>(input.participantUserIds);
    const removed = [...currentParticipants].filter((userId) => !requested.has(userId));
    const administrator = this.auth.role === "owner" || this.auth.role === "admin";
    if (removed.some((userId) => userId !== this.auth.userId) && !administrator) {
      throw new ApiError(403, "participant_removal_denied",
        "Only an Organization owner or admin can remove another channel participant");
    }
    if (input.inviteeEmails !== undefined) {
      // An invitee is a participant who has not joined, under the same rule:
      // anybody may add one, and only an administrator takes one out.
      const pending = new Set((await pendingInvitees(this.env.DB, this.auth.workspaceId)).map((invitee) => invitee.email));
      const unknown = input.inviteeEmails.filter((email) => !pending.has(email));
      if (unknown.length > 0) {
        throw new ApiError(422, "space_invitee_not_invited",
          "Only people with a pending invitation to the organization can be added by address");
      }
      if (!administrator) {
        const requestedInvitees = new Set(input.inviteeEmails);
        if ((await this.invitees(spaceId)).some((email) => !requestedInvitees.has(email))) {
          throw new ApiError(403, "participant_removal_denied",
            "Only an Organization owner or admin can remove another channel participant");
        }
      }
    }
    const result = await (await this.workspace()).noteSpaceAudience({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      audience: input,
    });
    // The caller took themselves out of a private Space: written, and no
    // longer theirs to be shown.
    if ("left" in result) return null;
    return this.settled(result, current.name);
  }

  /** The addresses of Organization invitees a Space lists, to whoever may edit it. */
  async invitees(spaceId: SpaceId): Promise<string[]> {
    const result = await (await this.workspace()).listSpaceInvitees({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
    });
    if (!result.ok) throw spaceRefusal(result.code, "");
    return result.emails;
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

  /** Archive a Space once no live member Channel would be stranded by it: one WorkspaceDO write. */
  async archive(spaceId: SpaceId): Promise<SpaceSummary> {
    return this.settled(await (await this.workspace()).archiveSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
    }), "");
  }

  /** Bring an archived Space back with the memberships its archive took out: one WorkspaceDO write. */
  async restore(spaceId: SpaceId): Promise<SpaceSummary> {
    return this.settled(await (await this.workspace()).restoreSpace({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
    }), "");
  }

  /**
   * Add a resource or a Sidekick every member Channel inherits.
   *
   * One WorkspaceDO call records the default and stages and fences its
   * delivery; for a Sidekick it also writes the recommendation a Channel
   * created in the Space reads from the Space's hosted parent, authorized from
   * the Space rows like every other Space write. The audience preflight runs
   * first: the full
   * effective audience of every member Channel has to fit inside what the
   * resource or Sidekick admits, and a default that fails that test must not be
   * published at all.
   */
  async addDefault(spaceId: SpaceId, kind: SpaceDefaultKind, targetId: string): Promise<SpaceSummary> {
    const space = await this.editable(spaceId);
    if (kind === "resource") {
      await new ResourceService(this.env, this.auth).getAttachable(targetId);
      await this.assertResourceAudience(space, targetId);
    }
    // A Sidekick default must be an Organization Sidekick: a personal one
    // would be offered in every member Channel and runnable by nobody but its
    // author. The write checks that from the directory in the same call.
    const result = WorkspaceSpaceDefaultResultSchema.parse(await (await this.workspace()).addSpaceDefault({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      kind,
      targetId,
    }).catch((error: unknown) => {
      if (error instanceof Error && error.message === "sidekick_not_found") {
        throw new ApiError(404, "sidekick_not_found", "Sidekick not found");
      }
      if (error instanceof Error && error.message === "sidekick_attachment_scope_invalid") {
        throw new ApiError(422, "sidekick_attachment_scope_invalid", "Choose an Organization Sidekick");
      }
      throw error;
    }));
    if (!result.ok) {
      throw spaceRefusal(result.code, space.name, result.unreachableUserIds, result.blockedWorkstreamIds);
    }
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
    const space = await this.editable(spaceId);
    return this.settled(await (await this.workspace()).removeSpaceDefault({
      workspaceId: asWorkspaceId(this.auth.workspaceId),
      userId: asUserId(this.auth.userId),
      spaceId,
      kind,
      targetId,
    }), space.name);
  }

  /**
   * Finish a staged operation whose request never came back, for a
   * `space_intent_resume` message already on the Queue.
   *
   * Only intents staged before migration 94 exist; WorkspaceDO finishes each
   * in one transaction (`resumeLegacyIntent`).
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
   * One piece of work against the Space's *own* authority, with its failure
   * named.
   *
   * The D1 anchor at creation is the one Space step outside WorkspaceDO, and
   * a rejection there that is not its own refusal arrives as a bare `Error`
   * with no code on it. Every one of those used to arrive at the route as
   * `internal_error` — the same word the Worker uses for every unhandled
   * failure it has — so a Space whose authority could not answer was
   * indistinguishable in a log from a bug in the route beside it.
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

  private workspace() {
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, this.auth.workspaceId),
    );
  }
}
