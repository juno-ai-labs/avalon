/**
 * What kind of text a person pasted, so a long paste stored as an attachment
 * carries a MIME type and extension that the attachment viewer and the agent
 * both read correctly. Cheap, deterministic checks rather than a model call:
 * the type should never wait on inference.
 */

export interface PastedTextType {
  mimeType: string;
  extension: string;
}

const PLAIN: PastedTextType = { mimeType: "text/plain", extension: "txt" };
const MARKDOWN: PastedTextType = { mimeType: "text/markdown", extension: "md" };
const HTML: PastedTextType = { mimeType: "text/html", extension: "html" };
const JSON_TYPE: PastedTextType = { mimeType: "application/json", extension: "json" };
const XML: PastedTextType = { mimeType: "application/xml", extension: "xml" };
const CSV: PastedTextType = { mimeType: "text/csv", extension: "csv" };
const TSV: PastedTextType = { mimeType: "text/tab-separated-values", extension: "tsv" };

const HTML_DOCUMENT = /^(?:<!doctype html|<html[\s>])/iu;
const HTML_CLOSING_TAG = /<\/(?:html|head|body|div|p|span|a|table|tr|td|ul|ol|li|h[1-6]|section|article|main|nav|header|footer|form|script|style)>/iu;
const XML_DECLARATION = /^<\?xml[\s?]/iu;
const ELEMENT_DOCUMENT = /^<([a-z_][\w.:-]*)[\s\S]*<\/\1>$/iu;

/** Each pattern is one kind of Markdown structure; two kinds, or one strong one, make it Markdown. */
const MARKDOWN_STRONG = [
  /^#{1,6} \S/mu,
  /^(?:```|~~~)/mu,
  /^\|?(?: *:?-{3,}:? *\|)+ *:?-{3,}:? *\|?$/mu,
];
const MARKDOWN_WEAK = [
  /^ {0,3}(?:[-*+]|\d{1,9}[.)]) \S/mu,
  /^> /mu,
  /\[[^\]\n]+\]\([^)\s]+\)/u,
  /\*\*[^*\n]+\*\*/u,
  /`[^`\n]+`/u,
];

function looksLikeJson(trimmed: string): boolean {
  if (!/^[[{]/u.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Separators outside quoted fields, so `"x,y"` is one field. An escaped `""`
 * toggles twice and leaves the state as it was.
 */
function separatorCount(line: string, separator: string): number {
  let count = 0;
  let quoted = false;
  for (const character of line) {
    if (character === '"') quoted = !quoted;
    else if (character === separator && !quoted) count += 1;
  }
  return count;
}

/**
 * Three or more rows that each carry the same number of separators, and at
 * least one. A paste long enough to attach is many lines, and prose almost
 * never keeps its comma count steady across them.
 */
function isDelimited(lines: string[], separator: string): boolean {
  if (lines.length < 3) return false;
  const count = separatorCount(lines[0]!, separator);
  return count > 0 && lines.every((line) => separatorCount(line, separator) === count);
}

/**
 * A line that reads as code or config rather than prose: it ends the way
 * statements and blocks do, opens with a common keyword, or is a `key:` pair.
 */
const CODE_LINE = /(?:[{};]|:)\s*$|^\s*(?:def|class|import|from|function|const|let|var|return|if|elif|else|for|while|fn|pub|package|#include)\b|^\s*[\w.-]+:\s/u;

/**
 * A fifth or more of the lines outside fenced blocks read as code. `#` opens a
 * comment in Python, shell, YAML, TOML and Ruby, so without this a commented
 * script would be read as Markdown and its comments shown as headings.
 */
function looksLikeCode(lines: string[]): boolean {
  let fenced = false;
  let prose = 0;
  let code = 0;
  for (const line of lines) {
    if (/^(?:```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || line.trim().length === 0) continue;
    if (CODE_LINE.test(line)) code += 1;
    else prose += 1;
  }
  return code > 0 && code * 5 >= code + prose;
}

function looksLikeMarkdown(text: string): boolean {
  if (looksLikeCode(text.split(/\r?\n/u))) return false;
  if (MARKDOWN_STRONG.some((pattern) => pattern.test(text))) return true;
  return MARKDOWN_WEAK.filter((pattern) => pattern.test(text)).length >= 2;
}

/**
 * The most specific common type the text plainly is, checked from the
 * strictest test to the loosest: JSON has to parse, markup has to open and
 * close, a table has to keep its shape, and Markdown needs more than one hint.
 * Anything else is plain text. Source code lands there too, `#` comments
 * included: no cheap test tells one language from another, and a wrong guess
 * reads worse than `.txt`.
 */
export function detectTextType(text: string): PastedTextType {
  const trimmed = text.trim();
  if (looksLikeJson(trimmed)) return JSON_TYPE;
  if (HTML_DOCUMENT.test(trimmed) || (trimmed.startsWith("<") && HTML_CLOSING_TAG.test(trimmed))) return HTML;
  if (XML_DECLARATION.test(trimmed) || ELEMENT_DOCUMENT.test(trimmed)) return XML;
  if (looksLikeMarkdown(trimmed)) return MARKDOWN;
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (isDelimited(lines, "\t")) return TSV;
  if (isDelimited(lines, ",")) return CSV;
  return PLAIN;
}
