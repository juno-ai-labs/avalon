import { z } from "zod";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";

/**
 * The two kinds of thing a conversation can belong to: a Sidekick
 * (`automation`, storage `AutomationDO`) or a Canvas (`canvas`, whose chat is
 * a `workstream` id in storage).
 *
 * An `AgentLoopDO` is one ordered transcript and one agent loop; it does not
 * decide who may read it or where its state rolls up. Its parent does, and
 * both kinds answer the same questions below, so everything between the
 * Worker and a conversation object is written once against this contract.
 * The Thread (`workstream`) and Space (`space`) parents retired with the
 * Canvases and Sidekicks pivot; a stored root that still names one is read
 * through `hostedConversationParentKind` (workstream-object-storage.ts) and
 * refused by name.
 */
export const ConversationParentKindSchema = z.enum(["automation", "canvas"]);
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
