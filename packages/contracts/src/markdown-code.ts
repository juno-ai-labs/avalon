/**
 * Which parts of a Markdown string are code, and which are prose.
 *
 * Two rewriters need this same answer and must not disagree about it: the TeX
 * repair ([`model-markdown.ts`](model-markdown.ts)), which must not rewrite a
 * sample that contains a dollar sign on purpose, and the citation rewrite for
 * Rally's non-renderer delivery surfaces ([`citations.ts`](citations.ts)),
 * which must not reduce `[Title](resource://id)` to its label when the model is
 * *showing* someone the syntax.
 *
 * The split is deliberately structural rather than clever. A rule smart enough
 * to recognise code mid-replacement is the kind that fails on the first sample
 * containing the character it keys on; splitting first and never looking inside
 * a code run cannot fail that way.
 */

/**
 * A fenced code block, an inline code span, or a stretch of neither.
 *
 * A fence has to start a line, so the pattern captures the newline before it
 * and hands it back untouched; an inline span is a run of backticks closed by a
 * run of the same length.
 */
const CODE_OR_TEXT = /(^|\n)([ \t]*(?:```|~~~)[\s\S]*?(?:\n[ \t]*(?:```|~~~)[^\n]*(?=\n|$)|$))|(`+)([\s\S]*?)\3/gu;

/**
 * Rewrites every run of prose in `value` through `transform`, leaving code
 * exactly as written.
 *
 * `transform` sees one prose run at a time, never the whole document, which
 * suits a rewrite decided character by character. A rewrite that has to reason
 * about *lines* — a footnote definition is a line — wants `maskMarkdownCode`
 * instead, because an inline code span in the middle of a line cuts that line
 * into two prose runs here.
 */
export function mapMarkdownProse(value: string, transform: (prose: string) => string): string {
  let result = "";
  let cursor = 0;
  CODE_OR_TEXT.lastIndex = 0;
  for (let match = CODE_OR_TEXT.exec(value); match !== null; match = CODE_OR_TEXT.exec(value)) {
    result += transform(value.slice(cursor, match.index));
    // A fenced block keeps the leading newline the pattern had to capture to
    // prove the fence started a line.
    result += match[0];
    cursor = match.index + match[0].length;
  }
  return result + transform(value.slice(cursor));
}

/**
 * `value` with every code character replaced by a space, and nothing else moved.
 *
 * Length, offsets and newlines are all preserved, so a caller can analyse the
 * mask line by line and then slice or splice the *original* string at the
 * offsets it found. That is what lets a rule read a whole line while staying
 * blind to the code inside it: a fenced block becomes lines of blanks that
 * match no rule, and an inline span becomes blanks that keep their line intact.
 *
 * The mask is for analysis only. It is never anybody's output — a run of spaces
 * where a code span was would read as an indented code block to the next parser
 * along.
 */
export function maskMarkdownCode(value: string): string {
  let result = "";
  let cursor = 0;
  CODE_OR_TEXT.lastIndex = 0;
  for (let match = CODE_OR_TEXT.exec(value); match !== null; match = CODE_OR_TEXT.exec(value)) {
    result += value.slice(cursor, match.index);
    result += match[0].replace(/[^\n]/gu, " ");
    cursor = match.index + match[0].length;
  }
  return result + value.slice(cursor);
}
