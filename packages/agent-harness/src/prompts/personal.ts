import { PERSONAL_SYSTEM_PROMPT_PREFIX, PERSONAL_SYSTEM_PROMPT_SUFFIX } from "@rally/contracts/text";

/** The member's standing instructions, carried with their user-role message. */
export function renderPersonalSystemPrompt(text: string): string {
  const trimmed = text.trim().replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  if (!trimmed) return "";
  return `${PERSONAL_SYSTEM_PROMPT_PREFIX}${trimmed}${PERSONAL_SYSTEM_PROMPT_SUFFIX}`;
}
