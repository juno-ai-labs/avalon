import { AGENT_MESSAGE_CONTENT_KIND, AgentExchangeSchema } from "@rally/contracts";
import { z } from "zod";

/** Durable message content used both on admission and when rebuilding model context. */
export const AgentMessageContentSchema = AgentExchangeSchema.extend({
  kind: z.literal(AGENT_MESSAGE_CONTENT_KIND),
  attachmentIds: z.array(z.string().uuid()),
});

export function renderAgentMessage(content: z.infer<typeof AgentMessageContentSchema>, text: string): string {
  return [
    `Message from agent ${content.senderAgentId}.`,
    `Message ID: ${content.messageId}. Use this message ID when responding to the sender.`,
    `Team: ${content.teamId}.`,
    text,
    ...(content.attachmentIds.length
      ? [`Attached resource IDs: ${content.attachmentIds.join(", ")}. Use the resource tools to inspect them.`] : []),
  ].join("\n");
}
