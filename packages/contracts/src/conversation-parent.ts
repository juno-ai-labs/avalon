import { z } from "zod";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";
import {
  ContextPluginRefSchema,
  ContextConfigSchema,
  PreparedSubstreamContextSchema,
  SubstreamContextCaptureSchema,
  SubstreamContextRecipeSchema,
} from "./substream-creation";

/**
 * The two kinds of thing a conversation can belong to.
 *
 * A `SubstreamAgent` is one ordered transcript and one agent loop; it does not
 * decide who may read it or where its state rolls up. Its parent does. A work
 * stream's parent is `WorkstreamDO`; an automation's parent is `AutomationDO`.
 * Both answer the same five questions below, so everything between the Worker
 * and a conversation object is written once against this contract rather than
 * once per kind of parent.
 */
export const ConversationParentKindSchema = z.enum(["workstream", "automation"]);
export type ConversationParentKind = z.infer<typeof ConversationParentKindSchema>;

export const ConversationParentRefSchema = z.strictObject({
  kind: ConversationParentKindSchema,
  id: IdSchema,
});
export type ConversationParentRef = z.infer<typeof ConversationParentRefSchema>;

const ParentAddressed = {
  workspaceId: WorkspaceIdSchema,
  parentId: IdSchema,
} as const;

/** May this person open the parent's conversations, and is the parent archived. */
export const ConversationParentAuthorizeViewerRequestSchema = z.strictObject({
  ...ParentAddressed,
  userId: UserIdSchema,
  substreamId: SubstreamIdSchema.optional(),
});
export const ConversationParentAuthorizeViewerResultSchema = z.strictObject({
  authorized: z.boolean(),
  archived: z.boolean(),
  childStatus: z.enum(["reserved", "ready", "failed"]).nullable().optional(),
  membershipVersion: z.number().int().nonnegative().optional(),
});

/** Whether the parent exists, and the generation and archive state its children inherit. */
export const ConversationParentAuthorityRequestSchema = z.strictObject(ParentAddressed);
export const ConversationParentAuthorityResultSchema = z.strictObject({
  exists: z.boolean(),
  authorityGeneration: z.number().int().nonnegative(),
  archived: z.boolean(),
});

/**
 * Record a child before it is addressed.
 *
 * Idempotent on `(parentId, substreamId)`. Registering the main conversation
 * (`"0"`) of a work stream also carries the directory fields the parent needs
 * to materialize its provisional workspace-directory row synchronously, so the
 * person who created it sees it before the child's first state message lands.
 */
export const ConversationParentReserveChildRequestSchema = z.strictObject({
  ...ParentAddressed,
  substreamId: SubstreamIdSchema,
  kind: z.enum(["main", "child"]),
  createdByUserId: UserIdSchema.nullable(),
  /**
   * The regional authority generation the caller is creating under. A parent
   * that does not exist yet is born at this generation; one that does answers
   * with its own and ignores this.
   */
  authorityGeneration: z.number().int().positive(),
  directory: z.strictObject({
    title: z.string().min(1).max(500),
    description: z.string().max(4_000),
    scope: z.enum(["personal", "workspace"]),
    systemKind: z.enum(["digest"]).nullable(),
    emailAddress: z.string().email().max(254).nullable(),
    titleStatus: z.enum(["naming", "automatic", "settled"]),
    createdAt: z.string().datetime({ offset: true }),
  }).optional(),
});
export const ConversationParentReserveChildResultSchema = z.strictObject({
  reserved: z.literal(true),
  authorityGeneration: z.number().int().nonnegative(),
});

export const ConversationParentListChildrenRequestSchema = z.strictObject(ParentAddressed);
export const ConversationParentListChildrenResultSchema = z.strictObject({
  children: z.array(z.strictObject({
    substreamId: SubstreamIdSchema,
    kind: z.enum(["main", "child"]),
    createdAt: z.number().int().nonnegative(),
  })),
});

const PrivateChildOperationAddress = {
  ...ParentAddressed,
  operationId: z.string().min(1).max(180),
} as const;

export const PrivateChildPreparationStatusSchema = z.enum([
  "preparing", "prepared", "confirming", "ready", "failed",
]);

export const PrivateChildPreparationOperationSchema = z.strictObject({
  operationId: z.string().min(1).max(180),
  substreamId: SubstreamIdSchema,
  creatorUserId: UserIdSchema,
  title: z.string().min(1).max(500),
  sourceSubstreamId: z.literal("0"),
  sourceThroughTurnId: z.string().min(1).nullable(),
  recipe: SubstreamContextRecipeSchema,
  status: PrivateChildPreparationStatusSchema,
  capture: SubstreamContextCaptureSchema.nullable(),
  completedParts: PreparedSubstreamContextSchema.shape.parts,
  preparedContext: PreparedSubstreamContextSchema.nullable(),
  errorCode: z.string().min(1).max(180).nullable(),
  membershipVersion: z.number().int().positive(),
  membershipInitializer: z.strictObject({
    plugin: ContextPluginRefSchema,
    config: ContextConfigSchema,
    memberUserIds: z.array(UserIdSchema).min(1),
  }),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const BeginPrivateChildPreparationRequestSchema = z.strictObject({
  ...PrivateChildOperationAddress,
  creatorUserId: UserIdSchema,
  title: z.string().min(1).max(500),
  sourceSubstreamId: z.literal("0"),
  sourceThroughTurnId: z.string().min(1).nullable(),
  recipe: SubstreamContextRecipeSchema,
  membershipInitializer: z.strictObject({
    plugin: ContextPluginRefSchema,
    config: ContextConfigSchema,
    memberUserIds: z.array(UserIdSchema).min(1),
  }),
});
export const ReadPrivateChildPreparationRequestSchema = z.strictObject(PrivateChildOperationAddress);
export const ClaimPrivateChildConfirmationRequestSchema = z.strictObject({
  ...PrivateChildOperationAddress,
  actorUserId: UserIdSchema,
});
export const SavePrivateChildCaptureRequestSchema = z.strictObject({
  ...PrivateChildOperationAddress,
  capture: SubstreamContextCaptureSchema,
});
export const SavePrivateChildPartRequestSchema = z.strictObject({
  ...PrivateChildOperationAddress,
  part: PreparedSubstreamContextSchema.shape.parts.element,
});
export const SavePreparedPrivateChildContextRequestSchema = z.strictObject({
  ...PrivateChildOperationAddress,
  preparedContext: PreparedSubstreamContextSchema,
});
export const SetPrivateChildTerminalStatusRequestSchema = z.strictObject({
  ...PrivateChildOperationAddress,
  status: z.enum(["ready", "failed"]),
  errorCode: z.string().min(1).max(180).nullable().default(null),
});

export const ListVisiblePrivateChildrenRequestSchema = z.strictObject({
  ...ParentAddressed,
  userId: UserIdSchema,
});
export const ListVisiblePrivateChildrenResultSchema = z.strictObject({
  children: z.array(z.strictObject({
    substreamId: SubstreamIdSchema,
    title: z.string().min(1).max(500),
    createdByUserId: UserIdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    /** This viewer's attention state for the child, from its own projection. */
    unreadCount: z.number().int().nonnegative().default(0),
    youAreMentioned: z.boolean().default(false),
  })),
});

/**
 * Archive or restore one private child.
 *
 * Archiving is the work stream's own `archived` field one level down, so the
 * request carries the state to move to rather than naming an action: the same
 * call restores, and a repeat of either is not an error.
 */
export const SetPrivateChildArchivedRequestSchema = z.strictObject({
  ...ParentAddressed,
  substreamId: SubstreamIdSchema.refine((value) => value !== "0", "A private child must be nonzero"),
  actorUserId: UserIdSchema,
  archived: z.boolean(),
});
export const SetPrivateChildArchivedResultSchema = z.strictObject({
  outcome: z.enum(["archived", "restored", "unchanged"]),
  archivedAt: z.number().int().nonnegative().nullable(),
});

export const MutatePrivateChildParticipantRequestSchema = z.strictObject({
  ...ParentAddressed,
  substreamId: SubstreamIdSchema.refine((value) => value !== "0", "A private child must be nonzero"),
  actorUserId: UserIdSchema,
  userId: UserIdSchema,
  operationId: z.string().min(1).max(180),
});
export const MutatePrivateChildParticipantResultSchema = z.strictObject({
  outcome: z.enum(["added", "removed", "unchanged", "not_found"]),
  membershipVersion: z.number().int().positive(),
});

export type ConversationParentAuthorizeViewerRequest =
  z.infer<typeof ConversationParentAuthorizeViewerRequestSchema>;
export type ConversationParentAuthorizeViewerResult =
  z.infer<typeof ConversationParentAuthorizeViewerResultSchema>;
export type ConversationParentAuthorityRequest =
  z.infer<typeof ConversationParentAuthorityRequestSchema>;
export type ConversationParentAuthorityResult =
  z.infer<typeof ConversationParentAuthorityResultSchema>;
export type ConversationParentReserveChildRequest =
  z.infer<typeof ConversationParentReserveChildRequestSchema>;
export type ConversationParentReserveChildResult =
  z.infer<typeof ConversationParentReserveChildResultSchema>;
export type ConversationParentListChildrenRequest =
  z.infer<typeof ConversationParentListChildrenRequestSchema>;
export type ConversationParentListChildrenResult =
  z.infer<typeof ConversationParentListChildrenResultSchema>;
export type PrivateChildPreparationOperation = z.infer<typeof PrivateChildPreparationOperationSchema>;
export type BeginPrivateChildPreparationRequest = z.infer<typeof BeginPrivateChildPreparationRequestSchema>;
export type ReadPrivateChildPreparationRequest = z.infer<typeof ReadPrivateChildPreparationRequestSchema>;
export type ClaimPrivateChildConfirmationRequest = z.infer<typeof ClaimPrivateChildConfirmationRequestSchema>;
export type SavePrivateChildCaptureRequest = z.infer<typeof SavePrivateChildCaptureRequestSchema>;
export type SavePrivateChildPartRequest = z.infer<typeof SavePrivateChildPartRequestSchema>;
export type SavePreparedPrivateChildContextRequest = z.infer<typeof SavePreparedPrivateChildContextRequestSchema>;
export type SetPrivateChildTerminalStatusRequest = z.infer<typeof SetPrivateChildTerminalStatusRequestSchema>;
export type ListVisiblePrivateChildrenRequest = z.infer<typeof ListVisiblePrivateChildrenRequestSchema>;
export type ListVisiblePrivateChildrenResult = z.infer<typeof ListVisiblePrivateChildrenResultSchema>;
export type MutatePrivateChildParticipantRequest = z.infer<typeof MutatePrivateChildParticipantRequestSchema>;
export type MutatePrivateChildParticipantResult = z.infer<typeof MutatePrivateChildParticipantResultSchema>;
export type SetPrivateChildArchivedRequest = z.infer<typeof SetPrivateChildArchivedRequestSchema>;
export type SetPrivateChildArchivedResult = z.infer<typeof SetPrivateChildArchivedResultSchema>;
