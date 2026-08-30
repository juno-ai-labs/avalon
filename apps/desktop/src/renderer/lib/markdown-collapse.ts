import { markdownLineKinds, type MarkdownLineKind } from '@rally/contracts/markdown-code';

/**
 * A top-level run of a markdown document for heading collapse.
 *
 * A `preamble` is everything that is not inside a collapsible section — the
 * lead before the first h2+, and any h1 (and its following prose) that closes
 * a section without starting a new one. A `section` is one accordion: an
 * h2–h6 and the content that follows it until the next heading of the same
 * or higher rank. Nested headings stay in the body; they are not sections.
 */
export type MarkdownCollapsePart =
  | { readonly type: 'preamble'; readonly source: string }
  | {
      readonly type: 'section';
      readonly id: string;
      readonly level: number;
      readonly heading: string;
      readonly body: string;
    };

/** ATX: 0–3 spaces, 1–6 hashes, then a space/tab or the end of the line. `#foo` is not a heading. */
const ATX_HEADING = /^( {0,3})(#{1,6})(?:[ \t]|[ \t]*$)/u;
const SETEXT_H1 = /^( {0,3})=+[ \t]*$/u;
const SETEXT_H2 = /^( {0,3})-+[ \t]*$/u;

function proseHeadingAt(
  lines: readonly string[],
  kinds: readonly MarkdownLineKind[],
  index: number,
): { level: number; lineCount: number } | null {
  if (kinds[index] !== 'prose') return null;
  const line = lines[index]!;
  const atx = ATX_HEADING.exec(line);
  if (atx) return { level: atx[2]!.length, lineCount: 1 };
  if (line.trim() === '') return null;
  const next = lines[index + 1];
  if (next === undefined || kinds[index + 1] !== 'prose') return null;
  if (SETEXT_H1.test(next)) return { level: 1, lineCount: 2 };
  if (SETEXT_H2.test(next)) return { level: 2, lineCount: 2 };
  return null;
}

function lineStartsOf(source: string, lines: readonly string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    starts.push(offset);
    offset += lines[index]!.length;
    if (index < lines.length - 1) offset += 1;
  }
  return starts;
}

function sliceLines(source: string, starts: readonly number[], from: number, to: number): string {
  const begin = starts[from] ?? source.length;
  const end = to >= starts.length ? source.length : starts[to]!;
  return source.slice(begin, end);
}

/**
 * Cut `source` into a preamble and a flat list of collapsible sections.
 *
 * Only h2–h6 start a section, and only when they are not nested inside an
 * already-open section of higher rank (lower number). An h3 under an h2 is
 * body, not an accordion. An h1 is never collapsible; it closes the open
 * section and the title that follows waits as preamble until the next h2+.
 *
 * Headings inside code are ignored — `markdownLineKinds` is the same answer
 * the streaming splitter and the citation rewrite use.
 *
 * `parts` reconstruct: joining each preamble and each `heading + body` yields
 * `source` byte for byte.
 */
export function splitCollapsibleMarkdown(source: string): MarkdownCollapsePart[] {
  if (source === '') return [];
  const lines = source.split('\n');
  const kinds = markdownLineKinds(lines);
  const starts = lineStartsOf(source, lines);
  const parts: MarkdownCollapsePart[] = [];
  let cursor = 0;
  let sectionIndex = 0;
  let open: { id: string; level: number; headingStart: number; headingEnd: number } | null = null;

  const closeSection = (endLine: number): void => {
    if (!open) return;
    parts.push({
      type: 'section',
      id: open.id,
      level: open.level,
      heading: sliceLines(source, starts, open.headingStart, open.headingEnd),
      body: sliceLines(source, starts, open.headingEnd, endLine),
    });
    open = null;
  };

  const flushPreamble = (endLine: number): void => {
    if (endLine <= cursor) return;
    const text = sliceLines(source, starts, cursor, endLine);
    if (text) parts.push({ type: 'preamble', source: text });
  };

  for (let index = 0; index < lines.length;) {
    const heading = proseHeadingAt(lines, kinds, index);
    if (heading && heading.level === 1) {
      closeSection(index);
      cursor = index;
      index += heading.lineCount;
      continue;
    }
    if (heading && heading.level >= 2 && (open === null || heading.level <= open.level)) {
      if (open) closeSection(index);
      else flushPreamble(index);
      open = {
        id: `section-${sectionIndex}`,
        level: heading.level,
        headingStart: index,
        headingEnd: index + heading.lineCount,
      };
      sectionIndex += 1;
      index += heading.lineCount;
      continue;
    }
    index += heading?.lineCount ?? 1;
  }

  if (open) closeSection(lines.length);
  else flushPreamble(lines.length);
  return parts;
}

export function collapsibleSectionIds(source: string): string[] {
  return splitCollapsibleMarkdown(source)
    .filter((part): part is Extract<MarkdownCollapsePart, { type: 'section' }> => part.type === 'section')
    .map((part) => part.id);
}
