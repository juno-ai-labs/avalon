import { describe, expect, it } from 'vitest';
import { edgePullOpens } from './edge-swipe';

describe('edge pull release', () => {
  it('settles on the nearer side when let go slowly', () => {
    expect(edgePullOpens(0.49, 0)).toBe(false);
    expect(edgePullOpens(0.5, 0)).toBe(true);
  });
  it('follows a fling, however far the drawer came', () => {
    expect(edgePullOpens(0.1, 600)).toBe(true);
    expect(edgePullOpens(0.9, -600)).toBe(false);
  });
});
