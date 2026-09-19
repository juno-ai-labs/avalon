import { describe, expect, it } from 'vitest';

import { moveWithin, orderByStoredIds, storedOrderFor } from './personal-order';

const SPACE_ID = '00000000-0000-7000-8000-0000000000a1';
const OTHER_SPACE_ID = '00000000-0000-7000-8000-0000000000a2';

interface Row { id: string }

const row = (id: string): Row => ({ id });
const ids = (rows: Row[]): string[] => rows.map((item) => item.id);

describe('the arrangement every hand-ordered list is drawn by', () => {
  it('puts the stored ids first and leaves the rest in the order the list had', () => {
    const list = [row('a'), row('b'), row('c'), row('d')];

    expect(ids(orderByStoredIds(list, ['c', 'a'], (item) => item.id)))
      .toEqual(['c', 'a', 'b', 'd']);
  });

  // A Space left, a Channel archived, a Breakout deleted — and, for a
  // Channel's Breakouts, an id the authority stored without ever being able to
  // check it, because WorkspaceDO cannot see a Channel's children.
  it('drops a stored id the list does not carry rather than drawing a gap', () => {
    const list = [row('a'), row('b')];

    expect(ids(orderByStoredIds(list, ['gone', 'b'], (item) => item.id))).toEqual(['b', 'a']);
  });

  // The identity, and the state every list is in until somebody drags
  // something: the natural order stands, whatever it is.
  it('leaves a list nobody has arranged exactly as it is', () => {
    const list = [row('b'), row('a')];

    expect(ids(orderByStoredIds(list, [], (item) => item.id))).toEqual(['b', 'a']);
  });

  it('finds one container by both halves of its address', () => {
    const ordering = [
      { container: { kind: 'space' as const, id: SPACE_ID }, itemIds: ['a'] },
      { container: { kind: 'channel' as const, id: SPACE_ID }, itemIds: ['b'] },
    ];

    // The kind alone is not the key: the same id can name a container of two
    // kinds, and reading either one's arrangement for the other would draw a
    // Space's Channels in the order somebody put that Channel's Breakouts in.
    expect(storedOrderFor(ordering, { kind: 'space', id: SPACE_ID })).toEqual(['a']);
    expect(storedOrderFor(ordering, { kind: 'channel', id: SPACE_ID })).toEqual(['b']);
    // A container nobody has arranged, and a client that has had no payload
    // yet, are the same answer: no arrangement, so the natural order stands.
    expect(storedOrderFor(ordering, { kind: 'space', id: OTHER_SPACE_ID })).toEqual([]);
    expect(storedOrderFor(undefined, { kind: 'space', id: SPACE_ID })).toEqual([]);
  });

  it('moves one id to a position, and stops at either end', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(moveWithin(['a', 'b', 'c'], 'a', 9)).toEqual(['b', 'c', 'a']);
    expect(moveWithin(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
  });
});
