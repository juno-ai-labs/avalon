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
  operationId: IdSchema,
});
export const SetChannelDirectScopeResultSchema = z.discriminatedUnion("ok", [
  // The scope recorded before this call, so a caller whose canonical update
  // then fails can put the record back rather than leaving it claiming an
  // audience the Channel never took.
  z.strictObject({ ok: z.literal(true), previousScope: SpaceScopeSchema }),
  z.strictObject({ ok: z.literal(false), code: SpaceErrorCodeSchema }),
]);
export type SetChannelDirectScopeResult = z.infer<typeof SetChannelDirectScopeResultSchema>;

export const NoteChannelDirectReaderRequestSchema = ChannelAccessAddressSchema.extend({
  userId: UserIdSchema,
});

/**
 * A plan and nothing else.
 *
 * It records no source. What it holds instead is a receipt, so a redelivery
 * answers what the first attempt did rather than recomputing a delta against a
 * Channel the first attempt has already changed. The source itself is committed
 * by {@link ConfirmSpaceAccessSourceRequestSchema}.
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
});
export type ApplySpaceAccessSourceRequest = z.infer<typeof ApplySpaceAccessSourceRequestSchema>;

export const SpaceAccessApplicationSchema = z.strictObject({
  widenScope: z.boolean(),
  seatUserIds: z.array(UserIdSchema),
});
export const ApplySpaceAccessSourceResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), plan: SpaceAccessApplicationSchema }),
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

export const RetractSpaceAccessSourceRequestSchema = ChannelAccessAddressSchema.extend({
  spaceId: SpaceIdSchema,
  operationId: IdSchema,
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
