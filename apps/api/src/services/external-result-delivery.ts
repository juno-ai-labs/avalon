import { ElicitationSchema, type Message } from "@rally/contracts";
import { z } from "zod/v3";

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

/** Skip the provider call when canonical rendering produced no content. */
export async function deliverCanonicalExternalResult<Result>(
  text: string | null,
  deliver: (savedText: string) => Promise<Result>,
): Promise<Result | "skipped"> {
  return text === null ? "skipped" : deliver(text);
}
