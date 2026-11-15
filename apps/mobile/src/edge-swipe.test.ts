import { describe, expect, it } from 'vitest';
import { edgeSwipeCompletes } from './edge-swipe';

describe('edge swipe', () => {
  it('opens once a pull has travelled inward far enough', () => {
    expect(edgeSwipeCompletes(39, 0, 0)).toBe(false);
    expect(edgeSwipeCompletes(40, 0, 0)).toBe(true);
  });
  it('opens sooner on a quick flick', () => {
    expect(edgeSwipeCompletes(12, 2, 0.5)).toBe(true);
    expect(edgeSwipeCompletes(12, 2, 0.2)).toBe(false);
  });
  it('ignores a mostly vertical drag and a pull back outward', () => {
    expect(edgeSwipeCompletes(50, 60, 1)).toBe(false);
    expect(edgeSwipeCompletes(-50, 0, -1)).toBe(false);
  });
});
