import { RegionSchema } from "@rally/contracts/regions";
import {
  ContainerOrderSchema,
  PinnedOrderSchema,
  ConversationParentReserveChildRequestSchema,
  CreateSpaceRequestSchema,
  IdSchema,
  ScopeSchema,
  ActivityEventSchema,
  ActivityFilterSchema,
  ActivityItemSchema,
  ActivityPageSchema,
  ChannelFeedPageSchema,
  ConversationMergeChannelSchema,
  MergeEmbedSchema,
  MESSAGE_MAX_CHARACTERS,
  ChannelStatsListSchema,
  ChannelStatsSchema,
  MyThreadsPageSchema,
  PinKindSchema,
  PinListSchema,
  ArtifactPinListSchema,
  SpaceChannelPageSchema,
  SpaceErrorCodeSchema,
  SpaceIconKeySchema,
  SpaceIdSchema,
  asSpaceId,
  type SpaceId,
  SpaceColorKeySchema,
  SpaceDefaultKindSchema,
  SpaceRequestScopeSchema,
  AudienceScopeSchema,
  SpaceSummarySchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { z } from "zod";
import { stableUuid } from "../lib/stable-uuid";
import { ExternalBindingClaimSchema } from "./workspace-external-binding-protocol";

/**
 * The wire contract for the Organization's Space authority.
 *
 * Shaped after `workspace-project-protocol.ts`, because the questions are the
 * same ones: who is asking, which Space, and which fence was this work staged
 * on. What is deliberately different is the failure channel. A Project RPC
 * answers with three codes of its own; a Space answers with `SpaceErrorCode`,
 * the one closed union `packages/contracts/src/spaces.ts` declares, so the
 * refusal a route renders and the refusal a Queue consumer logs are the same
 * word (`docs/naming-a-schema-failure.md`).
 *
 * Every mutating result is `{ ok }` plus a code rather than a throw: a Durable
 * Object RPC reduces a `ZodError` to a bare `Error` with no issues and no
 * message, so a refusal that has to be branched on cannot travel as one.
 */

const SpaceActorSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
});

const SpaceFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: SpaceErrorCodeSchema,
});

export const WorkspaceSpaceListRequestSchema = SpaceActorSchema;
export type WorkspaceSpaceListRequest = z.infer<typeof WorkspaceSpaceListRequestSchema>;

/**
 * `openGeneralSpace`. With a `spaceId` (whose D1 anchor the caller has already
 * written) General is created under it together with its hosted parent in one
 * transaction; without one the call only answers whether General exists.
 */
export const WorkspaceSpaceGeneralRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema.optional(),
}).strict();
export type WorkspaceSpaceGeneralRequest = z.infer<typeof WorkspaceSpaceGeneralRequestSchema>;

/**
 * `initializeWorkspace`'s General Space for a new Organization: the person
 * creating it, the id whose D1 anchor the caller has written, and the
 * authority generation it wrote that anchor at. `personalSpaceId` is the
 * creator's Personal Channel, anchored in the same batch; optional so a
 * Worker that predates it still opens General.
 */
export const WorkspaceGeneralOpeningSchema = z.strictObject({
  creatorUserId: UserIdSchema,
  spaceId: SpaceIdSchema,
  personalSpaceId: SpaceIdSchema.optional(),
  authorityGeneration: z.number().int().positive(),
});
export type WorkspaceGeneralOpening = z.infer<typeof WorkspaceGeneralOpeningSchema>;

export const WorkspaceSpaceReserveRequestSchema = SpaceActorSchema.extend({
  /** Always with an icon: the service stands one in when the person chose none. */
  space: CreateSpaceRequestSchema.extend({ iconKey: SpaceIconKeySchema }),
  /**
   * The creation identity. `SpaceService` always names one, because the D1
   * anchor is written under it before this call; absent only for a caller
   * that lets the Organization allocate it.
   */
  spaceId: SpaceIdSchema.optional(),
}).strict();
export type WorkspaceSpaceReserveRequest = z.infer<typeof WorkspaceSpaceReserveRequestSchema>;

/**
 * `seatOrganizationMember`: put a member who just became active in General and
 * give them their Personal Channel. Without `authorityGeneration` it only
 * answers whether the Personal Channel still needs its D1 anchor; with it (the
 * caller has written that anchor) the Personal Channel is created.
 */
export const WorkspaceSeatMemberRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  personalSpaceId: SpaceIdSchema,
  authorityGeneration: z.number().int().positive().optional(),
});
export type WorkspaceSeatMemberRequest = z.infer<typeof WorkspaceSeatMemberRequestSchema>;

/**
 * The id a member's Personal Channel is created under: derived, so every
 * attempt for the same person (organization creation, a redelivered
 * relationship change, the backfill, a retry) names the same Space and
 * anchors it once.
 */
export async function personalSpaceIdFor(workspaceId: string, userId: string): Promise<SpaceId> {
  return asSpaceId(await stableUuid(["personal_channel", workspaceId, userId]));
}

/**
 * `seated: false`, with nothing written, for somebody who is not an active
 * non-guest member (`not_member`: final, a guest gets neither, because General
 * is Organization-wide discovery a guest does not have) or an Organization
 * whose Spaces are not open (`spaces_not_open`: the object seats every member
 * when they open, so the caller need not retry).
 */
export const WorkspaceSeatMemberResultSchema = z.union([
  z.strictObject({ seated: z.literal(false), reason: z.enum(["not_member", "spaces_not_open"]) }),
  z.strictObject({ seated: z.literal(true), personalSpace: z.enum(["present", "absent"]) }),
]);
export type WorkspaceSeatMemberResult = z.infer<typeof WorkspaceSeatMemberResultSchema>;

export const WorkspaceSpaceRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
}).strict();
export type WorkspaceSpaceRequest = z.infer<typeof WorkspaceSpaceRequestSchema>;

/**
 * One person's order for one container: the Organization's Spaces, a Space's
 * Channels, or a Channel's Breakouts.
 *
 * One request for all three, because the authority's job is the same for each —
 * check who is asking, keep the items that belong in that container, write the
 * positions. The kind decides only which of those middle rules runs, and that
 * decision lives in `WorkspaceSpaceStorage.writeOrder` rather than in three
 * request shapes that would each have to be authorized separately.
 */
export const WorkspaceContainerOrderRequestSchema = SpaceActorSchema.extend({
  order: ContainerOrderSchema,
}).strict();
export type WorkspaceContainerOrderRequest = z.infer<typeof WorkspaceContainerOrderRequestSchema>;

/**
 * What was actually stored, which is not always what was asked for: the
 * Organization's list keeps the Spaces this viewer can see, a Space's list
 * keeps the Channels actually placed there. The caller is answered with the
 * stored list rather than an acknowledgement so a client can see what it lost.
 */
export const WorkspaceContainerOrderResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), order: ContainerOrderSchema }),
  SpaceFailureSchema,
]);
export type WorkspaceContainerOrderResult = z.infer<typeof WorkspaceContainerOrderResultSchema>;

/** One person's order for All's Pinned section; see `PinnedOrderSchema`. */
export const WorkspacePinnedOrderRequestSchema = SpaceActorSchema.extend({
  itemIds: PinnedOrderSchema,
}).strict();
export type WorkspacePinnedOrderRequest = z.infer<typeof WorkspacePinnedOrderRequestSchema>;

/** What was stored: the Channels this person can list, each once. */
export const WorkspacePinnedOrderResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), itemIds: PinnedOrderSchema }),
  SpaceFailureSchema,
]);
export type WorkspacePinnedOrderResult = z.infer<typeof WorkspacePinnedOrderResultSchema>;

/**
 * The presentation a Space's own authority has just accepted.
 *
 * WorkspaceDO applies it synchronously so the mutation can answer with the
 * Space as it now is. The Space's `directory_common` projection carries the
 * same change and lands a moment later at a higher source version, which is
 * what makes this provisional rather than authoritative — the fence below
 * treats a real projection as newer than anything written here.
 */
export const WorkspaceSpacePresentationRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  presentation: z.strictObject({
    name: z.string().trim().min(1),
    iconKey: SpaceIconKeySchema,
    colorKey: SpaceColorKeySchema,
  }),
  /**
   * Write only if the Space is still at this revision. Set by the icon Rally
   * chooses after creation, so it never lands over anything a person changed.
   */
  ifRevision: z.number().int().positive().optional(),
}).strict();
export type WorkspaceSpacePresentationRequest = z.infer<typeof WorkspaceSpacePresentationRequestSchema>;

/** A Space's scope and participants. */
export const WorkspaceSpaceAudienceNoteRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  audience: z.strictObject({
    scope: SpaceRequestScopeSchema,
    participantUserIds: z.array(UserIdSchema).min(1),
    /** Pending Organization invitees, the whole set; absent leaves them as stored. */
    inviteeEmails: z.array(z.string().email()).optional(),
  }),
}).strict();
export type WorkspaceSpaceAudienceNoteRequest = z.infer<typeof WorkspaceSpaceAudienceNoteRequestSchema>;

export const WorkspaceSpaceInviteesRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
}).strict();
export type WorkspaceSpaceInviteesRequest = z.infer<typeof WorkspaceSpaceInviteesRequestSchema>;

/** Someone who just accepted an Organization invitation, by the address it was sent to. */
export const WorkspaceSpaceSeatInviteeRequestSchema = SpaceActorSchema.extend({
  email: z.string().email(),
}).strict();
export type WorkspaceSpaceSeatInviteeRequest = z.infer<typeof WorkspaceSpaceSeatInviteeRequestSchema>;

export const WorkspaceSpaceMembershipRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  workstreamId: WorkstreamIdSchema,
}).strict();
export type WorkspaceSpaceMembershipRequest = z.infer<typeof WorkspaceSpaceMembershipRequestSchema>;

export const WorkspaceSpaceMembershipSettleRequestSchema = WorkspaceSpaceMembershipRequestSchema.extend({
  spaceRevision: z.number().int().positive(),
  membershipGeneration: z.number().int().positive(),
}).strict();
export type WorkspaceSpaceMembershipSettleRequest = z.infer<typeof WorkspaceSpaceMembershipSettleRequestSchema>;

export const WorkspaceSpaceMembershipRemovalRequestSchema = WorkspaceSpaceMembershipRequestSchema;
export type WorkspaceSpaceMembershipRemovalRequest = z.infer<typeof WorkspaceSpaceMembershipRemovalRequestSchema>;

/** One server-side transfer between two Spaces owned by this WorkspaceDO. */
export const WorkspaceSpaceMembershipMoveRequestSchema = SpaceActorSchema.extend({
  sourceSpaceId: SpaceIdSchema,
  targetSpaceId: SpaceIdSchema,
  workstreamId: WorkstreamIdSchema,
}).strict();
export type WorkspaceSpaceMembershipMoveRequest = z.infer<typeof WorkspaceSpaceMembershipMoveRequestSchema>;

/**
 * A refusal with legacy reader details and actionable Channel ids.
 *
 * `unreachableUserIds` remains on the stable RPC result shape during cutover;
 * associative ancestor visibility means current membership paths leave it empty.
 *
 * `blockedWorkstreamIds` are read out of storage, and are therefore narrowed to
 * the Channels this caller may already list. An archive is refused because of a
 * Channel, and the caller was acting on the Space; without the ids the only
 * thing a confirmation can say is that *some* Channel has to move first.
 */
export const WorkspaceSpaceAudienceFailureSchema = z.strictObject({
  ok: z.literal(false),
  code: SpaceErrorCodeSchema,
  unreachableUserIds: z.array(UserIdSchema).default([]),
  blockedWorkstreamIds: z.array(WorkstreamIdSchema).default([]),
});

export const WorkspaceSpaceMembershipPlanSchema = z.strictObject({
  ok: z.literal(true),
  space: SpaceSummarySchema,
  membershipGeneration: z.number().int().positive(),
});
export const WorkspaceSpaceMembershipPlanResultSchema = z.union([
  WorkspaceSpaceMembershipPlanSchema,
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMembershipPlanResult = z.infer<typeof WorkspaceSpaceMembershipPlanResultSchema>;

/**
 * A new Channel's whole Organization-side birth, in one call.
 *
 * Every row a creation needs from this object is in this object's database:
 * the memberships, the Space defaults a new member inherits, the Channel's
 * parent row and provisional directory row, and the record of which Space
 * supplied which reader. They commit in one transaction, so a Channel is never
 * listed outside a Space and a refused Space leaves nothing behind.
 *
 * Empty `spaceIds` means General. `requestedScope` and
 * `requestedParticipantUserIds` are what the caller asked for; the scope the
 * directory row carries is derived from them and the Spaces, by the same pure
 * function the coordinator opens the conversation with.
 */
export const WorkspaceChannelReservationRequestSchema = SpaceActorSchema.extend({
  workstreamId: WorkstreamIdSchema,
  spaceIds: z.array(SpaceIdSchema),
  requestedScope: ScopeSchema,
  requestedParticipantUserIds: z.array(UserIdSchema),
  /** A person started it from a Channel; see `resolveSpaceWorkstreamStart`. */
  narrowInPrivateSpaces: z.boolean().optional(),
  authorityGeneration: z.number().int().positive(),
  directory: ConversationParentReserveChildRequestSchema.shape.directory.unwrap().omit({
    scope: true,
    systemKind: true,
    appearance: true,
  }),
  /**
   * The external thread this Channel is being born for. Claimed `pending` in
   * the reservation's own transaction, so the Channel's birth, its placement
   * and its thread binding commit together; the coordinator activates it when
   * the creation receipt completes. See docs/external-conversation-bindings.md.
   */
  externalBinding: ExternalBindingClaimSchema.optional(),
  /**
   * A conversation import's reservation, whose Channel opens only when the
   * import completes. Watched in this same transaction, and archived if it
   * has not opened in time; see `import-reservation-reclaim.ts`.
   */
  reclaimUnopened: z.literal(true).optional(),
  /**
   * Who the Channel's parent row names as its creator, when that is not the
   * member acting on the Spaces: a connector ingress placing a Channel for a
   * provider sender with no Rally identity acts as the member who linked the
   * room, and the Channel stays ownerless (`null`) or attributed to whoever
   * the sender resolved to. Absent means the actor.
   */
  createdByUserId: UserIdSchema.nullable().optional(),
}).strict();
export type WorkspaceChannelReservationRequest = z.infer<typeof WorkspaceChannelReservationRequestSchema>;

export const WorkspaceChannelReservationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reserved"),
    authorityGeneration: z.number().int().positive(),
    /** Each Space the Channel is now in, as the transaction read it. */
    spaces: z.array(SpaceSummarySchema).min(1),
    /**
     * The colour the thread is born with: its canonical Channel's, read by
     * `channelColor` in the same transaction. The caller writes it into Main
     * so the thread never shows a colour derived from its id first. Optional
     * for an answer from an object deployed before it.
     */
    color: SpaceColorKeySchema.nullable().optional(),
  }),
  /**
   * The request named no Space and this Organization has no General yet.
   * Making one provisions its own conversation, which is not a write this
   * object can take in a transaction, so the caller makes it and asks again.
   */
  z.strictObject({ status: z.literal("general_missing") }),
  z.strictObject({
    status: z.literal("refused"),
    code: SpaceErrorCodeSchema,
    /** The Space refused, or null when the refusal is the caller's own membership. */
    spaceId: SpaceIdSchema.nullable(),
  }),
  /**
   * The external thread the request named is already bound, or another live
   * attempt is creating its Channel. Nothing was written.
   */
  z.strictObject({ status: z.literal("binding_refused"), outcome: z.enum(["held", "bound"]) }),
]);
export type WorkspaceChannelReservationResult = z.infer<typeof WorkspaceChannelReservationResultSchema>;

/**
 * `moveSpaceMembership`: an equal-audience move committed in one WorkspaceDO
 * transaction, or `moved: false` when the caller has to take the add-then-remove
 * path because the audiences differ or the Channel's recorded provenance does
 * not match the Spaces as they are now. Nothing is written in that case.
 */
export const WorkspaceSpaceMembershipMoveOutcomeSchema = z.union([
  z.strictObject({ ok: z.literal(true), moved: z.literal(false) }),
  z.strictObject({
    ok: z.literal(true),
    moved: z.literal(true),
    source: SpaceSummarySchema,
    target: SpaceSummarySchema,
  }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMembershipMoveOutcome = z.infer<typeof WorkspaceSpaceMembershipMoveOutcomeSchema>;

export const WorkspaceSpaceMutationResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMutationResult = z.infer<typeof WorkspaceSpaceMutationResultSchema>;

/**
 * An audience change answers like any Space mutation, except that the actor
 * may take themselves out of a private Space, after which it has no summary
 * for them: `left` says the change was written all the same.
 */
export const WorkspaceSpaceAudienceResultSchema = z.union([
  WorkspaceSpaceMutationResultSchema,
  z.strictObject({ ok: z.literal(true), left: z.literal(true) }),
]);
export type WorkspaceSpaceAudienceResult = z.infer<typeof WorkspaceSpaceAudienceResultSchema>;

export const WorkspaceSpaceReserveResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema, created: z.boolean() }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceReserveResult = z.infer<typeof WorkspaceSpaceReserveResultSchema>;


export const WorkspaceSpaceChannelPageRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  cursor: z.string().min(1).max(200).nullable(),
}).strict();
export type WorkspaceSpaceChannelPageRequest = z.infer<typeof WorkspaceSpaceChannelPageRequestSchema>;

export const WorkspaceSpaceChannelPageResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), page: SpaceChannelPageSchema }),
  SpaceFailureSchema,
]);
export type WorkspaceSpaceChannelPageResult = z.infer<typeof WorkspaceSpaceChannelPageResultSchema>;

/** A Channel's feed: the threads placed in it. Same request as the conversation page. */
export const WorkspaceChannelFeedResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), page: ChannelFeedPageSchema }),
  SpaceFailureSchema,
]);
export type WorkspaceChannelFeedResult = z.infer<typeof WorkspaceChannelFeedResultSchema>;

/** The Threads tab: what one person takes part in. */
export const WorkspaceMyThreadsRequestSchema = SpaceActorSchema.extend({
  cursor: z.string().min(1).max(200).nullable(),
}).strict();
export type WorkspaceMyThreadsRequest = z.infer<typeof WorkspaceMyThreadsRequestSchema>;

export const WorkspaceMyThreadsResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), page: MyThreadsPageSchema }),
  SpaceFailureSchema,
]);
export type WorkspaceMyThreadsResult = z.infer<typeof WorkspaceMyThreadsResultSchema>;

/** The Activity tab: the Threads tab's request, narrowed by an optional filter. */
export const WorkspaceActivityRequestSchema = WorkspaceMyThreadsRequestSchema.extend({
  only: ActivityFilterSchema.nullable().default(null),
}).strict();
export type WorkspaceActivityRequest = z.input<typeof WorkspaceActivityRequestSchema>;

export const WorkspaceActivityResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), page: ActivityPageSchema }),
  SpaceFailureSchema,
]);
export type WorkspaceActivityResult = z.infer<typeof WorkspaceActivityResultSchema>;

/** One Activity row a push names, read back when the push is sent. */
export const WorkspaceActivityPushReadRequestSchema = SpaceActorSchema.extend({
  itemId: ActivityItemSchema.shape.id,
}).strict();
export type WorkspaceActivityPushReadRequest = z.infer<typeof WorkspaceActivityPushReadRequestSchema>;

export const WorkspaceActivityPushReadResultSchema = ActivityItemSchema.nullable();

export const WorkspaceActivitySeenRequestSchema = SpaceActorSchema.extend({
  seenThrough: z.number().int().nonnegative(),
}).strict();
export type WorkspaceActivitySeenRequest = z.infer<typeof WorkspaceActivitySeenRequestSchema>;

export const WorkspaceActivityEventsRequestSchema = SpaceActorSchema.extend({
  events: z.array(ActivityEventSchema).min(1),
}).strict();
export type WorkspaceActivityEventsRequest = z.infer<typeof WorkspaceActivityEventsRequestSchema>;

/** Pin or unpin one item. `parentId` is a breakout's thread and nothing else's. */
export const WorkspacePinChangeRequestSchema = SpaceActorSchema.extend({
  kind: PinKindSchema,
  itemId: IdSchema,
  parentId: WorkstreamIdSchema.nullable(),
  pinned: z.boolean(),
}).strict();
export type WorkspacePinChangeRequest = z.infer<typeof WorkspacePinChangeRequestSchema>;

export const WorkspacePinOrderRequestSchema = SpaceActorSchema.extend({
  kind: PinKindSchema,
  ids: z.array(IdSchema),
}).strict();
export type WorkspacePinOrderRequest = z.infer<typeof WorkspacePinOrderRequestSchema>;

/**
 * Every pin after the change, or why it was refused: `pin_target_not_found`
 * for an item this person may not list, `pin_limit_reached` at the limit the
 * old per-Space pins already had.
 */
export const WorkspacePinResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), pins: PinListSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["pin_target_not_found", "pin_limit_reached"]) }),
]);
export type WorkspacePinResult = z.infer<typeof WorkspacePinResultSchema>;

/**
 * Pin or unpin one artifact. `threadId` names the thread whose Main it was
 * generated in; an unpin needs none.
 */
export const WorkspaceArtifactPinChangeRequestSchema = SpaceActorSchema.extend({
  itemId: IdSchema,
  threadId: WorkstreamIdSchema.nullable(),
  pinned: z.boolean(),
}).strict();
export type WorkspaceArtifactPinChangeRequest = z.infer<typeof WorkspaceArtifactPinChangeRequestSchema>;

export const WorkspaceArtifactPinOrderRequestSchema = SpaceActorSchema.extend({
  ids: z.array(IdSchema),
}).strict();
export type WorkspaceArtifactPinOrderRequest = z.infer<typeof WorkspaceArtifactPinOrderRequestSchema>;

/** Every artifact pin after the change, or why it was refused, as `WorkspacePinResultSchema` says. */
export const WorkspaceArtifactPinResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), artifactPins: ArtifactPinListSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["pin_target_not_found", "pin_limit_reached", "space_access_denied"]) }),
]);
export type WorkspaceArtifactPinResult = z.infer<typeof WorkspaceArtifactPinResultSchema>;

export const WorkspaceChannelStatsResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), stats: ChannelStatsListSchema }),
  z.strictObject({ ok: z.literal(false), code: z.literal("space_access_denied") }),
]);
export type WorkspaceChannelStatsResult = z.infer<typeof WorkspaceChannelStatsResultSchema>;

/** Acknowledge one Channel (storage Space) read through a placement, for one viewer. */
export const WorkspaceSpaceReadRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  readThroughSequenceNumber: z.number().int().nonnegative(),
}).strict();
export type WorkspaceSpaceReadRequest = z.infer<typeof WorkspaceSpaceReadRequestSchema>;

/** The viewer's `ChannelStats` row after the change, or `space_not_found` for a Channel they cannot list. */
export const WorkspaceSpaceReadResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), stats: ChannelStatsSchema }),
  z.strictObject({ ok: z.literal(false), code: z.enum(["space_access_denied", "space_not_found"]) }),
]);
export type WorkspaceSpaceReadResult = z.infer<typeof WorkspaceSpaceReadResultSchema>;

export const WorkspaceChannelSpacesRequestSchema = SpaceActorSchema.extend({
  workstreamId: WorkstreamIdSchema,
}).strict();
export type WorkspaceChannelSpacesRequest = z.infer<typeof WorkspaceChannelSpacesRequestSchema>;

export const WorkspaceChannelSpacesResultSchema = z.strictObject({
  spaceIds: z.array(SpaceIdSchema),
});
export type WorkspaceChannelSpacesResult = z.infer<typeof WorkspaceChannelSpacesResultSchema>;

/** Server-side URL placement: the stable first active Space ID. */
export const WorkspaceCanonicalChannelSpaceRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
});
export type WorkspaceCanonicalChannelSpaceRequest = z.infer<typeof WorkspaceCanonicalChannelSpaceRequestSchema>;

export const WorkspaceCanonicalChannelSpaceResultSchema = z.strictObject({
  spaceId: SpaceIdSchema.nullable(),
});
export type WorkspaceCanonicalChannelSpaceResult = z.infer<typeof WorkspaceCanonicalChannelSpaceResultSchema>;

export const WorkspaceSpaceDefaultRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  kind: SpaceDefaultKindSchema,
  targetId: IdSchema,
}).strict();
export type WorkspaceSpaceDefaultRequest = z.infer<typeof WorkspaceSpaceDefaultRequestSchema>;

export const WorkspaceSpaceDefaultTargetSchema = z.strictObject({
  spaceId: SpaceIdSchema,
  kind: SpaceDefaultKindSchema,
  targetId: IdSchema,
  defaultGeneration: z.number().int().positive(),
  workstreamId: WorkstreamIdSchema,
  membershipGeneration: z.number().int().positive(),
});
export type WorkspaceSpaceDefaultTarget = z.infer<typeof WorkspaceSpaceDefaultTargetSchema>;

export const WorkspaceSpaceDefaultResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    space: SpaceSummarySchema,
    targets: z.array(WorkspaceSpaceDefaultTargetSchema),
  }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceDefaultResult = z.infer<typeof WorkspaceSpaceDefaultResultSchema>;

export const SpaceDefaultQueueMessageSchema = WorkspaceSpaceDefaultTargetSchema.extend({
  type: z.literal("space_default"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  requestedByUserId: UserIdSchema,
}).strict();
export type SpaceDefaultQueueMessage = z.infer<typeof SpaceDefaultQueueMessageSchema>;

/**
 * A delivery attempt that failed, with the reason it failed.
 *
 * `errorCode` is the consumer's `diagnosticErrorCode`, not a literal this
 * object writes. `last_error_code` is the only durable record of *why* a
 * default has not reached a Channel, and the fixed
 * `space_default_apply_failed` it used to carry said only that it had not —
 * which is what the row's existence already said
 * (`docs/naming-a-schema-failure.md`).
 */
export const SpaceDefaultTargetFailureRequestSchema = SpaceDefaultQueueMessageSchema.extend({
  errorCode: z.string().min(1).max(200),
}).strict();
export type SpaceDefaultTargetFailureRequest = z.infer<typeof SpaceDefaultTargetFailureRequestSchema>;

/**
 * The operations that stage an intent, and therefore the ones a resume can be
 * about.
 *
 * Exactly the kinds `WorkspaceSpaceStorage.recordIntent` is called with. A
 * default's delivery and the cutover each have staging, a retry gate and a
 * consumer leg of their own, so admitting `default` and `bootstrap` here
 * described messages nothing could publish.
 */
export const SpaceIntentKindSchema = z.enum(["add", "remove", "move", "audience", "archive", "restore"]);
export type SpaceIntentKind = z.infer<typeof SpaceIntentKindSchema>;

/**
 * One unsettled Space intent on the activity Queue.
 *
 * Nothing publishes these: the alarm resumes every intent in WorkspaceDO. The
 * consumer accepts every kind so a message already queued finishes, by asking
 * WorkspaceDO to resume the intent from its row (`resumeSpaceIntent`); it
 * reads only the address and the requester.
 */
export const SpaceIntentResumeQueueMessageSchema = z.strictObject({
  type: z.literal("space_intent_resume"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  operationId: IdSchema,
  kind: SpaceIntentKindSchema,
  spaceId: SpaceIdSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  spaceRevision: z.number().int().positive(),
  membershipGeneration: z.number().int().positive().nullable(),
  sourceSpaceId: SpaceIdSchema.nullable().default(null),
  sourceSpaceRevision: z.number().int().positive().nullable().default(null),
  sourceMembershipGeneration: z.number().int().positive().nullable().default(null),
  /**
   * Where the operation's member walk got to, so the resume continues it.
   *
   * Without this the resume re-read the whole member list and started again at
   * the first Channel, which for a Space past one invocation's budget is a pass
   * that can never finish — every redelivery doing the same prefix again and
   * dying in the same place.
   */
  cursor: z.string().min(1).nullable(),
  requestedByUserId: UserIdSchema,
}).strict();
export type SpaceIntentResumeQueueMessage = z.infer<typeof SpaceIntentResumeQueueMessageSchema>;

export const WorkspaceSpaceGeneralOpenResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema, created: z.boolean() }),
  /** General does not exist yet; answered only to a call that named no `spaceId`. */
  z.strictObject({ ok: z.literal(true), absent: z.literal(true) }),
  SpaceFailureSchema,
]);
export type WorkspaceSpaceGeneralOpenResult = z.infer<typeof WorkspaceSpaceGeneralOpenResultSchema>;

/**
 * Where the Organization is in its one-time Space cutover.
 *
 * `ready` is what the sidebar reads: false while anything here is unfinished,
 * so the desktop shows the Organization-opening state rather than a hierarchy
 * that is half built.
 *
 * The phase is the pass that is *running*, which is what lets the alarm turn it
 * into a message kind without a second table. There is no separate audience
 * pass: applying General's Organization-wide source is what widens a formerly
 * personal Channel, and it happens inside the placement, through the Channel's
 * canonical scope operation and the retained-content trigger that guards it.
 *
 * `preflight` is the read-only pass in front of it. It asks the same questions
 * a placement asks and writes nothing, so an Organization whose cutover is
 * going to be refused is refused before the first Channel is widened — the
 * PRD's "without partial mutation".
 */
export const WorkspaceSpaceBootstrapStatusSchema = z.strictObject({
  phase: z.enum(["pending", "general", "preflight", "memberships", "finalize", "complete"]),
  generalSpaceId: SpaceIdSchema.nullable(),
  blockedWorkstreamIds: z.array(WorkstreamIdSchema),
  ready: z.boolean(),
});
export type WorkspaceSpaceBootstrapStatus = z.infer<typeof WorkspaceSpaceBootstrapStatusSchema>;

/**
 * One piece of cutover work, republished until its consumer reports back.
 *
 * The alarm claims it and the activity consumer runs it, which is the shape
 * every other staged fan-out in WorkspaceDO already has — and the reason the
 * cutover needs no user access to make progress. `cursor` is the Channel id the
 * previous page stopped at, so an interrupted pass resumes from a row rather
 * than from an offset that the directory may have moved under.
 */
export const SpaceBootstrapQueueMessageSchema = z.strictObject({
  type: z.literal("space_bootstrap"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  kind: z.enum(["general", "preflight", "memberships", "finalize"]),
  cursor: WorkstreamIdSchema.nullable(),
}).strict();
export type SpaceBootstrapQueueMessage = z.infer<typeof SpaceBootstrapQueueMessageSchema>;

/**
 * One Channel the cutover has to place, as the Organization already knows it.
 *
 * Everything a placement needs travels on the row because the alternative is a
 * cross-object read per Channel to learn what the directory projection already
 * says. `participantUserIds` is who could act on this Channel: the canonical
 * audience operation authorizes an actor, and a personal Channel admits only
 * its own participants — so the cutover acts as one of them rather than
 * inventing an authority of its own.
 */
export const SpaceBootstrapChannelSchema = z.strictObject({
  workstreamId: WorkstreamIdSchema,
  scope: AudienceScopeSchema,
  placed: z.boolean(),
  participantUserIds: z.array(UserIdSchema),
});
export type SpaceBootstrapChannel = z.infer<typeof SpaceBootstrapChannelSchema>;

export const WorkspaceSpaceBootstrapPageSchema = z.strictObject({
  generalSpaceId: SpaceIdSchema.nullable(),
  items: z.array(SpaceBootstrapChannelSchema),
  nextCursor: WorkstreamIdSchema.nullable(),
});
export type WorkspaceSpaceBootstrapPage = z.infer<typeof WorkspaceSpaceBootstrapPageSchema>;

/**
 * What one pass of the cutover finished, and what it could not.
 *
 * `clearedWorkstreamIds` is what the page settled *for*, in the sense the
 * blocked list is the other half of: a `memberships` page reports the Channels
 * it placed, a `preflight` page the Channels it found safe to place. Either way
 * they are the Channels that are no longer stuck, so either way they come off
 * `blocked_json`.
 */
export const WorkspaceSpaceBootstrapSettleRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  phase: z.enum(["general", "preflight", "memberships"]),
  cursor: WorkstreamIdSchema.nullable(),
  clearedWorkstreamIds: z.array(WorkstreamIdSchema).default([]),
  blocked: z.array(z.strictObject({
    workstreamId: WorkstreamIdSchema,
    // The consumer's `diagnosticErrorCode`, not a literal this object writes:
    // `blocked_json` is the only durable record of *why* an Organization's
    // cutover has not finished.
    code: z.string().min(1).max(200),
  })).default([]),
}).strict();
export type WorkspaceSpaceBootstrapSettleRequest =
  z.infer<typeof WorkspaceSpaceBootstrapSettleRequestSchema>;

/**
 * Why the cutover did not close, when it did not.
 *
 * Both refusals send the Organization back to the walk, because the walk is
 * the only thing that changes either fact: `unplaced` is a Channel the pass
 * has not reached yet, and `blocked` is one it reached and was refused on.
 */
export const WorkspaceSpaceBootstrapFinalizeResultSchema = z.strictObject({
  outcome: z.enum(["complete", "blocked", "unplaced"]),
});
export type WorkspaceSpaceBootstrapFinalizeResult =
  z.infer<typeof WorkspaceSpaceBootstrapFinalizeResultSchema>;

/**
 * One step of a staged operation, recorded against its intent.
 *
 * `settled` is what stops the alarm republishing it. A step that finished part
 * of the work writes a receipt without settling, so a resume knows what not to
 * do again; the last step settles.
 *
 * `cursor` is what a *paged* step writes: the Channel id its page stopped at,
 * or `null` once the walk is exhausted. Omitting it leaves the intent's cursor
 * alone, which is what every single-Channel operation does. It is the field a
 * resume actually reads — a receipt string says a page happened, the cursor
 * says where the next one starts.
 */
export const WorkspaceSpaceIntentReceiptRequestSchema = SpaceActorSchema.extend({
  operationId: IdSchema,
  receipt: z.string().min(1).max(200),
  settled: z.boolean(),
  cursor: z.string().min(1).nullable().optional(),
}).strict();
export type WorkspaceSpaceIntentReceiptRequest = z.infer<typeof WorkspaceSpaceIntentReceiptRequestSchema>;

/**
 * Why a resume did not finish, recorded on the intent it was about.
 *
 * `errorCode` is the consumer's `diagnosticErrorCode`, not a literal this
 * object writes — the same field and the same reason
 * {@link SpaceDefaultTargetFailureRequestSchema} carries one. The alarm
 * republishes an unsettled intent forever, so a resume that can never succeed
 * is a log line every thirty minutes and a row that says the operation did not
 * finish without saying what stopped it.
 */
export const WorkspaceSpaceIntentFailureRequestSchema = SpaceActorSchema.extend({
  operationId: IdSchema,
  errorCode: z.string().min(1).max(200),
}).strict();
export type WorkspaceSpaceIntentFailureRequest = z.infer<typeof WorkspaceSpaceIntentFailureRequestSchema>;

/**
 * The person a Space operation acts as when WorkspaceDO drives a Channel's
 * canonical audience operations itself.
 *
 * The same fields `WorkstreamObjectClient` sends on every product request, and
 * nothing more: the conversation re-verifies them (a login session against its
 * `sessions` row, any other principal against current membership), so passing
 * them through WorkspaceDO adds no authority the Worker did not already have.
 */
export const SpaceActorAuthSchema = z.strictObject({
  sessionId: z.string().min(1).max(200),
  userId: UserIdSchema,
  workspaceId: WorkspaceIdSchema,
  region: RegionSchema,
  role: z.enum(["owner", "admin", "member"]).nullable(),
  principal: z.enum(["connector", "demo_seed", "impersonation", "resource_authorization"]).optional(),
});
export type SpaceActorAuth = z.infer<typeof SpaceActorAuthSchema>;

/** `addSpaceChannel` and `removeSpaceChannel`: one existing Channel, one Space. */
export const WorkspaceSpaceChannelChangeRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  spaceId: SpaceIdSchema,
  workstreamId: WorkstreamIdSchema,
});
export type WorkspaceSpaceChannelChangeRequest = z.infer<typeof WorkspaceSpaceChannelChangeRequestSchema>;

/**
 * `channelMergeTarget`: where this thread's merge would go for this person,
 * `spaceId` when they named one, and the Channels they could pick instead.
 * Asked before any resource is attached; `mergeThreadIntoChannel` asks again
 * inside its write.
 */
export const WorkspaceChannelMergeTargetRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  workstreamId: WorkstreamIdSchema,
  spaceId: SpaceIdSchema.nullable(),
});
export type WorkspaceChannelMergeTargetRequest = z.infer<typeof WorkspaceChannelMergeTargetRequestSchema>;

const ChannelMergeRefusalSchema = z.strictObject({
  ok: z.literal(false),
  code: z.enum([
    "space_access_denied",
    "workstream_not_found",
    "conversation_archived",
    "merge_channel_not_placed",
    "merge_target_not_writable",
  ]),
  channels: z.array(ConversationMergeChannelSchema),
});

export const WorkspaceChannelMergeTargetResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    spaceId: SpaceIdSchema,
    name: z.string(),
    channels: z.array(ConversationMergeChannelSchema),
  }),
  ChannelMergeRefusalSchema,
]);
export type WorkspaceChannelMergeTargetResult = z.infer<typeof WorkspaceChannelMergeTargetResultSchema>;

/**
 * `threadMergePlacement`: the Channel a thread's merge would land in with
 * nobody in particular asking, the earliest active placement, as
 * `channelMergeTarget` picks it for a person. Read by the turn-disposition
 * observer in a thread's object, which has a settled run and no viewer, to
 * name the parent in the classifier's state and on the suggestion it writes.
 */
export const WorkspaceThreadMergePlacementRequestSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
});
export type WorkspaceThreadMergePlacementRequest = z.infer<typeof WorkspaceThreadMergePlacementRequestSchema>;

export const WorkspaceThreadMergePlacementResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), spaceId: SpaceIdSchema, title: z.string() }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["workstream_not_found", "conversation_archived", "merge_channel_not_placed"]),
  }),
]);
export type WorkspaceThreadMergePlacementResult = z.infer<typeof WorkspaceThreadMergePlacementResultSchema>;

/** `mergeThreadIntoChannel`: post or replace this thread's merge in one of its Channels. */
export const WorkspaceChannelMergeRequestSchema = WorkspaceChannelMergeTargetRequestSchema.extend({
  body: z.string().trim().min(1).max(MESSAGE_MAX_CHARACTERS),
  /**
   * What the body embeds, resolved and checked by the caller
   * (`resolveShareableResources`); WorkspaceDO links every one to the Channel
   * in the merge's own commit.
   */
  embeds: z.array(MergeEmbedSchema),
  operationId: z.string().min(1).max(200),
}).strict();
export type WorkspaceChannelMergeRequest = z.infer<typeof WorkspaceChannelMergeRequestSchema>;

export const WorkspaceChannelMergeResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    spaceId: SpaceIdSchema,
    name: z.string(),
    messageId: z.string().uuid(),
    replayed: z.boolean(),
    /** The resources this merge newly shared with the Channel. */
    linked: z.array(z.string()),
  }),
  ChannelMergeRefusalSchema,
]);
export type WorkspaceChannelMergeResult = z.infer<typeof WorkspaceChannelMergeResultSchema>;

/** `removeChannelMessage`: its author, or an Organization admin, deletes one Channel message. */
export const WorkspaceChannelMessageRemoveRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  spaceId: SpaceIdSchema,
  messageId: z.string().uuid(),
});
export type WorkspaceChannelMessageRemoveRequest = z.infer<typeof WorkspaceChannelMessageRemoveRequestSchema>;

export const WorkspaceChannelMessageRemoveResultSchema = z.union([
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({
    ok: z.literal(false),
    code: z.enum(["space_access_denied", "space_not_found", "channel_message_not_found"]),
  }),
]);
export type WorkspaceChannelMessageRemoveResult = z.infer<typeof WorkspaceChannelMessageRemoveResultSchema>;

/** `placeChannelInGeneral`: the cutover homing one Channel, as one of its people. */
export const WorkspaceGeneralPlacementRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  workstreamId: WorkstreamIdSchema,
});
export type WorkspaceGeneralPlacementRequest = z.infer<typeof WorkspaceGeneralPlacementRequestSchema>;

/**
 * Why a Space operation that reached a Channel did not finish, with what the
 * caller needs to say so.
 *
 * `space` is a refusal about the Space (rendered by `spaceRefusal`), `channel`
 * one about the Channel it reached (rendered by `spaceAccessError`, with the
 * Channel's title as `subject`), and `conversation` a refusal the Channel's
 * own conversation answered, passed on as it was given. That last one is the
 * product refusal that reached the route when the Worker made these calls; a
 * Durable Object RPC would otherwise reduce it to a bare `Error` with no code.
 */
export const SpaceChannelRefusalSchema = z.discriminatedUnion("about", [
  z.strictObject({
    about: z.literal("space"),
    code: SpaceErrorCodeSchema,
    subject: z.string(),
    unreachableUserIds: z.array(UserIdSchema).default([]),
    blockedWorkstreamIds: z.array(WorkstreamIdSchema).default([]),
  }),
  z.strictObject({ about: z.literal("channel"), code: SpaceErrorCodeSchema, subject: z.string() }),
  z.strictObject({
    about: z.literal("conversation"),
    status: z.number().int().min(400).max(599),
    code: z.string().min(1).max(200),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
]);
export type SpaceChannelRefusal = z.input<typeof SpaceChannelRefusalSchema>;
export type ParsedSpaceChannelRefusal = z.infer<typeof SpaceChannelRefusalSchema>;

export const WorkspaceSpaceChannelChangeResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema }),
  z.strictObject({ ok: z.literal(false), refusal: SpaceChannelRefusalSchema }),
]);
export type WorkspaceSpaceChannelChangeResult = z.input<typeof WorkspaceSpaceChannelChangeResultSchema>;

/**
 * `resumeSpaceIntent`: one step of one staged intent in WorkspaceDO, as the
 * actor the caller authenticated. The intent row, not the message that named it, is
 * what is resumed, because its cursor and fences are the current ones.
 */
export const WorkspaceSpaceIntentResumeRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  operationId: IdSchema,
});
export type WorkspaceSpaceIntentResumeRequest = z.infer<typeof WorkspaceSpaceIntentResumeRequestSchema>;

/**
 * `progressed`: a walk finished one page and has more; the intent is still
 * unsettled with its cursor advanced.
 */
export const WorkspaceSpaceIntentResumeResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), outcome: z.enum(["settled", "progressed"]) }),
  z.strictObject({ ok: z.literal(true), outcome: z.literal("abandoned"), reason: z.string().min(1).max(200) }),
  z.strictObject({ ok: z.literal(false), refusal: SpaceChannelRefusalSchema }),
]);
export type WorkspaceSpaceIntentResumeResult = z.input<typeof WorkspaceSpaceIntentResumeResultSchema>;
