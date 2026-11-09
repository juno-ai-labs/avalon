import { IdSchema } from "@rally/contracts";
import { z } from "zod";
import { deferredZodSchema } from "@rally/contracts/deferred-zod-schema";

/**
 * External conversation bindings as questions rather than SQL.
 *
 * A binding maps one external conversation path (a provider room, or a thread
 * inside one) to one Rally address: a Space for a room, a conversation for a
 * thread. The record is connector-neutral: `installationId` names the provider
 * installation whose events reach ingress (`slack:T123` for a Slack workspace
 * bot), and `path` is the ordered list of provider segments from the outermost
 * container to the conversation (`[channel]`, `[channel, thread_ts]`). See
 * `docs/external-conversation-bindings.md`.
 *
 * Provider identifiers are validated only as non-empty strings: they are the
 * provider's vocabulary, stored as opaque TEXT inside a canonical JSON array.
 */

const TimestampSchema = z.string().datetime({ offset: true });

/** One provider segment. Opaque; never parsed for meaning on this side. */
export const ExternalPathSegmentSchema = z.string().min(1);
export const ExternalPathSchema = z.array(ExternalPathSegmentSchema).min(1);
export type ExternalPath = z.infer<typeof ExternalPathSchema>;

/** A conversation's substream: the main one, or a Breakout or run by its id (`SubstreamIdSchema`'s shape). */
const ConversationSubstreamSchema = z.union([z.literal("0"), IdSchema]);

/** `<connector type>:<provider installation>`, e.g. `slack:T123`. */
export const ExternalInstallationIdSchema = z.string().regex(/^[a-z][a-z0-9_]*:.+$/u);

/** The key a connector writes beside an activity's metadata for its binding. */
export const ExternalConversationKeySchema = z.object({
  installationId: ExternalInstallationIdSchema,
  path: ExternalPathSchema,
});

export const ExternalBindingConversationTargetSchema = z.strictObject({
  kind: z.literal("conversation"),
  parentKind: z.enum(["workstream", "automation"]),
  parentId: IdSchema,
  substreamId: ConversationSubstreamSchema,
});
export type ExternalBindingConversationTarget = z.infer<typeof ExternalBindingConversationTargetSchema>;

export const ExternalBindingSpaceTargetSchema = z.strictObject({
  kind: z.literal("space"),
  spaceId: IdSchema,
});

export const ExternalBindingTargetSchema = z.discriminatedUnion("kind", [
  ExternalBindingSpaceTargetSchema,
  ExternalBindingConversationTargetSchema,
]);
export type ExternalBindingTarget = z.infer<typeof ExternalBindingTargetSchema>;

export const ExternalBindingStateSchema = z.enum(["pending", "active", "suspended"]);

/**
 * Why a binding stopped routing. The reason is what decides whether a later
 * event may bring it back: a re-invitation reactivates a room the bot left, a
 * reconnect reactivates what a disconnect suspended, and nothing automatic
 * reactivates a binding a person closed or whose Sidekick was deleted.
 */
export const ExternalBindingSuspensionReasonSchema = z.enum([
  "provider_membership_ended",
  "provider_room_archived",
  "connection_disconnected",
  "sidekick_deleted",
  "closed",
]);
export type ExternalBindingSuspensionReason = z.infer<typeof ExternalBindingSuspensionReasonSchema>;

export const ExternalBindingSchema = z.strictObject({
  installationId: ExternalInstallationIdSchema,
  path: ExternalPathSchema,
  target: ExternalBindingTargetSchema,
  state: ExternalBindingStateSchema,
  suspendedReason: ExternalBindingSuspensionReasonSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type ExternalBinding = z.infer<typeof ExternalBindingSchema>;

/** The key every request names. */
const BindingKeySchema = z.strictObject({
  workspaceId: IdSchema,
  installationId: ExternalInstallationIdSchema,
  path: ExternalPathSchema,
});

/**
 * Resolve one verified message's path, in one read.
 *
 * `claimKey` identifies the caller's own creation attempt (for Slack, the
 * ingress event), so a retry of the event that claimed a pending binding
 * resumes it instead of waiting behind itself. `pendingStaleBefore` is the
 * instant before which an unfinished claim is abandoned and may be taken over;
 * the caller supplies it from the fence it already runs creation under.
 */
export const ExternalBindingResolveRequestSchema = deferredZodSchema(() => BindingKeySchema.extend({
  addressed: z.boolean(),
  claimKey: z.string().min(1).nullable(),
  pendingStaleBefore: TimestampSchema,
}).strict());
export type ExternalBindingResolveRequest = z.infer<typeof ExternalBindingResolveRequestSchema>;

export const ExternalBindingResolutionSchema = deferredZodSchema(() => z.discriminatedUnion("outcome", [
  /** The path or an ancestor is suspended: nothing is delivered or created. */
  z.strictObject({
    outcome: z.literal("suspended"),
    path: ExternalPathSchema,
    reason: ExternalBindingSuspensionReasonSchema,
  }),
  /** The exact path is bound to a conversation: deliver there. */
  z.strictObject({ outcome: z.literal("deliver"), target: ExternalBindingConversationTargetSchema }),
  /** Another attempt is creating the conversation this path will point at. */
  z.strictObject({ outcome: z.literal("hold") }),
  /** Nothing to do: the path routes nowhere. */
  z.strictObject({ outcome: z.literal("none") }),
]));
export type ExternalBindingResolution = z.infer<typeof ExternalBindingResolutionSchema>;

/** Claim a thread path `pending` for a conversation being created. */
export const ExternalBindingClaimSchema = deferredZodSchema(() => z.strictObject({
  installationId: ExternalInstallationIdSchema,
  path: ExternalPathSchema,
  claimKey: z.string().min(1),
  pendingStaleBefore: TimestampSchema,
}));
export type ExternalBindingClaim = z.infer<typeof ExternalBindingClaimSchema>;

export const ExternalBindingSettleRequestSchema = deferredZodSchema(() => BindingKeySchema.extend({
  target: ExternalBindingConversationTargetSchema,
  at: TimestampSchema,
}).strict());
export type ExternalBindingSettleRequest = z.infer<typeof ExternalBindingSettleRequestSchema>;

export const ExternalBindingActivateResultSchema = z.strictObject({
  outcome: z.enum(["activated", "already_active", "missing", "conflict"]),
});
export const ExternalBindingReleaseResultSchema = z.strictObject({
  outcome: z.enum(["released", "absent"]),
});

export const ExternalBindingReadRequestSchema = deferredZodSchema(() => BindingKeySchema);
export type ExternalBindingReadRequest = z.infer<typeof ExternalBindingReadRequestSchema>;
export const ExternalBindingReadResultSchema = deferredZodSchema(() => z.strictObject({
  binding: ExternalBindingSchema.nullable(),
}));

/** An outbound send's reply thread, bound to the run child that sent it. */
export const ExternalBindingOutboundRequestSchema = deferredZodSchema(() => BindingKeySchema.extend({
  target: ExternalBindingConversationTargetSchema,
  at: TimestampSchema,
}).strict());
export type ExternalBindingOutboundRequest = z.infer<typeof ExternalBindingOutboundRequestSchema>;
export const ExternalBindingOutboundResultSchema = z.strictObject({
  outcome: z.enum(["bound", "already_bound", "conflict"]),
});

export const ExternalBindingLatestOutboundRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  installationId: ExternalInstallationIdSchema,
  /** The room whose descendants are searched; the room itself is not a candidate. */
  prefix: ExternalPathSchema,
}));
export type ExternalBindingLatestOutboundRequest = z.infer<typeof ExternalBindingLatestOutboundRequestSchema>;
/** The most recent Sidekick run request under a room, and the run it belongs to. */
export const ExternalBindingLatestOutboundResultSchema = deferredZodSchema(() => z.strictObject({
  latest: z.strictObject({
    path: ExternalPathSchema,
    sidekickId: IdSchema,
    runId: IdSchema,
  }).nullable(),
}));

export const ExternalBindingSuspendRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  installationId: ExternalInstallationIdSchema,
  /** Omitted: every active binding of the installation. */
  path: ExternalPathSchema.optional(),
  reason: ExternalBindingSuspensionReasonSchema,
  at: TimestampSchema,
}));
export type ExternalBindingSuspendRequest = z.infer<typeof ExternalBindingSuspendRequestSchema>;

export const ExternalBindingReactivateRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  installationId: ExternalInstallationIdSchema,
  /**
   * Omitted: every binding a disconnect suspended. Named: that one room, when
   * the bot left it or it was archived and the bot is now back.
   */
  path: ExternalPathSchema.optional(),
  at: TimestampSchema,
}));
export type ExternalBindingReactivateRequest = z.infer<typeof ExternalBindingReactivateRequestSchema>;

export const ExternalBindingSuspendResultSchema = deferredZodSchema(() => z.strictObject({
  suspended: z.array(ExternalPathSchema),
}));

/** A provider room changed its identifier; every path under it moves with it. */
export const ExternalBindingMoveRequestSchema = deferredZodSchema(() => z.strictObject({
  workspaceId: IdSchema,
  installationId: ExternalInstallationIdSchema,
  from: ExternalPathSchema,
  to: ExternalPathSchema,
  at: TimestampSchema,
}));
export type ExternalBindingMoveRequest = z.infer<typeof ExternalBindingMoveRequestSchema>;
export const ExternalBindingMoveResultSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("moved"), count: z.number().int().nonnegative() }),
  /** A path under the new identifier is already bound; nothing moved. */
  z.strictObject({ outcome: z.literal("conflict") }),
]);
