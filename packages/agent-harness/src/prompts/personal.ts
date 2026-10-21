/** The member's standing instructions, carried with their user-role message. */
export function renderPersonalSystemPrompt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
${trimmed}
</user_suppplied>
</user_system_prompt>`;
}
