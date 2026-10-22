import { z } from "zod";

import { IdSchema, SubstreamIdSchema, UserIdSchema, WorkstreamIdSchema } from "./identifiers";
import { WorkstreamAppearanceSchema } from "./workstream-appearance";

/**
 * What an Organization member who holds a link to a Channel or Breakout may
 * learn about it before they are in it: its name and its mark, and whether
 * they can open it already.
 *
 * `open` means the conversation admits them and the failure they saw was
 * something else. `requestable` means it does not, and "Request access" asks
 * its creator. Nothing of the conversation's content, roster or description
 * crosses here: a link is routing context, not a capability
 * (`docs/channel-access-requests.md`).
 */
export const ConversationAccessPreviewSchema = z.object({
  kind: z.enum(["channel", "breakout"]),
  title: z.string(),
  appearance: WorkstreamAppearanceSchema.nullable(),
  /** The id the mark resolves unset parts from: the Channel's when a Breakout wears the Channel's look. */
  markId: z.string(),
  access: z.enum(["open", "requestable"]),
  /** Whether this viewer already has a pending request for this conversation. */
  requestPending: z.boolean().default(false),
  /** A pending request whose email failed can be sent again under the same idempotency key. */
  requestEmailed: z.boolean().default(false),
});
export type ConversationAccessPreview = z.infer<typeof ConversationAccessPreviewSchema>;

/** `sent` once an approver was emailed; the client says so and waits for the socket to open. */
export const ConversationAccessRequestResultSchema = z.strictObject({
  status: z.literal("sent"),
});
export type ConversationAccessRequestResult = z.infer<typeof ConversationAccessRequestResultSchema>;

/**
 * One pending request in its approver's list: who asked, for what, and the
 * conversation's name and mark as they are now. Only the approver is sent it.
 */
export const ConversationAccessRequestItemSchema = z.strictObject({
  id: IdSchema,
  parentId: WorkstreamIdSchema,
  substreamId: SubstreamIdSchema,
  kind: z.enum(["channel", "breakout"]),
  title: z.string(),
  appearance: WorkstreamAppearanceSchema.nullable(),
  /** The Channel's id, or the Breakout's when it has a look of its own. */
  markId: IdSchema,
  requesterUserId: UserIdSchema,
  requesterName: z.string(),
  requestedAt: z.string().datetime(),
});
export type ConversationAccessRequestItem = z.infer<typeof ConversationAccessRequestItemSchema>;

/**
 * The approver's whole pending list, sent to their sockets only, whenever it
 * changes. Outside the waterline and never replayed: the subscribe answer's
 * `accessRequests` carries it again on every connect. Older clients ignore
 * the unknown `type`.
 */
export const WorkspaceAccessRequestsEventSchema = z.strictObject({
  type: z.literal("workspace_access_requests"),
  requests: z.array(ConversationAccessRequestItemSchema),
});
export type WorkspaceAccessRequestsEvent = z.infer<typeof WorkspaceAccessRequestsEventSchema>;

/** What approving or declining from the app did; `settled` means someone already had. */
export const ConversationAccessDecisionResultSchema = z.strictObject({
  status: z.enum(["approved", "declined", "settled"]),
});
export type ConversationAccessDecisionResult = z.infer<typeof ConversationAccessDecisionResultSchema>;
