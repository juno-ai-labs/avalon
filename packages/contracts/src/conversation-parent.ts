import { z } from "zod";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";
import { HarnessStatusSchema } from "./conversation-attention";
import {
  ContextPluginRefSchema,
  ContextConfigSchema,
  PreparedSubstreamContextSchema,
  SubstreamContextCaptureSchema,
  SubstreamContextRecipeSchema,
} from "./substream-creation";

/**
 * The three kinds of thing a conversation can belong to.
 *
 * An `AgentLoopDO` is one ordered transcript and one agent loop; it does not
 * decide who may read it or where its state rolls up. Its parent does. A work
 * stream's parent is `WorkstreamDO`; an automation's parent is `AutomationDO`;
 * a Space's parent is `SpaceDO`. All three answer the same five questions
 * below, so everything between the Worker and a conversation object is written
 * once against this contract rather than once per kind of parent.
 *
 * `space` is a *parent* kind and not a product surface. A Space's hidden main
 * conversation holds its participants and resources exactly as a Channel's
 * does, and that is the whole reason it is a conversation at all — but Rally
 * never opens it: no feed socket, no agent loop, no naming or description pass,
 * no Sidekick skills. A branch that means "an ordinary Channel conversation"
 * therefore tests `=== "workstream"`, never `!== "automation"`.
 */
export const ConversationParentKindSchema = z.enum(["workstream", "automation", "space", "canvas"]);
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
  /** Require completed canonical grant authority; never fall back to a legacy roster. */
  requireGrantAuthority: z.boolean().optional(),
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
    /**
     * A thread's birth appearance: no icon yet, and its Channel's colour, so
     * the provisional row is drawn in the colour it will keep. Absent for a
     * Breakout and for a parent that has no Channel.
     */
    appearance: WorkstreamAppearanceSchema.optional(),
  }).optional(),
  /**
   * Creation may overlap the provisional workspace-directory delivery with
   * child initialization, then explicitly flush it before answering. Omitted
   * by every existing caller, which preserves the synchronous default.
   */
  deferDirectoryDelivery: z.boolean().optional(),
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

/**
 * Every conversation of the parent that reports a Terminal deadline, with the
 * deadline. A conversation that holds a Daytona sandbox always reports one —
 * retention alone gives it an expiry — so this is also the list of the
 * parent's conversations that own a sandbox.
 */
export const ConversationParentTerminalDeadlinesRequestSchema = z.strictObject(ParentAddressed);
export const ConversationParentTerminalDeadlinesResultSchema = z.strictObject({
  items: z.array(z.strictObject({
    substreamId: SubstreamIdSchema,
    nextTerminalActionAt: z.string().datetime({ offset: true }),
  })),
});
export type ConversationParentTerminalDeadlinesRequest =
  z.infer<typeof ConversationParentTerminalDeadlinesRequestSchema>;
export type ConversationParentTerminalDeadlinesResult =
  z.infer<typeof ConversationParentTerminalDeadlinesResultSchema>;

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
  preparedConversationHash: z.string().regex(/^fnv1a64:[a-f0-9]{16}$/).nullable().default(null),
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
  preparedConversationHash: z.string().regex(/^fnv1a64:[a-f0-9]{16}$/).nullable().optional(),
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
  /**
   * The title the child is published under, where confirmation has a better one
   * than preparation reserved. Preparation happens before the opening message
   * exists, so the title it wrote is a placeholder; carrying the real one here
   * means the registry row and the child object agree in the same write that
   * makes the row visible, rather than the sidebar showing the placeholder
   * until the naming pass converges it a second or two later.
   */
  title: z.string().min(1).max(500).optional(),
});

export const ListVisiblePrivateChildrenRequestSchema = z.strictObject({
  ...ParentAddressed,
  userId: UserIdSchema,
});
export const ListVisiblePrivateChildrenResultSchema = z.strictObject({
  children: z.array(z.strictObject({
    resolved: z.boolean().optional(),
    substreamId: SubstreamIdSchema,
    title: z.string().min(1).max(500),
    appearance: WorkstreamAppearanceSchema.optional(),
    harnessStatus: HarnessStatusSchema.optional(),
    unreadCount: z.number().int().nonnegative().optional(),
    youAreMentioned: z.boolean().optional(),
    unseen: z.boolean().optional(),
    createdByUserId: UserIdSchema,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    /** The Main transcript turn the breakout was branched through; null when it was not branched from a turn. */
    originTurnId: z.string().min(1).nullable().optional(),
    /** Epoch milliseconds, like `createdAt`; absent until the breakout's directory state has arrived. */
    lastActivityAt: z.number().int().nonnegative().optional(),
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

/**
 * The same listing, asked by a caller that is about to close this parent.
 *
 * Retirement needs "this object was never built" and "this object disagrees
 * about which parent it is" as *answers*, not exceptions. Deciding either by
 * comparing an error message across an RPC boundary is one rename away from
 * permanently tombstoning a parent without walking its children.
 */
export const ConversationParentRetirementChildrenResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    children: z.array(z.strictObject({
      substreamId: SubstreamIdSchema,
      kind: z.enum(["main", "child"]),
      createdAt: z.number().int().nonnegative(),
    })),
  }),
  /** Named by a directory, never materialized. It has no children by construction. */
  z.strictObject({ status: z.literal("missing") }),
  /** Built, and holding a different identity than the directory row that named it. */
  z.strictObject({ status: z.literal("identity_mismatch") }),
]);
export type ConversationParentRetirementChildrenResult =
  z.infer<typeof ConversationParentRetirementChildrenResultSchema>;

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
