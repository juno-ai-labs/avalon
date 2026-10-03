/** Self-contained so the browser wrapper can embed the same function in the page. */
export function normalizePageText(
  text: string,
  replacements: Array<{ marker: string; text: string }> = [],
): string {
  if (typeof text !== 'string') throw new Error('rally.normalizeText text must be a string.');
  // Citations use private-use markers. Provider references also contain ordinary
  // spaces and prose: those must never become global text replacements.
  const privateUse = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
  for (const replacement of replacements) {
    if (typeof replacement.marker !== 'string' || typeof replacement.text !== 'string') {
      throw new Error('rally.normalizeText replacements need string marker and text fields.');
    }
    if (privateUse.test(replacement.marker)) text = text.split(replacement.marker).join(replacement.text);
  }
  // An unmapped inline citation is provider syntax, including the identifier
  // between its delimiters; removing only the delimiters would expose that ID.
  text = text.replace(/\uE200[^\uE201]*\uE201/gu, '');
  // Markdown needs tabs, newlines and carriage returns. Remove only the other
  // controls and any provider private-use syntax that was not converted above.
  // eslint-disable-next-line no-control-regex -- This conversion intentionally removes invalid controls from provider text.
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu, '');
}
