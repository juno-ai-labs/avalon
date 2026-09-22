import {
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
 * A plan — and, in one named case, the commit as well.
 *
 * Ordinarily it records no source. What it holds instead is a receipt, so a
 * redelivery answers what the first attempt did rather than recomputing a delta
 * against a Channel the first attempt has already changed. The source itself is
 * committed by {@link ConfirmSpaceAccessSourceRequestSchema}, because between
 * the two the caller runs the canonical operations that seat the plan's
 * readers. `bornWithSourceApplied` is the case where there is nothing to run in
 * between; the doc comment there says why that is only ever true at birth.
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
   * The caller asserting that the Channel was **born** with this source's
   * audience already applied, so this call commits the source as well as
   * planning it.
   *
   * That assertion is only true at birth. The creation coordinator derives the
   * union of every named Space and hands it to `initialize`, so the
   * conversation opens with the scope and the roster this source implies
   * already written — there is no widening left for the caller to ask the
   * Channel for, and therefore no step between the plan and its commit for a
   * crash to land in. Every other caller has one: it applies the plan through
   * the Channel's canonical scope and participant operations, and a source
   * recorded before those ran would claim a Space reaches this Channel while
   * that Space had seated nobody.
   *
   * Absent means false, and the normalized value is part of the receipt's
   * request fence: a redelivery under the other mode is a different request
   * rather than a convergence on the wrong answer.
   */
  bornWithSourceApplied: z.boolean().optional(),
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
     * `bornWithSourceApplied` committed the source here: every reader this
     * Space is now recorded as supplying. Absent otherwise, because nothing
     * has been recorded yet.
     */
    suppliedUserIds: z.array(UserIdSchema).optional(),
  }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type ApplySpaceAccessSourceResult = z.infer<typeof ApplySpaceAccessSourceResultSchema>;

/**
 * The source a confirmation commits, when the confirmation is the one that
 * commits it.
 *
 * Present on the confirmation rather than on the application because the
 * application is a plan: recording a source before the audience it describes
 * has been applied leaves, after any crash between the two, provenance that
 * supplies nobody — a Space the Channel claims reaches it and that seated no
 * reader. The confirmation is the first moment the Channel's readers and its
 * record of why can be made true together.
 *
 * **The split is the caller's canonical operations, so the one call that has
 * none does not need it.** A Space joining a Channel that already exists is
 * widened by the caller between the plan and this commit, which is the step the
 * two calls exist to bracket; a Channel *born* into a Space opened with that
 * audience already written, so `bornWithSourceApplied` on the application does
 * exactly what this body does, in the application's own transaction. Anything
 * with a canonical operation in the middle — an add, an audience change, a
 * restore, a placement by the cutover — stays two calls.
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
 * effective scope and roster do not change. Keeping this as one WorkstreamDO
 * transaction transfers the provenance without paying the plan/apply/confirm
 * protocol whose only purpose is to bracket a real audience mutation.
 */
export const ReplaceEquivalentSpaceAccessSourceRequestSchema = ChannelAccessAddressSchema.extend({
  sourceSpaceId: SpaceIdSchema,
  targetSpaceId: SpaceIdSchema,
  scope: SpaceScopeSchema,
  participantUserIds: z.array(UserIdSchema),
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
