/**
 * Long pasted text becomes an attachment rather than a wall of text in the
 * composer. This module decides what kind of text it is, so the file carries a
 * MIME type and extension that the attachment viewer and the agent both read
 * correctly, and marks the file so the upload asks the API to name it.
 */

/**
 * How long a paste has to be, in UTF-16 code units, before it attaches instead
 * of landing at the caret. A product choice rather than a derived bound: it is
 * where a paste stops being a message and starts being a document.
 */
export const LONG_PASTE_CHARACTERS = 5_000;

export interface PastedTextType {
  mimeType: string;
  extension: string;
}

const PLAIN: PastedTextType = { mimeType: 'text/plain', extension: 'txt' };
const MARKDOWN: PastedTextType = { mimeType: 'text/markdown', extension: 'md' };
const HTML: PastedTextType = { mimeType: 'text/html', extension: 'html' };
const JSON_TYPE: PastedTextType = { mimeType: 'application/json', extension: 'json' };
const XML: PastedTextType = { mimeType: 'application/xml', extension: 'xml' };
const CSV: PastedTextType = { mimeType: 'text/csv', extension: 'csv' };
const TSV: PastedTextType = { mimeType: 'text/tab-separated-values', extension: 'tsv' };

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
 * Three or more rows that each carry the same number of separators, and at
 * least one. A paste long enough to attach is many lines, and prose almost
 * never keeps its comma count steady across them.
 */
function isDelimited(lines: string[], separator: string): boolean {
  if (lines.length < 3) return false;
  const count = lines[0]!.split(separator).length - 1;
  return count > 0 && lines.every((line) => line.split(separator).length - 1 === count);
}

function looksLikeMarkdown(text: string): boolean {
  if (MARKDOWN_STRONG.some((pattern) => pattern.test(text))) return true;
  return MARKDOWN_WEAK.filter((pattern) => pattern.test(text)).length >= 2;
}

/**
 * The most specific common type the text plainly is, checked from the
 * strictest test to the loosest: JSON has to parse, markup has to open and
 * close, a table has to keep its shape, and Markdown needs more than one hint.
 * Anything else is plain text. Source code lands there too: no cheap test
 * tells one language from another, and a wrong guess reads worse than `.txt`.
 */
export function detectTextType(text: string): PastedTextType {
  const trimmed = text.trim();
  if (looksLikeJson(trimmed)) return JSON_TYPE;
  if (HTML_DOCUMENT.test(trimmed) || (trimmed.startsWith('<') && HTML_CLOSING_TAG.test(trimmed))) return HTML;
  if (XML_DECLARATION.test(trimmed) || ELEMENT_DOCUMENT.test(trimmed)) return XML;
  if (looksLikeMarkdown(trimmed)) return MARKDOWN;
  const lines = trimmed.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (isDelimited(lines, '\t')) return TSV;
  if (isDelimited(lines, ',')) return CSV;
  return PLAIN;
}

/**
 * Files the upload should ask the API to name from their content. A WeakSet
 * rather than a field on the file, so every surface that hands files to the
 * attachment hook keeps its signature; a draft restored after a restart is a
 * new `File` and keeps the name it was given here instead.
 */
const namedFromContent = new WeakSet<File>();

export function shouldNameFromContent(file: File): boolean {
  return namedFromContent.has(file);
}

/** The attachment a long paste becomes, under a stand-in name the API replaces. */
export function pastedTextFile(text: string, stamp: string, ordinal: number): File {
  const type = detectTextType(text);
  const file = new File(
    [text],
    `Pasted text ${stamp}${ordinal > 1 ? ` (${ordinal})` : ''}.${type.extension}`,
    { type: type.mimeType },
  );
  namedFromContent.add(file);
  return file;
}
