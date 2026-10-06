import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDockBadge } from './dock-badge';

const setDockBadgeCount = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('./platform', () => ({
  desktopBridge: () => ({ setDockBadgeCount }),
}));

describe('useDockBadge', () => {
  beforeEach(() => setDockBadgeCount.mockClear());

  it('holds the badge until the directory has loaded, then follows the count', () => {
    const { rerender } = renderHook(({ count, complete }) => useDockBadge(count, complete), {
      initialProps: { count: 1, complete: false },
    });
    expect(setDockBadgeCount).not.toHaveBeenCalled();

    rerender({ count: 3, complete: true });
    rerender({ count: 2, complete: true });
    expect(setDockBadgeCount.mock.calls).toEqual([[3], [2]]);
  });

  it('clears the badge when the shell unmounts', () => {
    const { unmount } = renderHook(() => useDockBadge(4, true));
    unmount();
    expect(setDockBadgeCount.mock.calls).toEqual([[4], [0]]);
  });
});
