import { RegionSchema } from "@rally/contracts/regions";
import {
  ContainerOrderSchema,
  ConversationParentReserveChildRequestSchema,
  CreateSpaceRequestSchema,
  IdSchema,
  ScopeSchema,
  SpaceChannelPageSchema,
  SpaceErrorCodeSchema,
  SpaceIconKeySchema,
  SpaceIdSchema,
  SpaceColorKeySchema,
  SpaceDefaultKindSchema,
  SpaceScopeSchema,
  SpaceSummarySchema,
  UserIdSchema,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
} from "@rally/contracts";
import { z } from "zod";

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

export const WorkspaceSpaceReserveRequestSchema = SpaceActorSchema.extend({
  space: CreateSpaceRequestSchema,
  /**
   * The creation identity. `SpaceService` always names one, because the D1
   * anchor is written under it before this call; absent only for a caller
   * that lets the Organization allocate it.
   */
  spaceId: SpaceIdSchema.optional(),
  /**
   * Reserve the Space's hosted parent (its metadata and provisional directory
   * row) in the same transaction as the Space. Omitted, the Space is written
   * alone at source version zero and the caller reserves the parent itself,
   * which is what a Worker from before this field did.
   */
  reserveParent: z.literal(true).optional(),
}).strict();
export type WorkspaceSpaceReserveRequest = z.infer<typeof WorkspaceSpaceReserveRequestSchema>;

export const WorkspaceSpaceRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
}).strict();
export type WorkspaceSpaceRequest = z.infer<typeof WorkspaceSpaceRequestSchema>;

/**
 * A whole-Space operation staged and settled under one operation id the caller
 * owns: an archive, or a restore.
 *
 * Separate from {@link WorkspaceSpaceRequestSchema} because the settlement has
 * to name the intent the staging wrote, and the id an archive used to
 * reconstruct that from — the Space revision, minus one, read back after the
 * archive advanced it — was arithmetic over two writes in two objects. The
 * caller mints one and hands it to both halves.
 *
 * One schema for both, because they are the same request: a Space id, and the
 * id of the operation the fan-out after it belongs to. Two identical
 * declarations named after their callers would be two places to change when the
 * next whole-Space operation arrives.
 */
export const WorkspaceSpaceStagedRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  operationId: IdSchema,
}).strict();
export type WorkspaceSpaceStagedRequest = z.infer<typeof WorkspaceSpaceStagedRequestSchema>;

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
}).strict();
export type WorkspaceSpacePresentationRequest = z.infer<typeof WorkspaceSpacePresentationRequestSchema>;

/** The scope and participants a Space's own authority has just accepted. */
export const WorkspaceSpaceAudienceNoteRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  /** The operation this change is staged under, so its receipts can settle it. */
  operationId: IdSchema,
  audience: z.strictObject({
    scope: SpaceScopeSchema,
    participantUserIds: z.array(UserIdSchema).min(1),
  }),
}).strict();
export type WorkspaceSpaceAudienceNoteRequest = z.infer<typeof WorkspaceSpaceAudienceNoteRequestSchema>;

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

export const WorkspaceSpaceMembershipMoveSettleRequestSchema = WorkspaceSpaceMembershipMoveRequestSchema.extend({
  operationId: IdSchema,
  sourceSpaceRevision: z.number().int().positive(),
  sourceMembershipGeneration: z.number().int().positive(),
  targetSpaceRevision: z.number().int().positive(),
  targetMembershipGeneration: z.number().int().positive(),
}).strict();
export type WorkspaceSpaceMembershipMoveSettleRequest =
  z.infer<typeof WorkspaceSpaceMembershipMoveSettleRequestSchema>;

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
  authorityGeneration: z.number().int().positive(),
  directory: ConversationParentReserveChildRequestSchema.shape.directory.unwrap().omit({
    scope: true,
    systemKind: true,
  }),
}).strict();
export type WorkspaceChannelReservationRequest = z.infer<typeof WorkspaceChannelReservationRequestSchema>;

export const WorkspaceChannelReservationResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("reserved"),
    authorityGeneration: z.number().int().positive(),
    /** Each Space the Channel is now in, as the transaction read it. */
    spaces: z.array(SpaceSummarySchema).min(1),
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
]);
export type WorkspaceChannelReservationResult = z.infer<typeof WorkspaceChannelReservationResultSchema>;

export const WorkspaceSpaceMembershipMovePlanResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    equivalentAudience: z.literal(false),
  }),
  z.strictObject({
    ok: z.literal(true),
    equivalentAudience: z.literal(true),
    operationId: IdSchema,
    source: SpaceSummarySchema,
    target: SpaceSummarySchema,
    sourceMembershipGeneration: z.number().int().positive(),
    targetMembershipGeneration: z.number().int().positive(),
  }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMembershipMovePlanResult =
  z.infer<typeof WorkspaceSpaceMembershipMovePlanResultSchema>;

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

export const WorkspaceSpaceMembershipMoveResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), source: SpaceSummarySchema, target: SpaceSummarySchema }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMembershipMoveResult = z.infer<typeof WorkspaceSpaceMembershipMoveResultSchema>;

export const WorkspaceSpaceMutationResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMutationResult = z.infer<typeof WorkspaceSpaceMutationResultSchema>;

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

/**
 * Which memberships a fan-out is asking about.
 *
 * Named for the walk rather than for the membership because `reach` is also
 * what a *viewer's* relationship to a Space is called — `SpaceSummary.reach`,
 * `participant | organization | through_channel` — and the two met three
 * lines apart inside `WorkspaceSpaceStorage.members`, where reading this one
 * as that one says the page is already viewer-scoped. It is not.
 *
 * `active` is what a surface means by a member. `reaching` also counts the ones
 * a staged removal or a staged archive has already flipped to `removing`: this
 * Space's access source is still on those Channels, and taking it off is
 * exactly the work the staged operation has left to do. An archive's fan-out
 * that asked for `active` would run over nothing, because the prepare it
 * follows is what emptied that set.
 */
export const MemberWalkReachSchema = z.enum(["active", "reaching"]);
export type MemberWalkReach = z.infer<typeof MemberWalkReachSchema>;

export const WorkspaceSpaceMembersRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  reach: MemberWalkReachSchema.default("active"),
  /** Where the walk got to; `null` starts it at the first Channel. */
  cursor: z.string().min(1).nullable().default(null),
}).strict();
/**
 * The *input* side of the schema, because `reach` and `cursor` have defaults: a
 * caller that means the first page of active members says neither, and the
 * parse is what supplies the words the storage branches on.
 */
export type WorkspaceSpaceMembersRequest = z.input<typeof WorkspaceSpaceMembersRequestSchema>;

/**
 * One membership a fan-out is about: the Channel, and the generation its row
 * is at.
 *
 * The generation travels with the id because every fan-out that re-applies
 * this Space's source has to fence on it, and the alternative was the literal
 * `1` at three call sites — a constant fed into a fence the module document
 * calls load-bearing, which reads as "generation one" and means "we did not
 * look".
 */
export const SpaceMemberSchema = z.strictObject({
  workstreamId: WorkstreamIdSchema,
  membershipGeneration: z.number().int().positive(),
});
export type SpaceMember = z.infer<typeof SpaceMemberSchema>;

/**
 * One page of the Channels a Space holds, archived ones included.
 *
 * Separate from {@link WorkspaceSpaceChannelPageResultSchema} for the reason
 * `listProjectMembers` is separate from `ProjectSummary.workstreamIds`: a page
 * is what a surface can list, and an archived member is not that — while an
 * audience change still has to reach it. Server-to-server, and paged for the
 * reason every read in this object is: the answer grows with the Organization,
 * and every caller is a fan-out that spends several cross-object awaits per
 * row, so an unbounded one is an operation that can never finish rather than a
 * slow one. The caller follows `nextCursor` and records it on the intent, so
 * an interrupted walk resumes from the page it reached.
 */
export const WorkspaceSpaceMembersResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    members: z.array(SpaceMemberSchema),
    nextCursor: z.string().min(1).nullable(),
  }),
  SpaceFailureSchema,
]);
export type WorkspaceSpaceMembersResult = z.infer<typeof WorkspaceSpaceMembersResultSchema>;

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
 * One unsettled Space intent, republished so an interrupted operation finishes.
 *
 * The alarm publishes these only for a stored `move`, which the Worker's
 * `SpaceService.resumeIntent` finishes; every other kind is resumed in
 * WorkspaceDO itself. The consumer still accepts every kind, so messages queued
 * before that finish (for anything but a `move`, by asking WorkspaceDO to
 * resume the intent from its row). Everything the consumer needs to address
 * the work is on the message, because by the time it runs the request that
 * created the intent is long gone.
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

export const WorkspaceSpaceGeneralResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema, created: z.boolean() }),
  SpaceFailureSchema,
]);
export type WorkspaceSpaceGeneralResult = z.infer<typeof WorkspaceSpaceGeneralResultSchema>;

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
  scope: SpaceScopeSchema,
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

/** The walks an audience change, an archive and a restore take over their member Channels. */
export const SpaceMemberWalkKindSchema = z.enum(["audience", "archive", "restore"]);
export type SpaceMemberWalkKind = z.infer<typeof SpaceMemberWalkKindSchema>;

/**
 * `walkSpaceMembers`: one page of a staged walk, run by WorkspaceDO.
 *
 * `expectedSpaceRevision` is the request path's fence: an audience change
 * abandons its walk when the Space moves under it, because the change that
 * overtook it walks every member itself. `null` converges on the Space as it
 * is now, which is what a resume does.
 */
export const WorkspaceSpaceMemberWalkRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  spaceId: SpaceIdSchema,
  operationId: IdSchema,
  kind: SpaceMemberWalkKindSchema,
  cursor: z.string().min(1).nullable(),
  expectedSpaceRevision: z.number().int().positive().nullable(),
});
export type WorkspaceSpaceMemberWalkRequest = z.infer<typeof WorkspaceSpaceMemberWalkRequestSchema>;

/**
 * `page` names where the next page starts, already written to the intent.
 * `walked` and `abandoned` mean the intent is settled (an archive also
 * finalized) and carry the Space as the actor now sees it.
 */
export const WorkspaceSpaceMemberWalkResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), outcome: z.literal("page"), cursor: z.string().min(1) }),
  z.strictObject({ ok: z.literal(true), outcome: z.enum(["walked", "abandoned"]), space: SpaceSummarySchema }),
  z.strictObject({ ok: z.literal(false), refusal: SpaceChannelRefusalSchema }),
]);
export type WorkspaceSpaceMemberWalkResult = z.input<typeof WorkspaceSpaceMemberWalkResultSchema>;

/**
 * `resumeSpaceIntent`: finish one staged intent in WorkspaceDO as the actor
 * the caller authenticated. The intent row, not the message that named it, is
 * what is resumed, because its cursor and fences are the current ones.
 */
export const WorkspaceSpaceIntentResumeRequestSchema = z.strictObject({
  auth: SpaceActorAuthSchema,
  operationId: IdSchema,
});
export type WorkspaceSpaceIntentResumeRequest = z.infer<typeof WorkspaceSpaceIntentResumeRequestSchema>;

export const WorkspaceSpaceIntentResumeResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), outcome: z.literal("settled") }),
  z.strictObject({ ok: z.literal(true), outcome: z.literal("abandoned"), reason: z.string().min(1).max(200) }),
  z.strictObject({ ok: z.literal(false), refusal: SpaceChannelRefusalSchema }),
]);
export type WorkspaceSpaceIntentResumeResult = z.input<typeof WorkspaceSpaceIntentResumeResultSchema>;
