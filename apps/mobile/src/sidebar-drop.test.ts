import { describe, expect, it } from 'vitest';
import { sidebarDropCommand } from './sidebar-drop';

describe('sidebar drops', () => {
  it('pins at the insertion marker, including an empty group and the end', () => {
    expect(sidebarDropCommand(['a', 'b'], 'new', { section: 'pins', index: 1 })).toEqual({ type: 'pin', id: 'new', pinned: true, beforeId: 'b' });
    expect(sidebarDropCommand(['a', 'b'], 'new', { section: 'pins', index: 2 })).toEqual({ type: 'pin', id: 'new', pinned: true });
    expect(sidebarDropCommand([], 'new', { section: 'pins', index: 0 })).toEqual({ type: 'pin', id: 'new', pinned: true });
  });
  it('reorders in both directions while retaining overflow pins', () => {
    const pins = ['a', 'b', 'c', 'd', 'e'];
    expect(sidebarDropCommand(pins, 'a', { section: 'pins', index: 3 })).toEqual({ type: 'reorder', ids: ['b', 'c', 'a', 'd', 'e'] });
    expect(sidebarDropCommand(pins, 'e', { section: 'pins', index: 0 })).toEqual({ type: 'reorder', ids: ['e', 'a', 'b', 'c', 'd'] });
    expect(pins).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
  it('places at either end and clamps drops beyond the pin list', () => {
    expect(sidebarDropCommand(['a', 'b', 'c'], 'a', { section: 'pins', index: 3 })).toEqual({ type: 'reorder', ids: ['b', 'c', 'a'] });
    expect(sidebarDropCommand(['a', 'b'], 'new', { section: 'pins', index: -1 })).toEqual({ type: 'pin', id: 'new', pinned: true, beforeId: 'a' });
    expect(sidebarDropCommand(['a', 'b'], 'a', { section: 'pins', index: 99 })).toEqual({ type: 'reorder', ids: ['b', 'a'] });
  });
  it('unpins only when a pin lands in Canvases', () => {
    expect(sidebarDropCommand(['a'], 'a', { section: 'canvases' })).toEqual({ type: 'pin', id: 'a', pinned: false });
    expect(sidebarDropCommand(['a'], 'b', { section: 'canvases' })).toBeNull();
    expect(sidebarDropCommand(['a'], 'a', null)).toBeNull();
  });
  it('does not write for either insertion edge of the original row', () => {
    expect(sidebarDropCommand(['a', 'b', 'c'], 'b', { section: 'pins', index: 1 })).toBeNull();
    expect(sidebarDropCommand(['a', 'b', 'c'], 'b', { section: 'pins', index: 2 })).toBeNull();
  });
});
