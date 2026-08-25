/**
 * The canonical implementation lives in `@rally/contracts`, beside the schemas
 * whose `max()` bounds it enforces, so `@rally/db` can apply the same bound to
 * the same column. Re-exported here because every existing call site in this app
 * imports it from this path.
 */
export { truncateUtf16Safe } from "@rally/contracts/text";

/**
 * The first line of a message with anything on it.
 *
 * What a work stream's provisional title and provisional description are both
 * derived from, before a model has written either. A person's opening line is
 * what they are asking for; the paragraphs, templates and pasted transcripts
 * under it are how they are asking for it, and neither a sidebar title nor a
 * sidebar description is the place for that. Null when the message is entirely
 * blank — a create carrying only attachments — which each caller answers with
 * its own fallback rather than an empty label.
 */
export function firstNonEmptyLine(value: string): string | null {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?? null;
}
