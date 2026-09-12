import { isMarkdownCode, markdownLineKinds } from '@rally/contracts/markdown-code';

/**
 * List editing for the composer's plain-text draft.
 *
 * A Rally message is Markdown — `MarkdownBody` renders every human turn through
 * `react-markdown` and `remark-gfm` — so a bulleted or numbered list is already
 * something a person can send. What was missing is the part every editor people
 * arrive from already has: after `- first`, Enter gives you `- ` rather than an
 * empty line to retype the dash into, a numbered list counts itself, Tab nests,
 * and a selection can be turned into a list without touching any of that by
 * hand.
 *
 * Everything here is a pure function over `(text, selectionStart, selectionEnd)`
 * returning the draft that should replace it, so the rules are testable without
 * a DOM and the composer's only job is to apply an edit and place the caret.
 * The composer is the one caller today; a second text surface that wants the
 * same keys — a note body, an automation definition — takes these rather than
 * growing its own.
 *
 * ## The three operations
 *
 * | Operation | Bound to |
 * | --- | --- |
 * | `continueListAtCaret` | the key that inserts a newline |
 * | `shiftListAtCaret` | Tab and Shift+Tab |
 * | `toggleListAtSelection` | ⌘/Ctrl+Shift+8, ⌘/Ctrl+Shift+7, and the composer menu |
 *
 * Each returns `null` when it has nothing to do, and a `null` is the signal to
 * let the keystroke do whatever it would have done — a plain newline, a move to
 * the next control. **That fallthrough is what keeps Tab from trapping a
 * keyboard user**: Tab only indents on a list line that has somewhere to nest,
 * and Shift+Tab only outdents one that is already nested, so there is always a
 * Tab or a Shift+Tab out of the composer.
 *
 * ## Every ordered list is renumbered, every time
 *
 * Each operation ends by rewriting the ordinals of every ordered run in the
 * draft so it counts consecutively from its own first item. Insert a line in
 * the middle of 1–4 and you get 1–5, not 1, 2, 3, 3, 4.
 *
 * This is one rule applied everywhere rather than each operation patching up
 * the ordinals it happens to have disturbed, and it is the rule because the
 * alternative is worse in the case that matters: continuing, nesting, and
 * unnesting all shift numbering *below* the caret, and three separate
 * corrections is three chances to disagree. Markdown itself does not need it —
 * a run written `1. 1. 1.` renders as 1, 2, 3 — so this is entirely about what
 * the person is looking at while they write.
 *
 * A list at the margin keeps its first ordinal and counts on from there, so a
 * list deliberately started at `5.` stays started at 5. A *nested* run always
 * restarts at 1, because the only way a sublist comes to start at 11 is that
 * somebody nested the eleventh item of the list above it, and that is never
 * what they meant.
 *
 * ## Code is left alone
 *
 * A line inside a fenced or indented code block is never read as a list item
 * and never rewritten, using the classifier in `@rally/contracts/markdown-code`
 * that the transcript renderer and the citation rewrites already share. A
 * shell transcript pasted into the composer keeps its `- ` flags.
 */

/** Which of the two kinds of list marker a line carries. */
export type ListMarkerKind = 'bulleted' | 'numbered';

/** A draft and where the selection sits in it, as an edit ready to be applied. */
export interface DraftEdit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

/** One line of a draft, read as a list item. */
export interface ListItemLine {
  /** The whitespace the line opens with — what nests it under the item above. */
  indent: string;
  kind: ListMarkerKind;
  /** The ordinal a numbered item carries, or `null` on a bullet. */
  number: number | null;
  /** `-`, `*`, `+` on a bullet; `.` or `)` on a numbered item. */
  delimiter: string;
  /** The whitespace between the marker and what follows it. */
  spacing: string;
  /** A GFM task box, exactly as written and with its trailing space, or `''`. */
  checkbox: string;
  /** Everything the marker introduces, the task box excluded. */
  content: string;
  /** How much of the line the marker occupies, the task box included. */
  prefixLength: number;
}

/**
 * A list item, and the one shape both kinds fit into.
 *
 * `[ \t]+` after the marker rather than `[ \t]*` is what keeps a typed em-dash
 * sentence and a `---` rule out: `-word` and `---` are not items, which is also
 * how the renderer will read them. Nine digits is CommonMark's own ceiling on an
 * ordinal, and stopping there means `2026-09-12.` at the head of a line is
 * prose rather than a list that renumbers itself the moment somebody presses
 * Enter under it.
 */
const LIST_ITEM = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/u;

/** Read one line as a list item, or `null` where it is not one. */
export function parseListItem(line: string): ListItemLine | null {
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const [, indent = '', bullet, ordinal, ordinalDelimiter, spacing = '', checkbox = '', content = ''] = match;
  const bulleted = bullet !== undefined;
  return {
    indent,
    kind: bulleted ? 'bulleted' : 'numbered',
    number: bulleted ? null : Number(ordinal),
    delimiter: bulleted ? bullet : ordinalDelimiter ?? '.',
    spacing,
    checkbox,
    content,
    prefixLength: indent.length + (bulleted ? 1 : (ordinal?.length ?? 0) + 1) + spacing.length + checkbox.length,
  };
}

/** The marker itself — what a numbered item renumbers and a bullet keeps. */
function markerOf(item: ListItemLine, ordinal = item.number ?? 1): string {
  return item.kind === 'bulleted' ? item.delimiter : `${ordinal}${item.delimiter}`;
}

/**
 * How far a child of this item has to be indented to nest under it.
 *
 * CommonMark nests on the parent's *content* column, so `- a` takes two spaces
 * and `10. a` takes four. Measuring it rather than picking a fixed two keeps
 * every nesting this produces one the renderer agrees with.
 */
function childIndentOf(item: ListItemLine): string {
  return ' '.repeat(item.indent.length + markerOf(item).length + item.spacing.length);
}

/** A prefix rewrite on one line: how much to take off the front, and what to put there. */
interface PrefixChange {
  prefixLength: number;
  prefix: string;
}

/**
 * Rewrite the front of some lines and carry the selection through it.
 *
 * Every operation here edits line prefixes and nothing else, which is what lets
 * one function place the caret for all of them: a caret past a prefix moves by
 * that prefix's change in length, and a caret inside one — which only a
 * selection dragged across a marker produces — settles at the end of the new
 * prefix rather than landing in the middle of a marker it no longer matches.
 *
 * The head of a *range* is the one offset that does not follow that rule. Sat
 * at the head of a line, it is holding a line rather than a character, so it
 * stays at the head of that line and the markers the operation writes fall
 * inside the selection — which is what keeps a list toggled on still selected,
 * and so toggleable straight back off.
 */
function replacePrefixes(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  changes: ReadonlyMap<number, PrefixChange>,
): DraftEdit {
  const lines = text.split('\n');
  const previousStarts: number[] = [];
  const nextStarts: number[] = [];
  const rewritten: string[] = [];
  let previousAt = 0;
  let nextAt = 0;
  for (const [index, line] of lines.entries()) {
    previousStarts.push(previousAt);
    nextStarts.push(nextAt);
    const change = changes.get(index);
    const next = change ? change.prefix + line.slice(change.prefixLength) : line;
    rewritten.push(next);
    previousAt += line.length + 1;
    nextAt += next.length + 1;
  }
  const move = (offset: number, opensRange = false): number => {
    let index = 0;
    while (index + 1 < lines.length && (previousStarts[index + 1] ?? 0) <= offset) index += 1;
    const column = offset - (previousStarts[index] ?? 0);
    const start = nextStarts[index] ?? 0;
    const change = changes.get(index);
    if (!change || (opensRange && column === 0)) return start + column;
    if (column >= change.prefixLength) return start + column + change.prefix.length - change.prefixLength;
    return start + Math.min(column, change.prefix.length);
  };
  return {
    text: rewritten.join('\n'),
    selectionStart: move(selectionStart, selectionStart !== selectionEnd),
    selectionEnd: move(selectionEnd),
  };
}

/**
 * Every ordered run in the draft, counting consecutively from its own first
 * item. See the module note above for why this runs after every operation
 * rather than each one repairing what it disturbed.
 *
 * A run is held open by blank lines, because a list with a blank line between
 * its items is a *loose* list and still one list. Anything else at the margin —
 * a paragraph, a heading, a line of code — ends every run, and an item nested
 * deeper than the one before it opens a run of its own that its parent's next
 * item closes.
 */
function renumberOrderedRuns(edit: DraftEdit): DraftEdit {
  const lines = edit.text.split('\n');
  const kinds = markdownLineKinds(lines);
  const changes = new Map<number, PrefixChange>();
  /** The ordinal last handed out at each indent width, for the runs still open. */
  const counters = new Map<number, number>();
  const closeDeeperThan = (width: number): void => {
    for (const open of counters.keys()) if (open > width) counters.delete(open);
  };
  for (const [index, line] of lines.entries()) {
    if (isMarkdownCode(kinds[index] ?? 'prose')) {
      counters.clear();
      continue;
    }
    const item = parseListItem(line);
    if (!item) {
      if (line.trim() !== '') counters.clear();
      continue;
    }
    const width = item.indent.length;
    closeDeeperThan(width);
    if (item.kind === 'bulleted') {
      // A bulleted run at this width is not something to count, and it ends any
      // ordered run that was open here — the two cannot be the same list.
      counters.delete(width);
      continue;
    }
    const open = counters.get(width);
    const ordinal = open !== undefined ? open + 1 : width === 0 ? item.number ?? 1 : 1;
    counters.set(width, ordinal);
    if (ordinal === item.number) continue;
    changes.set(index, {
      prefixLength: item.prefixLength,
      prefix: item.indent + markerOf(item, ordinal) + item.spacing + item.checkbox,
    });
  }
  if (changes.size === 0) return edit;
  return replacePrefixes(edit.text, edit.selectionStart, edit.selectionEnd, changes);
}

/** The half-open bounds of the line `offset` sits on. */
function lineBoundsAt(text: string, offset: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', offset - 1) + 1;
  const break_ = text.indexOf('\n', offset);
  return { start, end: break_ === -1 ? text.length : break_ };
}

/** The indices of every line the selection touches, in order. */
function selectedLineIndices(lines: readonly string[], selectionStart: number, selectionEnd: number): number[] {
  const indices: number[] = [];
  let at = 0;
  for (const [index, line] of lines.entries()) {
    const end = at + line.length;
    if (end >= selectionStart && at <= selectionEnd) indices.push(index);
    at = end + 1;
  }
  return indices;
}

/**
 * The newline that carries a list item on, or ends one.
 *
 * Three outcomes, which are the three a person expects from Enter in a list:
 *
 * - **On an item with something in it**, a new item of the same shape — same
 *   indent, same bullet or the next ordinal, and an *unchecked* box where the
 *   item above carried one, because a new task is not a done one.
 * - **On an empty nested item**, the same empty item one level out. Enter is
 *   how a sublist is left, and pressing it repeatedly walks back to the margin
 *   one level at a time before it exits the list at all.
 * - **On an empty item at the margin**, the marker is taken away and the caret
 *   stays on the line it emptied. No newline is inserted: the line the person
 *   is on is already blank, and adding another would make leaving a list cost a
 *   Backspace.
 *
 * Returns `null` where the caret is not in a list item, or is inside the marker
 * rather than past it — there the key does what it always did, so `|- a` still
 * opens a line above the item, and `Enter` on prose is still just a newline.
 */
export function continueListAtCaret(text: string, selectionStart: number, selectionEnd: number): DraftEdit | null {
  const bounds = lineBoundsAt(text, selectionStart);
  const lines = text.split('\n');
  const lineIndex = text.slice(0, bounds.start).split('\n').length - 1;
  if (isMarkdownCode(markdownLineKinds(lines)[lineIndex] ?? 'prose')) return null;
  const item = parseListItem(text.slice(bounds.start, bounds.end));
  if (!item) return null;
  if (selectionStart < bounds.start + item.prefixLength) return null;

  if (selectionStart === selectionEnd && item.content === '' && selectionStart === bounds.end) {
    if (item.indent === '') {
      // Out of the list: the prefix goes, the blank line it was on stays.
      return renumberOrderedRuns(replacePrefixes(
        text,
        selectionStart,
        selectionEnd,
        new Map([[lineIndex, { prefixLength: item.prefixLength, prefix: '' }]]),
      ));
    }
    return renumberOrderedRuns(replacePrefixes(
      text,
      selectionStart,
      selectionEnd,
      new Map([[lineIndex, {
        prefixLength: item.prefixLength,
        prefix: outdentOf(lines, lineIndex, item.indent) + markerOf(item) + item.spacing + item.checkbox,
      }]]),
    ));
  }

  const prefix = `${item.indent}${markerOf(item, (item.number ?? 0) + 1)}${item.spacing}${item.checkbox === '' ? '' : '[ ] '}`;
  return renumberOrderedRuns({
    text: `${text.slice(0, selectionStart)}\n${prefix}${text.slice(selectionEnd)}`,
    selectionStart: selectionStart + 1 + prefix.length,
    selectionEnd: selectionStart + 1 + prefix.length,
  });
}

/**
 * The indent an item falls back to when it is unnested: the nearest item above
 * it that is already shallower, or the margin where there is none. Landing on a
 * real ancestor's column rather than subtracting a guessed two spaces is what
 * keeps an outdent from stopping between two levels, where the renderer would
 * read it as a child of neither.
 *
 * `indentAt` is how the item above is measured, so a pass that is itself moving
 * those items can hand back where it has already put them rather than where
 * they started.
 */
function outdentOf(
  lines: readonly string[],
  lineIndex: number,
  indent: string,
  indentAt: (index: number, item: ListItemLine) => string = (_index, item) => item.indent,
): string {
  for (let above = lineIndex - 1; above >= 0; above -= 1) {
    const line = lines[above] ?? '';
    if (line.trim() === '') continue;
    const ancestor = parseListItem(line);
    if (!ancestor) break;
    const ancestorIndent = indentAt(above, ancestor);
    if (ancestorIndent.length < indent.length) return ancestorIndent;
  }
  return '';
}

/**
 * Tab and Shift+Tab over the list items the selection touches.
 *
 * Nesting in Markdown is positional: an item is a child of the item above it,
 * so the first item of a list has nothing to nest under and Tab there does not
 * indent — it moves focus, which is the behaviour a keyboard user needs to
 * still be able to leave the composer. Shift+Tab at the margin does the same.
 * A selection spanning several items shifts all of them, each measured against
 * the item above it *as already shifted*, so a nested block keeps its shape
 * instead of collapsing onto one column.
 */
export function shiftListAtCaret(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  direction: 'in' | 'out',
): DraftEdit | null {
  const lines = text.split('\n');
  const kinds = markdownLineKinds(lines);
  const selected = new Set(selectedLineIndices(lines, selectionStart, selectionEnd));
  const changes = new Map<number, PrefixChange>();
  /** Indents as this pass leaves them, so a shifted block measures against itself. */
  const shifted = new Map<number, string>();
  const indentAt = (index: number): string | undefined => {
    const item = parseListItem(lines[index] ?? '');
    if (!item) return undefined;
    return shifted.get(index) ?? item.indent;
  };
  for (const [index, line] of lines.entries()) {
    const item = parseListItem(line);
    if (!item || isMarkdownCode(kinds[index] ?? 'prose')) continue;
    const indent = shifted.get(index) ?? item.indent;
    if (!selected.has(index)) {
      shifted.set(index, indent);
      continue;
    }
    let next: string | null = null;
    if (direction === 'in') {
      const above = parseListItem(lines[index - 1] ?? '');
      const aboveIndent = indentAt(index - 1);
      // Only under a sibling or an ancestor. An item already nested inside the
      // one above it is as deep as this list can legally go.
      if (above && aboveIndent !== undefined && aboveIndent.length <= indent.length) {
        next = childIndentOf({ ...above, indent: aboveIndent });
      }
    } else if (indent !== '') {
      next = outdentOf(lines, index, indent, (above, ancestor) => shifted.get(above) ?? ancestor.indent);
    }
    if (next === null || next === indent) {
      shifted.set(index, indent);
      continue;
    }
    shifted.set(index, next);
    changes.set(index, { prefixLength: item.indent.length, prefix: next });
  }
  if (changes.size === 0) return null;
  return renumberOrderedRuns(replacePrefixes(text, selectionStart, selectionEnd, changes));
}

/**
 * Turn the selected lines into a list of `kind`, or back into prose where they
 * are already one.
 *
 * The toggle reads the selection before it acts: lines that are *all* already
 * this kind of list come back out of it, and anything else — prose, the other
 * kind, a mixture — goes in. That is one control per kind rather than four, and
 * it is why the menu item and the shortcut can be the same thing pressed twice.
 *
 * Blank lines inside a multi-line selection are skipped rather than given a
 * marker of their own, since a blank line between two items is how a loose list
 * is written and marking it would split the list in two. An empty draft is the
 * exception and the common case: with nothing selected there is nothing to
 * convert, so the toggle writes the marker and leaves the caret after it, ready
 * for the first item.
 */
export function toggleListAtSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  kind: ListMarkerKind,
): DraftEdit | null {
  const lines = text.split('\n');
  const kinds = markdownLineKinds(lines);
  const touched = selectedLineIndices(lines, selectionStart, selectionEnd)
    .filter((index) => !isMarkdownCode(kinds[index] ?? 'prose'));
  const written = touched.filter((index) => (lines[index] ?? '').trim() !== '');
  const targets = written.length > 0 ? written : touched;
  if (targets.length === 0) return null;
  const items = targets.map((index) => parseListItem(lines[index] ?? ''));
  const remove = items.every((item) => item?.kind === kind);
  const changes = new Map<number, PrefixChange>();
  let ordinal = 0;
  for (const [at, index] of targets.entries()) {
    const line = lines[index] ?? '';
    const item = items[at] ?? null;
    if (remove) {
      // The task box goes with the marker: a `[ ] ` outside a list is not a
      // checkbox to any renderer, it is two brackets in the middle of a
      // sentence.
      changes.set(index, { prefixLength: item?.prefixLength ?? 0, prefix: item?.indent ?? '' });
      continue;
    }
    ordinal += 1;
    const indent = item?.indent ?? /^[ \t]*/u.exec(line)?.[0] ?? '';
    const marker = kind === 'bulleted' ? '-' : `${ordinal}.`;
    changes.set(index, {
      prefixLength: item?.prefixLength ?? indent.length,
      prefix: `${indent}${marker} ${item?.checkbox ?? ''}`,
    });
  }
  return renumberOrderedRuns(replacePrefixes(text, selectionStart, selectionEnd, changes));
}
