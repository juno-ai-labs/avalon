import { AGENT_MESSAGE_CONTENT_KIND, AgentExchangeSchema } from "@rally/contracts";
import { z } from "zod";

/** Durable message content used both on admission and when rebuilding model context. */
export const AgentMessageContentSchema = AgentExchangeSchema.extend({
  kind: z.literal(AGENT_MESSAGE_CONTENT_KIND),
  attachmentIds: z.array(z.string().uuid()),
});

