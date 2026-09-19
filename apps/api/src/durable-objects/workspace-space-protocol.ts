import { RegionSchema } from "@rally/contracts/regions";
import {
  CreateSpaceRequestSchema,
  IdSchema,
  ReorderSpacesRequestSchema,
  SpaceChannelPageSchema,
  SpaceDirectorySchema,
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

export const WorkspaceSpaceReserveRequestSchema = SpaceActorSchema.extend({
  space: CreateSpaceRequestSchema,
}).strict();
export type WorkspaceSpaceReserveRequest = z.infer<typeof WorkspaceSpaceReserveRequestSchema>;

export const WorkspaceSpaceRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
}).strict();
export type WorkspaceSpaceRequest = z.infer<typeof WorkspaceSpaceRequestSchema>;

/**
 * An archive, staged and settled under one operation id the caller owns.
 *
 * Separate from {@link WorkspaceSpaceRequestSchema} because the settlement has
 * to name the intent the preflight staged, and the id it used to reconstruct
 * that from — the Space revision, minus one, read back after the archive
 * advanced it — was arithmetic over two writes in two objects. The caller
 * already mints one for an audience change; an archive is the same shape.
 */
export const WorkspaceSpaceArchiveRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  operationId: IdSchema,
}).strict();
export type WorkspaceSpaceArchiveRequest = z.infer<typeof WorkspaceSpaceArchiveRequestSchema>;

export const WorkspaceSpaceReorderRequestSchema = SpaceActorSchema.extend({
  order: ReorderSpacesRequestSchema,
}).strict();
export type WorkspaceSpaceReorderRequest = z.infer<typeof WorkspaceSpaceReorderRequestSchema>;

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

/**
 * What a Channel's readers would be once this Space stops reaching it.
 *
 * Supplied by the caller because only the Channel's own authority can compute
 * it: WorkspaceDO records which Spaces reach a Channel, never the Channel's
 * direct source. It is the input to the discoverability test — every remaining
 * reader has to be able to find at least one Space the Channel still belongs
 * to, or the Channel becomes something they can read and cannot reach.
 */
export const RemainingChannelAudienceSchema = z.strictObject({
  scope: SpaceScopeSchema,
  participantUserIds: z.array(UserIdSchema),
});
export type RemainingChannelAudience = z.infer<typeof RemainingChannelAudienceSchema>;

export const WorkspaceSpaceMembershipRemovalRequestSchema = WorkspaceSpaceMembershipRequestSchema.extend({
  remainingAudience: RemainingChannelAudienceSchema,
}).strict();
export type WorkspaceSpaceMembershipRemovalRequest = z.infer<typeof WorkspaceSpaceMembershipRemovalRequestSchema>;

/**
 * A refusal that names the readers and the Channels it is about.
 *
 * `unreachableUserIds` are ids the caller itself supplied in
 * `remainingAudience`, so returning them widens nothing: they are the subset of
 * what came in, not a record key or a value read out of storage.
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

export const WorkspaceSpaceMutationResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema }),
  WorkspaceSpaceAudienceFailureSchema,
]);
export type WorkspaceSpaceMutationResult = z.infer<typeof WorkspaceSpaceMutationResultSchema>;

export const WorkspaceSpaceDirectoryResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), directory: SpaceDirectorySchema }),
  SpaceFailureSchema,
]);
export type WorkspaceSpaceDirectoryResult = z.infer<typeof WorkspaceSpaceDirectoryResultSchema>;

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
 * `active` is what a surface means by a member. `reaching` also counts the ones
 * a staged removal or a staged archive has already flipped to `removing`: this
 * Space's access source is still on those Channels, and taking it off is
 * exactly the work the staged operation has left to do. An archive's fan-out
 * that asked for `active` would run over nothing, because the prepare it
 * follows is what emptied that set.
 */
export const SpaceMembershipReachSchema = z.enum(["active", "reaching"]);
export type SpaceMembershipReach = z.infer<typeof SpaceMembershipReachSchema>;

export const WorkspaceSpaceMembersRequestSchema = SpaceActorSchema.extend({
  spaceId: SpaceIdSchema,
  reach: SpaceMembershipReachSchema.default("active"),
}).strict();
/**
 * The *input* side of the schema, because `reach` has a default: a caller that
 * means the active members says nothing, and the parse is what supplies the
 * word the storage branches on.
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
 * Every Channel a Space holds, archived ones included.
 *
 * Separate from {@link WorkspaceSpaceChannelPageResultSchema} for the reason
 * `listProjectMembers` is separate from `ProjectSummary.workstreamIds`: a page
 * is what a surface can list, and an archived member is not that — while an
 * audience change still has to reach it. Server-to-server, and unpaginated,
 * because every caller is a fan-out that needs the whole set to be correct.
 */
export const WorkspaceSpaceMembersResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), members: z.array(SpaceMemberSchema) }),
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
 * One unsettled Space intent, republished so an interrupted operation finishes.
 *
 * The alarm publishes these; the activity consumer re-runs the service step the
 * intent names. Everything the consumer needs to address the work is on the
 * message, because by the time it runs the request that created the intent is
 * long gone.
 */
export const SpaceIntentResumeQueueMessageSchema = z.strictObject({
  type: z.literal("space_intent_resume"),
  region: RegionSchema,
  workspaceId: WorkspaceIdSchema,
  operationId: IdSchema,
  kind: z.enum(["add", "remove", "audience", "archive", "restore", "default", "bootstrap"]),
  spaceId: SpaceIdSchema,
  workstreamId: WorkstreamIdSchema.nullable(),
  spaceRevision: z.number().int().positive(),
  membershipGeneration: z.number().int().positive().nullable(),
  requestedByUserId: UserIdSchema,
}).strict();
export type SpaceIntentResumeQueueMessage = z.infer<typeof SpaceIntentResumeQueueMessageSchema>;

export const WorkspaceSpaceGeneralResultSchema = z.union([
  z.strictObject({ ok: z.literal(true), space: SpaceSummarySchema, created: z.boolean() }),
  SpaceFailureSchema,
]);
export type WorkspaceSpaceGeneralResult = z.infer<typeof WorkspaceSpaceGeneralResultSchema>;

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
 * `project_effects_pending` is the PRD's shutdown barrier: an Organization
 * cannot report a finished cutover while a Project default is still queued to
 * be delivered to one of its Channels.
 */
export const WorkspaceSpaceBootstrapFinalizeResultSchema = z.strictObject({
  outcome: z.enum(["complete", "blocked", "unplaced", "project_effects_pending"]),
});
export type WorkspaceSpaceBootstrapFinalizeResult =
  z.infer<typeof WorkspaceSpaceBootstrapFinalizeResultSchema>;

/**
 * One step of a staged operation, recorded against its intent.
 *
 * `settled` is what stops the alarm republishing it. A step that finished part
 * of the work writes a receipt without settling, so a resume knows what not to
 * do again; the last step settles.
 */
export const WorkspaceSpaceIntentReceiptRequestSchema = SpaceActorSchema.extend({
  operationId: IdSchema,
  receipt: z.string().min(1).max(200),
  settled: z.boolean(),
}).strict();
export type WorkspaceSpaceIntentReceiptRequest = z.infer<typeof WorkspaceSpaceIntentReceiptRequestSchema>;
