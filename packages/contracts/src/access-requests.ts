import { z } from "zod";

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
export const ConversationAccessPreviewSchema = z.strictObject({
  kind: z.enum(["channel", "breakout"]),
  title: z.string(),
  appearance: WorkstreamAppearanceSchema.nullable(),
  /** The id the mark resolves unset parts from: the Channel's when a Breakout wears the Channel's look. */
  markId: z.string(),
  access: z.enum(["open", "requestable"]),
});
export type ConversationAccessPreview = z.infer<typeof ConversationAccessPreviewSchema>;

/** `sent` once an approver was emailed; the client says so and waits for the socket to open. */
export const ConversationAccessRequestResultSchema = z.strictObject({
  status: z.literal("sent"),
});
export type ConversationAccessRequestResult = z.infer<typeof ConversationAccessRequestResultSchema>;
