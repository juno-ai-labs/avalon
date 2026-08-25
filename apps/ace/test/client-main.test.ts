import { describe, expect, it } from 'vitest';
import { initialDirectoryLookup, reorderRules } from '../src/client/main';

describe('Ace condition editor', () => {
  it('initializes a loaded directory condition from its stored opaque ID', () => {
    expect(initialDirectoryLookup({ value: 'workspace-loaded-id' })).toBe('workspace-loaded-id');
    expect(initialDirectoryLookup({})).toBe('');
  });
});

describe('reorderRules', () => {
  it('moves an item later, shifting the ones in between up', () => {
    expect(reorderRules(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves an item earlier, shifting the ones in between down', () => {
    expect(reorderRules(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('moves the first item to last', () => {
    expect(reorderRules(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });

  it('moves the last item to first', () => {
    expect(reorderRules(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('is a no-op when dropped on its own position', () => {
    expect(reorderRules(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the array it was given', () => {
    const original = ['a', 'b', 'c'];
    reorderRules(original, 0, 2);
    expect(original).toEqual(['a', 'b', 'c']);
  });
});
