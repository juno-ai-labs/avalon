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
/** CommonMark list marker: 0–3 spaces, then -, +, *, or an ordered marker. */
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:( +)|\t|$)/u;
const BLOCKQUOTE = /^ {0,3}>/u;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)$/u;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:[ \t]+\S/u;
const DEFINITION_CONTINUATION = /^(?: {4}|\t)/u;

function listItemContentIndent(line: string): number | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const markerIndent = match[1]!.length;
  const markerWidth = match[2]!.length;
  const spaces = match[3];
  const padding = spaces === undefined ? 1 : spaces.length > 4 ? 1 : spaces.length;
  return markerIndent + markerWidth + padding;
}

function leadingIndent(line: string): number {
  let indent = 0;
  for (const character of line) {
    if (character === ' ') indent += 1;
    else if (character === '\t') indent += 4 - (indent % 4);
    else break;
  }
  return indent;
}

/**
 * Which prose lines can open a *document* heading. An ATX or setext line
 * indented inside a list item is a heading of that item, not a section
 * boundary — splitting there would cut the list in two.
 */
function documentHeadingAllowed(
  lines: readonly string[],
  kinds: readonly MarkdownLineKind[],
): boolean[] {
  const allowed: boolean[] = [];
  const stack: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (kinds[index] !== 'prose') {
      allowed.push(false);
      continue;
    }
    const line = lines[index]!;
    if (line.trim() === '') {
      allowed.push(false);
      continue;
    }
    const indent = leadingIndent(line);
    while (stack.length > 0 && indent < stack[stack.length - 1]!) stack.pop();
    const itemIndent = listItemContentIndent(line);
    if (itemIndent !== null) {
      stack.push(itemIndent);
      allowed.push(false);
      continue;
    }
    if (stack.length > 0 && indent >= stack[stack.length - 1]!) {
      allowed.push(false);
      continue;
    }
    allowed.push(true);
  }
  return allowed;
}

function cannotBeSetextText(line: string): boolean {
  return listItemContentIndent(line) !== null || BLOCKQUOTE.test(line);
}

function proseHeadingAt(
  lines: readonly string[],
  kinds: readonly MarkdownLineKind[],
  allowed: readonly boolean[],
  index: number,
): { level: number; lineCount: number } | null {
  if (kinds[index] !== 'prose' || !allowed[index]) return null;
  const line = lines[index]!;
  const atx = ATX_HEADING.exec(line);
  if (atx) return { level: atx[2]!.length, lineCount: 1 };
  if (line.trim() === '' || cannotBeSetextText(line)) return null;
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

function isDefinitionOpener(line: string): boolean {
  if (FOOTNOTE_DEFINITION.test(line)) return true;
  if (/^ {0,3}\[\^/u.test(line)) return false;
  return LINK_DEFINITION.test(line);
}

/**
 * GFM footnote definitions and CommonMark link-reference definitions in
 * `source`, in document order, outside code. Each collapsible section is its
 * own `react-markdown` mount, and a definition that lives under a later
 * heading is otherwise invisible to a reference in an earlier one.
 */
export function markdownDefinitionBlocks(source: string): string[] {
  if (source === '') return [];
  const lines = source.split('\n');
  const kinds = markdownLineKinds(lines);
  const starts = lineStartsOf(source, lines);
  const blocks: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (kinds[index] !== 'prose' || !isDefinitionOpener(lines[index]!)) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < lines.length) {
      const line = lines[index]!;
      if (!line.trim() || DEFINITION_CONTINUATION.test(line)) {
        index += 1;
        continue;
      }
      break;
    }
    let end = index;
    while (end > start + 1 && lines[end - 1]!.trim() === '') end -= 1;
    blocks.push(sliceLines(source, starts, start, end));
  }
  return blocks;
}

/**
 * `fragment` with any document-level definitions it does not already carry
 * appended, so a section parse can resolve a `[^1]` or `[text][ref]` whose
 * definition lives in a later section. Returns `fragment` itself when there is
 * nothing to add, so callers can treat identity as "this parse owns its defs".
 */
export function withMarkdownDefinitions(fragment: string, blocks: readonly string[]): string {
  if (!fragment || blocks.length === 0) return fragment;
  const missing = blocks.filter((block) => {
    const opener = block.split('\n')[0] ?? '';
    return opener !== '' && !fragment.includes(opener);
  });
  if (missing.length === 0) return fragment;
  const sep = fragment.endsWith('\n\n') ? '' : fragment.endsWith('\n') ? '\n' : '\n\n';
  return `${fragment}${sep}${missing.join('')}`;
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
 * the streaming splitter and the citation rewrite use. Headings inside a list
 * item or a blockquote stay in that container; they are not section
 * boundaries.
 *
 * `parts` reconstruct: joining each preamble and each `heading + body` yields
 * `source` byte for byte.
 */
export function splitCollapsibleMarkdown(source: string): MarkdownCollapsePart[] {
  if (source === '') return [];
  const lines = source.split('\n');
  const kinds = markdownLineKinds(lines);
  const allowed = documentHeadingAllowed(lines, kinds);
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
    const heading = proseHeadingAt(lines, kinds, allowed, index);
    if (heading && heading.level === 1) {
      // An h1 is never a section. Closing the open one (if any) captures its
      // body up to here; with no section open, the lead before this title is
      // still waiting at `cursor` and has to be flushed or it disappears.
      if (open) closeSection(index);
      else flushPreamble(index);
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
