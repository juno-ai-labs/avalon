import { ElicitationSchema, type Message } from "@rally/contracts";
import { z } from "zod";

const CanonicalElicitationContentSchema = z.object({
  kind: z.literal("elicitation"),
  elicitation: ElicitationSchema.pick({ prompt: true }),
});

/** Render only content that was reloaded from one canonical transcript turn. */
export function canonicalExternalResultText(message: Message | null): string | null {
  if (!message) return null;
  if (message.messageType === "elicitation") {
    const elicitation = CanonicalElicitationContentSchema.safeParse(message.structuredContent);
    if (elicitation.success) return elicitation.data.elicitation.prompt.trim() || null;
  }
  return message.textContent.trim() || null;
}
