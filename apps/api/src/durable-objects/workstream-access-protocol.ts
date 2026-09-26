import {
  ChannelAccessSourcesSchema,
  IdSchema,
  SpaceErrorCodeSchema,
  SpaceIdSchema,
  SpaceScopeSchema,
  UserIdSchema,
  WorkspaceIdSchema,
} from "@rally/contracts";
import { z } from "zod";

import { WorkstreamReaderAudienceSchema } from "../lib/audience-containment";

/**
 * The wire contract for a Channel's access provenance.
 *
 * Every request carries the address the object asserts itself against, because
 * a Durable Object reached by name answers for whatever it was asked and
 * `assertParent` is what makes a misaddressed call a refusal rather than a
 * wrong answer. Every mutating result is `{ ok }` plus one of the closed
 * `SpaceErrorCode`s rather than a throw: these are outcomes a caller branches
 * on, and a `ZodError` or a bare `Error` across an RPC hop names neither the
 * field nor the reason (`docs/naming-a-schema-failure.md`).
 *
 * What the object never reads for itself is what the Channel's readers are
 * right now. That belongs to the main conversation, the caller has it in hand,
 * and fetching it here would put a cross-object read inside an authority whose
 * whole job is to decide synchronously.
 */
const ChannelAccessAddressSchema = z.strictObject({
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
});

/**
 * What the caller observed about the Channel before asking for a plan.
 *
 * Both halves, because they answer different questions and neither implies the
 * other. `readers` is who may read, and says only `workspace` once the audience
 * is Organization-wide — which is exactly when a plan still needs to know who
 * would remain if it stopped being Organization-wide. `participantUserIds` is
 * the roster, which exists in both scopes and is what the direct source is once
 * the readers a Space seated are taken out of it.
 */
export const ObservedChannelSchema = z.strictObject({
  readers: WorkstreamReaderAudienceSchema,
  participantUserIds: z.array(UserIdSchema),
});
export type ObservedChannel = z.infer<typeof ObservedChannelSchema>;

export const ReadChannelAccessSourcesRequestSchema = ChannelAccessAddressSchema.extend({
  channel: ObservedChannelSchema,
});

/**
 * Server-internal read of only the persisted Space provenance.
 *
 * Recovery for a move was authorized and durably staged by WorkspaceDO. It
 * must not turn the initiating user's mutable, current Channel access into a
 * second authorization fence while converging that intent.
 */
export const ReadPersistedSpaceAccessSourcesRequestSchema = ChannelAccessAddressSchema;
export const PersistedSpaceAccessSourcesSchema = ChannelAccessSourcesSchema.shape.spaces;

export const SetChannelDirectScopeRequestSchema = ChannelAccessAddressSchema.extend({
  scope: SpaceScopeSchema,
  /**
   * Whether this is something establishing the Channel's own audience, or a
   * restore putting back what was there.
   *
   * Absent means true, which is every caller that means it. A restore passes
   * false,
   * because the record it is undoing may never have been established at all:
   * the row was still the migration's guess, and putting the *scope* back while
   * marking it observed would tell the first Space to reach this Channel that
   * the guess was a decision, and stop it seeding the real value.
   */
  observed: z.boolean().optional(),
  operationId: IdSchema,
});
export const SetChannelDirectScopeResultSchema = z.discriminatedUnion("ok", [
  // The record as it was before this call, so a caller whose canonical update
  // then fails can put it back rather than leaving it claiming an audience the
  // Channel never took. Both halves, because a scope restored without its
  // `observed` is a different record.
  z.strictObject({
    ok: z.literal(true),
    previousScope: SpaceScopeSchema,
    previousObserved: z.boolean(),
  }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type SetChannelDirectScopeResult = z.infer<typeof SetChannelDirectScopeResultSchema>;

export const NoteChannelDirectReaderRequestSchema = ChannelAccessAddressSchema.extend({
  userId: UserIdSchema,
});

/**
 * A plan, and with `commitWithPlan` the commit as well.
 *
 * Either way it holds a receipt, so a redelivery under the same operation id
 * answers what the first attempt did rather than recomputing a delta against a
 * Channel the first attempt has already changed. Without `commitWithPlan` the
 * source is committed by {@link ConfirmSpaceAccessSourceRequestSchema} once the
 * caller has run the canonical operations that seat the plan's readers.
 */
export const ApplySpaceAccessSourceRequestSchema = ChannelAccessAddressSchema.extend({
  spaceId: SpaceIdSchema,
  scope: SpaceScopeSchema,
  /** The Space's participants, which is what this source supplies. */
  participantUserIds: z.array(UserIdSchema),
  /** The Space as it was when this work was staged; both fences are re-read here. */
  spaceRevision: z.number().int().positive(),
  membershipGeneration: z.number().int().positive(),
  operationId: IdSchema,
  channel: ObservedChannelSchema,
  /**
   * Commit the source in this call, recording the readers the plan seats as
   * supplied by it.
   *
   * Two callers. The Channel creation reservation, where the conversation
   * opens with the union of its Spaces' audiences already written, so there is
   * no canonical operation left to run. And WorkspaceDO's `SpaceChannelAccess`,
   * which commits the plan in the transaction that stages the intent: the
   * intent is resumed until it settles, so a crash between this commit and the
   * seating is finished or withdrawn by the resume, and the readers already
   * seated are attributed to this Space either way. Until then the source names
   * readers who may not be seated yet.
   *
   * Absent means false, and the normalized value is part of the receipt's
   * request fence: a redelivery under the other mode is a different request
   * rather than a convergence on the wrong answer.
   */
  commitWithPlan: z.boolean().optional(),
});
export type ApplySpaceAccessSourceRequest = z.infer<typeof ApplySpaceAccessSourceRequestSchema>;

export const SpaceAccessApplicationSchema = z.strictObject({
  widenScope: z.boolean(),
  seatUserIds: z.array(UserIdSchema),
});
export const ApplySpaceAccessSourceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    plan: SpaceAccessApplicationSchema,
    /**
     * What a confirmation would have answered, present exactly when
     * `commitWithPlan` committed the source here: every reader this
     * Space is now recorded as supplying. Absent otherwise, because nothing
     * has been recorded yet.
     */
    suppliedUserIds: z.array(UserIdSchema).optional(),
  }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type ApplySpaceAccessSourceResult = z.infer<typeof ApplySpaceAccessSourceResultSchema>;

/**
 * The source a confirmation commits, with the readers the caller seated.
 *
 * After an application that committed with its plan this is the same source
 * again, and it is what fences the settlement: a newer source for the same
 * Space refuses it, and a rollback confirms what was really seated before it
 * retracts.
 *
 * Absent means "attribute these readers to a source that is already here",
 * which is what a narrowing does: it seats readers a Space has supplied all
 * along, and the source row was committed when that Space arrived.
 *
 * `channel` is what the caller observed *before* it applied the audience, and
 * is only read to seed a Channel whose own scope nothing has established yet.
 * Reading it here rather than re-observing is the point: by now the audience
 * may already be Organization-wide because of this very source.
 */
export const ConfirmedAccessSourceSchema = z.strictObject({
  scope: SpaceScopeSchema,
  participantUserIds: z.array(UserIdSchema),
  spaceRevision: z.number().int().positive(),
  membershipGeneration: z.number().int().positive(),
  channel: ObservedChannelSchema,
});

export type ConfirmedAccessSource = z.infer<typeof ConfirmedAccessSourceSchema>;

export const ConfirmSpaceAccessSourceRequestSchema = ChannelAccessAddressSchema.extend({
  spaceId: SpaceIdSchema,
  operationId: IdSchema,
  seatedUserIds: z.array(UserIdSchema),
  source: ConfirmedAccessSourceSchema.optional(),
});
export const ConfirmSpaceAccessSourceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), suppliedUserIds: z.array(UserIdSchema) }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type ConfirmSpaceAccessSourceResult = z.infer<typeof ConfirmSpaceAccessSourceResultSchema>;

/**
 * Replace one Space source with another when both name the exact same audience.
 *
 * No canonical Channel audience write belongs between these two facts: the
 * effective scope and roster do not change. Keeping this as one hosted-parent
 * transaction transfers the provenance without paying the plan/apply/confirm
 * protocol whose only purpose is to bracket a real audience mutation.
 */
export const ReplaceEquivalentSpaceAccessSourceRequestSchema = ChannelAccessAddressSchema.extend({
  sourceSpaceId: SpaceIdSchema,
  targetSpaceId: SpaceIdSchema,
  scope: SpaceScopeSchema,
  participantUserIds: z.array(UserIdSchema),
  sourceSpaceRevision: z.number().int().positive(),
  sourceMembershipGeneration: z.number().int().positive(),
  targetSpaceRevision: z.number().int().positive(),
  targetMembershipGeneration: z.number().int().positive(),
  operationId: IdSchema,
}).strict();
export type ReplaceEquivalentSpaceAccessSourceRequest =
  z.infer<typeof ReplaceEquivalentSpaceAccessSourceRequestSchema>;

export const ReplaceEquivalentSpaceAccessSourceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type ReplaceEquivalentSpaceAccessSourceResult =
  z.infer<typeof ReplaceEquivalentSpaceAccessSourceResultSchema>;

export const RetractSpaceAccessSourceRequestSchema = ChannelAccessAddressSchema.extend({
  spaceId: SpaceIdSchema,
  operationId: IdSchema,
  /**
   * The Space revision this retraction was staged against, when the caller has
   * one.
   *
   * An audience change converges by retract-then-apply, and the retraction
   * *deletes* the source row the application and its confirmation fence on — so
   * without this an older interleaved change finds no row to be refused by and
   * installs a stale roster unfenced. Optional because a membership removal and
   * an archive withdraw a source rather than replace it: there is no newer
   * application for them to lose a race with.
   */
  expectedSpaceRevision: z.number().int().positive().optional(),
  channel: ObservedChannelSchema,
});
export type RetractSpaceAccessSourceRequest = z.infer<typeof RetractSpaceAccessSourceRequestSchema>;

export const SpaceAccessRetractionSchema = z.strictObject({
  narrowScope: z.boolean(),
  seatUserIds: z.array(UserIdSchema),
  removeUserIds: z.array(UserIdSchema),
});
export type SpaceAccessRetraction = z.infer<typeof SpaceAccessRetractionSchema>;
export type SpaceAccessApplication = z.infer<typeof SpaceAccessApplicationSchema>;
export const RetractSpaceAccessSourceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), plan: SpaceAccessRetractionSchema }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type RetractSpaceAccessSourceResult = z.infer<typeof RetractSpaceAccessSourceResultSchema>;
