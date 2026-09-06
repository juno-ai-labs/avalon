import { describe, expect, it } from 'vitest';
import { literalMatchRanges, matchingPassage } from '../src/services/search-passages';

describe('matching search passages', () => {
  it('finds literal substrings inside words without interpreting regex syntax', () => {
    expect(literalMatchRanges('Alex Danilowicz and DANIL', 'danil')).toEqual([{ start: 5, end: 10 }, { start: 20, end: 25 }]);
    expect(literalMatchRanges('a*b and axb', 'a*b')).toEqual([{ start: 0, end: 3 }]);
  });
  it('keeps source and excerpt offsets distinct when surrounding text is omitted', () => {
    const text = 'before before before Danilowicz after after after';
    const ranges = literalMatchRanges(text, 'danil');
    const passage = matchingPassage(text, ranges, 7)!;
    expect(text.slice(passage.range.start, passage.range.end)).toBe('Danil');
    expect(passage.excerpt.slice(passage.highlights[0]!.start, passage.highlights[0]!.end)).toBe('Danil');
    expect(passage.excerpt.startsWith('…')).toBe(true);
    expect(passage.excerpt.endsWith('…')).toBe(true);
  });
  it('preserves surrogate pairs and canonical UTF-16 offsets', () => {
    const text = '🦊A🦊';
    const passage = matchingPassage(text, literalMatchRanges(text, 'a'), 1)!;
    expect(passage.excerpt).toBe(text);
    expect(passage.range).toEqual({ start: 2, end: 3 });
    expect(matchingPassage(text, [], 1)).toBeNull();
  });
});
