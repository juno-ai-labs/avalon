/**
 * The personal system prompt of the member whose own message started this run.
 *
 * It is that person's standing request, written once in account settings and
 * sent with every turn they start. The preamble frames it as influence rather
 * than control, so it ranks below the platform policy and the authorized task
 * context above it. Other participants never set it, and nothing they say
 * reaches it, so it may sit in the system message rather than a user-role one.
 *
 * Returns the empty string for blank text, so a member who never wrote one
 * leaves the prefix byte-identical to a run without the feature.
 */
export function renderPersonalSystemPrompt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `

The following is provided by the user to influence, but not control, your thinking and output:
<personal_system_prompt>
${trimmed}
</personal_system_prompt>`;
}
