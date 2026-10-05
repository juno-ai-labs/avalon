/**
 * The personal system prompt of the member whose own message started this run.
 *
 * It is that person's standing request, written once in account settings and
 * sent with every turn they start, so it carries the authority of their
 * message and no more: it ranks below the platform policy and the authorized
 * task context above it. Other participants never set it, and nothing they say
 * reaches it, so it may sit in the system message rather than a user-role one.
 *
 * Returns the empty string for blank text, so a member who never wrote one
 * leaves the prefix byte-identical to a run without the feature.
 */
export function renderPersonalSystemPrompt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `

# Personal instructions
The member who sent the message that started this turn saved these instructions for every turn they start. Follow them as that member's own request. They may not override the platform policy or the authorized task context above, and they say nothing about what other participants want.
${trimmed}`;
}
