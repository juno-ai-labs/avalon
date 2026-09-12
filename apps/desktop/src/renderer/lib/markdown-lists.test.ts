import { describe, expect, it } from 'vitest';
import {
  continueListAtCaret,
  type DraftEdit,
  parseListItem,
  shiftListAtCaret,
  toggleListAtSelection,
} from './markdown-lists';

/**
 * Drafts are written with `|` standing where the caret is, so a case reads as
 * the thing somebody typed rather than as a string and two offsets that have to
 * be counted out by hand. A second `|` makes it a selection. `applied` puts the
 * bars back into the result, so what a case asserts is a draft too.
 */
function caretAt(marked: string): [text: string, start: number, end: number] {
  const start = marked.indexOf('|');
  const second = marked.slice(start + 1).indexOf('|');
  return [marked.replaceAll('|', ''), start, second === -1 ? start : start + second];
}

function applied(edit: DraftEdit | null): string | null {
  if (!edit) return null;
  const { text, selectionStart, selectionEnd } = edit;
  if (selectionStart === selectionEnd) return `${text.slice(0, selectionStart)}|${text.slice(selectionStart)}`;
  return `${text.slice(0, selectionStart)}|${text.slice(selectionStart, selectionEnd)}|${text.slice(selectionEnd)}`;
}

const enter = (marked: string): string | null => applied(continueListAtCaret(...caretAt(marked)));
const indent = (marked: string): string | null => applied(shiftListAtCaret(...caretAt(marked), 'in'));
const outdent = (marked: string): string | null => applied(shiftListAtCaret(...caretAt(marked), 'out'));
const bulleted = (marked: string): string | null => applied(toggleListAtSelection(...caretAt(marked), 'bulleted'));
const numbered = (marked: string): string | null => applied(toggleListAtSelection(...caretAt(marked), 'numbered'));

describe('parseListItem', () => {
  it('reads both kinds of marker, with their indent and their content', () => {
    expect(parseListItem('- first')).toMatchObject({ kind: 'bulleted', delimiter: '-', indent: '', content: 'first' });
    expect(parseListItem('  * second')).toMatchObject({ kind: 'bulleted', delimiter: '*', indent: '  ' });
    expect(parseListItem('3) third')).toMatchObject({ kind: 'numbered', number: 3, delimiter: ')', content: 'third' });
  });

  it('reads a task box as part of the marker rather than as content', () => {
    expect(parseListItem('- [x] done')).toMatchObject({ checkbox: '[x] ', content: 'done', prefixLength: 6 });
  });

  it('leaves prose that only looks like a marker alone', () => {
    expect(parseListItem('---')).toBeNull();
    expect(parseListItem('-word')).toBeNull();
    expect(parseListItem('2026-09-12. shipped')).toBeNull();
  });

  it('reads a spaced horizontal rule as a rule, not as a bullet', () => {
    // The renderer draws these; a bullet introducing `- -` is not what they are.
    expect(parseListItem('- - -')).toBeNull();
    expect(parseListItem('* * *')).toBeNull();
    expect(parseListItem('  _ _ _  ')).toBeNull();
    // Still a list item, though — three bullets is a rule, one is an item.
    expect(parseListItem('- - a')).toMatchObject({ kind: 'bulleted', content: '- a' });
  });
});

describe('continueListAtCaret', () => {
  it('carries a bullet on to the next line', () => {
    expect(enter('- first|')).toBe('- first\n- |');
  });

  it('counts a numbered list on, keeping the delimiter it was written with', () => {
    expect(enter('1. first|')).toBe('1. first\n2. |');
    expect(enter('3) first|')).toBe('3) first\n4) |');
  });

  it('keeps the indent of the item it continues', () => {
    expect(enter('- a\n  - b|')).toBe('- a\n  - b\n  - |');
  });

  it('gives the new task an unchecked box', () => {
    expect(enter('- [x] done|')).toBe('- [x] done\n- [ ] |');
  });

  it('splits an item when the caret is inside its content', () => {
    expect(enter('- fir|st')).toBe('- fir\n- |st');
  });

  it('renumbers the items below the one it inserted', () => {
    expect(enter('1. a|\n2. b\n3. c')).toBe('1. a\n2. |\n3. b\n4. c');
  });

  it('unnests an empty item one level rather than leaving the list', () => {
    expect(enter('- a\n  - |')).toBe('- a\n- |');
  });

  it('takes the marker off an empty item at the margin, without adding a line', () => {
    expect(enter('- a\n- |')).toBe('- a\n|');
  });

  it('leaves the keystroke alone where there is no list to continue', () => {
    expect(enter('hello|')).toBeNull();
    // Inside the marker: the newline belongs above the item, not in the middle
    // of its bullet.
    expect(enter('|- a')).toBeNull();
  });

  it('leaves a list-looking line inside a code fence alone', () => {
    expect(enter('```\n- a|\n```')).toBeNull();
  });

  it('leaves a horizontal rule alone rather than bulleting under it', () => {
    expect(enter('* * *|')).toBeNull();
  });

  it('counts past an item\'s own continuation paragraph', () => {
    // The indented line belongs to item 1, so the item after it is 3 and not a
    // second 2 — the run did not end, it was interrupted by its own content.
    expect(enter('1. a|\n   continuation\n2. b')).toBe('1. a\n2. |\n   continuation\n3. b');
  });

  it('starts a new run when the delimiter changes', () => {
    // CommonMark reads `1.` and `1)` as two lists, so the second keeps its own
    // first ordinal instead of counting on from the first.
    expect(enter('1. a|\n5) b')).toBe('1. a\n2. |\n5) b');
  });

  it('keeps the first ordinal of a top-level list that carries an indent', () => {
    // Up to three spaces is still a list at the margin. Nothing nests this run,
    // so renumbering it from 1 would rewrite a line nobody was editing.
    expect(enter('  5. a|\n  6. b')).toBe('  5. a\n  6. |\n  7. b');
  });
});

describe('shiftListAtCaret', () => {
  it('nests an item under the one above it', () => {
    expect(indent('- a\n- b|')).toBe('- a\n  - b|');
  });

  it('nests to the column the item above puts its own content in', () => {
    expect(indent('10. a\n11. b|')).toBe('10. a\n    1. b|');
  });

  it('will not nest an item that has nothing above it to nest under', () => {
    expect(indent('- a|')).toBeNull();
    expect(indent('intro\n- a|')).toBeNull();
  });

  it('unnests back onto the column of the nearest shallower item', () => {
    expect(outdent('- a\n    - b|')).toBe('- a\n- b|');
  });

  it('lets Tab out of the composer rather than shifting what cannot shift', () => {
    expect(outdent('- a|')).toBeNull();
    expect(indent('plain text|')).toBeNull();
  });

  it('shifts every item a selection touches, keeping their relative nesting', () => {
    expect(indent('- a\n|- b\n  - c|')).toBe('- a\n|  - b\n    - c|');
  });

  it('renumbers both lists when a numbered item leaves one for the other', () => {
    expect(outdent('1. a\n2. b\n   1. c\n   2. d|')).toBe('1. a\n2. b\n   1. c\n3. d|');
  });

  it('nests under a predecessor that is deeper, as its sibling', () => {
    // The line above is already a sublist, so the deepest legal target is its
    // own column. Declining here would not merely do nothing: Tab would fall
    // through and take focus out of the composer.
    expect(indent('- a\n  - b\n- c|')).toBe('- a\n  - b\n  - c|');
  });

  it('will not nest an item under a line of code', () => {
    expect(indent('    - sample\n- real|')).toBeNull();
  });

  it('keeps a nested block nested when the whole block is unnested', () => {
    expect(outdent('- a\n|  - b\n    - c|')).toBe('- a\n|- b\n  - c|');
  });
});

describe('toggleListAtSelection', () => {
  it('opens a list in an empty draft, ready for the first item', () => {
    expect(bulleted('|')).toBe('- |');
    expect(numbered('|')).toBe('1. |');
  });

  it('turns a line of prose into an item', () => {
    expect(bulleted('hello|')).toBe('- hello|');
  });

  it('turns the selected lines into a numbered list, counting as it goes', () => {
    expect(numbered('|a\nb\nc|')).toBe('|1. a\n2. b\n3. c|');
  });

  it('switches a list from one kind to the other', () => {
    expect(numbered('- hello|')).toBe('1. hello|');
    expect(bulleted('1. hello|')).toBe('- hello|');
  });

  it('takes the list back off when every selected line is already that kind', () => {
    expect(bulleted('|- a\n- b|')).toBe('|a\nb|');
  });

  it('takes a task box off with the marker it belonged to', () => {
    expect(bulleted('- [x] done|')).toBe('done|');
  });

  it('leaves a blank line between items unmarked, so the list stays one list', () => {
    expect(bulleted('|a\n\nb|')).toBe('|- a\n\n- b|');
  });

  it('leaves lines inside a code fence alone', () => {
    expect(bulleted('```\na|\n```')).toBeNull();
  });

  it('does not take the line a selection merely stops at the head of', () => {
    // Shift+Down from the head of a line: the range covers `alpha\n` and none
    // of `beta`, so only `alpha` is a line the person chose.
    expect(bulleted('|alpha\n|beta')).toBe('|- alpha\n|beta');
  });
});
