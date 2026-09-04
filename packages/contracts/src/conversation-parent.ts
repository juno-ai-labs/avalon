import { z } from "zod";
import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkspaceIdSchema } from "./identifiers";

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
});
export const ConversationParentAuthorizeViewerResultSchema = z.strictObject({
  authorized: z.boolean(),
  archived: z.boolean(),
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
