/** Shared by the instruction generator and display filter; iOS mirrors this envelope. */
export const PERSONAL_SYSTEM_PROMPT_PREFIX = `<user_system_prompt>
The following was provided by this user as instructions for how to respond to this message. For other users' requests ignore these instructions.
<user_suppplied>
`;
export const PERSONAL_SYSTEM_PROMPT_SUFFIX = "\n</user_suppplied>\n</user_system_prompt>";

/**
 * Remove the one generated personal-instruction envelope from display text.
 * Stored/model history retains it. Match the preamble as well as the tags so
 * XML examples in an ordinary message stay visible. Call before truncating.
 */
export function stripPersonalSystemPrompt(text: string): string {
  if (!text.startsWith(PERSONAL_SYSTEM_PROMPT_PREFIX)) return text;
  const end = text.indexOf(PERSONAL_SYSTEM_PROMPT_SUFFIX, PERSONAL_SYSTEM_PROMPT_PREFIX.length);
  return end < 0 ? text : text.slice(end + PERSONAL_SYSTEM_PROMPT_SUFFIX.length).replace(/^\n{0,2}/u, "");
}

/**
 * Truncates to at most `maxLength` UTF-16 code units without splitting a
 * surrogate pair at the boundary. `String.prototype.slice` and Zod's
 * `z.string().max()` both count code units, so a plain `.slice(0, N)` can
 * land inside an emoji or other non-BMP character and leave a lone
 * surrogate that renders as U+FFFD.
 *
 * This lives beside the schemas that declare the bounds it enforces, because
 * both the API and `@rally/db` have to apply the same bound to the same
 * column: a value written past a contract's `max()` is a row that fails its own
 * response schema on every subsequent read.
 */
export function truncateUtf16Safe(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const code = value.charCodeAt(maxLength - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? maxLength - 1 : maxLength;
  return value.slice(0, end);
}

/** The participant's words as shown in the feed, without their private instruction prefix. */
export function visibleParticipantText(text: string, actor: string): string {
  return actor === "human" || actor === "external"
    ? stripPersonalSystemPrompt(text)
    : text;
}
