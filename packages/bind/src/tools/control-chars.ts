/**
 * The character set stripped from any untrusted text the harness interpolates
 * into a message a model, a log, or a person will read.
 *
 * One definition, two call sites with different needs — a run interrupt's user
 * id (removed outright, so it cannot forge lines in the `[Interrupt from user
 * ...]` header) and a tool-argument path or name quoted back in a validation
 * failure (replaced with a space, so adjacent tokens stay separated, and
 * truncated). The *replacement* is the caller's choice; the *set* must not be,
 * because it is the security decision. Two copies means a future addition —
 * bidi overrides, say — lands in one and is forgotten in the other.
 *
 * Deliberately dependency-free: `@juno-ai/bind/loop` uses it, and that
 * subpath's module graph is kept free of runtime `zod`.
 */

/**
 * C0 controls, DEL, C1 controls, and the Unicode line/paragraph separators.
 *
 * Module-private because it carries the `g` flag and is therefore stateful
 * under `.test()` / `.exec()`. `String.replace` resets `lastIndex` itself, so
 * routing every caller through {@link stripControlChars} keeps that hazard in
 * one place.
 */
// eslint-disable-next-line no-control-regex -- Control characters are the characters this filter removes.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Remove control characters from `text`, optionally bounding its length.
 *
 * @param replacement what each stripped character becomes — `""` to delete it,
 *   `" "` to keep surrounding words apart.
 * @param maxLength truncate the result to at most this many characters.
 */
export function stripControlChars(
  text: string,
  replacement = "",
  maxLength?: number,
): string {
  const stripped = text.replace(CONTROL_CHARS, replacement);
  return maxLength === undefined ? stripped : stripped.slice(0, maxLength);
}
