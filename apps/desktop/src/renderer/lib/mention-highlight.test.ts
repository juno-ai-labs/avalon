import { describe, expect, it } from 'vitest';
import { normalizeMentionLabels, splitMentionHighlights } from './mention-highlight';

const labels = normalizeMentionLabels(['Bob Builder', 'Bob', 'Cara Chen', 'Google Drive']);

function mentions(value: string): string[] {
  return splitMentionHighlights(value, labels)
    .filter((segment) => segment.kind === 'mention')
    .map((segment) => segment.text);
}

describe('splitMentionHighlights', () => {
  it('returns the draft untouched when nothing is mentionable', () => {
    expect(splitMentionHighlights('ship it', labels)).toEqual([{ kind: 'text', text: 'ship it' }]);
    expect(splitMentionHighlights('', labels)).toEqual([]);
    expect(splitMentionHighlights('@Bob', [])).toEqual([{ kind: 'text', text: '@Bob' }]);
  });

  it('splits a known resource out of the surrounding text', () => {
    expect(splitMentionHighlights('hey @Bob, look', labels)).toEqual([
      { kind: 'text', text: 'hey ' },
      { kind: 'mention', text: '@Bob' },
      { kind: 'text', text: ', look' },
    ]);
  });

  it('prefers the longest matching label', () => {
    expect(mentions('@Bob Builder can you look')).toEqual(['@Bob Builder']);
    expect(mentions('@Bob can you look')).toEqual(['@Bob']);
  });

  it('matches labels case-insensitively but keeps what was typed', () => {
    expect(mentions('ping @cara chen please')).toEqual(['@cara chen']);
  });

  it('matches a label whose case folding changes its length', () => {
    // 'İ' lowercases to two code units, so a folded length would slice past the label.
    expect(splitMentionHighlights('ping @İstanbul Ops today', ['İstanbul Ops'])).toEqual([
      { kind: 'text', text: 'ping ' },
      { kind: 'mention', text: '@İstanbul Ops' },
      { kind: 'text', text: ' today' },
    ]);
  });

  it('deduplicates labels that differ only by case', () => {
    expect(normalizeMentionLabels(['Bob', 'bob', ' Cara Chen ', ''])).toEqual(['Cara Chen', 'Bob']);
  });

  it('highlights several resources in one draft', () => {
    expect(mentions('@Bob and @Google Drive both')).toEqual(['@Bob', '@Google Drive']);
  });

  it('leaves half-typed and unknown handles plain', () => {
    expect(mentions('@Ca')).toEqual([]);
    expect(mentions('@nobody at all')).toEqual([]);
    expect(mentions('@Bobby Tables')).toEqual([]);
  });

  it('ignores an @ that is part of another token', () => {
    expect(mentions('mail bob@Bob.com')).toEqual([]);
    expect(mentions('a@Bob')).toEqual([]);
  });

  it('accepts openers and terminators around the label', () => {
    expect(mentions('(@Bob)')).toEqual(['@Bob']);
    expect(mentions('[@Cara Chen]')).toEqual(['@Cara Chen']);
    expect(mentions('line\n@Bob')).toEqual(['@Bob']);
    expect(mentions('@Bob')).toEqual(['@Bob']);
  });

  it('reassembles the original draft from its segments', () => {
    const draft = 'hey @Bob Builder, ask @Google Drive — cc @nobody\n@Cara Chen';
    expect(splitMentionHighlights(draft, labels).map((segment) => segment.text).join('')).toBe(draft);
  });
});
