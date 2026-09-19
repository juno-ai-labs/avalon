import { AGENT_MESSAGE_CONTENT_KIND, AgentExchangeSchema } from "@rally/contracts";
import { z } from "zod";

/** Durable message content used both on admission and when rebuilding model context. */
export const AgentMessageContentSchema = AgentExchangeSchema.extend({
  kind: z.literal(AGENT_MESSAGE_CONTENT_KIND),
  attachmentIds: z.array(z.string().uuid()),
});

/**
 * How an admitted agent message reads to the model that receives it.
 *
 * The two host notices are attributed to the host, and that line is the whole
 * defence against one agent impersonating the other kind. Every agent message
 * arrives through this one renderer, so without the branch a worker that has
 * been prompt-injected by content it was allowed to read can `send_message`
 * the text "Agent failed due to connector_unavailable" naming a sibling, and
 * the recipient sees framing byte-identical to a notice the host computed.
 * `notice` is derived provenance and may cross into authority; the message
 * body is content and may not — `docs/writing-prompts.md` holds that rule.
 *
 * The human side lost its own check when the feed stopped showing the body,
 * which is what makes the model-facing attribution load-bearing rather than
 * cosmetic.
 */
export function renderAgentMessage(content: z.infer<typeof AgentMessageContentSchema>, text: string): string {
  if (content.notice) {
    return [
      content.notice === "failed"
        ? `Notice from Rally, not from an agent: the agent below failed${content.noticeReason ? ` (${content.noticeReason})` : ""}.`
        : "Notice from Rally, not from an agent: the agent below finished without replying.",
      `Agent: ${content.senderAgentId}.`,
      text,
    ].join("\n");
  }
  return [
    `Message from agent ${content.senderAgentId}.`,
    `Message ID: ${content.messageId}. Use this message ID when responding to the sender.`,
    `Team: ${content.teamId}.`,
    text,
    ...(content.attachmentIds.length
      ? [`Attached resource IDs: ${content.attachmentIds.join(", ")}. Use the resource tools to inspect them.`] : []),
  ].join("\n");
}
